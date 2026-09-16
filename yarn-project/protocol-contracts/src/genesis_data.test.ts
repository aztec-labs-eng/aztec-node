import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { getContractClassFromArtifact } from '@aztec-labs/stdlib/contract';
import { siloNullifier } from '@aztec-labs/stdlib/hash';

import { DEFAULT_GENESIS_DATA } from './genesis_data.js';
import { ProtocolContractAddress, protocolContractNames } from './protocol_contract_data.js';
import { ProtocolContractArtifact } from './provider/bundle.js';

describe('DEFAULT_GENESIS_DATA', () => {
  // Recomputed from the bundled artifacts rather than read back from the generator's output, so a stale
  // `protocol_contract_data.ts` or a mistake in its generator fails here. This does not catch a class id rotation:
  // the generated file is rebuilt from the same artifacts, so both sides move together. What catches that is the
  // pinned-root assertion in world-state's `testing.test.ts`, which compares a live genesis against
  // `GENESIS_ARCHIVE_ROOT`.
  it('seeds exactly the registration nullifiers the bundled protocol artifacts imply', async () => {
    const expected: Fr[] = [];
    for (const name of protocolContractNames) {
      const { id: classId } = await getContractClassFromArtifact(ProtocolContractArtifact[name]);
      expected.push(await siloNullifier(ProtocolContractAddress.ContractClassRegistry, classId));
      expected.push(
        await siloNullifier(ProtocolContractAddress.ContractInstanceRegistry, ProtocolContractAddress[name].toField()),
      );
    }
    expected.sort((a, b) => (a.toBigInt() < b.toBigInt() ? -1 : 1));

    expect(DEFAULT_GENESIS_DATA.prefilledNullifiers.map(n => n.toString())).toEqual(expected.map(n => n.toString()));
  });

  it('is strictly increasing, as the indexed nullifier tree requires', () => {
    const nullifiers = DEFAULT_GENESIS_DATA.prefilledNullifiers;
    expect(nullifiers.length).toBeGreaterThan(0);
    for (let i = 1; i < nullifiers.length; i++) {
      expect(nullifiers[i - 1].toBigInt() < nullifiers[i].toBigInt()).toBe(true);
    }
  });
});
