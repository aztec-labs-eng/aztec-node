import { RollupAbi } from '@aztec-foundation/l1-artifacts';

import { getPublicClient } from '@aztec-labs/ethereum/client';
import { startAnvil } from '@aztec-labs/ethereum/test';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { createLogger } from '@aztec-labs/foundation/log';
import { Buffer } from 'buffer';
import { Command } from 'commander';
import { type Hex, decodeFunctionData } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';

import { injectCommands } from './index.js';

const mnemonic = 'test test test test test test test test test test test junk';
const withdrawer = mnemonicToAccount(mnemonic);
const withdrawerKey = `0x${Buffer.from(withdrawer.getHdKey().privateKey!).toString('hex')}`;
const validator = EthAddress.random();
const recipient = EthAddress.random();
// The command only builds and sends the transaction, so any address without code accepts it.
const rollup = EthAddress.random();
const logger = createLogger('cli:test:remove-l1-validator');

describe('remove-l1-validator command', () => {
  let rpcUrl: string;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    ({ rpcUrl, stop } = await startAnvil({ port: 0 }));
  });

  afterAll(async () => {
    await stop?.();
  });

  const run = async (extraArgs: string[]) => {
    const messages: string[] = [];
    const program = new Command().name('aztec').exitOverride();
    program.configureOutput({ writeErr: () => {} });
    injectCommands(program, message => messages.push(message), logger);
    await program.parseAsync(
      [
        'remove-l1-validator',
        '--validator',
        validator.toString(),
        '--rollup',
        rollup.toString(),
        '--l1-rpc-urls',
        rpcUrl,
        '--l1-chain-id',
        String(foundry.id),
        '--private-key',
        withdrawerKey,
        ...extraArgs,
      ],
      { from: 'user' },
    );
    return messages;
  };

  it('initiates the withdrawal to the given recipient', async () => {
    const messages = await run(['--recipient', recipient.toString()]);

    const txHash = messages.map(m => m.match(/^Transaction hash: (0x[0-9a-f]+)$/)?.[1]).find(Boolean) as Hex;
    expect(txHash).toBeDefined();
    const tx = await getPublicClient({ l1RpcUrls: [rpcUrl], l1ChainId: foundry.id }).getTransaction({ hash: txHash });
    const { functionName, args } = decodeFunctionData({ abi: RollupAbi, data: tx.input });

    expect(functionName).toBe('initiateWithdraw');
    expect((args as readonly Hex[]).map(arg => arg.toLowerCase())).toEqual([
      validator.toString().toLowerCase(),
      recipient.toString().toLowerCase(),
    ]);
  });

  it('refuses to run without a recipient', async () => {
    await expect(run([])).rejects.toThrow("required option '--recipient <address>' not specified");
  });
});
