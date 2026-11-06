import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { createLogger } from '@aztec-labs/foundation/log';
import { Gas } from '@aztec-labs/stdlib/gas';
import type { AllowedElement } from '@aztec-labs/stdlib/interfaces/server';
import { makeAztecAddress, makeSelector } from '@aztec-labs/stdlib/testing';

import { warnOnSetupEntriesWithoutMinGas } from './allowed_setup_helpers.js';

describe('warnOnSetupEntriesWithoutMinGas', () => {
  const log = createLogger('p2p:test:allowed-setup-helpers');

  it('reports the entries that declare no minimum gas', () => {
    const metered: AllowedElement = { address: makeAztecAddress(1), selector: makeSelector(1), minGas: new Gas(0, 10) };
    const unmeteredAddress: AllowedElement = {
      address: makeAztecAddress(2),
      selector: makeSelector(2),
      onlySelf: true,
    };
    const unmeteredClass: AllowedElement = { classId: Fr.random(), selector: makeSelector(3) };

    expect(warnOnSetupEntriesWithoutMinGas([metered, unmeteredAddress, unmeteredClass], log)).toEqual([
      unmeteredAddress,
      unmeteredClass,
    ]);
  });

  it('reports nothing when every entry declares a minimum gas', () => {
    const entries: AllowedElement[] = [
      { address: makeAztecAddress(1), selector: makeSelector(1), minGas: new Gas(64, 0) },
      { classId: Fr.random(), selector: makeSelector(2), minGas: new Gas(0, 1) },
    ];

    expect(warnOnSetupEntriesWithoutMinGas(entries, log)).toEqual([]);
  });
});
