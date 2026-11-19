#!/usr/bin/env python3
"""Exercise harness command construction and ownership guards without a Docker daemon."""
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / 'helper-scripts/dev-mailcow-dind.sh'


class HarnessTests(unittest.TestCase):
    def run_script(self, *args, **overrides):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            executable = folder / 'docker'
            executable.write_text('''#!/usr/bin/env python3
import os, sys, json, tarfile
args=sys.argv[1:]
with open(os.environ['MOCK_LOG'],'a') as f: f.write(json.dumps(args)+'\\n')
if args[:2]==['container','inspect']: sys.exit(0 if os.environ.get('MOCK_CONTAINER') else 1)
if args and args[0]=='inspect':
 expression=' '.join(args)
 if 'State.Running' in expression and os.environ.get('MOCK_STOPPED'): print('false'); sys.exit(0)
 print(('8443' if '443/tcp' in expression else '8080') if 'HostPort' in expression else ('false' if os.environ.get('MOCK_UNOWNED') else ('false' if 'source-copy' in expression and os.environ.get('MOCK_OLD_MOUNT') else ('true' if 'source-copy' in expression else (os.environ['MOCK_ROOT'] if 'source' in expression else 'true')))))
if args[:2]==['volume','inspect']: sys.exit(1)
if args and args[0]=='build' and os.environ.get('MOCK_BUILD_FAILURE'): sys.exit(1)
if args[:2]==['exec','-i']:
 with tarfile.open(fileobj=sys.stdin.buffer, mode='r|') as archive:
  with open(os.environ['MOCK_LOG'],'a') as f: f.write(json.dumps(['snapshot-files', *archive.getnames()])+'\\n')
''')
            executable.chmod(0o755)
            log = folder / 'commands.jsonl'
            env = dict(os.environ, PATH=str(folder) + os.pathsep + os.environ['PATH'], MOCK_LOG=str(log), MOCK_ROOT=str(ROOT))
            env.update(overrides)
            result = subprocess.run(['bash', str(SCRIPT), *args], cwd=ROOT, env=env, capture_output=True, text=True)
            commands = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
            return result, commands

    def test_dry_run_never_calls_docker(self):
        result, commands = self.run_script('up', '--dry-run')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(commands)
        self.assertIn('127.0.0.1:8080:80', result.stdout)
        self.assertIn('no host bind mount', result.stdout)
        self.assertIn('dockerd --host=unix', result.stdout)
        self.assertNotIn('source=/var/run/docker.sock', result.stdout)

    def test_real_construction_is_local_and_scoped(self):
        result, commands = self.run_script('up', '--name', 'mailcow-check', '--http-port', '8099')
        self.assertEqual(result.returncode, 0, result.stderr)
        run = next(command for command in commands if command[0] == 'run')
        self.assertIn('--privileged', run)
        self.assertIn('127.0.0.1:8099:80', run)
        self.assertTrue(all(command.startswith('127.0.0.1:') for i, command in enumerate(run) if i > 0 and run[i - 1] == '--publish'))
        self.assertIn('mailcow-check-harness', run)
        self.assertFalse(any('type=bind' in argument for argument in run))
        upload = next(command for command in commands if command[:2] == ['exec', '-i'])
        self.assertIn('tar -xf - -C /source', upload[-1])
        self.assertFalse(any(command[0] == 'cp' for command in commands))
        files = next(command[1:] for command in commands if command[0] == 'snapshot-files')
        self.assertIn('data/web/inc/twig.inc.php', files)
        self.assertIn('tests/live/manage.sh', files)
        self.assertFalse(any('.git' in Path(path).parts or 'node_modules' in Path(path).parts or Path(path).name in ['mailcow.conf', 'vars.local.inc.php'] for path in files))
        self.assertNotIn('/var/run/docker.sock:/var/run/docker.sock', run)

    def test_failed_build_explains_dns_without_creating_resources(self):
        result, commands = self.run_script('up', MOCK_BUILD_FAILURE='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('colima start --dns', result.stderr)
        self.assertFalse(any(command[0] in ['run', 'volume'] for command in commands))

    def test_unrelated_container_cannot_be_removed(self):
        result, commands = self.run_script('reset', '--yes', MOCK_CONTAINER='1', MOCK_UNOWNED='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('unrelated container', result.stderr)
        self.assertFalse(any(command[0] == 'rm' for command in commands))

    def test_missing_instance_explains_creation(self):
        for action in ['sync', 'status', 'logs', 'shell', 'stop', 'down']:
            result, commands = self.run_script(action)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('does not exist in the current Docker context', result.stderr)
            self.assertIn('up --name mailcow-ui-test', result.stderr)
            self.assertNotIn('unrelated', result.stderr)
            self.assertFalse(any(command[0] in ['exec', 'rm', 'run'] for command in commands))

    def test_stopped_instance_explains_resume(self):
        result, commands = self.run_script('sync', MOCK_CONTAINER='1', MOCK_STOPPED='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('is stopped', result.stderr)
        self.assertIn('to resume it', result.stderr)
        self.assertFalse(any(command[0] == 'exec' for command in commands))

    def test_invalid_ports_fail_before_docker(self):
        for port in ['0', '65536', 'abc', '80;false']:
            result, commands = self.run_script('up', '--http-port', port)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(commands)

    def test_invalid_names_fail_before_docker(self):
        result, commands = self.run_script('up', '--name', '../production')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(commands)

    def test_owned_instance_resumes_without_rebuilding(self):
        result, commands = self.run_script('up', MOCK_CONTAINER='1')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(any(command[0] == 'start' for command in commands))
        self.assertFalse(any(command[0] == 'build' for command in commands))

    def test_old_bind_mount_requires_recreation_before_copy(self):
        result, commands = self.run_script('sync', MOCK_CONTAINER='1', MOCK_OLD_MOUNT='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('down then up', result.stderr)
        self.assertFalse(any(command[:2] == ['exec', '-i'] for command in commands))

    def test_changed_ports_require_recreation(self):
        result, commands = self.run_script('up', '--http-port', '8099', MOCK_CONTAINER='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('different ports', result.stderr)
        self.assertFalse(any(command[0] == 'start' for command in commands))


if __name__ == '__main__':
    unittest.main()
