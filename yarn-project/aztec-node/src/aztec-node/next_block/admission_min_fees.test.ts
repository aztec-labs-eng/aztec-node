import { GasFees } from '@aztec-labs/stdlib/gas';

import { AdmissionMinFeesProvider } from './admission_min_fees.js';

describe('AdmissionMinFeesProvider', () => {
  const L1_FORWARD_FEES = new GasFees(3, 30);

  const makeProvider = (nextBlockFees: GasFees | undefined) =>
    new AdmissionMinFeesProvider(
      { getNextBlockMinFees: () => Promise.resolve(nextBlockFees) },
      { getCurrentMinFees: () => Promise.resolve(L1_FORWARD_FEES) },
    );

  it('admits against the next-block fee when it resolves', async () => {
    const provider = makeProvider(new GasFees(7, 70));

    await expect(provider.getAdmissionMinFees()).resolves.toEqual(new GasFees(7, 70));
  });

  it('admits against the L1-forward fee when the next block cannot be priced', async () => {
    const provider = makeProvider(undefined);

    await expect(provider.getAdmissionMinFees()).resolves.toEqual(L1_FORWARD_FEES);
  });

  it('reports the next-block fee unchanged, unavailability included', async () => {
    await expect(makeProvider(new GasFees(7, 70)).getNextBlockMinFees()).resolves.toEqual(new GasFees(7, 70));
    await expect(makeProvider(undefined).getNextBlockMinFees()).resolves.toBeUndefined();
  });
});
