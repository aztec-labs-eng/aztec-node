import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { recoverTypedDataAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { getPublicClient } from '../client.js';
import { RollupContract } from './rollup.js';

const account = privateKeyToAccount(`0x${'01'.repeat(32)}`);
const otherAccount = privateKeyToAccount(`0x${'02'.repeat(32)}`);
const attester = EthAddress.fromString(account.address);
const address = EthAddress.fromString('0x1234567890123456789012345678901234567890');
// January 1, 2100 (Unix seconds), so the test authorization stays valid as time passes.
const deadline = 4102444800n;
const client = getPublicClient({ l1RpcUrls: ['http://127.0.0.1:1'], l1ChainId: 31337 });
const rollup = new RollupContract(client, address);
const sign = (target = rollup) =>
  target.createAttesterExitAuthorization(attester, deadline, data => account.signTypedData(data));

describe('attester exit authorizations', () => {
  it('creates an independently verifiable EIP-712 signature without RPC', async () => {
    const authorization = await sign();
    const recovered = await recoverTypedDataAddress({
      domain: { name: 'Aztec Rollup', version: '1', chainId: 31337, verifyingContract: address.toString() },
      types: {
        AttesterExit: [
          { name: 'attester', type: 'address' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
      primaryType: 'AttesterExit',
      message: { attester: account.address, deadline },
      signature: { ...authorization.signature, v: BigInt(authorization.signature.v) },
    });
    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
  });

  it('validates a batch without modifying its authorizations or contacting RPC', async () => {
    const entries = [
      await sign(),
      await rollup.createAttesterExitAuthorization(EthAddress.fromString(otherAccount.address), deadline, data =>
        otherAccount.signTypedData(data),
      ),
    ];
    const before = entries.map(entry => ({ ...entry, signature: { ...entry.signature } }));
    await expect(rollup.validateAttesterExitAuthorizations(entries)).resolves.toBeUndefined();
    expect(entries).toEqual(before);
  });

  it('rejects duplicate attesters', async () => {
    const entry = await sign();
    await expect(rollup.validateAttesterExitAuthorizations([entry, entry])).rejects.toThrow('Duplicate attester');
  });

  it.each(['chain', 'rollup'])('rejects a signature from another %s', async domain => {
    const otherRollup = new RollupContract(
      domain === 'chain' ? getPublicClient({ l1RpcUrls: ['http://127.0.0.1:1'], l1ChainId: 1 }) : client,
      domain === 'rollup' ? EthAddress.ZERO : address,
    );
    await expect(rollup.validateAttesterExitAuthorizations([await sign(otherRollup)])).rejects.toThrow(
      'Invalid signature',
    );
  });

  it('rejects an expired authorization', async () => {
    const entry = await sign();
    await expect(rollup.validateAttesterExitAuthorizations([{ ...entry, deadline: 1n }])).rejects.toThrow(
      'Invalid or expired deadline',
    );
  });

  it('rejects a signer that does not match the attester', async () => {
    await expect(
      rollup.createAttesterExitAuthorization(attester, deadline, data => otherAccount.signTypedData(data)),
    ).rejects.toThrow('Invalid signature');
  });

  it.each([0n, -1n, 1n << 256n])('rejects an invalid signing deadline %s', async deadline => {
    await expect(
      rollup.createAttesterExitAuthorization(attester, deadline, data => account.signTypedData(data)),
    ).rejects.toThrow('Deadline must be a future Unix timestamp');
  });
});
