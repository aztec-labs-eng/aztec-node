import { times } from '@aztec-labs/foundation/collection';
import { describe, expect, it } from '@jest/globals';
import { Buffer } from 'buffer';
import { spawnSync } from 'child_process';
import { once } from 'events';
import { createServer } from 'net';
import { delimiter, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const AZTEC_SH = join(PACKAGE_ROOT, 'scripts/aztec.sh');
const WORKSPACE = join(PACKAGE_ROOT, 'test/large-output-tests');

// Linux's default pipe capacity (16 pages of 4 KiB). The workspace's test output must exceed it for a stalled reader
// to exert backpressure.
const PIPE_CAPACITY_BYTES = 16 * 4096;
// How many payload lines the workspace's test prints.
const PAYLOAD_LINE_COUNT = 3000;
// How long the reader stops draining once nargo starts testing; nargo prints the whole payload well within it.
const READER_STALL_S = 5;
// The port `aztec test` runs the TXE on.
const TXE_PORT = 8081;
// Far longer than compiling the workspace and a failed TXE startup take, so a run still going by then is hung.
const STARTUP_FAILURE_TIMEOUT_MS = 60_000;
// Far longer than compiling the workspace and running its test take, yet short of the jest timeout so that a hung run
// still reaches the assertions and reports its output.
const FULL_RUN_TIMEOUT_MS = 100_000;

describe('aztec test', () => {
  it('delivers all test output when the reader falls behind', () => {
    // Pass output through until nargo starts testing, then stop reading so that nargo's writes fill the pipe.
    const { status, stdout, stderr } = runInBash(
      `
      "$AZTEC_SH" test --show-output | {
        while IFS= read -r line; do
          printf '%s\\n' "$line"
          [[ $line == *"Running 1 test function"* ]] && break
        done
        sleep ${READER_STALL_S}
        cat
      }
      exit "\${PIPESTATUS[0]}"
    `,
      { timeoutMs: FULL_RUN_TIMEOUT_MS },
    );

    // Matching the pair makes a non-zero status print stderr in the failure diff.
    expect({ status, stderr }).toEqual({ status: 0, stderr: expect.any(String) });
    const payload = stdout.match(/^payload line \d+:.*$/gm) ?? [];
    const indices = payload.map(line => parseInt(line.slice('payload line '.length)));
    expect(indices).toEqual(times(PAYLOAD_LINE_COUNT, i => i));
    expect(Buffer.byteLength(payload.join('\n'))).toBeGreaterThan(PIPE_CAPACITY_BYTES);
    expect(stdout).toContain('1 test passed');
  }, 120_000);

  it('fails instead of testing against another server that holds the TXE port', async () => {
    await using portHolder = createServer().listen(TXE_PORT, '127.0.0.1');
    await once(portHolder, 'listening');

    const { status, stdout, stderr } = runInBash('"$AZTEC_SH" test', { timeoutMs: STARTUP_FAILURE_TIMEOUT_MS });

    expect(status).not.toBe(0);
    expect(stderr).toContain(`port ${TXE_PORT}`);
    expect(stdout).not.toContain('Running 1 test function');
  }, 120_000);

  it('fails when the TXE exits before it starts listening', () => {
    // With a single worker the TXE creates its temp contract store before listening, so an unusable temp directory
    // makes it exit first. Compiling this workspace does not need the temp directory.
    const { status, signal, stderr } = runInBash('"$AZTEC_SH" test', {
      env: { TXE_WORKERS: '1', TMPDIR: '/nonexistent' },
      timeoutMs: STARTUP_FAILURE_TIMEOUT_MS,
    });

    // A hung run ends with the timeout's SIGTERM instead of an exit status.
    expect(signal).toBeNull();
    expect(status).not.toBe(0);
    expect(stderr).toContain('TXE exited');
  }, 120_000);
});

/**
 * Runs a bash script in the test workspace, with `$AZTEC_SH` pointing at the wrapper and nargo on the PATH. `env` adds
 * to the inherited environment; `timeoutMs` kills the script with SIGTERM once it elapses.
 */
function runInBash(script: string, { env = {}, timeoutMs }: { env?: NodeJS.ProcessEnv; timeoutMs: number }) {
  const nargoDir = process.env.NARGO ? [dirname(process.env.NARGO)] : [];
  return spawnSync('bash', ['-c', script], {
    cwd: WORKSPACE,
    encoding: 'utf-8',
    env: { ...process.env, AZTEC_SH, PATH: [...nargoDir, process.env.PATH].join(delimiter), ...env },
    timeout: timeoutMs,
  });
}
