#!/usr/bin/env python3
"""Host-side full-stack upgrades. No Docker socket or host command execution in PHP.

Requires a local Linux Docker Engine, Compose >=2.24.4, and iptables. Backups are
cold archives of files, named volumes and old images. Traffic stays blocked until
health checks pass. After the commit point, cleanup never restores stale mail data.
"""
import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import secrets
import shutil
import signal
import subprocess
import sys
import tempfile
import time

HELPER_IMAGE = 'debian:bookworm-slim'
TERMINAL = {'complete', 'rolled_back', 'failed'}
KEYS = {'heartbeat': 'SIMPLIFIED_UPDATE_HEARTBEAT', 'queue': 'SIMPLIFIED_UPDATE_QUEUE',
        'status': 'SIMPLIFIED_UPDATE_STATUS', 'lock': 'SIMPLIFIED_UPDATE_LOCK'}
LEGACY_UI_FILES = {
    'data/web/inc/twig.inc.php', 'data/web/inc/triggers.admin.inc.php', 'data/web/json_api.php',
    'data/web/api/openapi.yaml', 'data/web/js/site/mailbox.js', 'data/web/templates/admin.twig',
    'data/web/templates/base.twig', 'data/web/inc/lib/mailcow/Mailbox/MailboxSearchScope.php',
}
LEGACY_UI_DIRS = ('data/web/ui/plates/', 'data/web/inc/lib/mailcow/Ui/')
INSTANCE_FILES = {'data/conf/postfix/main.cf', 'data/assets/ssl-example/cert.pem', 'data/assets/ssl-example/key.pem'}


class UpgradeError(RuntimeError):
    pass


class UpgradeInterrupted(BaseException):
    def __init__(self, signum):
        self.signum = signum
        super().__init__('Upgrade interrupted; recovery runs before exit.')


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix='.update-')
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream, indent=2)
            stream.write('\n'); stream.flush(); os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try: os.fsync(directory)
        finally: os.close(directory)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)


def sha256(path):
    checksum = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''): checksum.update(block)
    return checksum.hexdigest()


def recovery_signals(operation):
    def protected(*args, **kwargs):
        previous = {sig: signal.getsignal(sig) for sig in (signal.SIGINT, signal.SIGTERM)}
        try:
            for sig in previous: signal.signal(sig, signal.SIG_IGN)
            return operation(*args, **kwargs)
        finally:
            for sig, handler in previous.items(): signal.signal(sig, handler)
    return protected


def execute(arguments, cwd=None, env=None, timeout=3600, allow_failure=False):
    result = subprocess.run(arguments, cwd=cwd, env=env, text=True, capture_output=True, timeout=timeout)
    if result.returncode and not allow_failure:
        command = arguments[0] + (' ' + arguments[1] if arguments[0] == 'git' and len(arguments) > 1 else '')
        raise UpgradeError(f'{command} exited {result.returncode}: {result.stderr[-2000:].strip() or "no error details returned"}')
    return result


class Firewall:
    def __init__(self, bridge, families, identifier, runner=execute):
        if not re.fullmatch(r'[A-Za-z0-9_.:-]{1,15}', bridge): raise UpgradeError('Invalid bridge interface.')
        if not re.fullmatch(r'[a-f0-9]{32}', identifier): raise UpgradeError('Invalid transaction ID.')
        if not families or any(f not in ('iptables', 'ip6tables') for f in families): raise UpgradeError('Invalid firewall family.')
        self.bridge, self.families = bridge, families
        self.chain = 'MCU_' + identifier[:12].upper()
        self.run = runner

    def rules(self):
        # Block requests directed into this bridge, not replies to outbound DNS/HTTP.
        direction = ['-m', 'conntrack', '--ctdir', 'ORIGINAL']
        return [('DOCKER-USER', ['!', '-i', self.bridge, '-o', self.bridge, *direction, '-j', self.chain]),
                ('OUTPUT', ['-o', self.bridge, *direction, '-j', self.chain])]

    def block(self):
        for family in self.families:
            for chain in ('DOCKER-USER', self.chain):
                self.run([family, '-w', '-N', chain], allow_failure=True)
                self.run([family, '-w', '-L', chain])
            if self.run([family, '-w', '-C', self.chain, '-j', 'DROP'], allow_failure=True).returncode:
                self.run([family, '-w', '-A', self.chain, '-j', 'DROP'])
            for parent, rule in self.rules():
                if self.run([family, '-w', '-C', parent, *rule], allow_failure=True).returncode:
                    self.run([family, '-w', '-I', parent, '1', *rule])

    def release(self):
        for family in self.families:
            for parent, rule in self.rules():
                if not self.run([family, '-w', '-C', parent, *rule], allow_failure=True).returncode:
                    self.run([family, '-w', '-D', parent, *rule])
            # Only our private chain is removed. Do not flush Docker or Mailcow rules.
            self.run([family, '-w', '-F', self.chain], allow_failure=True)
            self.run([family, '-w', '-X', self.chain], allow_failure=True)


class Engine:
    def __init__(self, config, runner=execute, notify=None):
        self.config, self.run, self.notify = config, runner, notify
        self.root = Path(config['target']).resolve()
        self.backups = Path(config.get('backup_dir', '/var/backups/mailcow-simplified')).resolve()
        self.state = Path(config.get('state_dir', '/var/lib/mailcow-simplified-updates')).resolve()
        self.journal = self.state / 'transaction.json'
        self.env = dict(os.environ, GIT_TERMINAL_PROMPT='0')
        self.job = None

    def command(self, *arguments, **kwargs):
        kwargs.setdefault('timeout', int(self.config.get('command_timeout', 3600)))
        return self.run(list(arguments), cwd=kwargs.pop('cwd', self.root), env=self.env, **kwargs).stdout.strip()

    def ensure_recovery_service(self, source):
        if not Path('/run/systemd/system').is_dir():
            raise UpgradeError('The guarded full upgrader requires systemd for recovery before Docker restarts.')
        path = Path('/etc/mailcow-simplified-updates.json')
        if path.exists():
            configured = load_config(path)
            if Path(configured['target']).resolve() != self.root or Path(configured.get('state_dir', str(self.state))).resolve() != self.state:
                raise UpgradeError('The installed recovery service is configured for a different target/state directory.')
        else:
            config = dict(self.config, target=str(self.root), state_dir=str(self.state), backup_dir=str(self.backups),
                          repo=self.command('git', 'remote', 'get-url', 'origin', cwd=source), ref=self.config.get('ref', 'master'))
            atomic_json(path, config)
        # Refresh the installed engine as part of every full release, without
        # interrupting a daemon that is currently executing this transaction.
        self.command('bash', str(source / 'helper-scripts/install-upgrade-worker.sh'), '--target', str(self.root), '--no-start')

    def load_environment(self):
        result = self.run(['bash', '-c', 'set -a; source "$1"; env -0', 'mailcow-config', str(self.root / 'mailcow.conf')])
        for item in result.stdout.split('\0'):
            if '=' in item:
                key, value = item.split('=', 1); self.env[key] = value
        self.project = self.env.get('COMPOSE_PROJECT_NAME', 'mailcow-dockerized')
        if not re.fullmatch(r'[a-z0-9][a-z0-9_-]*', self.project): raise UpgradeError('Invalid Compose project name.')

    def compose(self, *arguments, source=None, extra=None, **kwargs):
        source = Path(source) if source else self.root
        command = ['docker', 'compose', '--project-directory', str(source), '-p', self.project,
                   '--env-file', str(self.root / 'mailcow.conf'), '-f', str(source / 'docker-compose.yml')]
        override = self.root / 'docker-compose.override.yml'
        if override.exists(): command += ['-f', str(override)]
        if extra: command += ['-f', str(extra)]
        return self.command(*command, *arguments, **kwargs)

    def inspect_project(self, running=False):
        arguments = ['docker', 'ps', '-q' if running else '-aq', '--filter', f'label=com.docker.compose.project={self.project}']
        ids = self.command(*arguments).split()
        return json.loads(self.command('docker', 'inspect', *ids)) if ids else []

    def preflight(self, readonly=False):
        if platform.system() != 'Linux' or os.geteuid() != 0: raise UpgradeError('Full upgrades require root on the Linux mailcow host.')
        if not (self.root / 'mailcow.conf').is_file(): raise UpgradeError('Existing mailcow.conf is required; never regenerate it for an upgrade.')
        if self.root == self.backups or self.root in self.backups.parents: raise UpgradeError('Full backups must be outside the installation directory.')
        if self.root == self.state or self.root in self.state.parents: raise UpgradeError('Worker state must be outside the installation directory.')
        if ',' in str(self.backups) or ',' in str(self.root): raise UpgradeError('Docker bind paths cannot contain commas.')
        self.load_environment()
        if self.env.get('COMPOSE_FILE'): raise UpgradeError('COMPOSE_FILE overrides need manual review; use docker-compose.override.yml.')
        context = json.loads(self.command('docker', 'context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}'))
        if not self.env.get('DOCKER_HOST', context).startswith('unix://'): raise UpgradeError('A local Docker Engine is required for consistent file and volume backups.')
        version = re.search(r'(\d+)\.(\d+)\.(\d+)', self.command('docker', 'compose', 'version', '--short'))
        if not version or tuple(map(int, version.groups())) < (2, 24, 4): raise UpgradeError('Docker Compose 2.24.4 or newer is required.')
        if '-j DOCKER-USER' not in self.command('iptables', '-S', 'FORWARD'):
            raise UpgradeError("The updater requires Docker's iptables DOCKER-USER hook; nftables-only backends need manual upgrades.")
        if self.command('git', 'status', '--porcelain', '--untracked-files=no'):
            raise UpgradeError('Tracked files contain local changes. Commit/review them before upgrading.')
        for name in ('mailcow.conf', 'docker-compose.yml', 'docker-compose.override.yml'):
            path = self.root / name
            if path.exists() and (path.stat().st_uid != 0 or path.stat().st_mode & 0o022):
                raise UpgradeError('Upgrade configuration must be root-owned and not group/world-writable: ' + name)
        for command in ('tar', 'iptables', 'ip6tables'):
            if not shutil.which(command): raise UpgradeError(command + ' is required.')
        if 'GNU tar' not in self.command('tar', '--version'): raise UpgradeError('GNU tar is required for ownership, ACL and extended-attribute backups.')
        if not readonly:
            self.backups.mkdir(parents=True, exist_ok=True, mode=0o700)
            self.state.mkdir(parents=True, exist_ok=True, mode=0o700)
        for path in (self.backups, self.state):
            if path.exists() and (path.stat().st_uid != 0 or path.stat().st_mode & 0o022):
                raise UpgradeError('Backup/state directories must be root-owned and not writable by other users: ' + str(path))
        if self.journal.exists():
            pending = json.loads(self.journal.read_text())
            if pending['phase'] not in TERMINAL: raise UpgradeError('An incomplete upgrade needs recovery before another upgrade.')

    def phase(self, phase, message):
        self.job.update(phase=phase, message=message, updated_at=int(time.time()))
        atomic_json(self.journal, self.job)
        print(f'{phase}: {message}', flush=True)
        if self.notify:
            with contextlib.suppress(Exception): self.notify(self.public_status())

    def public_status(self):
        return {key: self.job.get(key) for key in ('id', 'phase', 'message', 'commit', 'updated_at')}

    def selected_client(self, mode):
        if mode == 'sogo': return 'sogo'
        if mode == 'roundcube': return 'roundcube'
        if self.env.get('WEBMAIL_CLIENT') in ('sogo', 'roundcube'): return self.env['WEBMAIL_CLIENT']
        running = self.inspect_project(running=True)
        return 'roundcube' if any(c['Config']['Labels'].get('com.docker.compose.service') == 'roundcube-mailcow' for c in running) else 'sogo'

    def ancestry(self, ancestor, descendant):
        result = self.run(['git', 'merge-base', '--is-ancestor', ancestor, descendant], cwd=self.root, env=self.env, allow_failure=True)
        if result.returncode not in (0, 1): raise UpgradeError('Unable to compare Git revisions: ' + result.stderr[-1000:])
        return result.returncode == 0

    def legacy_ui_state(self, commit):
        path = self.root / '.plates-ui-state.json'
        if not path.is_file() or path.is_symlink(): return {}
        try:
            state = json.loads(path.read_text())
            previous = state.get('commit', '')
            if state.get('version') != 1 or not isinstance(previous, str) or not re.fullmatch(r'[a-f0-9]{40,64}', previous) or not isinstance(state.get('files'), dict): return {}
            # A local JSON file cannot authorize arbitrary code: its package must
            # be in the trusted release's history, and hashes are checked below.
            if not self.ancestry(previous, commit): return {}
            return state
        except (ValueError, OSError): return {}

    def known_legacy_ui(self, name, state, base=None):
        if name not in LEGACY_UI_FILES and not name.startswith(LEGACY_UI_DIRS): return False
        path = self.root / name
        if any(parent.is_symlink() for parent in [path, *path.parents] if parent != self.root.parent): return False
        expected = state.get('files', {}).get(name)
        if not isinstance(expected, str) or not re.fullmatch(r'[a-f0-9]{64}', expected): return False
        previous = state['commit']
        # Use raw bytes for package hashes (fonts and CRLF PHP files included).
        blob = subprocess.run(['git', 'show', previous + ':' + name], cwd=self.root, capture_output=True)
        if blob.returncode or hashlib.sha256(blob.stdout).hexdigest() != expected: return False
        if path.is_file() and sha256(path) == expected: return True
        if base is None or not path.is_file(): return False
        # The stock updater can merge newer upstream changes into the installed
        # UI. Recognize only the exact, clean three-way merge of that known package.
        common = self.command('git', 'merge-base', previous, base)
        def content(ref):
            result = subprocess.run(['git', 'show', ref + ':' + name], cwd=self.root, capture_output=True)
            return result.stdout if result.returncode == 0 else None
        upstream, before = content(base), content(common)
        if upstream is None or before is None: return False
        with tempfile.TemporaryDirectory(prefix='mailcow-ui-review-') as directory:
            files = [Path(directory) / part for part in ('upstream', 'base', 'ui')]
            for target, data in zip(files, (upstream, before, blob.stdout)): target.write_bytes(data)
            merged = subprocess.run(['git', 'merge-file', '-p', *map(str, files)], capture_output=True)
        return merged.returncode == 0 and merged.stdout == path.read_bytes()

    def installation_plan(self, commit):
        state = self.legacy_ui_state(commit)
        preserve, rejected = [], []
        if not self.ancestry('HEAD', commit):
            result = self.run(['git', 'merge-base', 'HEAD', commit], cwd=self.root, env=self.env, allow_failure=True)
            base = result.stdout.strip()
            if result.returncode or not base:
                raise UpgradeError('The installed checkout and release have no shared history. No services were changed.')
            changed = self.command('git', 'diff', '--name-only', '-z', base, 'HEAD').split('\0')
            for name in filter(None, changed):
                if name in INSTANCE_FILES and (self.root / name).is_file() and not (self.root / name).is_symlink() and self.command('git', 'rev-parse', base + ':' + name) == self.command('git', 'rev-parse', commit + ':' + name):
                    preserve.append(name)
                elif not self.known_legacy_ui(name, state, base): rejected.append(name)
            if rejected:
                current = self.command('git', 'rev-parse', '--short', 'HEAD')
                raise UpgradeError('Installed revision ' + current + ' is not contained in release ' + commit[:12]
                    + '. Unreviewed local/newer-upstream changes: ' + ', '.join(rejected[:12])
                    + '. Integrate these changes into the fork before upgrading; no services were changed.')
            print('Recognized local update commits; preserving instance configuration and replacing verified legacy UI files.', flush=True)
        candidate = set(filter(None, self.command('git', 'ls-tree', '-r', '--name-only', '-z', commit).split('\0')))
        untracked = set(filter(None, self.command('git', 'ls-files', '--others', '--exclude-standard', '-z').split('\0')))
        untracked.update(filter(None, self.command('git', 'ls-files', '--others', '--ignored', '--exclude-standard', '-z').split('\0')))
        replace = []
        for name in sorted(candidate & untracked):
            if name == 'upgrade.sh' or self.known_legacy_ui(name, state): replace.append(name)
            else: rejected.append(name)
        if rejected:
            raise UpgradeError('Untracked files conflict with this release: ' + ', '.join(rejected[:12])
                + '. Preserve/review these files before retrying; no services were changed.')
        return preserve, replace

    def set_client_environment(self, client):
        self.env.update(WEBMAIL_CLIENT=client, SKIP_SOGO='n' if client == 'sogo' else 'y', COMPOSE_PROFILES=client)
        if not self.env.get('ROUNDCUBE_DES_KEY'):
            self.env['ROUNDCUBE_DES_KEY'] = ''.join(secrets.choice('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') for _ in range(24))
        if len(self.env['ROUNDCUBE_DES_KEY']) != 24: raise UpgradeError('ROUNDCUBE_DES_KEY must contain exactly 24 characters.')

    def write_client_environment(self):
        path = self.root / 'mailcow.conf'
        content = path.read_text()
        for key in ('WEBMAIL_CLIENT', 'SKIP_SOGO', 'COMPOSE_PROFILES', 'ROUNDCUBE_DES_KEY'):
            value = self.env[key]
            if not re.fullmatch(r'[A-Za-z0-9_-]+', value): raise UpgradeError('Unsafe webmail configuration value.')
            line = key + '=' + value
            if re.search(r'^' + key + '=', content, re.M): content = re.sub(r'^' + key + '=.*$', line, content, flags=re.M)
            else: content += '\n' + line + '\n'
        path.write_text(content)

    def capture(self):
        running = self.inspect_project(running=True)
        if not running: raise UpgradeError('No running mailcow services found for this project.')
        volumes, images = {}, {}
        old_config = json.loads(self.compose('config', '--format', 'json'))
        network_name = old_config['networks']['mailcow-network']['name']
        network = json.loads(self.command('docker', 'network', 'inspect', network_name))[0]
        bridge = network.get('Options', {}).get('com.docker.network.bridge.name') or 'br-' + network['Id'][:12]
        families = ['iptables'] + (['ip6tables'] if network.get('EnableIPv6') else [])
        for family in families:
            if '-j DOCKER-USER' not in self.command(family, '-S', 'FORWARD'):
                raise UpgradeError('Missing Docker firewall hook for ' + family)
        for container in running:
            service = container['Config']['Labels']['com.docker.compose.service']
            images[service] = container['Image']
            for mount in container['Mounts']:
                if mount['Type'] == 'volume':
                    name = mount['Name']
                    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', name): raise UpgradeError('Invalid volume name.')
                    detail = json.loads(self.command('docker', 'volume', 'inspect', name))[0]
                    if (detail.get('Labels') or {}).get('com.docker.compose.project') != self.project:
                        raise UpgradeError('External/shared volumes require an operator-reviewed backup procedure: ' + name)
                    volumes[name] = {'file': 'volume-' + name + '.tar'}
                elif mount['Type'] == 'bind' and mount.get('RW') and mount['Source'] != '/var/run/docker.sock':
                    source = Path(mount['Source']).resolve()
                    if source != self.root and self.root not in source.parents:
                        raise UpgradeError('Writable bind outside the installation is not covered by backups: ' + str(source))
        # Include inactive webmail volumes too: switching clients may write to them.
        owned = self.command('docker', 'volume', 'ls', '-q', '--filter', f'label=com.docker.compose.project={self.project}').split()
        for name in owned:
            if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', name): raise UpgradeError('Invalid volume name.')
            volumes.setdefault(name, {'file': 'volume-' + name + '.tar'})
        for name in volumes:
            users = self.command('docker', 'ps', '-aq', '--filter', 'volume=' + name).split()
            if users:
                consumers = json.loads(self.command('docker', 'inspect', *users))
                if any((c['Config'].get('Labels') or {}).get('com.docker.compose.project') != self.project for c in consumers):
                    raise UpgradeError('Volume is also used outside this project: ' + name)
        return running, volumes, images, bridge, families, old_config

    def remove_inactive_webmail(self, selected):
        # Stopped containers can retain their network endpoint. Both clients use .248.
        for container in self.inspect_project():
            name = container['Config']['Labels'].get('com.docker.compose.service')
            if name in ('sogo-mailcow', 'roundcube-mailcow') and name != selected + '-mailcow':
                if container.get('State', {}).get('Running'): raise UpgradeError('Former webmail service is still running.')
                self.command('docker', 'rm', container['Id'])  # Never remove volumes.

    def volume_tool(self, volume, script, *arguments, readonly=True):
        mount = f'type=volume,src={volume},dst=/source' + (',readonly' if readonly else '')
        return self.command('docker', 'run', '--rm', '--network', 'none', '--read-only', '--security-opt', 'label=disable',
                            '--mount', mount, '--mount', f'type=bind,src={self.job["backup"]},dst=/backup',
                            HELPER_IMAGE, 'sh', '-ec', script, 'volume-backup', *arguments)

    def verify_backup(self):
        backup = Path(self.job['backup'])
        for filename, expected in self.job['checksums'].items():
            if Path(filename).name != filename or sha256(backup / filename) != expected:
                raise UpgradeError('Backup checksum verification failed: ' + filename)

    def cold_backup(self):
        backup = Path(self.job['backup'])
        self.command('tar', '--xattrs', '--acls', '--numeric-owner', '--exclude=./.git', '--exclude=./.update-ui.lock',
                     '-cpf', str(backup / 'files.tar'), '-C', str(self.root), '.')
        for volume, info in self.job['volumes'].items():
            self.volume_tool(volume, 'tar --xattrs --acls --numeric-owner -cpf "/backup/$1" -C /source .', info['file'])
        archives = ['images.tar', 'files.tar'] + [info['file'] for info in self.job['volumes'].values()]
        for name in archives:
            with (backup / name).open('rb') as stream: os.fsync(stream.fileno())
        self.job['checksums'] = {name: sha256(backup / name) for name in archives}
        self.verify_backup()
        shutil.copy2(__file__, backup / 'recover.py')
        atomic_json(backup / 'engine-config.json', self.config)
        atomic_json(backup / 'transaction.json', self.job)
        self.job['backup_complete'] = True
        atomic_json(self.journal, self.job)

    def stop_all(self):
        running = self.inspect_project(running=True)
        # Stop producers/supervisors before stores so accepted messages finish or remain queued.
        order = {'watchdog-mailcow': 0, 'ofelia-mailcow': 0, 'nginx-mailcow': 1,
                 'roundcube-mailcow': 2, 'sogo-mailcow': 2, 'postfix-mailcow': 3,
                 'dovecot-mailcow': 4, 'php-fpm-mailcow': 5, 'mysql-mailcow': 8, 'redis-mailcow': 9}
        running.sort(key=lambda c: order.get(c['Config']['Labels']['com.docker.compose.service'], 6))
        for container in running:
            self.command('docker', 'stop', '--time', '300', container['Id'])
            state = json.loads(self.command('docker', 'inspect', '--format', '{{json .State}}', container['Id']))
            if state.get('ExitCode') == 137 or state.get('OOMKilled'):
                raise UpgradeError('A service could not stop cleanly; restart the unchanged stack before retrying.')

    def health(self, expected):
        deadline = time.monotonic() + int(self.config.get('health_timeout', 240))
        last = 'Services are starting.'
        while time.monotonic() < deadline:
            containers = self.inspect_project()
            services = {c['Config']['Labels']['com.docker.compose.service']: c for c in containers}
            ok = True
            for name in expected:
                container = services.get(name)
                state = container.get('State', {}) if container else {}
                if not state.get('Running') or state.get('Health', {}).get('Status', 'healthy') != 'healthy':
                    last = name + ' is not ready.'; ok = False; break
            if ok:
                probes = [('nginx-mailcow', ['nginx', '-t']),
                          ('php-fpm-mailcow', ['php', '-r', 'require "/web/inc/lib/vendor/autoload.php"; exit(!is_file("/web/inc/lib/mailcow/Ui/WebmailAccess.php") || class_exists("Mailcow\\\\Ui\\\\WebmailAccess") ? 0 : 1);'])]
                if 'nginx-mailcow' in expected:
                    probes.append(('nginx-mailcow', ['sh', '-ec', 'wget -q -T 10 -O - http://127.0.0.1:65510/ | grep -q \'name="login_user"\'']))
                if 'roundcube-mailcow' in expected: probes.append(('roundcube-mailcow', ['php', '/var/www/html/healthcheck.php']))
                if 'sogo-mailcow' in expected:
                    probes.append(('php-fpm-mailcow', ['php', '-r',
                        '$body=@file_get_contents("http://sogo-mailcow:20000/SOGo.index/",false,stream_context_create(["http"=>["timeout"=>5,"ignore_errors"=>true]])); '
                        'exit($body!==false && preg_match("#^HTTP/[0-9.]+ [23][0-9]{2}#",$http_response_header[0]??"") ? 0 : 1);']))
                if 'postfix-mailcow' in expected: probes.append(('postfix-mailcow', ['postfix', 'status']))
                if 'dovecot-mailcow' in expected: probes.append(('dovecot-mailcow', ['doveadm', 'service', 'status', 'imap-login']))
                try:
                    for name, command in probes:
                        if name in expected: self.compose('exec', '-T', name, *command)
                    return
                except UpgradeError as error: last = str(error)
            time.sleep(2)
        raise UpgradeError('Health checks failed: ' + last)

    @recovery_signals
    def restore(self):
        if self.job.get('version') != 1 or Path(self.job['target']).resolve() != self.root:
            raise UpgradeError('Recovery journal belongs to a different target or engine protocol.')
        self.project = self.job['project']
        if self.command('docker', 'info', '--format', '{{.ID}}') != self.job['daemon_id']:
            raise UpgradeError('Docker daemon identity changed; automatic volume recovery is not safe.')
        firewall = Firewall(self.job['bridge'], self.job['families'], self.job['id'], self.run)
        firewall.block()
        # Once public access was committed, never restore an older mailbox snapshot.
        if self.job.get('committed'):
            firewall.release(); self.phase('complete', 'Update completed; traffic guard cleanup recovered.'); return
        self.phase('restoring', 'Recovering the previous stack while mail access remains paused.')
        self.stop_all()
        if self.job.get('applied'):
            self.verify_backup()
            backup = Path(self.job['backup'])
            # The backup was created here and verified; no user-supplied archive is extracted.
            for child in self.root.iterdir():
                if child.name in ('.git', '.update-ui.lock'): continue
                if child.is_dir() and not child.is_symlink(): shutil.rmtree(child)
                else: child.unlink()
            self.command('tar', '--xattrs', '--acls', '--numeric-owner', '-xpf', str(backup / 'files.tar'), '-C', str(self.root))
            self.command('git', 'reset', '--mixed', self.job['old_commit'])
            if self.job.get('old_branch'):
                self.command('git', 'checkout', self.job['old_branch'])
            self.load_environment()
            self.command('docker', 'image', 'load', '-i', str(backup / 'images.tar'))
            for volume, info in self.job['volumes'].items():
                # Verify the volume still exists; never silently create a similarly named empty volume.
                self.command('docker', 'volume', 'inspect', volume)
                self.volume_tool(volume, 'find /source -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; '
                                 'tar --xattrs --acls --numeric-owner -xpf "/backup/$1" -C /source', info['file'], readonly=False)
            override = Path(self.job['backup']) / 'old-images.json'
            atomic_json(override, {'services': {name: {'image': image, 'pull_policy': 'never'} for name, image in self.job['images'].items()}})
            self.remove_inactive_webmail('roundcube' if 'roundcube-mailcow' in self.job['images'] else 'sogo')
            self.compose('up', '-d', '--no-deps', '--force-recreate', *self.job['images'], extra=override)
        else:
            self.load_environment()
            for identifier in self.job['old_containers']: self.command('docker', 'start', identifier)
        self.health(set(self.job['images']))
        firewall.release()
        self.phase('rolled_back', 'Update failed. The previous stack and data were recovered; backup retained.')

    def upgrade(self, source, mode='roundcube', check=False):
        self.preflight(readonly=check)
        source = Path(source).resolve()
        commit = self.command('git', 'rev-parse', 'HEAD', cwd=source)
        if not re.fullmatch(r'[a-f0-9]{40,64}', commit): raise UpgradeError('Invalid release commit.')
        self.command('git', 'fetch', str(source), commit)
        preserve, replace = self.installation_plan(commit)
        client = self.selected_client(mode)
        running, volumes, images, bridge, families, old_config = self.capture()
        old_env = dict(self.env)
        self.set_client_environment(client)
        candidate = json.loads(self.compose('config', '--format', 'json', source=source))
        for key in ('ipam', 'driver', 'driver_opts', 'enable_ipv6', 'internal'):
            if candidate['networks']['mailcow-network'].get(key) != old_config['networks']['mailcow-network'].get(key):
                raise UpgradeError('Network/subnet changes require a separate reviewed migration.')
        for name, service in candidate['services'].items():
            if service.get('network_mode') == 'host' and name != 'netfilter-mailcow':
                raise UpgradeError('Extra host-network services require a reviewed maintenance policy.')
            if set(service.get('networks', {})) - {'mailcow-network'}:
                raise UpgradeError('Extra service networks require a reviewed maintenance policy.')
        if any('build' in service for service in candidate['services'].values()): raise UpgradeError('Local image builds require a separate reviewed deployment.')
        for name in ('nginx-mailcow', 'php-fpm-mailcow', client + '-mailcow'):
            if name not in candidate['services']: raise UpgradeError('Release does not contain required service ' + name)
        if check:
            print(f'Validated {commit}, webmail={client}. A full cold backup and health checks will run during upgrade.'); return
        self.ensure_recovery_service(source)
        identifier = secrets.token_hex(16)
        backup = self.backups / (time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-' + identifier[:8])
        backup.mkdir(mode=0o700)
        self.job = {'version': 1, 'target': str(self.root), 'daemon_id': self.command('docker', 'info', '--format', '{{.ID}}'),
                    'id': identifier, 'phase': 'preparing', 'commit': commit, 'client': client,
                    'backup': str(backup), 'old_commit': self.command('git', 'rev-parse', 'HEAD'),
                    'old_branch': self.command('git', 'branch', '--show-current'), 'project': self.project,
                    'old_containers': [c['Id'] for c in running], 'volumes': volumes, 'images': images,
                    'bridge': bridge, 'families': families, 'checksums': {}, 'applied': False, 'committed': False,
                    'request_id': getattr(self, 'request_id', None)}
        self.job.update(preserved_files=preserve, replaced_untracked=replace)
        firewall = Firewall(bridge, families, identifier, self.run)
        try:
            self.phase('downloading', 'Downloading the selected release images before pausing mail access.')
            docker_root = Path(self.command('docker', 'info', '--format', '{{.DockerRootDir}}'))
            if not docker_root.is_dir(): raise UpgradeError('Docker storage is not on this host; remote/Desktop engines require manual deployment.')
            if shutil.disk_usage(docker_root).free < int(self.config.get('reserve_bytes', 5 * 1024 ** 3)):
                raise UpgradeError('Free Docker storage is below the configured reserve. No images were pulled.')
            self.compose('pull', source=source)
            self.command('docker', 'pull', HELPER_IMAGE)
            # Estimate cold data and full image archives; retain headroom rather than delete old backups.
            volume_bytes = sum(int(self.volume_tool(name, 'du -sb /source | cut -f1')) for name in volumes)
            saved_images = sorted(set(images.values())) + [HELPER_IMAGE]
            image_info = json.loads(self.command('docker', 'image', 'inspect', *saved_images))
            image_bytes = sum(info['Size'] for info in image_info)
            files_bytes = int(self.command('du', '-sb', str(self.root)).split()[0])
            reserve = int(self.config.get('reserve_bytes', 5 * 1024 ** 3))
            if shutil.disk_usage(backup).free < int((volume_bytes + image_bytes + files_bytes) * 1.2) + reserve:
                self.phase('failed', 'Insufficient backup space. Existing stack was not changed.'); raise UpgradeError(self.job['message'])
            self.command('docker', 'image', 'save', '-o', str(backup / 'images.tar'), *saved_images)
            self.phase('maintenance', 'Pausing mail connections for a consistent backup and reversible upgrade.')
            self.job['guarded'] = True; atomic_json(self.journal, self.job)
            firewall.block()
            self.stop_all()
            self.phase('backing_up', 'Archiving and verifying the installation, named volumes and previous images.')
            self.cold_backup()
            self.phase('applying', 'Installing the selected fork release and webmail configuration.')
            self.job['applied'] = True; atomic_json(self.journal, self.job)
            self.command('git', 'fetch', str(source), commit)
            for name in replace: (self.root / name).unlink()  # Already retained in the verified cold archive.
            self.command('git', 'checkout', '--no-overwrite-ignore', '--detach', commit)
            if preserve:
                self.command('tar', '--xattrs', '--acls', '--numeric-owner', '-xpf', str(backup / 'files.tar'), '-C', str(self.root),
                             *('./' + name for name in preserve))
                self.command('git', '-c', 'user.name=Mailcow instance', '-c', 'user.email=instance@localhost',
                             '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '--only',
                             '-m', 'Preserve instance configuration over fork ' + commit[:12], '--', *preserve)
            self.job['deployed_commit'] = self.command('git', 'rev-parse', 'HEAD')
            self.write_client_environment()
            self.remove_inactive_webmail(client)
            quarantine = backup / 'maintenance.yml'
            quarantine.write_text('services:\n' + ''.join(
                f'  {name}:\n    ports: !reset []\n    restart: "no"\n' for name in candidate['services']))
            # Stop a former webmail container before the selected client reuses .248.
            active = {name for name, service in candidate['services'].items()
                      if not service.get('profiles') or client in service['profiles']}
            self.compose('up', '-d', '--no-build', '--force-recreate', extra=quarantine)
            self.phase('health_check', 'Checking the isolated stack before publishing any service ports.')
            self.health(active)
            firewall.block()
            self.compose('up', '-d', '--no-build', '--force-recreate')
            self.health(active)
            # Nothing that mutates mailbox data is allowed after this point.
            self.job['committed'] = True; atomic_json(self.journal, self.job)
            firewall.release()
            self.phase('complete', f'Upgraded to {commit[:12]} with {client}. Verified backup retained.')
        except BaseException:
            try:
                self.env = old_env
                if self.job.get('guarded'): self.restore()
                else: self.phase('failed', 'Upgrade stopped before changing the running stack; inspect the worker log.')
            except BaseException as recovery_error:
                self.phase('manual_recovery', 'Recovery needs operator attention. Mail access remains guarded; retain all backups.')
                raise UpgradeError(f'Recovery failed; journal: {self.journal}. {recovery_error}')
            if self.job.get('committed') and self.job['phase'] == 'complete': return
            raise


def load_config(path):
    stat = path.stat()
    if stat.st_uid != 0 or stat.st_mode & 0o022: raise UpgradeError('Worker configuration must be root-owned and not writable by other users.')
    return json.loads(path.read_text())


def clone_release(repo, ref, folder):
    execute(['git', 'clone', '--quiet', '--single-branch', '--branch', ref, '--', repo, str(folder)],
            env=dict(os.environ, GIT_TERMINAL_PROMPT='0'), timeout=180)


def redis_call(engine, *arguments):
    containers = [c for c in engine.inspect_project(running=True)
                  if c['Config']['Labels'].get('com.docker.compose.service') == 'redis-mailcow']
    if len(containers) != 1: raise UpgradeError('Redis is not available.')
    env = dict(engine.env, REDISCLI_AUTH=engine.env['REDISPASS'])
    result = engine.run(['docker', 'exec', '-e', 'REDISCLI_AUTH', containers[0]['Id'],
                         'redis-cli', '--raw', *arguments], env=env, timeout=15)
    return result.stdout.strip()


def daemon(config, config_path=Path('/etc/mailcow-simplified-updates.json')):
    loaded_engine = sha256(Path(__file__))
    engine = Engine(config)
    # Recover a process/power interruption before accepting another job.
    if engine.journal.exists():
        engine.job = json.loads(engine.journal.read_text())
        if engine.job['phase'] == 'manual_recovery':
            raise UpgradeError('Recovery is awaiting an operator. Inspect the journal and run --recover explicitly.')
        if engine.job['phase'] not in TERMINAL:
            with open(engine.root / '.update-ui.lock', 'a') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                engine.restore()
    engine.load_environment()
    if engine.job and engine.job.get('request_id') and engine.job['phase'] in TERMINAL:
        redis_call(engine, 'EVAL', "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1],KEYS[2]) end return 0",
                   '2', KEYS['lock'], KEYS['queue'], engine.job['request_id'])
    candidate, last_check = None, 0
    while True:
        claimed = None
        try:
            current = engine.command('git', 'rev-parse', 'HEAD')
            if engine.job and engine.job.get('committed') and engine.job.get('deployed_commit', engine.job['commit']) == current:
                current = engine.job['commit']
            if time.time() - last_check > 60:
                ref = config.get('ref', 'master')
                output = engine.command('git', 'ls-remote', '--', config['repo'], 'refs/heads/' + ref,
                                        'refs/tags/' + ref, 'refs/tags/' + ref + '^{}', timeout=30)
                refs = {line.split()[1]: line.split()[0] for line in output.splitlines() if len(line.split()) == 2}
                candidate = refs.get('refs/heads/' + ref) or refs.get('refs/tags/' + ref + '^{}') or refs.get('refs/tags/' + ref)
                last_check = time.time()
            status = engine.public_status() if engine.job else {'phase': 'idle', 'message': 'No upgrade is running.'}
            heartbeat = {'at': int(time.time()), 'candidate': candidate if candidate != current else None,
                         'ready': bool(candidate), 'message': 'Update available.' if candidate and candidate != current else 'This fork is up to date.' if candidate else 'Configured release was not found.'}
            redis_call(engine, 'SET', KEYS['heartbeat'], json.dumps(heartbeat), 'EX', '45')
            request = redis_call(engine, 'GET', KEYS['queue'])
            if request:
                request = json.loads(request)
                with open(engine.root / '.update-ui.lock', 'a') as lock:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    claimed = request.get('id')
                    if not re.fullmatch(r'[a-f0-9]{32}', request.get('id', '')) or request.get('commit') != candidate:
                        raise UpgradeError('Queued release no longer matches the configured remote.')
                    engine.request_id = claimed
                    redis_call(engine, 'SET', KEYS['heartbeat'], json.dumps({'at': int(time.time()), 'ready': False, 'message': 'Preparing the reviewed upgrade.'}), 'EX', '3600')
                    redis_call(engine, 'SET', KEYS['status'], json.dumps({'id': claimed, 'phase': 'downloading', 'message': 'Downloading and validating the reviewed fork release.'}))
                    with tempfile.TemporaryDirectory(prefix='mailcow-release-') as directory:
                        source = Path(directory) / 'repo'
                        clone_release(config['repo'], config.get('ref', 'master'), source)
                        if engine.command('git', 'rev-parse', 'HEAD', cwd=source) != candidate:
                            raise UpgradeError('Remote changed after review. Review the new release before updating.')
                        engine.notify = lambda value: redis_call(engine, 'SET', KEYS['status'], json.dumps(value))
                        engine.upgrade(source, mode='preserve')
            if engine.job: redis_call(engine, 'SET', KEYS['status'], json.dumps(engine.public_status()))
        except Exception as error:
            print('Update worker: ' + str(error), file=sys.stderr, flush=True)
            with contextlib.suppress(Exception):
                if claimed and (not engine.job or engine.job.get('request_id') != claimed):
                    redis_call(engine, 'SET', KEYS['status'], json.dumps({'id': claimed, 'phase': 'failed', 'message': 'Upgrade preflight failed or the release changed. Inspect the worker log and review before retrying.'}))
                redis_call(engine, 'SET', KEYS['heartbeat'], json.dumps({'at': int(time.time()), 'ready': False, 'message': 'Update worker needs operator attention; inspect its service log.'}), 'EX', '45')
        finally:
            if claimed and (not engine.job or engine.job['phase'] in TERMINAL):
                with contextlib.suppress(Exception):
                    redis_call(engine, 'EVAL', "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1],KEYS[2]) end return 0", '2', KEYS['lock'], KEYS['queue'], claimed)
        if (not engine.job or engine.job['phase'] in TERMINAL) and sha256(Path(__file__)) != loaded_engine:
            os.execv(sys.executable, [sys.executable, str(Path(__file__).resolve()), '--daemon', '--config', str(config_path)])
        time.sleep(10)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', type=Path, default=Path('/etc/mailcow-simplified-updates.json'))
    parser.add_argument('--source', type=Path)
    parser.add_argument('--target', type=Path)
    parser.add_argument('--backup-dir', type=Path)
    parser.add_argument('--mode', choices=['roundcube', 'preserve', 'sogo'], default='roundcube')
    parser.add_argument('--release-ref', help='configured branch/tag for a newly installed host worker')
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--daemon', action='store_true')
    parser.add_argument('--guard-only', action='store_true')
    parser.add_argument('--recover', action='store_true')
    args = parser.parse_args()
    if args.source:
        installed = Path('/etc/mailcow-simplified-updates.json')
        config = load_config(installed) if installed.exists() else {}
        if config and Path(config['target']).resolve() != args.target.resolve():
            raise UpgradeError('Another instance already owns the host recovery service.')
        config['target'] = str(args.target)
        if args.release_ref and not installed.exists(): config['ref'] = args.release_ref
        if args.backup_dir: config['backup_dir'] = str(args.backup_dir)
    else: config = load_config(args.config)
    if args.daemon: daemon(config, args.config); return
    engine = Engine(config)
    if args.guard_only or args.recover:
        if engine.journal.exists():
            engine.job = json.loads(engine.journal.read_text())
            if engine.job['phase'] not in TERMINAL:
                if args.guard_only: Firewall(engine.job['bridge'], engine.job['families'], engine.job['id']).block()
                else:
                    with open(engine.root / '.update-ui.lock', 'a') as lock:
                        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        engine.restore()
        return
    with open(engine.root / '.update-ui.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        engine.upgrade(args.source, args.mode, args.check)
    if not args.check:
        result = execute(['systemctl', 'start', 'mailcow-simplified-updates.service'], allow_failure=True)
        if result.returncode: print('Upgrade committed. Start the optional overview update worker after inspecting its service log.', file=sys.stderr)


if __name__ == '__main__':
    def interrupt(signum, frame): raise UpgradeInterrupted(signum)
    signal.signal(signal.SIGINT, interrupt); signal.signal(signal.SIGTERM, interrupt)
    try: main()
    except (Exception, UpgradeInterrupted) as error:
        print('Upgrade failed: ' + str(error), file=sys.stderr)
        sys.exit(128 + error.signum if isinstance(error, UpgradeInterrupted) else 1)
