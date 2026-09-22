"""W6-P2-7: best-effort in-memory secret hygiene.

CPython reality check, stated honestly: `bytes` and `str` are immutable,
so every secret held as bytes/str leaves copies the interpreter may
retain (temporaries, HMAC/hashlib internals, hex encodings). No
Python-level code can GUARANTEE erasure. This module does what CAN be
done:

- Secrets with a defined lifetime are held in a MUTABLE bytearray
  (SecretBytes) instead of bytes/str, so the holder's own copy is
  deterministically overwritten at the end of its lifetime.
- zero() overwrites the buffer in place (idempotent); the
  context-manager form zeroes on exit even on exception; __del__
  zeroes best-effort; zero_later() zeroes at process exit.
- Short-lived secrets go through secret_bytes(raw) as a context
  manager: use-then-zero, so even a transient copy does not linger as
  an immutable bytes object.
- view() exposes the underlying bytearray for crypto calls WITHOUT
  making our own copy (hmac/hashlib accept bytearray); bytes(s) makes
  an explicit copy when the callee requires immutable bytes.

What this does NOT do: erase copies made by other layers (hmac,
hashlib, base64, the interpreter's own temporaries). Same-UID memory
disclosure (ptrace, /proc/pid/mem, core dumps) is outside this
control's scope. The OS-level mitigations stay: 0600 secret files,
0700 dirs, short secret lifetimes via rotation (W6-P1-2), and no core
dumps of secret-holding processes.
"""

import atexit


class SecretBytes:
    """A mutable, explicitly-zeroizable secret buffer.

    Construct from bytes-like; the buffer is a bytearray owned by this
    object. Pass view() (the raw bytearray, no copy by us) to crypto
    calls; bytes(s) returns an explicit COPY when immutable bytes are
    required. The buffer starts zeroed-on-exit via the context manager,
    zero_later(), or __del__.
    """

    __slots__ = ("_buf", "_zeroed")

    def __init__(self, raw):
        self._buf = bytearray(raw)
        self._zeroed = False

    def __len__(self):
        return len(self._buf)

    def __bytes__(self):
        return bytes(self._buf)

    def view(self):
        """The underlying bytearray. No copy is made; the caller must
        not retain it past this object's lifetime."""
        return self._buf

    def zero(self):
        """Overwrite the buffer in place. Idempotent."""
        try:
            buf = self._buf
        except AttributeError:
            return
        if not self._zeroed:
            for i in range(len(buf)):
                buf[i] = 0
            self._zeroed = True

    @property
    def zeroed(self):
        return self._zeroed

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.zero()
        return False

    def __del__(self):
        try:
            self.zero()
        except Exception:
            pass


def secret_bytes(raw):
    """Short-lived secret buffer: `with secret_bytes(raw) as s:` ...
    The buffer is zeroed on block exit, even on exception."""
    return SecretBytes(raw)


def zero_later(secret):
    """Register a SecretBytes for zeroing at process exit (best-effort:
    a SIGKILLed process never runs atexit handlers). Returns the secret
    for inline use: TOKEN = zero_later(secret_bytes(raw))."""
    atexit.register(secret.zero)
    return secret
