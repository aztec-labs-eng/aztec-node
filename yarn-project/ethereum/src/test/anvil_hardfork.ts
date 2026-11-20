import { Buffer } from 'buffer';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { type EIP1193RequestFn, type Hex, createPublicClient, http } from 'viem';

import { resolveFoundryBinary } from '../foundry_binary.js';
import { isAmsterdamBlock } from '../l1_tx_utils/amsterdam.js';
import type { EthCheatCodes } from './eth_cheat_codes.js';
import { type Anvil, startAnvil } from './start_anvil.js';

/** Gas of a plain value transfer before any state gas. */
const PLAIN_TRANSFER_GAS = 21_000n;

/** An address no anvil dev account or genesis allocation uses, so it has no balance, nonce or code. */
const EMPTY_ADDRESS = '0x000000000000000000000000000000000000dEaD';

/**
 * Starts a throwaway anvil on `hardfork` and checks that it mines blocks of that fork, so a test that needs a fork
 * the installed foundry cannot run fails within seconds instead of after its whole setup. Never skips.
 *
 * On Amsterdam it also checks that anvil charges EIP-8037 state gas. Anvil before foundry 1.9.0 mines Amsterdam
 * blocks but estimates and executes with the pre-fork gas schedule, so Amsterdam runs on it say nothing about
 * Amsterdam gas. A value transfer to an empty address is the cheapest probe: it creates an account, so under EIP-8037
 * it costs far more than a plain transfer.
 */
export async function assertAnvilSupportsHardfork(hardfork: string): Promise<void> {
  let res: Awaited<ReturnType<typeof startAnvil>> | undefined;
  try {
    res = await startAnvil({ port: 0, hardfork });
    const client = createPublicClient({ transport: http(res.rpcUrl, { batch: false }) });
    await client.request({ method: 'evm_mine' as any, params: [] as any });
    const block = await client.getBlock({ blockTag: 'latest' });
    if (isAmsterdamBlock(block) !== (hardfork === 'amsterdam')) {
      throw new Error(`anvil --hardfork ${hardfork} mined block ${block.number} with the wrong header shape`);
    }
    if (hardfork === 'amsterdam') {
      const [from] = (await client.request({ method: 'eth_accounts' as any, params: [] as any })) as Hex[];
      const gas = await client.estimateGas({ account: from, to: EMPTY_ADDRESS, value: 1n });
      if (gas <= PLAIN_TRANSFER_GAS) {
        throw new Error(`anvil estimated ${gas} gas for a transfer to an empty address, so it charges no state gas`);
      }
    }
  } catch (err) {
    throw new Error(
      `Anvil at ${resolveFoundryBinary('anvil')} cannot run --hardfork ${hardfork}; foundry >= 1.9.0 is required`,
      { cause: err },
    );
  } finally {
    await res?.stop();
  }
}

/**
 * Writes anvil's state, including the historical states it still keeps, as the plain JSON file `--load-state` reads.
 * Without history, reads at blocks before a restart fail on the reloaded anvil. A dump with history easily exceeds
 * viem's default response size limit, so `client` must be one built without it, such as `createExtendedL1Client`'s.
 */
export async function dumpAnvilStateWithHistory(client: { request: EIP1193RequestFn }, path: string): Promise<void> {
  const hex = await client.request<{ Method: 'anvil_dumpState'; Parameters: [boolean]; ReturnType: Hex }>({
    method: 'anvil_dumpState',
    params: [true],
  });
  const dump = Buffer.from(hex.slice(2), 'hex');
  const isGzip = dump[0] === 0x1f && dump[1] === 0x8b;
  // Kept as a Buffer: a dump with history can exceed the maximum length of a V8 string.
  await writeFile(path, isGzip ? gunzipSync(dump) : dump);
}

/**
 * Moves an interval-mining anvil to another hardfork, continuing its chain. Anvil cannot change hardfork at runtime,
 * so this stops mining, dumps the state with history to `stateDir` using `dumpClient`, stops `anvil`, and starts a new
 * anvil on the same port from the dump with `startOpts`. Mining stays stopped until the old anvil is gone, so no block
 * mined after the dump is lost. Pending txs are lost, since the mempool is not part of the dump.
 *
 * The reloaded anvil would stamp its next block as if no time had passed since the dump, so the first block on the new
 * hardfork is mined at the first L1 slot of the old chain's grid that is not in the past, and interval mining resumes
 * from there.
 *
 * @returns The new anvil, which replaces `anvil`, and the first block mined on `hardfork`.
 */
export async function restartAnvilOnHardfork(
  anvil: Anvil,
  cheat: EthCheatCodes,
  dumpClient: { request: EIP1193RequestFn },
  opts: { hardfork: string; stateDir: string; startOpts?: Parameters<typeof startAnvil>[0] },
): Promise<{ anvil: Anvil; forkBlock: { number: bigint; timestamp: bigint } }> {
  const blockTimeS = await cheat.getIntervalMining();
  if (!blockTimeS) {
    throw new Error('restartAnvilOnHardfork needs an anvil in interval mining');
  }
  await cheat.setIntervalMining(0, { silent: true });
  const tip = await cheat.publicClient.getBlock({ blockTag: 'latest' });
  const statePath = join(opts.stateDir, `anvil-state-${tip.number}.json`);
  await dumpAnvilStateWithHistory(dumpClient, statePath);
  await anvil.stop();

  const restarted = await startAnvil({
    ...opts.startOpts,
    port: anvil.port,
    hardfork: opts.hardfork,
    loadState: statePath,
    l1BlockTime: blockTimeS,
  });

  const blockTime = BigInt(blockTimeS);
  const nowS = BigInt(Math.ceil(cheat.dateProvider.now() / 1000));
  const slotsSinceTip = nowS > tip.timestamp ? (nowS - tip.timestamp + blockTime - 1n) / blockTime : 1n;
  await cheat.warp(tip.timestamp + blockTime * slotsSinceTip, { silent: true, resetBlockInterval: true });

  const forkBlock = await cheat.publicClient.getBlock({ blockNumber: tip.number + 1n });
  return { anvil: restarted.anvil, forkBlock: { number: forkBlock.number, timestamp: forkBlock.timestamp } };
}
