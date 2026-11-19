#!/usr/bin/env python3
"""Deploy real temporary Git releases into fixtures; Docker is isolated behind a stub."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / 'update-ui.sh'
CORE = (
    'data/web/inc/twig.inc.php', 'data/web/inc/triggers.admin.inc.php',
    'data/web/json_api.php', 'data/web/api/openapi.yaml',
    'data/web/js/site/mailbox.js', 'data/web/templates/admin.twig',
    'data/web/templates/base.twig',
)
AUTOLOAD = (
    'data/web/inc/lib/composer.json',
    'data/web/inc/lib/vendor/composer/autoload_psr4.php',
    'data/web/inc/lib/vendor/composer/autoload_static.php',
)
PACKAGE = (
    'data/web/inc/lib/mailcow/Mailbox/MailboxSearchScope.php',
    'data/web/inc/lib/mailcow/Ui/Branding.php',
    'data/web/inc/lib/mailcow/Ui/OverviewStats.php',
    'data/web/ui/plates/presentation.php',
    'data/web/ui/plates/assets/plates.css',
)
SHARED = 'data/web/templates/user_index.twig'


def write(root, name, content):
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)


class UpdateUiTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='ui-deploy-test-')
        self.addCleanup(self.temporary.cleanup)
        self.folder = Path(self.temporary.name)
        self.source = self.folder / 'source repo'
        self.target = self.folder / 'live instance'
        self.source.mkdir()
        self.target.mkdir()
        for name in CORE + AUTOLOAD + (SHARED,):
            write(self.source, name, 'original ' + name + '\n')
            write(self.target, name, 'original ' + name + '\n')
        (self.target / CORE[0]).chmod(0o640)
        write(self.target, 'mailcow.conf', 'LIVE_CONFIG=preserved\n')
        write(self.target, 'docker-compose.yml', 'live compose\n')
        write(self.target, 'data/web/inc/vars.local.inc.php', 'local branding\n')
        write(self.target, 'data/web/unrelated.txt', 'keep\n')
        self.git('init', '-q', '-b', 'master')
        self.git('config', 'user.email', 'test@example.invalid')
        self.git('config', 'user.name', 'UI deployment tests')
        self.commit('stock baseline')
        self.base = self.git('rev-parse', 'HEAD')
        for name in CORE + PACKAGE:
            write(self.source, name, '<?php // UI release 1\n' if name.endswith('.php') else 'UI release 1\n')
        self.manifest()
        self.commit('custom UI')
        self.bin = self.folder / 'bin'
        self.bin.mkdir()
        docker = self.bin / 'docker'
        docker.write_text('''#!/usr/bin/env python3
import json, os, pathlib, signal, sys
args = sys.argv[1:]
root = pathlib.Path(os.environ['MOCK_ROOT'])
with open(os.environ['MOCK_LOG'], 'a') as log: log.write(json.dumps(args) + '\\n')
if args[:2] == ['compose', 'version']: print('Compose fixture'); sys.exit(0)
if args[:2] == ['compose', 'ps']: print('php-container'); sys.exit(0)
if args and args[0] == 'inspect':
 print(json.dumps([{'Type': 'bind', 'Destination': '/web', 'Source': str(root / ('wrong' if os.environ.get('WRONG_MOUNT') else 'data/web'))}]))
 sys.exit(0)
if args[:2] == ['compose', 'exec']:
 data = sys.stdin.buffer.read() if '-l' in args else b''
 if os.environ.get('FAIL_LINT') and '-l' in args: sys.exit(1)
 if os.environ.get('FAIL_CLASSES') and '-r' in args: sys.exit(1)
 sys.exit(0)
if args[:2] == ['compose', 'restart']:
 marker = root / '.mock-restart-failed'
 if os.environ.get('INTERRUPT_RESTART') and not marker.exists():
  marker.touch(); os.kill(os.getppid(), signal.SIGTERM); sys.exit(0)
 if os.environ.get('FAIL_RESTART') and not marker.exists():
  marker.touch(); print('restart failed', file=sys.stderr); sys.exit(1)
 sys.exit(0)
print('unexpected Docker call', args, file=sys.stderr); sys.exit(1)
''')
        docker.chmod(0o755)
        self.temp_root = self.folder / 'downloads'
        self.temp_root.mkdir()
        self.log = self.folder / 'docker.jsonl'
        self.env = dict(os.environ, PATH=str(self.bin) + os.pathsep + os.environ['PATH'],
                        TMPDIR=str(self.temp_root), MOCK_ROOT=str(self.target), MOCK_LOG=str(self.log))

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.source), *args], text=True).strip()

    def commit(self, message):
        self.git('add', '.')
        self.git('commit', '-qm', message)

    def manifest(self):
        self.dependencies = {name: hashlib.sha256((self.source / name).read_bytes()).hexdigest()
                             for name in CORE + (SHARED,)}
        write(self.source, 'data/web/ui/plates/compatibility.json',
              json.dumps({'reviewed_base': self.base, 'sha256': self.dependencies}))

    def deploy(self, *args, **environment):
        result = subprocess.run(['bash', str(SCRIPT), '--target', str(self.target),
                                 '--repo', self.source.as_uri(), *args],
                                env=dict(self.env, **environment), text=True, capture_output=True)
        self.assertEqual(list(self.temp_root.iterdir()), [], 'temporary checkout leaked')
        return result

    def snapshot(self):
        return {str(path.relative_to(self.target)): path.read_bytes()
                for path in (self.target / 'data').rglob('*') if path.is_file()}

    def backups(self):
        parent = self.target / 'ui-backups'
        return sorted(parent.iterdir()) if parent.exists() else []

    def commands(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()]

    def test_install_backup_and_manual_restore(self):
        original = self.snapshot()
        result = self.deploy()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.target / CORE[0]).read_bytes(), (self.source / CORE[0]).read_bytes())
        self.assertEqual((self.target / CORE[0]).stat().st_mode & 0o777, 0o640)
        self.assertEqual((self.target / 'mailcow.conf').read_text(), 'LIVE_CONFIG=preserved\n')
        self.assertEqual((self.target / 'data/web/unrelated.txt').read_text(), 'keep\n')
        self.assertEqual((self.target / 'data/web/inc/vars.local.inc.php').read_text(), 'local branding\n')
        backup = self.backups()[0]
        self.assertEqual(backup.stat().st_mode & 0o777, 0o700)
        self.assertEqual((backup / 'files' / CORE[0]).read_bytes(), original[CORE[0]])
        result = self.deploy('--restore', str(backup))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.snapshot(), original)
        self.assertFalse((self.target / '.plates-ui-state.json').exists())
        self.assertEqual(len(self.backups()), 2)

    def test_check_does_not_write_ui_or_restart(self):
        original = self.snapshot()
        result = self.deploy('--check')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.snapshot(), original)
        self.assertEqual(self.backups(), [])
        self.assertFalse(any(command[:2] == ['compose', 'restart'] for command in self.commands()))

    def test_new_web_directories_are_readable_with_restrictive_umask(self):
        before = os.umask(0o077)
        try:
            result = self.deploy()
        finally:
            os.umask(before)
        self.assertEqual(result.returncode, 0, result.stderr)
        for name in ('data/web/ui', 'data/web/ui/plates', 'data/web/inc/lib/mailcow/Ui'):
            self.assertEqual((self.target / name).stat().st_mode & 0o777, 0o755)
        self.assertEqual((self.target / PACKAGE[-1]).stat().st_mode & 0o777, 0o644)

    def test_repeat_and_upgrade_remove_only_retired_managed_files(self):
        self.assertEqual(self.deploy().returncode, 0)
        self.assertEqual(self.deploy().returncode, 0)
        write(self.target, 'data/web/ui/plates/local.txt', 'user-owned\n')
        retired = 'data/web/ui/plates/assets/plates.css'
        (self.source / retired).unlink()
        write(self.source, CORE[0], '<?php // UI release 2\n')
        self.manifest()
        self.commit('UI release 2')
        result = self.deploy()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.target / retired).exists())
        self.assertEqual((self.target / 'data/web/ui/plates/local.txt').read_text(), 'user-owned\n')

    def test_conflicting_mailcow_version_is_rejected(self):
        write(self.target, SHARED, 'different Mailcow version\n')
        original = self.snapshot()
        result = self.deploy()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Compatibility review required', result.stderr)
        self.assertEqual(self.snapshot(), original)
        self.assertEqual(self.backups(), [])

    def test_source_without_ui_is_rejected(self):
        self.git('tag', 'stock', self.base)
        result = self.deploy('--ref', 'stock')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Commit and push', result.stderr)
        self.assertEqual(self.backups(), [])

    def test_restart_failure_restores_files_and_restarts_again(self):
        original = self.snapshot()
        result = self.deploy(FAIL_RESTART='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Previous UI restored', result.stderr)
        self.assertEqual(self.snapshot(), original)
        self.assertEqual(len(self.backups()), 1)
        self.assertEqual(sum(command[:2] == ['compose', 'restart'] for command in self.commands()), 2)

    def test_class_loading_failure_rolls_back(self):
        original = self.snapshot()
        result = self.deploy(FAIL_CLASSES='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.snapshot(), original)
        self.assertIn('Previous UI restored', result.stderr)

    def test_interrupt_rolls_back_and_removes_temporary_checkout(self):
        original = self.snapshot()
        result = self.deploy(INTERRUPT_RESTART='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Previous UI restored', result.stderr)
        self.assertEqual(self.snapshot(), original)

    def test_rollback_of_failed_upgrade_preserves_previous_deployment_state(self):
        self.assertEqual(self.deploy().returncode, 0)
        original = self.snapshot()
        state = (self.target / '.plates-ui-state.json').read_bytes()
        write(self.source, CORE[0], '<?php // second release\n')
        self.manifest()
        self.commit('second release')
        result = self.deploy(FAIL_RESTART='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.snapshot(), original)
        self.assertEqual((self.target / '.plates-ui-state.json').read_bytes(), state)

    def test_corrupt_backup_is_rejected_before_manual_restore(self):
        self.assertEqual(self.deploy().returncode, 0)
        original = self.snapshot()
        backup = self.backups()[0]
        (backup / 'files' / CORE[0]).write_text('corrupt\n')
        result = self.deploy('--restore', str(backup))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Backup verification failed', result.stderr)
        self.assertEqual(self.snapshot(), original)

    def test_php_syntax_failure_is_before_backup_or_install(self):
        original = self.snapshot()
        result = self.deploy(FAIL_LINT='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.snapshot(), original)
        self.assertEqual(self.backups(), [])

    def test_local_edits_to_installed_ui_are_not_overwritten(self):
        self.assertEqual(self.deploy().returncode, 0)
        write(self.target, PACKAGE[-1], 'local edits\n')
        result = self.deploy()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(PACKAGE[-1], result.stderr)
        self.assertEqual((self.target / PACKAGE[-1]).read_text(), 'local edits\n')
        self.assertEqual(len(self.backups()), 1)

    def test_symlink_cannot_redirect_installation(self):
        outside = self.folder / 'outside'
        outside.write_text('untouched\n')
        (self.target / CORE[0]).unlink()
        (self.target / CORE[0]).symlink_to(outside)
        result = self.deploy()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('symlink', result.stderr)
        self.assertEqual(outside.read_text(), 'untouched\n')

    def test_wrong_running_mount_is_rejected(self):
        result = self.deploy(WRONG_MOUNT='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('does not mount', result.stderr)
        self.assertEqual(self.backups(), [])

    def test_backup_cannot_be_web_accessible(self):
        result = self.deploy('--backup-dir', str(self.target / 'data/web/backups'))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('outside the web root', result.stderr)

    def test_default_backup_symlink_cannot_expose_backups(self):
        (self.target / 'ui-backups').symlink_to(self.target / 'data/web')
        result = self.deploy()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('outside the web root', result.stderr)

    def test_instance_lock_prevents_parallel_updates(self):
        with (self.target / '.update-ui.lock').open('w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = self.deploy()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('already running', result.stderr)

    def test_unreviewed_source_is_rejected(self):
        write(self.source, CORE[0], 'unreviewed edit\n')
        self.commit('unreviewed')
        result = self.deploy()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Unreviewed source dependency', result.stderr)
        self.assertEqual(self.backups(), [])

    def test_update_does_not_accept_old_versions_of_undeployed_dependencies(self):
        self.assertEqual(self.deploy().returncode, 0)
        write(self.source, SHARED, 'new backend contract\n')
        self.manifest()
        self.commit('new backend required')
        result = self.deploy()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(SHARED, result.stderr)
        self.assertEqual(len(self.backups()), 1)


if __name__ == '__main__':
    unittest.main()
