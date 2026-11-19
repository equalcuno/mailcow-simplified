#!/usr/bin/env bash
# Install the optional host service used by Overview's Update server action.
set -euo pipefail
SOURCE_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ROOT=$SOURCE_ROOT
START=true
if [[ ${1:-} == --help ]]; then
  echo 'Usage: sudo bash helper-scripts/install-upgrade-worker.sh'
  echo 'Install the root-owned Linux/systemd upgrade worker for this existing instance.'
  exit 0
fi
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) [[ $# -ge 2 ]] || exit 2; ROOT=$(cd "$2" && pwd); shift 2 ;;
    --no-start) START=false; shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
[[ $(uname -s) == Linux && $EUID == 0 ]] || { echo 'Run as root on the Linux mailcow server.' >&2; exit 1; }
[[ -f "$ROOT/mailcow.conf" ]] || { echo 'Configure mailcow first.' >&2; exit 1; }
for executable in python3 docker systemctl iptables ip6tables; do command -v "$executable" >/dev/null || { echo "$executable is required." >&2; exit 1; }; done
install -d -m 755 /usr/local/lib/mailcow-simplified-updates
install -m 755 "$SOURCE_ROOT/helper-scripts/upgrade_worker.py" /usr/local/lib/mailcow-simplified-updates/worker.py
python3 - "$ROOT" <<'PY'
import json, os, sys
from pathlib import Path
path = Path('/etc/mailcow-simplified-updates.json')
target = str(Path(sys.argv[1]).resolve())
if path.exists():
    config = json.loads(path.read_text())
    if config['target'] != target:
        sys.exit('An upgrade worker is already configured for a different instance.')
else:
    config = {'target': target, 'repo': 'https://github.com/equalcuno/mailcow-simplified.git',
              'ref': 'master', 'backup_dir': '/var/backups/mailcow-simplified',
              'state_dir': '/var/lib/mailcow-simplified-updates', 'health_timeout': 240,
              'reserve_bytes': 5368709120}
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, 'w') as stream: json.dump(config, stream, indent=2); stream.write('\n')
os.chown(path, 0, 0); os.chmod(path, 0o600)
PY
cat > /etc/systemd/system/mailcow-simplified-update-guard.service <<'UNIT'
[Unit]
Description=Keep unfinished Mailcow updates isolated before Docker starts
DefaultDependencies=no
After=local-fs.target
Before=docker.service

[Service]
Type=oneshot
ExecStart=/usr/bin/python3 /usr/local/lib/mailcow-simplified-updates/worker.py --guard-only
RemainAfterExit=yes

[Install]
RequiredBy=docker.service
UNIT
cat > /etc/systemd/system/mailcow-simplified-updates.service <<'UNIT'
[Unit]
Description=Mailcow Simplified upgrade worker
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
UMask=0077
ExecStart=/usr/bin/python3 /usr/local/lib/mailcow-simplified-updates/worker.py --daemon
Restart=on-failure
RestartSec=10
TimeoutStopSec=infinity

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable mailcow-simplified-update-guard.service mailcow-simplified-updates.service
python3 - <<'PY'
import os
from pathlib import Path
for directory in ('/usr/local/lib/mailcow-simplified-updates', '/etc/systemd/system', '/etc'):
    root = Path(directory)
    names = ('worker.py',) if 'usr/local' in directory else ('mailcow-simplified-update-guard.service', 'mailcow-simplified-updates.service') if directory.endswith('/system') else ('mailcow-simplified-updates.json',)
    for name in names:
        with (root / name).open('rb') as stream: os.fsync(stream.fileno())
    fd = os.open(root, os.O_RDONLY)
    try: os.fsync(fd)
    finally: os.close(fd)
os.sync()
PY
if "$START"; then systemctl restart mailcow-simplified-updates.service; fi
echo 'Upgrade worker installed. Review Overview → Server updates and the service logs before the first update.'
echo 'Configuration: /etc/mailcow-simplified-updates.json'
