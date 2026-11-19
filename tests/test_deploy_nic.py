"""Isolated FTPS deployment tests. No network calls or real credentials."""
import ftplib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('deploy_nic', Path(__file__).resolve().parents[1] / 'scripts' / 'deploy-nic.py')
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


class FakeFTP:
    def __init__(self):
        self.files = {}
        self.directories = {''}
        self.events = []
        self.fail_destination = None

    @staticmethod
    def clean(name):
        return name.strip('/')

    def cwd(self, path):
        if path != '/':
            raise AssertionError('Deployment must stay rooted at /')

    def mlsd(self, path='/'):
        directory = self.clean(path)
        prefix = directory + '/' if directory else ''
        rows = [('.', {'type': 'cdir'}), ('..', {'type': 'pdir'})]
        for name in self.directories:
            if name.startswith(prefix) and name != directory and '/' not in name[len(prefix):]:
                rows.append((name[len(prefix):], {'type': 'dir'}))
        for name in self.files:
            if name.startswith(prefix) and '/' not in name[len(prefix):]:
                rows.append((name[len(prefix):], {'type': 'file'}))
        return rows

    def retrbinary(self, command, callback):
        name = self.clean(command.removeprefix('RETR '))
        if name not in self.files:
            raise ftplib.error_perm('550 Missing')
        callback(self.files[name])

    def storbinary(self, command, stream):
        name = self.clean(command.removeprefix('STOR '))
        self.files[name] = stream.read()
        self.events.append(('store', name))

    def rename(self, old, new):
        old, new = self.clean(old), self.clean(new)
        if new == self.fail_destination:
            raise OSError('Simulated interrupted upload')
        self.files[new] = self.files.pop(old)
        self.events.append(('rename', new))

    def delete(self, name):
        name = self.clean(name)
        del self.files[name]
        self.events.append(('delete', name))

    def mkd(self, name):
        self.directories.add(self.clean(name))
        self.events.append(('mkdir', self.clean(name)))


class DeploymentTests(unittest.TestCase):
    def initialized(self):
        ftp = FakeFTP()
        deploy.initialize(ftp)
        return ftp

    def test_initialize_requires_completely_empty_root_including_dotfiles(self):
        for existing in ['index.php', '.htaccess', '.hidden']:
            ftp = FakeFTP()
            ftp.files[existing] = b'untouched'
            with self.assertRaises(deploy.DeployError):
                deploy.initialize(ftp)
            self.assertEqual(ftp.events, [])
        ftp = FakeFTP()
        ftp.directories.add('old')
        with self.assertRaises(deploy.DeployError):
            deploy.initialize(ftp)
        ftp = self.initialized()
        self.assertEqual(json.loads(ftp.files[deploy.MARKER]), deploy.EXPECTED_TARGET)
        self.assertEqual(set(ftp.files), {deploy.MARKER})

    def test_missing_or_wrong_marker_cannot_publish(self):
        for marker in [None, {'domain': 'other.example'}, {**deploy.EXPECTED_TARGET, 'webroot': '/wrong'}]:
            ftp = FakeFTP()
            if marker is not None:
                ftp.files[deploy.MARKER] = deploy.json_bytes(marker)
            with self.assertRaises(deploy.DeployError):
                deploy.deploy(ftp, {'index.html': b'new'})
            self.assertEqual(ftp.events, [])

    def test_rejects_traversal_private_files_and_ftp_command_injection(self):
        for name in ['../x', '/x', 'a/../x', 'a//x', 'a\\x', 'C:/x', '.env', '.git/config', '.jks-deploy-target.json', 'x\r\nDELE /index.html']:
            ftp = self.initialized()
            ftp.events.clear()
            with self.assertRaises(deploy.DeployError, msg=name):
                deploy.deploy(ftp, {'index.html': b'new', name: b'bad'})
            self.assertEqual(ftp.events, [])

    def test_assets_before_html_htaccess_last_and_unique_atomic_uploads(self):
        ftp = self.initialized()
        artifact = {'index.html': b'home', 'about/index.html': b'about', '_astro/site.abc.js': b'js', 'logo.svg': b'svg', '.htaccess': b'rules'}
        result = deploy.deploy(ftp, artifact)
        published = [name for event, name in ftp.events if event == 'rename' and name not in (deploy.MARKER, deploy.MANIFEST)]
        self.assertEqual(published, ['_astro/site.abc.js', 'logo.svg', 'about/index.html', 'index.html', '.htaccess'])
        temporary = [name for event, name in ftp.events if event == 'store']
        self.assertTrue(all('.jks-upload-' in name for name in temporary))
        self.assertEqual(len(temporary), len(set(temporary)))
        self.assertFalse(any('.jks-upload-' in name for name in ftp.files))
        self.assertEqual(result['uploaded'], len(artifact))
        self.assertEqual(json.loads(ftp.files[deploy.MANIFEST])['files']['index.html'], deploy.digest(b'home'))

    def test_stale_owned_routes_removed_foreign_files_and_cached_assets_retained(self):
        ftp = self.initialized()
        deploy.deploy(ftp, {'index.html': b'old', 'old/index.html': b'old route', '_astro/old.abc.js': b'cached', 'manual.txt': b'old manual'})
        ftp.files['manual.txt'] = b'edited outside deployment'
        ftp.files['foreign.txt'] = b'not ours'
        result = deploy.deploy(ftp, {'index.html': b'new', '_astro/new.xyz.js': b'new'})
        self.assertNotIn('old/index.html', ftp.files)
        self.assertEqual(ftp.files['foreign.txt'], b'not ours')
        self.assertEqual(ftp.files['manual.txt'], b'edited outside deployment')
        self.assertEqual(ftp.files['_astro/old.abc.js'], b'cached')
        owned = json.loads(ftp.files[deploy.MANIFEST])['files']
        self.assertIn('_astro/old.abc.js', owned)
        self.assertNotIn('manual.txt', owned)
        self.assertEqual(result['removed'], 1)

    def test_unmanaged_file_collision_refused_before_any_write(self):
        ftp = self.initialized()
        deploy.deploy(ftp, {'index.html': b'old'})
        ftp.files['foreign.txt'] = b'original'
        ftp.events.clear()
        with self.assertRaises(deploy.DeployError):
            deploy.deploy(ftp, {'index.html': b'new', 'foreign.txt': b'overwrite'})
        self.assertEqual(ftp.events, [])
        self.assertEqual(ftp.files['index.html'], b'old')

    def test_corrupt_manifest_cannot_authorize_traversing_deletion(self):
        ftp = self.initialized()
        ftp.files[deploy.MANIFEST] = deploy.json_bytes({
            'schema': 1, 'target': deploy.EXPECTED_TARGET,
            'files': {'../outside.txt': deploy.digest(b'outside')},
        })
        ftp.events.clear()
        with self.assertRaises(deploy.DeployError):
            deploy.deploy(ftp, {'index.html': b'new'})
        self.assertEqual(ftp.events, [])

    def test_remote_file_directory_collision_and_links_abort_before_write(self):
        ftp = self.initialized()
        deploy.deploy(ftp, {'index.html': b'old'})
        ftp.files['about'] = b'foreign file'
        ftp.events.clear()
        with self.assertRaises(deploy.DeployError):
            deploy.deploy(ftp, {'index.html': b'new', 'about/index.html': b'about'})
        self.assertEqual(ftp.events, [])
        ftp = self.initialized()
        original = ftp.mlsd
        ftp.mlsd = lambda path='/': [*original(path), ('outside', {'type': 'OS.unix=slink'})]
        with self.assertRaises(deploy.DeployError):
            deploy.deploy(ftp, {'index.html': b'new'})

    def test_unavailable_complete_listing_never_initializes(self):
        ftp = FakeFTP()
        def unsupported(path='/'):
            raise ftplib.error_perm('500 MLSD unavailable')
        ftp.mlsd = unsupported
        with self.assertRaises(deploy.DeployError):
            deploy.initialize(ftp)
        self.assertEqual(ftp.files, {})

    def test_failed_upload_can_resume_using_durable_write_manifest(self):
        ftp = self.initialized()
        artifact = {'_astro/new.abc.js': b'asset', 'index.html': b'home'}
        ftp.fail_destination = 'index.html'
        with self.assertRaises(OSError):
            deploy.deploy(ftp, artifact)
        self.assertEqual(ftp.files['_astro/new.abc.js'], b'asset')
        self.assertFalse(any('.jks-upload-' in name for name in ftp.files))
        ftp.fail_destination = None
        deploy.deploy(ftp, artifact)
        self.assertEqual(ftp.files['index.html'], b'home')

    def test_local_artifact_requires_index_and_blocks_private_files(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            with self.assertRaises(deploy.DeployError):
                deploy.local_artifact(root)
            (root / 'index.html').write_bytes(b'home')
            self.assertEqual(deploy.local_artifact(root), {'index.html': b'home'})
            (root / '.env').write_text('private')
            with self.assertRaises(deploy.DeployError):
                deploy.local_artifact(root)

    def test_public_php_endpoint_allowed_but_private_runtime_files_blocked(self):
        ftp = self.initialized()
        artifact = {'index.html': b'home', **{name: b'<?php /* public code */' for name in deploy.PUBLIC_PHP_FILES}}
        deploy.deploy(ftp, artifact)
        self.assertEqual(ftp.files['api/admin.php'], artifact['api/admin.php'])
        for name in ['config.php', 'api/config.php', 'config.json', 'api/credentials.json',
                     'users.json', 'api/admin.php.bak', 'api/unknown.php', 'uploads/test.phtml', 'archive.sql',
                     'sessions.sqlite', '../.jks-admin/config.php', '.jks-admin/config.php']:
            with self.assertRaises(deploy.DeployError, msg=name):
                deploy.valid_path(name)

    def test_explicit_tls_uses_expected_hostname_and_protects_data_channel(self):
        env = {'NIC_FTP_HOST': 'ftp.jksooo.nichost.ru', 'NIC_FTP_TLS_NAME': 'jksooo.nichost.ru', 'NIC_FTP_USER': 'fake', 'NIC_FTP_PASSWORD': 'fake'}
        with patch.dict('os.environ', env), patch.object(deploy.ftplib, 'FTP_TLS') as ctor:
            ftp = ctor.return_value
            deploy.connect_from_environment()
            ftp.connect.assert_called_once_with('ftp.jksooo.nichost.ru', 21)
            self.assertEqual(ftp.host, 'jksooo.nichost.ru')
            ftp.auth.assert_called_once_with()
            ftp.login.assert_called_once_with('fake', 'fake')
            ftp.prot_p.assert_called_once_with()
            self.assertTrue(ctor.call_args.kwargs['context'].check_hostname)


if __name__ == '__main__':
    unittest.main()
