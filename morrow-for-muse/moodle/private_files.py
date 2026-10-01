"""Immutable, account/course-scoped Moodle attachment bytes in private state."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import uuid

from moodle.contracts import normalize_moodle_base
from privacy.core import (_canonical_private_state_file_path, _create_exact_file,
                          _file_lock, _read_exact_file, _require_aesgcm)
from transport.local_chromium import tree_state_dir

_MAX_FILE = 1048576
_MAX_RECORD = 2 * 1048576
_SCHEMA = 'morrow.moodle-private-file.v1'


def _manifest(value):
    if not isinstance(value, dict) or set(value) != {'filename', 'size_bytes', 'sha256'}:
        raise ValueError('A private file needs its exact review manifest')
    name = value['filename']
    if (not isinstance(name, str) or not name or name.strip() != name or name in ('.', '..')
            or len(name.encode('utf-16-le')) // 2 > 255
            or re.search(r'[\\/\x00-\x1f\x7f]', name)):
        raise ValueError('Select a valid file name without a path')
    if type(value['size_bytes']) is not int or not 1 <= value['size_bytes'] <= _MAX_FILE:
        raise ValueError('Moodle private files must be between 1 byte and 1 MiB')
    if not isinstance(value['sha256'], str) or not re.fullmatch(r'[a-f0-9]{64}', value['sha256']):
        raise ValueError('A private file needs its exact SHA-256')
    return dict(value)


def _scope(binding):
    site, principal, course = (binding.get(key) for key in ('siteUrl', 'principalId', 'courseId'))
    if normalize_moodle_base(site) != site or not site.startswith('https://'):
        raise ValueError('A private file needs the paired Moodle site')
    for value in (principal, course):
        if not isinstance(value, str) or not re.fullmatch(r'[1-9][0-9]*', value) or int(value) > 9007199254740991:
            raise ValueError('A private file needs the paired account and course')
    return {'site': site, 'principal': principal, 'course': course}


def _json(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode('utf-8')


class PrivateMoodleFiles:
    def __init__(self):
        self.root = Path(tree_state_dir()) / 'moodle_private_files'
        self.key_path = _canonical_private_state_file_path(self.root / 'key', 'private file key')

    def _key(self):
        with _file_lock(self.key_path):
            key = _read_exact_file(self.key_path, 'private file key', 32, 32)
            if key is None:
                _create_exact_file(self.key_path, os.urandom(32), 'private file key', 32, 32)
                key = _read_exact_file(self.key_path, 'private file key', 32, 32)
            return key

    def _path(self, scope, manifest):
        digest = hashlib.sha256(_json({'scope': scope, 'manifest': manifest})).hexdigest()
        return _canonical_private_state_file_path(self.root / (digest + '.file'), 'private Moodle file')

    def _read(self, path, scope, manifest):
        sealed = _read_exact_file(path, 'private Moodle file', 29, _MAX_RECORD)
        if sealed is None:
            raise ValueError('Stage this exact file before preparing the Moodle write')
        try:
            plain = _require_aesgcm()(self._key()).decrypt(sealed[:12], sealed[12:], Path(path).name.encode('ascii'))
            record = json.loads(plain.decode('utf-8'))
            if (set(record) != {'schema', 'scope', 'manifest', 'handle', 'bytes_base64'}
                    or record['schema'] != _SCHEMA or record['scope'] != scope
                    or record['manifest'] != manifest or not re.fullmatch(r'[a-f0-9]{32}', record['handle'])
                    or not isinstance(record['bytes_base64'], str) or len(record['bytes_base64']) > 1398104):
                raise ValueError()
            data = base64.b64decode(record['bytes_base64'], validate=True)
            if len(data) != manifest['size_bytes'] or hashlib.sha256(data).hexdigest() != manifest['sha256']:
                raise ValueError()
            return {'schema': 'morrow.private-file-attachment.v1', 'handle': record['handle'],
                    'manifest': manifest, 'bytes_base64': record['bytes_base64']}
        except Exception:
            raise ValueError('The staged private file changed or could not be verified') from None

    def stage(self, binding, source, filename):
        scope = _scope(binding)
        source = Path(source).expanduser().absolute()
        named = source.lstat()
        if not stat.S_ISREG(named.st_mode) or source.is_symlink() or named.st_nlink != 1:
            raise ValueError('Select one regular local file, not a link')
        if not 1 <= named.st_size <= _MAX_FILE:
            raise ValueError('Moodle private files must be between 1 byte and 1 MiB')
        descriptor = os.open(source, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))
        with os.fdopen(descriptor, 'rb') as stream:
            opened = os.fstat(stream.fileno())
            if (not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1
                    or (opened.st_dev, opened.st_ino) != (named.st_dev, named.st_ino)):
                raise ValueError('The local file changed during staging')
            data = stream.read(_MAX_FILE + 1)
            after = os.fstat(stream.fileno())
        current = source.lstat()
        if ((opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns)
                != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)
                or (current.st_dev, current.st_ino) != (opened.st_dev, opened.st_ino)
                or len(data) != opened.st_size):
            raise ValueError('The local file changed during staging')
        manifest = _manifest({'filename': filename, 'size_bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
        path = self._path(scope, manifest)
        with _file_lock(path):
            if _read_exact_file(path, 'private Moodle file', 29, _MAX_RECORD) is None:
                record = {'schema': _SCHEMA, 'scope': scope, 'manifest': manifest,
                          'handle': uuid.uuid4().hex, 'bytes_base64': base64.b64encode(data).decode('ascii')}
                nonce = os.urandom(12)
                sealed = nonce + _require_aesgcm()(self._key()).encrypt(nonce, _json(record), Path(path).name.encode('ascii'))
                _create_exact_file(path, sealed, 'private Moodle file', 29, _MAX_RECORD)
            self._read(path, scope, manifest)
        return manifest

    def attachments(self, binding, arguments, mode):
        if mode == 'none':
            return {}
        manifests = [_manifest({key: arguments.get(key) for key in ('filename', 'size_bytes', 'sha256')})] if mode == 'single' else arguments.get('files')
        if (mode not in ('single', 'multiple') or not isinstance(manifests, list) or not 1 <= len(manifests) <= 8):
            raise ValueError('Select a bounded reviewed file set')
        manifests = [_manifest(value) for value in manifests]
        if sum(value['size_bytes'] for value in manifests) > _MAX_FILE or len({value['filename'] for value in manifests}) != len(manifests):
            raise ValueError('The reviewed file set must have unique names and total at most 1 MiB')
        scope = _scope(binding)
        result = []
        for manifest in manifests:
            path = self._path(scope, manifest)
            with _file_lock(path):
                result.append(self._read(path, scope, manifest))
        return {'privateAttachment': result[0]} if mode == 'single' else {'privateAttachments': result}
