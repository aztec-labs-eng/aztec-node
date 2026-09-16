import { type Logger, createLogger } from '@aztec-labs/foundation/log';
import { sleep } from '@aztec-labs/foundation/sleep';
import { TestDateProvider } from '@aztec-labs/foundation/timer';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { type AddressInfo, createServer } from 'node:net';
import { tmpdir } from 'os';
import { join } from 'path';
import { createPublicClient, http, parseAbiItem } from 'viem';

import type { Anvil } from './start_anvil.js';
import { startAnvil } from './start_anvil.js';

/** Stands in for an anvil that announces itself and then refuses to die on SIGTERM. */
const UNKILLABLE_ANVIL = `#!/usr/bin/env bash
trap '' TERM INT
port=8545
while [ $# -gt 0 ]; do
  [ "$1" = '--port' ] && port=$2
  shift
done
echo $$ > "$ANVIL_STUB_PIDFILE"
echo "Listening on 127.0.0.1:$port"
while true; do sleep 1 & wait $!; done
`;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
  it('leaves nothing running when anvil ignores SIGTERM', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'anvil-stub-'));
    const stub = join(dir, 'anvil');
    const pidFile = join(dir, 'pid');
    writeFileSync(stub, UNKILLABLE_ANVIL, { mode: 0o755 });
    process.env.ANVIL_STUB_PIDFILE = pidFile;

    try {
      // A concrete port, not 0: the stand-in echoes back whatever it is given, and real anvil is what
      // turns a requested 0 into the actual port in that line. It binds nothing, so the value is free.
      const { anvil } = await withAnvilBin(stub, () => startAnvil({ port: 39544 }));
      const pid = parseInt(readFileSync(pidFile, 'utf8').trim());
      expect(isAlive(pid)).toBe(true);

      const start = Date.now();
      await anvil.stop();
      // Must not hang: the SIGTERM the watchdog sends is ignored here, so only the kill escalation
      // can end this, and that escalation has to both fire and be waited for.
      expect(Date.now() - start).toBeLessThan(15_000);
      expect(anvil.status).toEqual('idle');

      // The stand-in is not our child, so it is reaped by init rather than by us and can linger as a
      // zombie for a moment after the group kill; what matters is that it goes, not that it has gone
      // by the exact instant stop() returns. Without the escalation it never goes at all.
      for (let i = 0; i < 50 && isAlive(pid); i++) {
        await sleep(100);
      }
      expect(isAlive(pid)).toBe(false);
    } finally {
      delete process.env.ANVIL_STUB_PIDFILE;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('frees the port before stop resolves', async () => {
    const { anvil, rpcUrl } = await startAnvil({ port: 0 });
    const port = parseInt(new URL(rpcUrl).port);

    await anvil.stop();

    // Rebinding immediately is the caller-visible form of "anvil is really gone": suites reuse ports
    // across cases, so a stop() that returns early hands the next startAnvil a port still in use.
    const rebound = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        rebound.once('error', reject);
        rebound.listen(port, '127.0.0.1', () => resolve());
      });
    } finally {
      await new Promise<void>(resolve => rebound.close(() => resolve()));
    }
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
