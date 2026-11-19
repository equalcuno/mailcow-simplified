#!/usr/bin/env python3
"""Opt-in cold upgrade/rollback against an isolated Docker-in-Docker daemon.

Uses real Compose, volumes, image archives and iptables. The small fixture replaces
Mailcow-specific health probes and systemd installation only. Never mounts the host
Docker socket or edits host configuration. Requires the existing live harness image.
"""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[2] if '--inner' not in sys.argv else Path('/fixture')


def run(*args, **kwargs):
    return subprocess.check_output(args, text=True, timeout=240, **kwargs).strip()


def inner():
    spec = importlib.util.spec_from_file_location('worker', '/fixture/upgrade_worker.py')
    worker = importlib.util.module_from_spec(spec); spec.loader.exec_module(worker)

    class FixtureEngine(worker.Engine):
        unhealthy = False
        def ensure_recovery_service(self, source): pass
        def health(self, expected):
            running = self.inspect_project(running=True)
            names = {c['Config']['Labels']['com.docker.compose.service'] for c in running}
            assert names == expected, (names, expected)
            # A real connection from the host namespace must be blocked before commit.
            port = json.loads(self.command('docker', 'inspect', running[0]['Id']))[0]['NetworkSettings']['Ports'].get('80/tcp')
            if port:
                result = self.run(['curl', '--noproxy', '*', '--silent', '--fail', '--max-time', '1', 'http://127.0.0.1:' + port[0]['HostPort']], allow_failure=True)
                assert result.returncode, 'Published port was accessible before commit'
            if self.unhealthy and self.job['phase'] != 'restoring':
                self.unhealthy = False
                self.command('docker', 'exec', running[0]['Id'], 'sh', '-c', 'echo damaged > /mail/message')
                raise worker.UpgradeError('Injected candidate health failure')

    with tempfile.TemporaryDirectory(prefix='real-upgrade-') as directory:
        folder = Path(directory); source = folder / 'source'; source.mkdir()
        fixture = {'name': 'upgradetest', 'services': {}, 'volumes': {'mail': {}}, 'networks': {
            'mailcow-network': {'driver': 'bridge', 'ipam': {'config': [{'subnet': '172.31.215.0/24'}]}}}}
        for name in ('nginx', 'php-fpm', 'sogo', 'roundcube'):
            service = {'image': 'nginx:alpine', 'volumes': ['mail:/mail'], 'networks': {'mailcow-network': {}}, 'restart': 'unless-stopped'}
            if name in ('sogo', 'roundcube'):
                service['profiles'] = [name]; service['networks']['mailcow-network']['ipv4_address'] = '172.31.215.248'
            if name == 'nginx': service['ports'] = ['127.0.0.1::80']
            fixture['services'][name + '-mailcow'] = service
        (source / 'docker-compose.yml').write_text(json.dumps(fixture))
        (source / '.gitignore').write_text('mailcow.conf\n.update-ui.lock\n')
        (source / 'version').write_text('old')
        (source / 'data/conf/postfix').mkdir(parents=True)
        (source / 'data/conf/postfix/main.cf').write_text('relayhost =\n')
        def git(path, *args): return run('git', '-C', str(path), *args)
        git(source, 'init', '-q', '-b', 'master'); git(source, 'config', 'user.name', 'Upgrade runtime')
        git(source, 'config', 'user.email', 'fixture@example.invalid'); git(source, 'add', '.')
        git(source, 'commit', '-qm', 'Old fixture'); old = git(source, 'rev-parse', 'HEAD')
        (source / 'version').write_text('new'); git(source, 'commit', '-qam', 'New fixture')
        target = folder / 'instance'; run('git', 'clone', '-q', str(source), str(target)); git(target, 'reset', '--hard', old)
        git(target, 'config', 'user.name', 'Upgrade runtime'); git(target, 'config', 'user.email', 'fixture@example.invalid')
        (target / 'data/conf/postfix/main.cf').write_text('relayhost = private.example\n')
        git(target, 'commit', '-qam', 'Before stock update')
        # The real server has an untracked, renamed stock updater at this path.
        (target / 'upgrade.sh').write_text('#!/bin/bash\necho old updater\n')
        (source / 'upgrade.sh').write_text('#!/bin/bash\necho full fork upgrader\n')
        git(source, 'add', 'upgrade.sh'); git(source, 'commit', '-qm', 'Ship fork entry point')
        (target / 'mailcow.conf').write_text('COMPOSE_PROJECT_NAME=upgradetest\nWEBMAIL_CLIENT=sogo\nSKIP_SOGO=n\nCOMPOSE_PROFILES=sogo\n')
        os.chmod(target / 'mailcow.conf', 0o600)
        config = {'target': str(target), 'backup_dir': str(folder / 'backups'), 'state_dir': str(folder / 'state'), 'reserve_bytes': 0}
        engine = FixtureEngine(config); engine.load_environment(); engine.compose('up', '-d')
        try:
            engine.compose('exec', '-T', 'nginx-mailcow', 'sh', '-c', 'echo original-mail > /mail/message')
            engine.upgrade(source)
            assert engine.job['phase'] == 'complete' and 'WEBMAIL_CLIENT=roundcube' in (target / 'mailcow.conf').read_text()
            assert (target / 'data/conf/postfix/main.cf').read_text() == 'relayhost = private.example\n'
            assert 'full fork upgrader' in (target / 'upgrade.sh').read_text()
            assert git(target, 'status', '--porcelain', '--untracked-files=no') == ''
            assert 'sogo-mailcow' not in {c['Config']['Labels']['com.docker.compose.service'] for c in engine.inspect_project()}
            engine.upgrade(source, mode='sogo')
            assert engine.job['phase'] == 'complete' and 'WEBMAIL_CLIENT=sogo' in (target / 'mailcow.conf').read_text()
            (source / 'version').write_text('bad'); git(source, 'commit', '-qam', 'Unhealthy fixture')
            engine.unhealthy = True
            try: engine.upgrade(source)
            except worker.UpgradeError: pass
            else: raise AssertionError('Unhealthy release was accepted')
            assert engine.job['phase'] == 'rolled_back'
            assert (target / 'version').read_text() == 'new'
            assert (target / 'data/conf/postfix/main.cf').read_text() == 'relayhost = private.example\n'
            assert engine.compose('exec', '-T', 'nginx-mailcow', 'cat', '/mail/message') == 'original-mail'
            assert 'WEBMAIL_CLIENT=sogo' in (target / 'mailcow.conf').read_text()
            print('Real upgrade runtime passed: Compose profiles, shared .248 handover, firewall isolation, cold archives, image/volume/code recovery.')
        finally:
            engine.compose('--profile', '*', 'down', '--volumes', '--remove-orphans')


def outer():
    name = 'upgrade-runtime-' + uuid.uuid4().hex[:8]
    run('docker', 'run', '-d', '--privileged', '--memory', '1g', '--name', name,
        '--label', 'com.mailcow.simplified-checks=true', '-e', 'DOCKER_TLS_CERTDIR=', 'mailcow-ui-test-harness:latest',
        'dockerd', '--host=unix:///var/run/docker.sock')
    try:
        for _ in range(60):
            if subprocess.run(['docker', 'exec', name, 'docker', 'info'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0: break
            time.sleep(1)
        else: raise RuntimeError('Nested Docker daemon did not start')
        run('docker', 'exec', name, 'apk', 'add', '--no-cache', 'tar')
        run('docker', 'exec', name, 'mkdir', '/fixture')
        run('docker', 'cp', str(ROOT / 'helper-scripts/upgrade_worker.py'), name + ':/fixture/upgrade_worker.py')
        run('docker', 'cp', str(Path(__file__).resolve()), name + ':/fixture/test.py')
        for image in ('nginx:alpine', 'debian:bookworm-slim'):
            if subprocess.run(['docker', 'image', 'inspect', image], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
                run('docker', 'pull', image)
            producer = subprocess.Popen(['docker', 'image', 'save', image], stdout=subprocess.PIPE)
            try:
                subprocess.run(['docker', 'exec', '-i', name, 'docker', 'load'], stdin=producer.stdout, check=True, stdout=subprocess.DEVNULL, timeout=240)
            finally:
                producer.stdout.close()
                if producer.wait(): raise RuntimeError('Could not preload ' + image)
        subprocess.run(['docker', 'exec', name, 'python3', '/fixture/test.py', '--inner'], check=True, timeout=600)
    finally:
        subprocess.run(['docker', 'rm', '-fv', name], check=True, stdout=subprocess.DEVNULL)


if __name__ == '__main__':
    inner() if '--inner' in sys.argv else outer()
