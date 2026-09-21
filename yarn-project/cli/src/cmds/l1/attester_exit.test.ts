import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { Signature } from '@aztec-labs/foundation/eth-signature';
import { createLogger } from '@aztec-labs/foundation/log';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mnemonicToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';

import { initiateWithdrawByAttester, readAttesterExitAuthorizations } from './update_l1_validators.js';

const mnemonic = 'test test test test test test test test test test test junk';
const attester = mnemonicToAccount(mnemonic);
const withdrawer = mnemonicToAccount(mnemonic, { addressIndex: 1 });
const logger = createLogger('cli:test:attester-exit');

describe('initiate-withdraw-by-attester command', () => {
  it('rejects a signer that does not match the attester before contacting L1', async () => {
    await expect(
      initiateWithdrawByAttester({
        rpcUrls: ['http://127.0.0.1:1'],
        chainId: foundry.id,
        privateKey: `0x${Buffer.from(attester.getHdKey().privateKey!).toString('hex')}`,
        attesterAddress: EthAddress.fromString(withdrawer.address),
        rollupAddress: EthAddress.ZERO,
        log: () => {},
        debugLogger: logger,
      }),
    ).rejects.toThrow('The transaction signer must match the attester address');
  });
});

describe('initiate-withdraw-by-attester-batch command', () => {
  it.each(['0x', '0x12', `0x${'11'.repeat(64)}`, '0xnothex'])(
    'rejects malformed signature %s with its authorization index',
    async signature => {
      const directory = await mkdtemp(join(tmpdir(), 'attester-exit-invalid-'));
      const path = join(directory, 'authorizations.json');
      try {
        await writeFile(
          path,
          JSON.stringify([
            { attester: attester.address, deadline: '123456789', signature: Signature.random().toString() },
            { attester: withdrawer.address, deadline: '123456789', signature },
          ]),
        );
        await expect(readAttesterExitAuthorizations(path)).rejects.toThrow(
          'Attester exit authorization 1 has an invalid signature',
        );
      } finally {
        await rm(directory, { recursive: true });
      }
    },
  );
});
