import type { ContractDataSource } from '@aztec-labs/stdlib/contract';
import { SimulationError } from '@aztec-labs/stdlib/errors';
import { GasFees } from '@aztec-labs/stdlib/gas';
import { mockTx } from '@aztec-labs/stdlib/testing';
import { GlobalVariables } from '@aztec-labs/stdlib/tx';
import { mock } from 'jest-mock-extended';

import { AvmProcessDiedError, type AvmSimulator } from '../avm_simulator.js';
import { PublicContractsDB } from '../public_db_sources.js';
import { PublicTxSimulator } from './public_tx_simulator.js';

describe('PublicTxSimulator', () => {
  const globalVariables = GlobalVariables.from({
    ...GlobalVariables.empty(),
    gasFees: GasFees.from({ feePerDaGas: 2n, feePerL2Gas: 3n }),
  });

  const simulatorFailingWith = (error: Error) => {
    const avmSimulator = mock<AvmSimulator>();
    avmSimulator.simulate.mockRejectedValue(error);
    return new PublicTxSimulator(avmSimulator, globalVariables, new PublicContractsDB(mock<ContractDataSource>()), 1);
  };

  const mockTxWithPublicCalls = () =>
    mockTx(1, { numberOfNonRevertiblePublicCallRequests: 1, numberOfRevertiblePublicCallRequests: 1 });

  it('passes a dead AVM process through unwrapped, so callers can tell it from a failing tx', async () => {
    const died = new AvmProcessDiedError('AVM simulator process died twice running this simulation');
    const simulator = simulatorFailingWith(died);

    await expect(simulator.simulate(await mockTxWithPublicCalls())).rejects.toBe(died);
  });

  it('wraps any other AVM failure as a simulation error', async () => {
    const simulator = simulatorFailingWith(new Error('assertion failed in the AVM'));

    const err = await simulator.simulate(await mockTxWithPublicCalls()).then(
      () => undefined,
      (e: Error) => e,
    );

    expect(err).toBeInstanceOf(SimulationError);
    expect(err?.message).toMatch(/AVM simulation failed: assertion failed in the AVM/);
  });
});
