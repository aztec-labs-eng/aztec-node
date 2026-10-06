#!/usr/bin/env python3
"""Run with python3 spartan/terraform/deploy-ethereum/snapshot_test.py; no cloud access needed."""
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time
import unittest

SCRIPTS = Path(__file__).resolve().parent
FAKE_COMMAND = '''#!/usr/bin/env python3
import json, os, sys, time
from pathlib import Path
state = Path(os.environ['FAKE_STATE'])
args = sys.argv[1:]
if Path(sys.argv[0]).name == 'kubectl':
    args = args[3:]
    if args[0] == 'get':
        resource = args[1]
        if resource.startswith('sts/'):
            print((state / resource.split('/')[-1]).read_text())
        elif resource.startswith('pvc/'):
            print('pv-' + resource.split('/')[-1])
        else:
            print('projects/testnet-440309/zones/us-west1-a/disks/' + resource.split('/')[-1])
    elif args[0] == 'scale':
        for resource in args[1:-1]:
            (state / resource.split('/')[-1]).write_text(args[-1].split('=')[1])
    elif args[0] == 'wait' and (state / 'wait-fail').exists():
        sys.exit(1)
else:
    action = args[2]
    if action == 'create':
        name = args[3]
        (state / (name + '.started')).touch()
        while (state / 'hold').exists():
            time.sleep(0.02)
        if (state / 'fail').exists() and 'reth' in name:
            (state / (name + '.status')).write_text('FAILED')
            sys.exit(1)
        (state / (name + '.status')).write_text('READY')
    elif action == 'describe':
        if (state / 'unknown').exists():
            sys.exit(1)
        print((state / (args[3] + '.status')).read_text())
    elif action == 'delete':
        for name in args[3:5]:
            (state / (name + '.status')).unlink()
'''


class SnapshotScriptsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.state = Path(self.temp.name)
        for command in ['kubectl', 'gcloud']:
            executable = self.state / command
            executable.write_text(FAKE_COMMAND)
            executable.chmod(0o755)
        self.env = dict(os.environ, FAKE_STATE=str(self.state), PATH=f'{self.state}:{os.environ["PATH"]}')
        for client, replicas in [('reth', '2'), ('lighthouse', '1')]:
            (self.state / f'sepolia-{client}').write_text(replicas)

    def replicas(self):
        return [(self.state / f'sepolia-{client}').read_text() for client in ['reth', 'lighthouse']]

    def run_script(self, name, stdin=''):
        return subprocess.run(['bash', str(SCRIPTS / name), 'sepolia'], env=self.env,
                              input=stdin, capture_output=True, text=True, timeout=10)

    def wait_until(self, predicate):
        deadline = time.monotonic() + 5
        while not predicate():
            if time.monotonic() > deadline:
                self.fail('Timed out waiting for test process')
            time.sleep(0.02)

    def test_success_restores_original_replicas(self):
        result = self.run_script('snapshot.sh')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.replicas(), ['2', '1'])
        for client in ['reth', 'lighthouse']:
            self.assertEqual((self.state / f'sepolia-{client}-pre-upgrade.status').read_text(), 'READY')

    def test_failure_before_snapshots_restores_original_replicas(self):
        (self.state / 'wait-fail').touch()
        result = self.run_script('snapshot.sh')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.replicas(), ['2', '1'])
        self.assertEqual(list(self.state.glob('*.started')), [])

    def test_failed_snapshot_keeps_clients_stopped(self):
        (self.state / 'fail').touch()
        result = self.run_script('snapshot.sh')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.replicas(), ['0', '0'])

    def test_unknown_snapshot_status_keeps_clients_stopped(self):
        (self.state / 'unknown').touch()
        result = self.run_script('snapshot.sh')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.replicas(), ['0', '0'])

    def test_signals_do_not_restart_clients_during_inflight_snapshots(self):
        for sig in [signal.SIGINT, signal.SIGTERM]:
            with self.subTest(signal=sig):
                for pattern in ['*.started', '*.status']:
                    for file in self.state.glob(pattern):
                        file.unlink()
                (self.state / 'hold').touch()
                with tempfile.TemporaryFile(mode='w+') as output:
                    proc = subprocess.Popen(['bash', str(SCRIPTS / 'snapshot.sh'), 'sepolia'], env=self.env,
                                            stdout=output, stderr=output)
                    try:
                        self.wait_until(lambda: len(list(self.state.glob('*.started'))) == 2)
                        proc.send_signal(sig)
                        proc.wait(timeout=5)
                        self.assertEqual(proc.returncode, 128 + sig)
                        self.assertEqual(self.replicas(), ['0', '0'])
                    finally:
                        (self.state / 'hold').unlink(missing_ok=True)
                        if proc.poll() is None:
                            proc.kill()
                            proc.wait()
                    self.wait_until(lambda: all((self.state / f'sepolia-{c}-pre-upgrade.status').exists()
                                                for c in ['reth', 'lighthouse']))

    def test_cleanup_requires_selected_network_confirmation(self):
        for client in ['reth', 'lighthouse']:
            (self.state / f'sepolia-{client}-pre-upgrade.status').write_text('READY')
        for confirmation in ['', 'mainnet\n', 'no\n']:
            result = self.run_script('cleanup-snapshots.sh', confirmation)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(len(list(self.state.glob('*.status'))), 2)
        result = self.run_script('cleanup-snapshots.sh', 'sepolia\n')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(list(self.state.glob('*.status')), [])


if __name__ == '__main__':
    unittest.main()
