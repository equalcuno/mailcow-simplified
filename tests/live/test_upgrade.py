#!/usr/bin/env python3
"""Fault-inject the full upgrade transaction against real temporary Git/files/archives.

Docker and firewall operations are isolated doubles; no host services are changed.
"""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('upgrade_worker', ROOT / 'helper-scripts/upgrade_worker.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args], text=True).strip()


class Guard:
    events = []
    fail_release = False
    active = False
    def __init__(self, *args): pass
    def block(self): self.events.append('block'); Guard.active = True
    def release(self):
        self.events.append('release')
        if Guard.fail_release:
            Guard.fail_release = False
            raise worker.UpgradeError('Injected guard cleanup failure')
        Guard.active = False


class FixtureEngine(worker.Engine):
    def __init__(self, config, volume, failure=None):
        self.volume, self.failure, self.operations, self.health_calls = volume, failure, [], 0
        super().__init__(config, runner=self.fake_run)

    def preflight(self, readonly=False):
        self.load_environment()
        self.backups.mkdir(exist_ok=True)
        self.state.mkdir(exist_ok=True)

    def ensure_recovery_service(self, source): pass

    def capture(self):
        old = json.loads((self.root / 'docker-compose.yml').read_text())
        client = self.env['WEBMAIL_CLIENT']
        images = {name: 'sha256:' + 'a'*64 for name, service in old['services'].items()
                  if not service.get('profiles') or client in service['profiles']}
        return ([{'Id': name} for name in images], {'fixture_vmail': {'file': 'volume-fixture_vmail.tar'}},
                images, 'br-mailcow', ['iptables'], old)

    def fake_run(self, arguments, **kwargs):
        self.operations.append(arguments)
        if arguments[0] in ('git', 'bash'): return worker.execute(arguments, **kwargs)
        output = ''
        if arguments[0] == 'du': output = '1\tfixture'
        elif arguments[0] == 'tar':
            if '-cpf' in arguments:
                path = Path(arguments[arguments.index('-cpf')+1])
                with tarfile.open(path, 'w') as archive:
                    def retain(info):
                        return None if any(part in ('.git', '.update-ui.lock') for part in Path(info.name).parts) else info
                    archive.add(self.root, arcname='.', filter=retain)
            else:
                with tarfile.open(arguments[arguments.index('-xpf')+1]) as archive:
                    selected = arguments[arguments.index('-C')+2:]
                    archive.extractall(self.root, members=[archive.getmember(name) for name in selected] if selected else None)
        elif arguments[:3] == ['docker', 'image', 'inspect']: output = '[{"Size":1}]'
        elif arguments[:2] == ['docker', 'info']: output = 'fixture-daemon' if '{{.ID}}' in arguments else str(self.root)
        elif arguments[:3] == ['docker', 'image', 'save']:
            Path(arguments[arguments.index('-o')+1]).write_bytes(b'previous images')
        elif arguments[:2] == ['docker', 'volume']: output = '[{}]'
        elif arguments[:2] == ['docker', 'compose']:
            if 'config' in arguments:
                source = Path(arguments[arguments.index('-f')+1])
                output = source.read_text()
            elif 'pull' in arguments and self.failure == 'pull':
                raise worker.UpgradeError('Injected registry failure')
            elif 'up' in arguments and self.job['phase'] != 'restoring':
                self.assert_guarded()
                self.volume.write_text('candidate runtime data')
                if self.failure == 'start':
                    self.failure = None
                    raise worker.UpgradeError('Injected candidate startup failure')
        return subprocess.CompletedProcess(arguments, 0, output, '')

    def assert_guarded(self):
        if not Guard.active: raise AssertionError('Application started without the traffic guard')

    def stop_all(self): self.operations.append(['stop-all']); self.assert_guarded()

    def volume_tool(self, name, script, *arguments, readonly=True):
        if script.startswith('du'): return str(self.volume.stat().st_size)
        if self.failure == 'backup': raise worker.UpgradeError('Injected backup failure')
        path = Path(self.job['backup']) / arguments[0]
        if readonly:
            with tarfile.open(path, 'w') as archive: archive.add(self.volume, arcname='mail')
        else:
            self.operations.append(['restore-volume'])
            self.assert_guarded()
            with tarfile.open(path) as archive: self.volume.write_bytes(archive.extractfile('mail').read())

    def health(self, expected):
        self.assert_guarded()
        self.health_calls += 1
        if self.failure in ('health', 'rollback-health') and self.health_calls == 1:
            raise worker.UpgradeError('Injected unhealthy release')
        if self.failure == 'rollback-health' and self.job['phase'] == 'restoring':
            raise worker.UpgradeError('Injected recovery failure')
        if self.job['phase'] == 'restoring':
            assert (self.root / 'application.txt').read_text() == 'old code'
            assert self.volume.read_text() == 'old mail'


class TransactionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='upgrade-transaction-')
        self.addCleanup(self.temporary.cleanup)
        self.folder = Path(self.temporary.name)
        self.source = self.folder / 'source'
        self.source.mkdir()
        config = {'services': {'nginx-mailcow': {}, 'php-fpm-mailcow': {}, 'sogo-mailcow': {'profiles': ['sogo']},
                              'roundcube-mailcow': {'profiles': ['roundcube']}},
                  'networks': {'mailcow-network': {'ipam': {'config': [{'subnet': '172.22.1.0/24'}]}}}}
        (self.source / 'docker-compose.yml').write_text(json.dumps(config))
        (self.source / 'application.txt').write_text('old code')
        (self.source / 'data/conf/postfix').mkdir(parents=True)
        (self.source / 'data/conf/postfix/main.cf').write_text('relayhost =\n')
        (self.source / 'data/web/templates').mkdir(parents=True)
        (self.source / 'data/web/templates/base.twig').write_bytes(b'header\nbody\nfooter\n')
        (self.source / '.gitignore').write_text('mailcow.conf\n.update-ui.lock\n')
        git(self.source, 'init', '-q', '-b', 'master')
        git(self.source, 'config', 'user.name', 'Upgrade fixtures')
        git(self.source, 'config', 'user.email', 'fixture@example.invalid')
        git(self.source, 'add', '.')
        git(self.source, 'commit', '-qm', 'old release')
        self.old = git(self.source, 'rev-parse', 'HEAD')
        (self.source / 'application.txt').write_text('new code')
        git(self.source, 'commit', '-qam', 'new release')
        self.target = self.folder / 'instance'
        subprocess.run(['git', 'clone', '-q', str(self.source), str(self.target)], check=True)
        git(self.target, 'config', 'user.name', 'Upgrade fixtures')
        git(self.target, 'config', 'user.email', 'fixture@example.invalid')
        git(self.target, 'reset', '--hard', self.old)
        (self.target / 'mailcow.conf').write_text('COMPOSE_PROJECT_NAME=fixture\nWEBMAIL_CLIENT=sogo\nSKIP_SOGO=n\nCOMPOSE_PROFILES=sogo\nROUNDCUBE_DES_KEY=abcdefghijklmnopqrstuvwx\n')
        self.volume = self.folder / 'mail'
        self.volume.write_text('old mail')
        self.config = {'target': str(self.target), 'backup_dir': str(self.folder / 'backups'),
                       'state_dir': str(self.folder / 'state'), 'reserve_bytes': 0}
        Guard.events, Guard.active, Guard.fail_release = [], False, False
        self.guard = patch.object(worker, 'Firewall', Guard)
        self.guard.start(); self.addCleanup(self.guard.stop)
        handlers = {sig: signal.getsignal(sig) for sig in (signal.SIGINT, signal.SIGTERM)}
        self.addCleanup(lambda: [signal.signal(sig, handler) for sig, handler in handlers.items()])

    def engine(self, failure=None): return FixtureEngine(self.config, self.volume, failure)

    def test_success_has_verified_backups_and_opens_only_after_health_checks(self):
        engine = self.engine(); engine.upgrade(self.source)
        self.assertEqual(engine.job['phase'], 'complete')
        self.assertTrue(engine.job['committed'])
        self.assertEqual(engine.health_calls, 2)
        self.assertFalse(Guard.active)
        self.assertIn('WEBMAIL_CLIENT=roundcube', (self.target / 'mailcow.conf').read_text())
        self.assertEqual(self.volume.read_text(), 'candidate runtime data')
        engine.verify_backup()
        self.assertTrue((Path(engine.job['backup']) / 'recover.py').is_file())

    def test_skip_roundcube_keeps_sogo(self):
        engine = self.engine(); engine.upgrade(self.source, mode='preserve')
        self.assertIn('WEBMAIL_CLIENT=sogo', (self.target / 'mailcow.conf').read_text())
        self.assertIn('COMPOSE_PROFILES=sogo', (self.target / 'mailcow.conf').read_text())
        self.assertIn('SKIP_SOGO=n', (self.target / 'mailcow.conf').read_text())

    def test_regress_sogo_is_a_forward_upgrade_without_deleting_data(self):
        content = (self.target / 'mailcow.conf').read_text().replace('WEBMAIL_CLIENT=sogo', 'WEBMAIL_CLIENT=roundcube')
        (self.target / 'mailcow.conf').write_text(content)
        engine = self.engine(); engine.upgrade(self.source, mode='sogo')
        self.assertEqual((self.target / 'application.txt').read_text(), 'new code')
        self.assertIn('WEBMAIL_CLIENT=sogo', (self.target / 'mailcow.conf').read_text())
        self.assertTrue((Path(engine.job['backup']) / 'volume-fixture_vmail.tar').exists())

    def test_check_never_stops_or_replaces_application_files(self):
        engine = self.engine(); engine.upgrade(self.source, check=True)
        self.assertEqual((self.target / 'application.txt').read_text(), 'old code')
        self.assertEqual(self.volume.read_text(), 'old mail')
        self.assertFalse(Guard.events)
        self.assertFalse(any(args == ['stop-all'] for args in engine.operations))

    def test_registry_failure_happens_before_maintenance(self):
        engine = self.engine('pull')
        with self.assertRaises(worker.UpgradeError): engine.upgrade(self.source)
        self.assertEqual(engine.job['phase'], 'failed')
        self.assertEqual(self.volume.read_text(), 'old mail')
        self.assertFalse(Guard.events)

    def test_diverged_application_changes_fail_with_actionable_error_before_maintenance(self):
        (self.target / 'application.txt').write_text('custom code')
        git(self.target, 'commit', '-qam', 'Local changes')
        engine = self.engine()
        with self.assertRaisesRegex(worker.UpgradeError, 'Unreviewed local/newer-upstream changes: application.txt'):
            engine.upgrade(self.source)
        self.assertFalse(Guard.events)
        self.assertEqual((self.target / 'application.txt').read_text(), 'custom code')

    def legacy_installation(self):
        template = 'data/web/templates/base.twig'
        asset = 'data/web/ui/plates/assets/fixture.woff2'
        (self.source / template).write_bytes(b'ui header\nbody\nfooter\n')
        (self.source / asset).parent.mkdir(parents=True)
        (self.source / asset).write_bytes(bytes(range(256)))
        (self.source / 'upgrade.sh').write_text('#!/bin/bash\necho new upgrader\n')
        git(self.source, 'add', '.'); git(self.source, 'commit', '-qm', 'Legacy UI package')
        previous = git(self.source, 'rev-parse', 'HEAD')
        files = {name: worker.sha256(self.source / name) for name in (template, asset)}
        (self.target / template).write_bytes((self.source / template).read_bytes())
        (self.target / 'data/conf/postfix/main.cf').write_text('relayhost = private.example\n')
        git(self.target, 'add', '.'); git(self.target, 'commit', '-qm', 'Before update on fixture')
        (self.target / asset).parent.mkdir(parents=True)
        (self.target / asset).write_bytes((self.source / asset).read_bytes())
        (self.target / 'upgrade.sh').write_text('#!/bin/bash\necho old stock updater\n')
        (self.target / '.plates-ui-state.json').write_text(json.dumps({'version': 1, 'commit': previous, 'files': files}))
        (self.source / template).write_bytes(b'new ui header\nbody\nfooter\n')
        git(self.source, 'commit', '-qam', 'Current UI package')
        return template, asset

    def test_legacy_ui_and_stock_update_commits_are_adopted_with_instance_configuration(self):
        template, asset = self.legacy_installation()
        engine = self.engine(); engine.upgrade(self.source)
        self.assertEqual(engine.job['phase'], 'complete')
        self.assertEqual((self.target / template).read_bytes(), (self.source / template).read_bytes())
        self.assertEqual((self.target / 'data/conf/postfix/main.cf').read_text(), 'relayhost = private.example\n')
        self.assertIn(asset, git(self.target, 'ls-files'))
        self.assertEqual(git(self.target, 'status', '--porcelain', '--untracked-files=no'), '')
        self.assertNotEqual(engine.job['commit'], engine.job['deployed_commit'])
        with tarfile.open(Path(engine.job['backup']) / 'files.tar') as archive:
            self.assertIn(b'old stock updater', archive.extractfile('./upgrade.sh').read())
        # Preserved configuration remains eligible for subsequent releases.
        engine.upgrade(self.source, check=True)

    def test_legacy_ui_failure_restores_untracked_files_and_local_configuration(self):
        template, asset = self.legacy_installation()
        original = git(self.target, 'rev-parse', 'HEAD')
        engine = self.engine('health')
        with self.assertRaises(worker.UpgradeError): engine.upgrade(self.source)
        self.assertEqual(engine.job['phase'], 'rolled_back')
        self.assertEqual(git(self.target, 'rev-parse', 'HEAD'), original)
        self.assertIn('old stock updater', (self.target / 'upgrade.sh').read_text())
        self.assertEqual((self.target / template).read_bytes(), b'ui header\nbody\nfooter\n')
        self.assertEqual((self.target / 'data/conf/postfix/main.cf').read_text(), 'relayhost = private.example\n')
        self.assertNotIn(asset, git(self.target, 'ls-files'))

    def test_modified_untracked_legacy_asset_is_not_silently_replaced(self):
        _, asset = self.legacy_installation()
        (self.target / asset).write_bytes(b'personal asset')
        engine = self.engine()
        with self.assertRaisesRegex(worker.UpgradeError, 'Untracked files conflict'):
            engine.upgrade(self.source)
        self.assertFalse(Guard.events)
        self.assertEqual((self.target / asset).read_bytes(), b'personal asset')

    def test_upstream_merge_of_known_legacy_ui_is_recognized(self):
        template = 'data/web/templates/base.twig'
        (self.source / template).write_bytes(b'ui header\nbody\nfooter\n')
        git(self.source, 'commit', '-qam', 'Known legacy UI')
        previous = git(self.source, 'rev-parse', 'HEAD')
        expected = worker.sha256(self.source / template)
        git(self.source, 'checkout', '--detach', self.old)
        (self.source / template).write_bytes(b'header\nbody\nupstream footer\n')
        git(self.source, 'commit', '-qam', 'New upstream release')
        upstream = git(self.source, 'rev-parse', 'HEAD')
        git(self.target, 'fetch', str(self.source), upstream)
        git(self.target, 'reset', '--hard', upstream)
        (self.target / template).write_bytes(b'ui header\nbody\nupstream footer\n')
        git(self.target, 'commit', '-qam', 'Stock updater retained UI')
        (self.target / '.plates-ui-state.json').write_text(json.dumps({'version': 1, 'commit': previous, 'files': {template: expected}}))
        git(self.source, 'checkout', 'master'); git(self.source, 'merge', '--no-edit', upstream)
        engine = self.engine(); engine.upgrade(self.source, check=True)
        self.assertFalse(Guard.events)

    def test_concurrent_fork_change_to_local_postfix_configuration_requires_review(self):
        _, _ = self.legacy_installation()
        (self.source / 'data/conf/postfix/main.cf').write_text('relayhost = release.example\n')
        git(self.source, 'commit', '-qam', 'Fork configuration migration')
        engine = self.engine()
        with self.assertRaisesRegex(worker.UpgradeError, 'Unreviewed local/newer-upstream changes: data/conf/postfix/main.cf'):
            engine.upgrade(self.source)
        self.assertFalse(Guard.events)

    def test_local_manifest_cannot_approve_an_unknown_ui_blob(self):
        _, asset = self.legacy_installation()
        (self.target / asset).write_bytes(b'unknown personal code')
        path = self.target / '.plates-ui-state.json'
        state = json.loads(path.read_text()); state['files'][asset] = worker.sha256(self.target / asset)
        path.write_text(json.dumps(state))
        engine = self.engine()
        with self.assertRaisesRegex(worker.UpgradeError, 'Untracked files conflict'):
            engine.upgrade(self.source)
        self.assertFalse(Guard.events)

    def test_backup_failure_restarts_unchanged_stack(self):
        engine = self.engine('backup')
        with self.assertRaises(worker.UpgradeError): engine.upgrade(self.source)
        self.assertEqual(engine.job['phase'], 'rolled_back')
        self.assertEqual(self.volume.read_text(), 'old mail')
        self.assertFalse(Guard.active)

    def test_startup_and_health_failures_restore_code_and_mail_before_opening(self):
        for failure in ('start', 'health'):
            with self.subTest(failure=failure):
                engine = self.engine(failure)
                with self.assertRaises(worker.UpgradeError): engine.upgrade(self.source)
                self.assertEqual(engine.job['phase'], 'rolled_back')
                self.assertEqual((self.target / 'application.txt').read_text(), 'old code')
                self.assertEqual(self.volume.read_text(), 'old mail')
                self.assertFalse(Guard.active)
                self.assertEqual(git(self.target, 'rev-parse', 'HEAD'), self.old)

    def test_failed_recovery_keeps_traffic_blocked(self):
        engine = self.engine('rollback-health')
        with self.assertRaises(worker.UpgradeError): engine.upgrade(self.source)
        self.assertEqual(engine.job['phase'], 'manual_recovery')
        self.assertTrue(Guard.active)
        self.assertTrue(Path(engine.job['backup']).is_dir())

    def test_cleanup_failure_after_commit_never_restores_old_mail(self):
        Guard.fail_release = True
        engine = self.engine(); engine.upgrade(self.source)
        self.assertEqual(engine.job['phase'], 'complete')
        self.assertEqual((self.target / 'application.txt').read_text(), 'new code')
        self.assertEqual(self.volume.read_text(), 'candidate runtime data')
        self.assertFalse(any(args == ['restore-volume'] for args in engine.operations))

    def test_recovery_can_restore_an_interrupted_missing_configuration(self):
        engine = self.engine(); engine.upgrade(self.source)
        engine.job.update(committed=False, phase='applying')
        worker.atomic_json(engine.journal, engine.job)
        (self.target / 'mailcow.conf').unlink()
        recovered = self.engine()
        recovered.job = json.loads(engine.journal.read_text())
        recovered.restore()
        self.assertEqual(recovered.job['phase'], 'rolled_back')
        self.assertEqual(self.volume.read_text(), 'old mail')
        self.assertIn('WEBMAIL_CLIENT=sogo', (self.target / 'mailcow.conf').read_text())


class FirewallTests(unittest.TestCase):
    def test_guard_only_targets_its_bridge_and_private_chain(self):
        commands = []
        def run(command, **kwargs):
            commands.append(command)
            return subprocess.CompletedProcess(command, 1 if '-C' in command else 0, '', '')
        guard = worker.Firewall('br-mailcow', ['iptables', 'ip6tables'], 'a'*32, run)
        guard.block()
        inserts = [cmd for cmd in commands if '-I' in cmd]
        self.assertEqual(len(inserts), 4)
        self.assertTrue(all('br-mailcow' in cmd for cmd in inserts))
        self.assertTrue(any('!' in cmd and 'DOCKER-USER' in cmd for cmd in inserts))
        self.assertFalse(any('-F' in cmd for cmd in commands))


class BootstrapTests(unittest.TestCase):
    def test_modes_and_temp_checkout_cleanup_on_success_and_failure(self):
        with tempfile.TemporaryDirectory(prefix='bootstrap-fixture-') as directory:
            folder = Path(directory); source = folder / 'source'; source.mkdir()
            (source / 'helper-scripts').mkdir()
            (source / 'helper-scripts/upgrade_worker.py').write_text('''import json, os, sys
from pathlib import Path
Path(os.environ['FIXTURE_OUTPUT']).write_text(json.dumps({'args': sys.argv, 'source': str(Path(__file__).resolve().parents[1])}))
sys.exit(int(os.environ.get('FIXTURE_EXIT', '0')))
''')
            git(source, 'init', '-q', '-b', 'master'); git(source, 'config', 'user.name', 'Bootstrap fixture')
            git(source, 'config', 'user.email', 'fixture@example.invalid'); git(source, 'add', '.')
            git(source, 'commit', '-qm', 'Fixture worker')
            target = folder / 'instance'; target.mkdir()
            for name in ('mailcow.conf', 'docker-compose.yml'): (target / name).touch()
            output = folder / 'result.json'
            base = ['bash', str(ROOT / 'upgrade.sh'), '--target', str(target), '--repo', str(source)]
            for flag, mode, code in (([], 'roundcube', '0'), (['--skip-roundcube'], 'preserve', '0'), (['--regress-sogo'], 'sogo', '1')):
                with self.subTest(mode=mode):
                    result = subprocess.run(base + flag, env=dict(os.environ, FIXTURE_OUTPUT=str(output), FIXTURE_EXIT=code), capture_output=True, text=True)
                    self.assertEqual(result.returncode, int(code), result.stderr)
                    data = json.loads(output.read_text())
                    self.assertEqual(data['args'][data['args'].index('--mode') + 1], mode)
                    self.assertFalse(Path(data['source']).exists(), 'Downloaded checkout leaked after command exit')
            output.unlink()
            result = subprocess.run(base + ['--skip-roundcube', '--regress-sogo'], env=dict(os.environ, FIXTURE_OUTPUT=str(output)), capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(output.exists(), 'Conflicting flags reached the worker')


if __name__ == '__main__': unittest.main()
