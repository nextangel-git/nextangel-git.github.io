#!/usr/bin/env python3
"""Publish an owned static artifact to the NIC.RU webroot over verified FTPS.

Credentials: NIC_FTP_HOST, NIC_FTP_USER, NIC_FTP_PASSWORD, NIC_FTP_TLS_NAME.
Initialization is a separate, explicit operation and requires an empty FTP root.
Only files recorded in our manifest can ever be removed. No recursive deletion.
"""
import argparse
import ftplib
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import ssl
import sys
import uuid

MARKER = '.jks-deploy-target.json'
MANIFEST = '.jks-deploy-manifest.json'
EXPECTED_TARGET = {
    'schema': 1,
    'domain': 'jks.ooo',
    'webroot': '/home/jksooo/jks.ooo/docs',
    'ftp_root': '/',
}
MAX_METADATA = 8 * 1024 * 1024
HASH_RE = re.compile(r'^[a-f0-9]{64}$')
PUBLIC_PHP_FILES = {'api/admin.php', 'api/admin-core.php', 'api/admin-schema.php'}
PRIVATE_BASENAMES = {'config.php', 'config.json', 'users.json', 'credentials.json', 'secrets.json', 'server.mjs', 'package-lock.json'}


class DeployError(RuntimeError):
    pass


def valid_path(value):
    if not isinstance(value, str) or not value or '\\' in value:
        raise DeployError('Invalid relative artifact path')
    if any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise DeployError('Control characters in artifact path')
    parts = value.split('/')
    if any(part in ('', '.', '..') for part in parts):
        raise DeployError('Absolute or traversing artifact path')
    if PurePosixPath(value).is_absolute() or ':' in parts[0]:
        raise DeployError('Absolute artifact path')
    # The only intended dotfile in a public release is the Apache configuration.
    if any(part.startswith('.') for part in parts) and value != '.htaccess':
        raise DeployError('Private or reserved artifact path')
    basename = parts[-1].lower()
    if basename in PRIVATE_BASENAMES or basename.endswith(('.sql', '.sqlite', '.sqlite3', '.db')):
        raise DeployError('Private configuration or database in artifact')
    if re.search(r'\.(?:php[0-9]*|phtml|phar|inc)(?:\.|$)', basename) and value not in PUBLIC_PHP_FILES:
        raise DeployError('Only the explicitly allowed public admin PHP files may be deployed')
    return value


def digest(data):
    return hashlib.sha256(data).hexdigest()


def local_artifact(directory):
    directory = Path(directory).resolve(strict=True)
    if not directory.is_dir():
        raise DeployError('Artifact must be a directory')
    result = {}
    for item in sorted(directory.rglob('*')):
        if item.is_symlink():
            raise DeployError('Symlinks are not allowed in the artifact')
        if item.is_file():
            name = valid_path(item.relative_to(directory).as_posix())
            result[name] = item.read_bytes()
    if 'index.html' not in result:
        raise DeployError('Artifact has no index.html')
    return result


def entries(ftp, directory='/'):
    try:
        rows = list(ftp.mlsd(directory))
    except ftplib.error_perm as exc:
        raise DeployError('MLSD is required to safely inspect all remote files') from exc
    result = {}
    for name, facts in rows:
        kind = facts.get('type', '').lower()
        if kind in ('cdir', 'pdir') or name in ('.', '..'):
            continue
        if '/' in name or '\\' in name or any(ord(c) < 32 for c in name):
            raise DeployError('Unsafe remote directory entry')
        result[name] = kind
    return result


def read_remote(ftp, name, limit=None):
    data = bytearray()
    def append(chunk):
        data.extend(chunk)
        if limit is not None and len(data) > limit:
            raise DeployError('Remote metadata exceeds its size limit')
    ftp.retrbinary(f'RETR /{name}', append)
    return bytes(data)


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + '\n').encode('utf-8')


def atomic_upload(ftp, name, data):
    parent, _, leaf = name.rpartition('/')
    temporary = f'{parent + "/" if parent else ""}.jks-upload-{uuid.uuid4().hex}-{leaf}'
    try:
        ftp.storbinary(f'STOR /{temporary}', io.BytesIO(data))
        ftp.rename('/' + temporary, '/' + name)
    except Exception:
        # Only this invocation's unique temporary name may be cleaned up.
        try:
            ftp.delete('/' + temporary)
        except ftplib.all_errors:
            pass
        raise


def initialize(ftp):
    ftp.cwd('/')
    if entries(ftp):
        raise DeployError('Initialization requires a completely empty webroot')
    atomic_upload(ftp, MARKER, json_bytes(EXPECTED_TARGET))


def target_and_manifest(ftp):
    root = entries(ftp)
    if root.get(MARKER) != 'file':
        raise DeployError('Required deployment target marker is missing or not a file')
    try:
        marker = json.loads(read_remote(ftp, MARKER, MAX_METADATA))
    except (ValueError, UnicodeError) as exc:
        raise DeployError('Invalid target marker') from exc
    if marker != EXPECTED_TARGET:
        raise DeployError('Target marker does not identify the expected jks.ooo webroot')
    if MANIFEST not in root:
        # A missing manifest is valid only immediately after initialization.
        if set(root) != {MARKER}:
            raise DeployError('Manifest is missing from a nonempty initialized webroot')
        return {}
    if root[MANIFEST] != 'file':
        raise DeployError('Deployment manifest is not a regular file')
    try:
        manifest = json.loads(read_remote(ftp, MANIFEST, MAX_METADATA))
    except (ValueError, UnicodeError) as exc:
        raise DeployError('Invalid deployment manifest') from exc
    if not isinstance(manifest, dict) or manifest.get('schema') != 1 or manifest.get('target') != EXPECTED_TARGET:
        raise DeployError('Manifest does not match the deployment target')
    files = manifest.get('files')
    if not isinstance(files, dict):
        raise DeployError('Invalid manifest file list')
    for name, sha in files.items():
        valid_path(name)
        if not isinstance(sha, str) or not HASH_RE.fullmatch(sha):
            raise DeployError('Invalid manifest file digest')
    return files


def inventory(ftp):
    """Return all regular files; refuse links without following them."""
    result = set()
    directories = {''}
    pending = ['']
    while pending:
        parent = pending.pop()
        for name, kind in entries(ftp, '/' + parent).items():
            full = parent + '/' + name if parent else name
            if kind == 'dir':
                directories.add(full)
                pending.append(full)
            elif kind == 'file':
                result.add(full)
            else:
                # FTP symlinks must never become traversal targets.
                raise DeployError('Unsupported remote file type (possible symlink)')
    return result, directories


def upload_order(name):
    if name == '.htaccess':
        return (3, name)
    if name.endswith('.html'):
        return (2, name)
    return (0 if name.startswith('_astro/') else 1, name)


def deploy(ftp, artifact):
    # Validate all local paths before connecting them to FTP command arguments.
    for name, data in artifact.items():
        valid_path(name)
        if not isinstance(data, bytes):
            raise DeployError('Artifact content must be bytes')
    if 'index.html' not in artifact:
        raise DeployError('Artifact has no index.html')
    ftp.cwd('/')
    previous = target_and_manifest(ftp)
    remote, directories = inventory(ftp)
    for name in artifact:
        if name in directories or (name in remote and name not in previous):
            raise DeployError(f'Unmanaged remote path would be overwritten: {name}')
        parent = PurePosixPath(name).parent
        while str(parent) != '.':
            if str(parent) in remote:
                raise DeployError('A remote file blocks an artifact directory')
            parent = parent.parent
    # Record the validated write set first: a dropped FTP connection can leave a
    # partially published release, and the next run must still recognize its files.
    # Old entries remain until successful completion and hash-checked stale removal.
    planned = {**previous, **{name: digest(data) for name, data in artifact.items()}}
    atomic_upload(ftp, MANIFEST, json_bytes({
        'schema': 1, 'target': EXPECTED_TARGET, 'files': planned,
    }))
    for name in sorted(artifact, key=upload_order):
        parent = PurePosixPath(name).parent
        for directory in reversed([parent, *parent.parents]):
            value = directory.as_posix()
            if value != '.' and value not in directories:
                ftp.mkd('/' + value)
                directories.add(value)
        atomic_upload(ftp, name, artifact[name])

    current = {name: digest(data) for name, data in artifact.items()}
    removed = 0
    retained = 0
    for name, expected_digest in previous.items():
        if name in current or name not in remote:
            continue
        if name.startswith('_astro/'):
            current[name] = expected_digest
            retained += 1
        elif digest(read_remote(ftp, name)) == expected_digest:
            ftp.delete('/' + name)
            removed += 1
        else:
            # A manual edit is no longer ours to delete; forget ownership.
            retained += 1
    atomic_upload(ftp, MANIFEST, json_bytes({
        'schema': 1, 'target': EXPECTED_TARGET, 'files': current,
    }))
    return {'uploaded': len(artifact), 'removed': removed, 'retained': retained}


def connect_from_environment():
    names = ['NIC_FTP_HOST', 'NIC_FTP_USER', 'NIC_FTP_PASSWORD', 'NIC_FTP_TLS_NAME']
    if any(not os.environ.get(name) for name in names):
        raise DeployError('Required NIC_FTP_HOST/USER/PASSWORD/TLS_NAME environment is incomplete')
    ftp = ftplib.FTP_TLS(context=ssl.create_default_context(), timeout=60)
    ftp.connect(os.environ['NIC_FTP_HOST'], 21)
    # Connect to the FTP endpoint, but authenticate the certificate's DNS name.
    ftp.host = os.environ['NIC_FTP_TLS_NAME']
    ftp.auth()
    ftp.login(os.environ['NIC_FTP_USER'], os.environ['NIC_FTP_PASSWORD'])
    ftp.prot_p()
    return ftp


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dist', default='dist', help='Local static artifact directory')
    parser.add_argument('--initialize', action='store_true', help='Create marker only; requires an empty FTP root')
    args = parser.parse_args()
    # Check the artifact before logging in, except for explicit initialization.
    artifact = None if args.initialize else local_artifact(args.dist)
    ftp = connect_from_environment()
    try:
        if args.initialize:
            initialize(ftp)
            print('Initialized the jks.ooo target marker; no site files uploaded.')
        else:
            print(json.dumps(deploy(ftp, artifact), sort_keys=True))
    finally:
        try:
            ftp.quit()
        except ftplib.all_errors:
            ftp.close()


if __name__ == '__main__':
    try:
        main()
    except (DeployError, OSError, ftplib.Error) as error:
        # Do not include login commands, credentials or arbitrary FTP server text.
        detail = str(error) if isinstance(error, DeployError) else 'Check target, permissions, TLS and the local artifact.'
        print(f'Deployment failed ({type(error).__name__}): {detail}', file=sys.stderr)
        sys.exit(1)
