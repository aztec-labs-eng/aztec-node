import { type Logger, createLogger } from '@aztec-labs/foundation/log';
import { sleep } from '@aztec-labs/foundation/sleep';
import { TestDateProvider } from '@aztec-labs/foundation/timer';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { type AddressInfo, createServer } from 'node:net';
import { tmpdir } from 'os';
import { join } from 'path';
import { createPublicClient, http, parseAbiItem } from 'viem';

import type { Anvil } from './start_anvil.js';
import { startAnvil } from './start_anvil.js';

/**
 * Stands in for an anvil that announces itself, holds its port, and refuses to die on SIGTERM. It holds
 * a real port because whether the port comes back is what teardown has to guarantee, and unlike the
 * stand-in's liveness that cannot be confused by a killed process lingering as a zombie under a
 * container PID 1 that never reaps. Like anvil it reports the port it actually bound, so callers can
 * ask for an ephemeral one rather than racing to reserve a number in advance.
 *
 * It is `.cjs` so that `require` works wherever the temp directory happens to sit, and it is launched
 * through the shell wrapper below rather than a `#!${'$'}{process.execPath}` shebang, which would break on
 * a node path containing a space or exceeding the kernel's shebang limit.
 */
const UNKILLABLE_ANVIL = `
const net = require('node:net');
process.on('SIGTERM', () => {});
process.on('SIGINT', () => {});
// Nothing else will ever reap this: SIGTERM is ignored, and a test that fails before teardown never
// sends the SIGKILL that would. Without this it survives as a listener holding the port indefinitely.
setTimeout(() => process.exit(1), 60_000);
const argv = process.argv;
const requested = argv.indexOf('--port') === -1 ? 0 : Number(argv[argv.indexOf('--port') + 1]);
net.createServer().listen(requested, '127.0.0.1', function () {
  console.log('Listening on 127.0.0.1:' + this.address().port);
});
`;

/** Runs the stand-in under the node running this suite, quoted so a path with spaces survives. */
const UNKILLABLE_ANVIL_LAUNCHER = `#!/bin/sh
exec "${process.execPath}" "$(dirname "$0")/stub.cjs" "$@"
`;

/** Attempts to bind the port, reporting what stopped it when it could not. */
async function probePort(port: number): Promise<{ free: boolean; error?: string }> {
  const probe = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(port, '127.0.0.1', () => resolve());
    });
    return { free: true };
  } catch (err) {
    return { free: false, error: (err as Error).message };
  } finally {
    await new Promise<void>(resolve => probe.close(() => resolve()));
  }
}

/** Fails unless the port is free, allowing `within` ms for a process that has been signalled to go. */
async function expectPortFree(port: number, within = 0): Promise<void> {
  const deadline = Date.now() + within;
  let probed = await probePort(port);
  while (!probed.free && Date.now() < deadline) {
    await sleep(100);
    probed = await probePort(port);
  }
  // Assert on the bind error rather than a bare boolean: it names what is still holding the port, which
  // is the whole diagnostic value of these two tests.
  expect(probed.error ?? 'port is free').toEqual('port is free');
}

async function withAnvilBin<T>(bin: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.ANVIL_BIN;
  process.env.ANVIL_BIN = bin;
  try {
    return await fn();
  } finally {
    if (prev === undefined) {
      delete process.env.ANVIL_BIN;
    } else {
      process.env.ANVIL_BIN = prev;
    }
  }
}

describe('startAnvil teardown', () => {
  it('releases the port when anvil ignores SIGTERM', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'anvil-stub-'));
    const stub = join(dir, 'anvil');
    writeFileSync(join(dir, 'stub.cjs'), UNKILLABLE_ANVIL);
    writeFileSync(stub, UNKILLABLE_ANVIL_LAUNCHER, { mode: 0o755 });

    let anvil: Anvil | undefined;
    try {
      const started = await withAnvilBin(stub, () => startAnvil({ port: 0 }));
      anvil = started.anvil;
      const port = parseInt(new URL(started.rpcUrl).port);
      expect((await probePort(port)).free).toBe(false);

      const start = Date.now();
      await anvil.stop();
      // Must not hang: the SIGTERM the watchdog sends is ignored here, so only the kill escalation can
      // end this, and that escalation has to both fire and be waited for.
      expect(Date.now() - start).toBeLessThan(15_000);
      expect(anvil.status).toEqual('idle');

      // And the stand-in must actually be gone, not merely abandoned — without the escalation it outlives
      // teardown holding this port for the rest of the run. The grace is for the kill itself: both
      // processes are signalled at once here, so nothing orders the stand-in's fds closing before the
      // watchdog's exit is observed.
      await expectPortFree(port, 10_000);
    } finally {
      // An assertion failing before `stop()` would otherwise strand a listener that ignores SIGTERM and
      // that nothing else ever signals; the stand-in's own self-destruct is only the backstop for a
      // failure that stops even this from running.
      await anvil?.stop().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('frees the port before stop resolves', async () => {
    const { anvil, rpcUrl } = await startAnvil({ port: 0 });
    const port = parseInt(new URL(rpcUrl).port);

    await anvil.stop();

    // Rebinding immediately is the caller-visible form of "anvil is really gone": suites reuse ports
    // across cases, so a stop() that returns early hands the next startAnvil a port still in use. No
    // grace, because anvil honours the SIGTERM here and the watchdog waits for it before exiting — if
    // anvil ever stopped honouring it this would escalate like the test above and need one too.
    await expectPortFree(port);
  }, 60_000);
});

describe('startAnvil with a binary that exits before listening', () => {
  it('rejects instead of hanging', async () => {
    // `false` lives at /bin/false on Linux but /usr/bin/false on macOS; resolveFoundryBinary
    // requires $ANVIL_BIN to be an existing executable, so pick whichever is present.
    const falseBin = ['/bin/false', '/usr/bin/false'].find(p => existsSync(p)) ?? '/bin/false';
    // Must settle (via the retry loop, ~15s of backoff) rather than await a "Listening on" line
    // that never comes.
    await withAnvilBin(falseBin, () => expect(startAnvil({ port: 0 })).rejects.toThrow(/before listening/));
  }, 30_000);
});

describe('start_anvil', () => {
  let logger: Logger;
  let anvil: Anvil;
  let rpcUrl: string;

  beforeEach(async () => {
    logger = createLogger('ethereum:test:anvil');
    ({ anvil, rpcUrl } = await startAnvil());
  });

  afterEach(async () => {
    await anvil.stop().catch(err => logger.error(err));
  });

  it('starts anvil on a free port', async () => {
    const port = parseInt(new URL(rpcUrl).port);
    expect(port).toBeLessThan(65536);
    expect(port).toBeGreaterThan(1024);
    expect(anvil.port).toEqual(port);

    const host = new URL(rpcUrl).hostname;
    expect(anvil.host).toEqual(host);

    const publicClient = createPublicClient({ transport: http(rpcUrl, { batch: false }) });
    const chainId = await publicClient.getChainId();
    expect(chainId).toEqual(31337);
    expect(anvil.status).toEqual('listening');

    await anvil.stop().catch(err => createLogger('cleanup').error(err));
    expect(anvil.status).toEqual('idle');
  });

  it('rejects instead of hanging when anvil cannot bind its port', async () => {
    const blocker = createServer();
    await new Promise<void>(resolve => blocker.listen(0, '127.0.0.1', () => resolve()));
    const port = (blocker.address() as AddressInfo).port;

    try {
      await expect(startAnvil({ port })).rejects.toThrow(/before listening/);
    } finally {
      await new Promise<void>(resolve => blocker.close(() => resolve()));
    }
  }, 120_000);

  it('ignores errors uninstalling filters during teardown', async () => {
    const publicClient = createPublicClient({ transport: http(rpcUrl, { batch: false }) });
    const abiItem = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

    const stopWatching = publicClient.watchEvent({ event: abiItem, onLogs: () => {} });
    await sleep(100);

    // Stop watching while anvil is still alive so the filter is cleanly uninstalled.
    // Stopping anvil first and then calling stopWatching() causes eth_uninstallFilter
    // to hit a dead server, leaving dangling undici sockets that prevent exit.
    logger.info('Stopping watch event');
    stopWatching();
    await sleep(100);
  });

  it('syncs dateProvider to anvil block time on each mined block', async () => {
    // Stop the default anvil instance (no dateProvider).
    await anvil.stop();

    const dateProvider = new TestDateProvider();
    const res = await startAnvil({ dateProvider });
    anvil = res.anvil;
    rpcUrl = res.rpcUrl;

    const publicClient = createPublicClient({ transport: http(rpcUrl, { batch: false }) });

    // Mine a block so anvil emits a "Block Time" line.
    await publicClient.request({ method: 'evm_mine', params: [] } as any);
    // Give the stdout listener time to fire.
    await sleep(200);

    const block = await publicClient.getBlock({ blockTag: 'latest' });
    const blockTimeMs = Number(block.timestamp) * 1000;
    // The dateProvider should now be within 2 seconds of the anvil block time.
    // TestDateProvider.now() = Date.now() + offset, and setTime sets offset = blockTimeMs - Date.now(),
    // so subsequent now() calls return blockTimeMs + elapsed. We check the difference is small.
    expect(Math.abs(dateProvider.now() - blockTimeMs)).toBeLessThan(2000);

    // Warp anvil forward by 1000 seconds and verify the dateProvider follows.
    const futureTimestamp = Number(block.timestamp) + 1000;
    await publicClient.request({
      method: 'evm_setNextBlockTimestamp',
      params: [futureTimestamp],
    } as any);
    await publicClient.request({ method: 'evm_mine', params: [] } as any);
    await sleep(200);

    const futureTimeMs = futureTimestamp * 1000;
    expect(Math.abs(dateProvider.now() - futureTimeMs)).toBeLessThan(2000);
  });
});
