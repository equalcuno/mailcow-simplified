#!/usr/bin/env bash
# Standalone bootstrap. Download this file into an existing Mailcow installation.
set -euo pipefail
command -v python3 >/dev/null || { echo 'Python 3 is required.' >&2; exit 1; }
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
exec python3 - "$SCRIPT_DIR" "$@" <<'PY'
import argparse
import fcntl
from pathlib import Path
import os
import signal
import subprocess
import sys
import tempfile

parser = argparse.ArgumentParser(prog='upgrade.sh', description=(
    'Upgrade the complete Mailcow Simplified fork with cold backups and guarded recovery. '
    'Run as root on the Linux mailcow server.'))
parser.add_argument('--target', default=sys.argv[1], help='existing mailcow directory (default: script directory)')
parser.add_argument('--repo', default='https://github.com/equalcuno/mailcow-simplified.git', help='fork Git URL (HTTPS or SSH)')
parser.add_argument('--ref', default='master', help='tested branch or tag (default: master)')
parser.add_argument('--backup-dir', help='backup directory outside the installation (default: installed worker config or /var/backups/mailcow-simplified)')
parser.add_argument('--check', action='store_true', help='download and validate without changing files or services')
mode = parser.add_mutually_exclusive_group()
mode.add_argument('--skip-roundcube', action='store_true', help='keep the current webmail client; do not migrate SOGo to Roundcube')
mode.add_argument('--regress-sogo', action='store_true', help='switch back to SOGo, retaining Roundcube and SOGo data')
args = parser.parse_args(sys.argv[2:])
target = Path(args.target).resolve()
if not (target / 'mailcow.conf').is_file() or not (target / 'docker-compose.yml').is_file():
    parser.error('Target must be an existing Mailcow installation with mailcow.conf.')
environment = dict(os.environ, GIT_TERMINAL_PROMPT='0')
def interrupted(signum, frame): raise InterruptedError('Upgrade interrupted; waiting for recovery.')
signal.signal(signal.SIGTERM, interrupted)
try:
    # Keep one installation lock from before download until child recovery and
    # temporary-checkout cleanup finish. The worker inherits this same lock.
    lock = open(target / '.update-ui.lock', 'a')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise RuntimeError('Another upgrade or recovery is already running for this installation.') from None
    environment['MAILCOW_UPGRADE_LOCK_FD'] = str(lock.fileno())
    with tempfile.TemporaryDirectory(prefix='mailcow-upgrade-') as directory:
        source = Path(directory) / 'repo'
        print(f'Downloading {args.repo} ({args.ref})…', flush=True)
        subprocess.run(['git', 'clone', '--quiet', '--single-branch', '--branch', args.ref,
                        '--', args.repo, str(source)], env=environment, check=True)
        worker = source / 'helper-scripts/upgrade_worker.py'
        if not worker.is_file() or worker.is_symlink():
            raise RuntimeError('The selected release has no full-stack upgrade engine. Publish the fork changes first.')
        selected = 'sogo' if args.regress_sogo else 'preserve' if args.skip_roundcube else 'roundcube'
        command = [sys.executable, str(worker), '--source', str(source), '--target', str(target), '--mode', selected,
                   '--release-ref', args.ref]
        if args.backup_dir: command += ['--backup-dir', str(Path(args.backup_dir).resolve())]
        if args.check: command.append('--check')
        child = subprocess.Popen(command, env=environment, pass_fds=(lock.fileno(),))
        try:
            result = child.wait()
        except (KeyboardInterrupt, InterruptedError):
            # Do not remove the checkout or kill the engine while it restores a backup.
            signal.signal(signal.SIGINT, signal.SIG_IGN)
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            if child.poll() is None: child.send_signal(signal.SIGTERM)
            child.wait()
            raise
        if result: raise subprocess.CalledProcessError(result, command)
        print('Temporary checkout removed after this command exits.', flush=True)
except (Exception, KeyboardInterrupt) as error:
    print(f'Upgrade stopped: {error}', file=sys.stderr)
    sys.exit(1)
PY
