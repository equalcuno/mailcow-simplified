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
import sys
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
        self.check_local_changes()
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

    def stop_all(self, strict=True): self.operations.append(['stop-all']); self.assert_guarded()

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

    def test_private_daemon_umask_does_not_make_deployed_code_unreadable(self):
        added = 'data/web/inc/new-component/fixture.php'
        (self.source / added).parent.mkdir(parents=True)
        (self.source / added).write_text('<?php echo "ready";')
        git(self.source, 'add', added); git(self.source, 'commit', '-qm', 'New PHP component')
        previous = os.umask(0o077)
        try:
            engine = self.engine(); engine.upgrade(self.source)
            self.assertEqual((self.target / 'application.txt').stat().st_mode & 0o777, 0o644)
            self.assertEqual((self.target / added).stat().st_mode & 0o777, 0o644)
            self.assertEqual((self.target / added).parent.stat().st_mode & 0o777, 0o755)
            self.assertEqual(engine.journal.stat().st_mode & 0o077, 0)
            self.assertEqual((Path(engine.job['backup']) / 'images.tar').stat().st_mode & 0o077, 0)
            current = os.umask(0o077)
            self.assertEqual(current, 0o077, 'Only the Git child process may relax its umask')
        finally:
            os.umask(previous)

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

    def test_only_success_replaces_older_backups_and_keeps_foreign_or_unmanaged_data(self):
        engine = self.engine(); engine.upgrade(self.source)
        first = Path(engine.job['backup'])
        failed = self.engine('health')
        with self.assertRaises(worker.UpgradeError): failed.upgrade(self.source)
        second = Path(failed.job['backup'])
        self.assertTrue(first.is_dir(), 'Rollback must retain the previous verified backup')
        self.assertTrue(second.is_dir(), 'Rollback must retain its own backup and diagnostics')
        unknown = first.parent / 'manual-backup'; unknown.mkdir(); (unknown / 'keep').touch()
        foreign = first.parent / ('20000101T000000Z-' + 'a' * 8); foreign.mkdir()
        (foreign / 'transaction.json').write_text(json.dumps({'version': 1, 'id': 'a' * 32, 'daemon_id': engine.job['daemon_id'], 'target': str(self.folder / 'another-instance'), 'backup': str(foreign)}))
        other_host = first.parent / ('20000101T000002Z-' + 'd' * 8); other_host.mkdir()
        (other_host / 'transaction.json').write_text(json.dumps({'version': 1, 'id': 'd' * 32, 'daemon_id': 'another-docker-host', 'target': str(self.target), 'backup': str(other_host)}))
        link = first.parent / ('20000101T000001Z-' + 'b' * 8); link.symlink_to(unknown, target_is_directory=True)
        success = self.engine(); success.upgrade(self.source)
        self.assertFalse(first.exists()); self.assertFalse(second.exists())
        self.assertTrue(Path(success.job['backup']).is_dir())
        success.verify_backup()
        self.assertTrue((unknown / 'keep').exists()); self.assertTrue(foreign.is_dir()); self.assertTrue(link.is_symlink())
        self.assertTrue(other_host.is_dir())
        self.assertEqual(success.job['backup_cleanup']['status'], 'complete')
        self.assertEqual(len(success.job['backup_cleanup']['removed']), 2)

    def test_backup_cleanup_failure_cannot_roll_back_a_committed_update(self):
        first = self.engine(); first.upgrade(self.source)
        previous = Path(first.job['backup'])
        engine = self.engine()
        with patch.object(worker.shutil, 'rmtree', side_effect=PermissionError('Injected backup cleanup error')):
            engine.upgrade(self.source)
        self.assertEqual(engine.job['phase'], 'complete'); self.assertTrue(engine.job['committed'])
        self.assertEqual(engine.job['backup_cleanup']['status'], 'incomplete')
        self.assertTrue(previous.is_dir()); self.assertTrue(Path(engine.job['backup']).is_dir())
        self.assertEqual(self.volume.read_text(), 'candidate runtime data')
        self.assertFalse(Guard.active)

    def test_corrupt_new_backup_prevents_cleanup_of_previous_backup(self):
        engine = self.engine(); engine.upgrade(self.source)
        current = Path(engine.job['backup'])
        previous = current.parent / ('20000101T000000Z-' + 'c' * 8); previous.mkdir()
        (previous / 'transaction.json').write_text(json.dumps({'version': 1, 'id': 'c' * 32, 'daemon_id': engine.job['daemon_id'], 'target': str(self.target), 'backup': str(previous)}))
        (current / 'images.tar').write_bytes(b'corrupt archive')
        engine.job.pop('backup_cleanup'); engine.cleanup_successful_backups()
        self.assertTrue(previous.is_dir()); self.assertTrue(current.is_dir())
        self.assertEqual(engine.job['backup_cleanup']['status'], 'incomplete')

    def test_check_does_not_replace_any_backup(self):
        engine = self.engine(); engine.upgrade(self.source)
        before = set(self.folder.joinpath('backups').iterdir())
        self.engine().upgrade(self.source, check=True)
        self.assertEqual(set(self.folder.joinpath('backups').iterdir()), before)

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

    def postfix_runtime_tail(self):
        main = self.target / 'data/conf/postfix/main.cf'
        committed = 'relayhost = private.example\n# DO NOT EDIT ANYTHING BELOW #\n# Overrides #\n'
        main.write_text(committed)
        git(self.target, 'commit', '-qam', 'Instance postfix configuration')
        # What postfix.sh appends on every container start.
        main.write_text(committed + '\npostscreen_dnsbl_sites = example\n\n# User Overrides\n')
        return main, committed

    def test_postfix_generated_tail_does_not_block_upgrade(self):
        main, committed = self.postfix_runtime_tail()
        engine = self.engine(); engine.upgrade(self.source)
        self.assertEqual(engine.job['phase'], 'complete')
        self.assertEqual(main.read_text(), committed)
        self.assertEqual(git(self.target, 'status', '--porcelain', '--untracked-files=no'), '')

    def test_postfix_edit_above_marker_is_rejected_by_name(self):
        main, committed = self.postfix_runtime_tail()
        main.write_text(committed.replace('private', 'edited'))
        engine = self.engine()
        with self.assertRaisesRegex(worker.UpgradeError, 'local changes: data/conf/postfix/main.cf'):
            engine.upgrade(self.source)
        self.assertIsNone(engine.job)

    def test_rollback_restores_postfix_generated_tail_exactly(self):
        main, _ = self.postfix_runtime_tail()
        before = main.read_text()
        engine = self.engine('start')
        with self.assertRaises(worker.UpgradeError): engine.upgrade(self.source)
        self.assertEqual(engine.job['phase'], 'rolled_back')
        self.assertEqual(main.read_text(), before)

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
                self.assertEqual(engine.job['failure']['phase'], 'applying' if failure == 'start' else 'health_check')
                self.assertIn('Injected', engine.public_status()['message'])
                self.assertEqual(json.loads(engine.journal.read_text())['failure'], engine.job['failure'])

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


class StopTests(unittest.TestCase):
    """Exercise the real Engine.stop_all against scripted docker stop results."""
    class Stopper(worker.Engine):
        def __init__(self, exits):
            super().__init__({'target': tempfile.gettempdir()})
            self.exits, self.stopped, self.messages = exits, [], []
        def inspect_project(self, running=False):
            return [{'Id': name, 'Config': {'Labels': {'com.docker.compose.service': name}}} for name in self.exits]
        def command(self, *arguments, **kwargs):
            if arguments[1] == 'stop': self.stopped.append((arguments[-1], arguments[3])); return ''
            return json.dumps({'Running': False, 'ExitCode': self.exits[arguments[-1]], 'OOMKilled': False})
        def log(self, message): self.messages.append(message)

    def test_killed_stateless_helper_does_not_abort_and_gets_short_grace(self):
        engine = self.Stopper({'acme-mailcow': 137, 'mysql-mailcow': 0})
        engine.stop_all()
        self.assertEqual(dict(engine.stopped), {'acme-mailcow': '30', 'mysql-mailcow': '300'})
        self.assertIn('acme-mailcow', engine.messages[0])

    def test_killed_data_store_aborts_backup_naming_the_service(self):
        with self.assertRaisesRegex(worker.UpgradeError, 'dovecot-mailcow'):
            self.Stopper({'dovecot-mailcow': 137}).stop_all()

    def test_recovery_tolerates_killed_data_store(self):
        engine = self.Stopper({'dovecot-mailcow': 137, 'redis-mailcow': 0})
        engine.stop_all(strict=False)
        self.assertEqual(len(engine.stopped), 2)


class DiagnosticTests(unittest.TestCase):
    def test_stdout_only_command_failure_is_not_discarded(self):
        with self.assertRaisesRegex(worker.UpgradeError, 'database readiness failed'):
            worker.execute([sys.executable, '-c', 'print("database readiness failed"); raise SystemExit(1)'])

    def test_stdout_failure_redacts_environment_secrets(self):
        password = 'fixture-database-password'
        with self.assertRaises(worker.UpgradeError) as failure:
            worker.execute([sys.executable, '-c', 'import os; print(os.environ["DBPASS"]); raise SystemExit(1)'],
                           env=dict(os.environ, DBPASS=password))
        self.assertNotIn(password, str(failure.exception))
        self.assertIn('[REDACTED]', str(failure.exception))

    def test_each_failed_health_probe_names_its_service_and_check(self):
        services = ['nginx-mailcow', 'php-fpm-mailcow', 'roundcube-mailcow', 'postfix-mailcow', 'dovecot-mailcow']
        containers = [{'Id': name, 'Config': {'Labels': {'com.docker.compose.service': name}}, 'State': {'Running': True}} for name in services]
        cases = [('nginx-mailcow', 'nginx', 'nginx configuration'),
                 ('php-fpm-mailcow', 'php', 'PHP autoload'),
                 ('nginx-mailcow', 'sh', 'portal login page'),
                 ('roundcube-mailcow', 'php', 'Roundcube database'),
                 ('postfix-mailcow', 'postfix', 'Postfix running'),
                 ('dovecot-mailcow', 'doveadm', 'Dovecot IMAP')]
        for service, executable, label in cases:
            with self.subTest(probe=label):
                engine = worker.Engine({'target': tempfile.gettempdir(), 'health_timeout': 1})
                def compose(*arguments):
                    if arguments[2:4] == (service, executable): raise worker.UpgradeError('docker exited 1: no error details returned')
                    return ''
                with patch.object(engine, 'inspect_project', return_value=containers), patch.object(engine, 'compose', side_effect=compose), \
                     patch.object(worker.time, 'monotonic', side_effect=[0, 0, 1]), patch.object(worker.time, 'sleep'):
                    with self.assertRaises(worker.UpgradeError) as failure: engine.health(set(services))
                self.assertIn(service + ' (' + label + ')', str(failure.exception))

    def test_candidate_logs_and_failure_survive_rollback_status_without_secrets(self):
        with tempfile.TemporaryDirectory(prefix='upgrade-diagnostics-') as directory:
            folder = Path(directory); backup = folder / 'backup'; backup.mkdir()
            password = 'fixture-database-password'
            result = subprocess.CompletedProcess([], 0, 'stdout '+password, 'stderr '+password)
            engine = worker.Engine({'target': directory, 'state_dir': str(folder/'state')}, runner=lambda *args, **kwargs: result)
            engine.env = dict(DBPASS=password)
            engine.job = {'id': 'fixture', 'phase': 'health_check', 'message': 'Checking readiness.', 'guarded': True, 'backup': str(backup)}
            containers = [{'Id': 'fixture-id', 'Config': {'Labels': {'com.docker.compose.service': 'nginx-mailcow'},
                           'Env': ['DBPASS='+password]}, 'State': {'Running': True}}]
            with patch.object(engine, 'inspect_project', return_value=containers):
                engine.retain_failure(worker.UpgradeError('nginx-mailcow probe failed: '+password))
            self.assertEqual(json.loads(engine.journal.read_text())['failure']['phase'], 'health_check')
            saved = (backup/'failure-diagnostics.json').read_text()
            self.assertNotIn(password, saved)
            self.assertNotIn('DBPASS=', saved)
            self.assertIn('stdout [REDACTED]', saved)
            self.assertIn('stderr [REDACTED]', saved)
            engine.phase('rolled_back', 'Previous stack recovered.')
            public = engine.public_status()
            self.assertIn('nginx-mailcow probe failed', public['message'])
            self.assertNotIn(password, json.dumps(public))


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


class LockTests(unittest.TestCase):
    def test_another_process_is_rejected_and_lock_releases_automatically(self):
        with tempfile.TemporaryDirectory(prefix='upgrade-lock-') as directory:
            code = ('import importlib.util,sys; from pathlib import Path; '
                    's=importlib.util.spec_from_file_location("worker",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); '
                    'lock=m.installation_lock(Path(sys.argv[2])); lock.__enter__(); print("acquired")')
            command = [sys.executable, '-c', code, str(ROOT/'helper-scripts/upgrade_worker.py'), directory]
            environment = dict(os.environ); environment.pop('MAILCOW_UPGRADE_LOCK_FD', None)
            with worker.installation_lock(directory) as lock:
                rejected = subprocess.run(command, env=environment, capture_output=True, text=True)
                self.assertNotEqual(rejected.returncode, 0)
                self.assertIn('Another upgrade or recovery is already running', rejected.stderr)
                inherited = dict(environment, MAILCOW_UPGRADE_LOCK_FD=str(lock.fileno()))
                accepted = subprocess.run(command, env=inherited, pass_fds=(lock.fileno(),), capture_output=True, text=True)
                self.assertEqual(accepted.returncode, 0, accepted.stderr)
                self.assertNotEqual(subprocess.run(command, env=environment, capture_output=True).returncode, 0,
                                    'The child must not release the bootstrap parent lock')
            accepted = subprocess.run(command, env=environment, capture_output=True, text=True)
            self.assertEqual(accepted.returncode, 0, accepted.stderr)
            self.assertTrue(Path(directory,'.update-ui.lock').is_file(), 'The lock inode must persist')

    def test_inherited_lock_cannot_target_a_different_installation(self):
        with tempfile.TemporaryDirectory(prefix='upgrade-lock-owner-') as directory:
            first = Path(directory,'first'); second = Path(directory,'second'); first.mkdir(); second.mkdir()
            with worker.installation_lock(first) as lock, worker.installation_lock(second):
                with patch.dict(os.environ, MAILCOW_UPGRADE_LOCK_FD=str(lock.fileno())):
                    with self.assertRaisesRegex(worker.UpgradeError, 'does not belong'):
                        with worker.installation_lock(second): pass


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
            with worker.installation_lock(target):
                blocked = subprocess.run(base, env=dict(os.environ, FIXTURE_OUTPUT=str(output)), capture_output=True, text=True)
                self.assertNotEqual(blocked.returncode, 0)
                self.assertIn('Another upgrade or recovery is already running', blocked.stderr)
                self.assertNotIn('Downloading', blocked.stdout, 'The bootstrap must lock before downloading')
                self.assertFalse(output.exists())
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
