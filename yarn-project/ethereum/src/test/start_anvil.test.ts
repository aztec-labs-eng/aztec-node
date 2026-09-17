import { type Logger, createLogger } from '@aztec-labs/foundation/log';
import { sleep } from '@aztec-labs/foundation/sleep';
import { TestDateProvider } from '@aztec-labs/foundation/timer';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { type AddressInfo, createServer } from 'node:net';
import { tmpdir } from 'os';
import { join } from 'path';
import { createPublicClient, http, parseAbiItem } from 'viem';

import { resolveFoundryBinary } from '../foundry_binary.js';
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
 * through a shell wrapper rather than a `#!${'$'}{process.execPath}` shebang, which would break on a
 * node path containing a space or exceeding the kernel's shebang limit.
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

/**
 * Writes the executable startAnvil will spawn as `anvil`. It records the pid of the process that goes
 * on to become anvil — `$$` survives the `exec` — so a test can signal the spawn itself rather than the
 * watchdog wrapping it.
 */
function writeLauncher(dir: string, execLine: string): string {
  const launcher = join(dir, 'anvil');
  writeFileSync(launcher, `#!/bin/sh\necho $$ > "$(dirname "$0")/pid"\n${execLine}\n`, { mode: 0o755 });
  return launcher;
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

/** Fails unless the port can be rebound immediately. */
async function expectPortFree(port: number): Promise<void> {
  const probed = await probePort(port);
  // Assert on the bind error rather than a bare boolean: it names what is still holding the port, which
  // is the whole diagnostic value of the teardown cells.
  expect(probed.error ?? 'port is free').toEqual('port is free');
}

/** The escalation fires at 5s; anything past this is the hang the escalation exists to prevent. */
const SETTLE_BOUND_MS = 15_000;

/** How the spawn reacts to the SIGTERM teardown sends first. */
type Behaviour =
  /** Real anvil, which honours SIGTERM, so the watchdog reaps it and no escalation is needed. */
  | 'honours'
  /** A stand-in that ignores SIGTERM: only the group SIGKILL can end it. */
  | 'ignores'
  /** Real anvil under SIGSTOP, which cannot run a handler at all, so the escalation must do it. */
  | 'stopped';

/** How the caller drives `stop()`. */
type Pattern =
  /** One call. */
  | 'single'
  /** Two calls in flight before either resolves; they must share one shutdown. */
  | 'concurrent'
  /** A second call after the first resolved; it must be a no-op, not a second kill. */
  | 'sequential'
  /** The spawn is already gone before `stop()` is called at all. */
  | 'after-exit';

const BEHAVIOURS: Behaviour[] = ['honours', 'ignores', 'stopped'];
const PATTERNS: Pattern[] = ['single', 'concurrent', 'sequential', 'after-exit'];

/** Handle kinds startAnvil creates; a leak here is what keeps a suite's event loop alive after it. */
function spawnHandleCount(): number {
  const info = (process as NodeJS.Process & { getActiveResourcesInfo?: () => string[] }).getActiveResourcesInfo;
  return info ? info.call(process).filter(r => r === 'Pipe' || r === 'ChildProcess').length : 0;
}

interface Spawn {
  anvil: Anvil;
  port: number;
  /** The pid of anvil (or the stand-in) itself, not the watchdog wrapping it. */
  pid: number;
  dispose: () => Promise<void>;
}

async function spawnFor(behaviour: Behaviour): Promise<Spawn> {
  const dir = mkdtempSync(join(tmpdir(), `anvil-${behaviour}-`));
  let execLine: string;
  if (behaviour === 'ignores') {
    writeFileSync(join(dir, 'stub.cjs'), UNKILLABLE_ANVIL);
    execLine = `exec "${process.execPath}" "$(dirname "$0")/stub.cjs" "$@"`;
  } else {
    execLine = `exec "${resolveFoundryBinary('anvil')}" "$@"`;
  }
  const launcher = writeLauncher(dir, execLine);

  let anvil: Anvil | undefined;
  try {
    ({ anvil } = await withAnvilBin(launcher, () => startAnvil({ port: 0 })));
    const pid = Number(readFileSync(join(dir, 'pid'), 'utf8').trim());
    expect(pid).toBeGreaterThan(0);
    if (behaviour === 'stopped') {
      process.kill(pid, 'SIGSTOP');
    }
    return {
      anvil,
      port: anvil.port,
      pid,
      dispose: async () => {
        // SIGKILL first: a cell that failed mid-teardown may have left a spawn that ignores SIGTERM,
        // and stop() would then spend its whole escalation before this could remove the temp dir.
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Already gone, which is the normal case once the cell's own stop() has run.
        }
        await anvil?.stop().catch(() => {});
        rmSync(dir, { recursive: true, force: true });
      },
    };
  } catch (err) {
    await anvil?.stop().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

/** Kills the spawn out from under the caller and waits for startAnvil to notice. */
async function killAndAwaitExit(spawn: Spawn): Promise<void> {
  process.kill(spawn.pid, 'SIGKILL');
  const deadline = Date.now() + SETTLE_BOUND_MS;
  while (spawn.anvil.status !== 'idle' && Date.now() < deadline) {
    await sleep(50);
  }
  expect(spawn.anvil.status).toEqual('idle');
}

async function drive(anvil: Anvil, pattern: Pattern): Promise<void> {
  switch (pattern) {
    case 'concurrent': {
      // Both started before either is awaited: the second must join the first shutdown rather than
      // starting its own or returning before the first has finished.
      const [first, second] = [anvil.stop(), anvil.stop()];
      await Promise.all([first, second]);
      return;
    }
    case 'sequential':
      await anvil.stop();
      await anvil.stop();
      return;
    case 'single':
    case 'after-exit':
      await anvil.stop();
      return;
  }
}

// How the spawn responds to teardown, crossed with how the caller drives `stop()`. Every cell asserts
// the same four invariants, so a change that satisfies one cell by breaking another fails here.
describe.each(BEHAVIOURS)('startAnvil teardown when anvil %s SIGTERM', behaviour => {
  it.each(PATTERNS)(
    'frees the port and settles (%s)',
    async pattern => {
      const baselineHandles = spawnHandleCount();
      const spawn = await spawnFor(behaviour);
      try {
        if (pattern === 'after-exit') {
          await killAndAwaitExit(spawn);
        } else {
          expect((await probePort(spawn.port)).free).toBe(false);
        }

        const start = Date.now();
        await drive(spawn.anvil, pattern);
        const elapsed = Date.now() - start;

        // 1. Settles, and within the escalation's budget rather than merely before jest's timeout.
        expect(elapsed).toBeLessThan(SETTLE_BOUND_MS);

        // 2. Rebinding immediately is the caller-visible form of "anvil is really gone": suites reuse
        //    ports across cases, so a stop() that returns early hands the next startAnvil a port still
        //    in use.
        await expectPortFree(spawn.port);

        // 3. The instance agrees it is down.
        expect(spawn.anvil.status).toEqual('idle');

        // 4. Nothing is left holding the event loop open.
        expect(spawnHandleCount()).toEqual(baselineHandles);
      } finally {
        await spawn.dispose();
      }
    },
    90_000,
  );
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
