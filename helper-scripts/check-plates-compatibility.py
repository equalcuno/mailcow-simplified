#!/usr/bin/env python3
"""Flag changes to the upstream contracts used by Plates. No production mutations."""
import argparse
import hashlib
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / 'data/web/ui/plates/compatibility.json'
DEPENDENCIES = [
    'data/web/templates/base.twig',
    'data/web/templates/user_index.twig',
    'data/web/templates/admin_index.twig',
    'data/web/templates/domainadmin_index.twig',
    'data/web/templates/mailbox.twig',
    'data/web/templates/edit.twig',
    'data/web/templates/edit/mailbox.twig',
    'data/web/templates/mailbox/tab-domains.twig',
    'data/web/templates/mailbox/tab-mailboxes.twig',
    'data/web/templates/modals/mailbox.twig',
    'data/web/templates/dashboard.twig',
    'data/web/templates/admin.twig',
    'data/web/templates/quarantine.twig',
    'data/web/templates/queue.twig',
    'data/web/admin/mailbox.php',
    'data/web/admin/dashboard.php',
    'data/web/domainadmin/mailbox.php',
    'data/web/inc/twig.inc.php',
    'data/web/inc/header.inc.php',
    'data/web/inc/footer.inc.php',
    'data/web/inc/sessions.inc.php',
    'data/web/inc/triggers.admin.inc.php',
    'data/web/inc/functions.customize.inc.php',
    'data/web/inc/functions.mailbox.inc.php',
    'data/web/inc/init_db.inc.php',
    'data/web/inc/lib/ssp.class.php',
    'data/web/json_api.php',
    'data/web/api/openapi.yaml',
    'data/web/js/build/001-bootstrap.bundle.min.js',
    'data/web/js/build/004-datatables.js',
    'data/web/js/build/011-api.js',
    'data/web/js/build/013-mailcow.js',
    'data/web/js/site/mailbox.js',
    'data/web/js/site/edit.js',
    'data/web/css/build/014-mailcow.css',
    'data/web/css/build/015-responsive.css',
    'data/web/css/themes/mailcow-darkmode.css',
    'data/web/css/site/mailbox.css',
    'data/conf/nginx/templates/sites-default.conf.j2',
    'data/Dockerfiles/postfix/syslog-ng.conf',
    'data/Dockerfiles/postfix/syslog-ng-redis_slave.conf',
]


def read(path, ref):
    if ref:
        return subprocess.check_output(['git', 'show', f'{ref}:{path}'], cwd=ROOT)
    return (ROOT / path).read_bytes()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ref', help='Compare a fetched Git ref instead of the working tree')
    parser.add_argument('--record', action='store_true', help='Accept this baseline after review and tests')
    args = parser.parse_args()
    if args.record and args.ref:
        parser.error('--record only accepts the tested working tree')
    hashes = {}
    for path in DEPENDENCIES:
        try:
            hashes[path] = hashlib.sha256(read(path, args.ref)).hexdigest()
        except (OSError, subprocess.CalledProcessError):
            hashes[path] = None
    if args.record:
        if None in hashes.values():
            raise SystemExit('Cannot record a baseline with missing dependencies')
        commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
        MANIFEST.write_text(json.dumps({'reviewed_base': commit, 'sha256': hashes}, indent=2) + '\n')
        print('Recorded reviewed Plates dependencies. Commit the manifest with the presentation changes.')
        return
    manifest = json.loads(MANIFEST.read_text())
    changed = [path for path, digest in hashes.items() if manifest['sha256'].get(path) != digest]
    if changed:
        print('Plates compatibility review required:')
        for path in changed:
            print(f'  {path}')
        print('Review changes, run UI checks, then --record the new baseline. Do not automatically accept it.')
        raise SystemExit(1)
    print(f'Plates: {len(hashes)} upstream dependencies match the reviewed baseline.')


if __name__ == '__main__':
    main()
