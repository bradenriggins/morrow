"""Integrity-checked adapter staging for the governed Moodle executor.

Staging compiles trusted package code in a private browser context. It does
not invoke the adapter or send provider requests. The executor must complete
identity, privacy and admission checks before invoking a staged operation.
"""
import base64
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import threading
import time
import uuid
from urllib.parse import urlsplit

_MAX_BYTES = 2 * 1024 * 1024
_CHUNK_BYTES = 44000
_HEX = re.compile(r"[a-f0-9]{64}\Z")
_FILE = re.compile(r"moodle-[a-z0-9-]+\.js\Z")


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate adapter metadata key")
        result[key] = value
    return result


def _read(path):
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(descriptor, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > _MAX_BYTES or Path(path).is_symlink():
            raise ValueError("adapter asset is not a bounded regular file")
        value = stream.read(_MAX_BYTES + 1)
        if len(value) > _MAX_BYTES:
            raise ValueError("adapter asset exceeds its byte limit")
        return value


def _json(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))


def _hash(value):
    return hashlib.sha256(value).hexdigest()


@dataclass(frozen=True)
class StagedMoodleAdapter:
    slot: str
    function_sha256: str
    payload_sha256: str
    read_only: bool


class MoodleAdapterLoader:
    def __init__(self, assets, *, registry_sha256):
        self.assets = Path(assets)
        self._pace_lock = threading.Lock()
        self._last_evaluation = 0.0
        if not isinstance(registry_sha256, str) or not _HEX.fullmatch(registry_sha256):
            raise ValueError("adapter registry needs an integrity pin")
        raw = _read(self.assets / "moodle-browser-routes.json")
        if _hash(raw) != registry_sha256:
            raise ValueError("adapter registry integrity mismatch")
        registry = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_object)
        if registry.get("schema") != "morrow.moodle-browser-routes.v1":
            raise ValueError("unsupported adapter registry")
        self.sources = registry.get("sources")
        self.operations = registry.get("operations")
        if not isinstance(self.sources, dict) or not isinstance(self.operations, dict) or not self.operations:
            raise ValueError("adapter registry is incomplete")
        catalog = _read(self.assets / "moodle-browser-catalog.json")
        if _hash(catalog) != self.sources.get("moodle-browser-catalog.json"):
            raise ValueError("adapter catalog integrity mismatch")
        rows = json.loads(catalog.decode("utf-8"), object_pairs_hook=_unique_object).get("operations")
        if not isinstance(rows, list):
            raise ValueError("adapter catalog is incomplete")
        definitions = {row.get("key"): row for row in rows if isinstance(row, dict)}
        if len(definitions) != len(rows) or set(definitions) != set(self.operations):
            raise ValueError("adapter catalog routes mismatch")
        for key, route in self.operations.items():
            definition = definitions[key]
            if (not isinstance(route, dict) or not _FILE.fullmatch(str(route.get("file", "")))
                    or not _HEX.fullmatch(str(self.sources.get(route["file"], "")))
                    or not _HEX.fullmatch(str(route.get("functionSha256", "")))
                    or not re.fullmatch(r"[A-Za-z_$][A-Za-z0-9_$]*", str(route.get("function", "")))
                    or type(route.get("readOnly")) is not bool
                    or route["readOnly"] != definition.get("readOnly")
                    or route.get("toolName") != definition.get("toolName")
                    or definition.get("provider") != "moodle"
                    or route.get("inputKind") not in ("operation", "roster")
                    or route.get("attachmentMode") not in ("none", "single", "multiple")):
                raise ValueError("adapter route metadata is invalid")
            bounds = route.get("functionByteRange")
            if (not isinstance(bounds, list) or len(bounds) != 2
                    or any(type(n) is not int for n in bounds)
                    or not 0 <= bounds[0] < bounds[1] <= _MAX_BYTES):
                raise ValueError("adapter callable byte range is invalid")

    def stage(self, cdp, tab, context_id, operation_key, request, *, base_url):
        route = self.operations.get(operation_key)
        if route is None:
            raise ValueError("unknown Moodle adapter route")
        parsed = urlsplit(base_url)
        if (parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password
                or parsed.query or parsed.fragment or base_url.endswith("/")):
            raise ValueError("adapter staging needs an exact HTTPS site")
        if type(context_id) is not int or context_id < 1 or not isinstance(request, dict):
            raise ValueError("adapter staging needs a private context and request")
        module = _read(self.assets / route["file"])
        if _hash(module) != self.sources[route["file"]]:
            raise ValueError("adapter source integrity mismatch")
        start, end = route["functionByteRange"]
        function = module[start:end]
        if len(function) != end - start or _hash(function) != route["functionSha256"]:
            raise ValueError("adapter callable integrity mismatch")
        function.decode("utf-8")
        payload = _json(request).encode("utf-8")
        if len(payload) > _MAX_BYTES:
            raise ValueError("adapter request exceeds its byte limit")
        slot = "__morrow_adapter_" + uuid.uuid4().hex
        quoted = _json(slot)
        pin = {"base": base_url, "source": _hash(function), "payload": _hash(payload),
               "sourceBytes": len(function), "payloadBytes": len(payload)}
        initialize = r"""(() => {
          const pin = %s, root = new URL(pin.base), slot = %s;
          const basePath = root.pathname.replace(/\/$/, '');
          if (location.origin !== root.origin || !(location.pathname === basePath || location.pathname.startsWith(basePath + '/')))
            throw new Error('moodle_site_mismatch');
          if (Object.hasOwn(globalThis, slot)) throw new Error('moodle_stage_collision');
          Object.defineProperty(globalThis, slot, {configurable: true, enumerable: true,
            value: {pin, href: location.href, source: [], payload: [], sourceOffset: 0, payloadOffset: 0}});
          return {slot};
        })()""" % (_json(pin), quoted)
        def evaluate(expression, **options):
            with self._pace_lock:
                delay = self._last_evaluation + 0.1 - time.monotonic()
                if delay > 0:
                    time.sleep(delay)
                self._last_evaluation = time.monotonic()
            return cdp.evaluate(tab, expression, context_id=context_id, **options)

        try:
            initial = evaluate(initialize)
            if not isinstance(initial, dict) or initial.get("slot") != slot:
                raise ValueError("adapter staging initialization was not acknowledged")
            for kind, value in (("source", function), ("payload", payload)):
                for offset in range(0, len(value), _CHUNK_BYTES):
                    chunk = value[offset:offset + _CHUNK_BYTES]
                    expression = """(() => {
                      const s = globalThis[%s], kind = %s, offset = %d;
                      if (!s || s.href !== location.href || s[kind + 'Offset'] !== offset || s.fn)
                        throw new Error('moodle_stage_changed');
                      const bytes = Uint8Array.from(atob(%s), c => c.charCodeAt(0));
                      if (offset + bytes.length > s.pin[kind + 'Bytes']) throw new Error('moodle_stage_oversized');
                      s[kind].push(bytes); s[kind + 'Offset'] += bytes.length;
                      return {slot: %s, kind, offset: s[kind + 'Offset']};
                    })()""" % (quoted, _json(kind), offset, _json(base64.b64encode(chunk).decode("ascii")), quoted)
                    acknowledged = evaluate(expression)
                    if acknowledged != {"slot": slot, "kind": kind, "offset": offset + len(chunk)}:
                        raise ValueError("adapter staging chunk was not acknowledged")
            finalize = """(async () => {
              const s = globalThis[%s];
              if (!s || s.href !== location.href || s.fn) throw new Error('moodle_stage_changed');
              const decode = async kind => {
                if (s[kind + 'Offset'] !== s.pin[kind + 'Bytes']) throw new Error('moodle_stage_incomplete');
                const bytes = new Uint8Array(s.pin[kind + 'Bytes']); let offset = 0;
                for (const chunk of s[kind]) {bytes.set(chunk, offset); offset += chunk.length;}
                const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
                if (digest !== s.pin[kind]) throw new Error('moodle_stage_integrity_mismatch');
                return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
              };
              const source = await decode('source'), payload = await decode('payload');
              if (s.href !== location.href) throw new Error('moodle_stage_changed');
              const fn = Function('return (' + source + ')')();
              if (typeof fn !== 'function') throw new Error('moodle_stage_callable_invalid');
              s.fn = fn; s.input = payload; s.source = null; s.payload = null;
              return {slot: %s, source: s.pin.source, payload: s.pin.payload};
            })()""" % (quoted, quoted)
            completed = evaluate(finalize, await_promise=True)
            if completed != {"slot": slot, "source": pin["source"], "payload": pin["payload"]}:
                raise ValueError("adapter staging completion was not acknowledged")
            return StagedMoodleAdapter(slot, pin["source"], pin["payload"], route["readOnly"])
        except Exception:
            try:
                evaluate("delete globalThis[%s]" % quoted)
            except Exception:
                pass
            raise
