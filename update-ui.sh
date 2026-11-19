#!/usr/bin/env bash
# Standalone Plates deployment: copy this script to the existing mailcow directory.
set -euo pipefail
command -v python3 >/dev/null || { echo 'Python 3 is required.' >&2; exit 1; }
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
exec python3 - "$SCRIPT_DIR" "$@" <<'PY'
import argparse
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile

CORE = (
    'data/web/inc/twig.inc.php',
    'data/web/inc/triggers.admin.inc.php',
    'data/web/json_api.php',
    'data/web/api/openapi.yaml',
    'data/web/js/site/mailbox.js',
    'data/web/templates/admin.twig',
    'data/web/templates/base.twig',
    'data/web/inc/lib/mailcow/Mailbox/MailboxSearchScope.php',
)
DIRECTORIES = ('data/web/ui/plates/', 'data/web/inc/lib/mailcow/Ui/')
AUTOLOAD = (
    'data/web/inc/lib/composer.json',
    'data/web/inc/lib/vendor/composer/autoload_psr4.php',
    'data/web/inc/lib/vendor/composer/autoload_static.php',
)
STATE = '.plates-ui-state.json'


def run(command, cwd=None, data=None):
    result = subprocess.run(command, cwd=cwd, input=data, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE)
    if result.returncode:
        detail = result.stderr.decode(errors='replace').strip()
        if not detail:
            detail = result.stdout.decode(errors='replace').strip()
        raise RuntimeError(f'{command[0]} failed: {detail}')
    return result.stdout.decode().strip()


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None


def relative(value):
    path = PurePosixPath(value)
    if not value or path.is_absolute() or '..' in path.parts or str(path) != value:
        raise RuntimeError(f'Unsafe package path: {value!r}')
    return value


def managed(path):
    return path in CORE or any(path.startswith(prefix) for prefix in DIRECTORIES)


def checked(root, name):
    relative(name)
    path = root
    for part in PurePosixPath(name).parts:
        path = path / part
        if path.is_symlink():
            raise RuntimeError(f'Refusing a symlink in deployment path: {path}')
    if path.exists() and not path.is_file():
        raise RuntimeError(f'Expected a regular file: {path}')
    return path


def read_state(root):
    path = checked(root, STATE)
    if not path.exists():
        return {'files': {}, 'dependencies': {}}
    state = json.loads(path.read_text())
    if state.get('version') != 1:
        raise RuntimeError('Unsupported Plates deployment state version.')
    for name in state['files']:
        if not managed(relative(name)):
            raise RuntimeError(f'Unexpected file in deployment state: {name}')
    return state


def install(path, content, metadata=None):
    missing = []
    parent = path.parent
    while not parent.exists():
        missing.append(parent)
        parent = parent.parent
    for directory in reversed(missing):
        owner = directory.parent.stat()
        directory.mkdir(mode=0o755)
        directory.chmod(0o755)  # Root's restrictive umask must not hide web assets.
        current = directory.stat()
        if (current.st_uid, current.st_gid) != (owner.st_uid, owner.st_gid):
            os.chown(directory, owner.st_uid, owner.st_gid)
    if metadata is None:
        stat = path.stat() if path.exists() else path.parent.stat()
        metadata = {'mode': (stat.st_mode & 0o777) if path.exists() else 0o644,
                    'uid': stat.st_uid, 'gid': stat.st_gid}
    fd, temporary = tempfile.mkstemp(prefix='.plates-install-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
            os.fchmod(stream.fileno(), metadata['mode'])
            current = os.fstat(stream.fileno())
            if (current.st_uid, current.st_gid) != (metadata['uid'], metadata['gid']):
                os.fchown(stream.fileno(), metadata['uid'], metadata['gid'])
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def backup_files(root, destination, names, info):
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    timestamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup = Path(tempfile.mkdtemp(prefix=f'plates-{timestamp}-', dir=destination))
    entries = {}
    for name in sorted(names):
        path = checked(root, name)
        if path.exists():
            stat = path.stat()
            entries[name] = {'existed': True, 'mode': stat.st_mode & 0o777,
                             'uid': stat.st_uid, 'gid': stat.st_gid, 'sha256': digest(path)}
            saved = backup / 'files' / name
            saved.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, saved)
            if digest(saved) != entries[name]['sha256']:
                raise RuntimeError(f'Backup verification failed: {name}')
        else:
            entries[name] = {'existed': False}
    info.update({'target': str(root), 'entries': entries})
    (backup / 'backup.json').write_text(json.dumps(info, indent=2) + '\n')
    print(f'Backup: {backup}', flush=True)
    return backup, entries


def restore(root, backup, entries):
    # Refuse a corrupt/incomplete backup before replacing any live files.
    for name, entry in entries.items():
        checked(root, name)
        if entry['existed'] and digest(backup / 'files' / name) != entry['sha256']:
            raise RuntimeError(f'Backup verification failed: {name}')
    for name, entry in entries.items():
        path = checked(root, name)
        if entry['existed']:
            install(path, (backup / 'files' / name).read_bytes(), entry)
        elif path.exists():
            path.unlink()


def interrupted(signum, frame):
    raise RuntimeError(f'Interrupted by signal {signum}')


def main():
    parser = argparse.ArgumentParser(prog='update-ui.sh', description=(
        'Download and install Plates onto an existing mailcow instance. '
        'Only UI files are changed; a verified file backup is kept outside the web root.'))
    parser.add_argument('--target', default=sys.argv[1], help='mailcow directory (default: script directory)')
    parser.add_argument('--repo', default='https://github.com/equalcuno/mailcow-simplified.git',
                        help='custom mailcow Git URL (HTTPS or SSH)')
    parser.add_argument('--ref', default='master', help='branch or tag to deploy (default: master)')
    parser.add_argument('--backup-dir', help='backup parent directory (default: TARGET/ui-backups)')
    parser.add_argument('--check', action='store_true', help='download and validate without installing or restarting')
    parser.add_argument('--restore', metavar='BACKUP', help='restore a backup made by this script, without downloading')
    args = parser.parse_args(sys.argv[2:])
    root = Path(args.target).resolve(strict=True)
    if not (root / 'mailcow.conf').is_file() or not (root / 'docker-compose.yml').is_file():
        raise RuntimeError(f'Not an existing mailcow installation: {root}')
    for program in ('git', 'docker'):
        if not shutil.which(program):
            raise RuntimeError(f'{program} is required.')
    try:
        run(['docker', 'compose', 'version'])
        compose = ['docker', 'compose']
    except RuntimeError:
        if not shutil.which('docker-compose'):
            raise RuntimeError('Docker Compose is required.')
        run(['docker-compose', 'version'])
        compose = ['docker-compose']

    def service(*arguments, data=None):
        return run(compose + list(arguments), cwd=root, data=data)

    lock_fd = os.open(root / '.update-ui.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lock_fd, 'w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('Another UI update is already running for this instance.')
        container = service('ps', '--status', 'running', '-q', 'php-fpm-mailcow').splitlines()
        if len(container) != 1:
            raise RuntimeError('Expected one running php-fpm-mailcow container.')
        mounts = json.loads(run(['docker', 'inspect', '--format', '{{json .Mounts}}', container[0]]))
        if not any(mount['Destination'] == '/web' and mount.get('Type') == 'bind'
                   and Path(mount['Source']).resolve() == root / 'data/web' for mount in mounts):
            raise RuntimeError('The running PHP container does not mount this instance\'s data/web at /web.')
        backup_parent = (Path(args.backup_dir) if args.backup_dir else root / 'ui-backups').resolve()
        if backup_parent == root / 'data/web' or root / 'data/web' in backup_parent.parents:
            raise RuntimeError('Backups must be outside the web root.')
        if args.restore:
            if args.check:
                raise RuntimeError('--restore cannot be combined with --check.')
            backup = Path(args.restore).resolve(strict=True)
            info = json.loads((backup / 'backup.json').read_text())
            if info['target'] != str(root):
                raise RuntimeError('This backup belongs to a different mailcow installation.')
            entries = info['entries']
            for name in entries:
                if name != STATE and not managed(relative(name)):
                    raise RuntimeError(f'Unexpected backup path: {name}')
                if entries[name]['existed'] and digest(backup / 'files' / name) != entries[name]['sha256']:
                    raise RuntimeError(f'Backup verification failed: {name}')
            safety, before = backup_files(root, backup_parent, entries, {'restoring': str(backup)})
            try:
                restore(root, backup, entries)
                service('restart', 'php-fpm-mailcow')
            except BaseException as failure:
                signal.signal(signal.SIGINT, signal.SIG_IGN)
                signal.signal(signal.SIGTERM, signal.SIG_IGN)
                try:
                    restore(root, safety, before)
                    service('restart', 'php-fpm-mailcow')
                except BaseException as rollback_failure:
                    raise RuntimeError(f'Restore rollback failed: {rollback_failure}. '
                                       f'Current UI backup retained at {safety}') from failure
                raise RuntimeError('Restore failed; the UI from before the restore was recovered.') from failure
            print(f'Restored UI backup: {backup}')
            return

        print(f'Downloading {args.repo} ({args.ref})...', flush=True)
        with tempfile.TemporaryDirectory(prefix='mailcow-ui-') as directory:
            source = Path(directory) / 'repo'
            run(['git', 'clone', '--quiet', '--depth', '1', '--single-branch', '--branch', args.ref,
                 '--', args.repo, str(source)])
            commit = run(['git', 'rev-parse', 'HEAD'], cwd=source)
            manifest = checked(source, 'data/web/ui/plates/compatibility.json')
            if not manifest.is_file():
                raise RuntimeError('The selected repo/ref has no Plates UI. Commit and push the custom UI first.')
            compatibility = json.loads(manifest.read_text())
            base = compatibility['reviewed_base']
            if not re.fullmatch(r'[0-9a-f]{40,64}', base):
                raise RuntimeError('Invalid reviewed base in compatibility manifest.')
            try:
                run(['git', 'cat-file', '-e', f'{base}^{{commit}}'], cwd=source)
            except RuntimeError:
                run(['git', 'fetch', '--quiet', '--depth', '1', 'origin', base], cwd=source)
            tracked = run(['git', 'ls-files', '-z'], cwd=source).split('\0')
            files = sorted(name for name in tracked if name and managed(name))
            required = CORE + ('data/web/ui/plates/presentation.php',
                               'data/web/inc/lib/mailcow/Ui/Branding.php',
                               'data/web/inc/lib/mailcow/Ui/OverviewStats.php')
            if any(name not in files for name in required):
                raise RuntimeError('The downloaded UI package is incomplete.')
            for name in files:
                if not checked(source, name).is_file():
                    raise RuntimeError(f'Missing UI file: {name}')
                checked(root, name)
            previous = read_state(root)
            dependencies = compatibility['sha256']
            if not dependencies or any(name not in dependencies for name in CORE[:7]):
                raise RuntimeError('The compatibility manifest is missing core UI dependencies.')
            mismatches = []
            for name, expected in dependencies.items():
                if (not relative(name).startswith('data/') or not isinstance(expected, str)
                        or not re.fullmatch(r'[0-9a-f]{64}', expected)
                        or digest(checked(source, name)) != expected):
                    raise RuntimeError(f'Unreviewed source dependency: {name}')
                accepted = {expected}
                if name in files:
                    original = subprocess.run(['git', 'show', f'{base}:{name}'], cwd=source,
                                              stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                    if original.returncode == 0:
                        accepted.add(hashlib.sha256(original.stdout).hexdigest())
                    if previous.get('dependencies', {}).get(name):
                        accepted.add(previous['dependencies'][name])
                if digest(checked(root, name)) not in accepted:
                    mismatches.append(name)
            # The added classes require the fork's existing PSR-4 autoloader.
            for name in AUTOLOAD:
                if digest(checked(root, name)) != digest(checked(source, name)):
                    mismatches.append(name)
            # Catch local edits, and safely remove files retired by later UI releases.
            for name, expected in previous['files'].items():
                current = digest(checked(root, name))
                if current not in (expected, digest(source / name) if name in files else None):
                    mismatches.append(name)
            if mismatches:
                raise RuntimeError('Compatibility review required; live files were not changed:\n  '
                                   + '\n  '.join(sorted(set(mismatches))))
            for name in files:
                if name.endswith('.php'):
                    service('exec', '-T', 'php-fpm-mailcow', 'php', '-l', data=(source / name).read_bytes())
            print(f'Validated UI release {commit} ({len(files)} files).', flush=True)
            if args.check:
                print('Check complete. Live UI was not changed; temporary checkout will be removed.')
                return
            names = set(files) | set(previous['files']) | {STATE}
            backup, entries = backup_files(root, backup_parent, names,
                                            {'repo': args.repo, 'ref': args.ref, 'commit': commit})
            try:
                for name in files:
                    install(checked(root, name), (source / name).read_bytes())
                for name in set(previous['files']) - set(files):
                    path = checked(root, name)
                    if path.exists():
                        path.unlink()
                service('restart', 'php-fpm-mailcow')
                service('exec', '-T', 'php-fpm-mailcow', 'php', '-r',
                        'require "/web/inc/lib/vendor/autoload.php"; '
                        'foreach (["Mailcow\\\\Ui\\\\Branding", "Mailcow\\\\Ui\\\\OverviewStats", '
                        '"Mailcow\\\\Mailbox\\\\MailboxSearchScope"] as $class) '
                        '{ if (!class_exists($class)) { fwrite(STDERR, "Missing class: $class\\n"); exit(1); } }')
                state = {'version': 1, 'repo': args.repo, 'ref': args.ref, 'commit': commit,
                         'dependencies': dependencies,
                         'files': {name: digest(source / name) for name in files}}
                install(root / STATE, (json.dumps(state, indent=2) + '\n').encode())
            except BaseException as failure:
                # A second interrupt must not abandon restoration halfway through.
                signal.signal(signal.SIGINT, signal.SIG_IGN)
                signal.signal(signal.SIGTERM, signal.SIG_IGN)
                print(f'Update failed: {failure}\nRestoring {backup}...', file=sys.stderr, flush=True)
                try:
                    restore(root, backup, entries)
                    service('restart', 'php-fpm-mailcow')
                except BaseException as rollback_failure:
                    raise RuntimeError(f'Automatic rollback failed: {rollback_failure}. '
                                       f'Backup retained at {backup}') from failure
                raise RuntimeError('Previous UI restored after the failed update.') from failure
            restore_command = shlex.join(['bash', str(Path(sys.argv[1]) / 'update-ui.sh'),
                                          '--target', str(root), '--restore', str(backup)])
            print(f'UI updated to {commit}. Temporary checkout will be removed.\n'
                  'Open /?ui=plates&components=redesigned to verify the interface.\n'
                  f'To restore: {restore_command}')


signal.signal(signal.SIGINT, interrupted)
signal.signal(signal.SIGTERM, interrupted)
try:
    main()
except (Exception, KeyboardInterrupt) as error:
    print(f'Error: {error}', file=sys.stderr)
    sys.exit(1)
PY
