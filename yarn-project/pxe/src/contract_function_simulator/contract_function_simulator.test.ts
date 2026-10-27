import { BackendType, BarretenbergSync } from '@aztec-foundation/bb.js';

import { MAX_TX_LIFETIME, PUBLIC_DATA_TREE_HEIGHT } from '@aztec-labs/constants';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { createLogger } from '@aztec-labs/foundation/log';
import { SiblingPath } from '@aztec-labs/foundation/trees';
import type { AztecNode } from '@aztec-labs/stdlib/interfaces/client';
import { PublicDataTreeLeaf, PublicDataTreeLeafPreimage, PublicDataWitness } from '@aztec-labs/stdlib/trees';
import { HashedValues, PrivateExecutionResult } from '@aztec-labs/stdlib/tx';
import { mock } from 'jest-mock-extended';
import times from 'lodash.times';

import type { ResolveExpirationAndPadding } from '../hooks/resolve_expiration_and_padding.js';
import { roundDownTxExpirationTimestamp } from '../private_kernel/hints/round_down_tx_expiration_timestamp.js';
import { PrivateCircuitPublicInputsBuilder, makeExecutionResult } from '../private_kernel/hints/test_utils.js';
import {
  computeSimulatedMaxExpirationTimestamp,
  generateSimulatedProvingResult,
} from './contract_function_simulator.js';

const logger = createLogger('contract_function_simulator_test');

beforeAll(async () => {
  await BarretenbergSync.initSingleton({ backend: BackendType.NativeSharedMemory, logger: logger.debug });
});

describe('computeSimulatedMaxExpirationTimestamp', () => {
  const anchorBlockTimestamp = 1_000_000n;
  let node: ReturnType<typeof mock<AztecNode>>;

  beforeEach(() => {
    node = mock<AztecNode>();
    // A low leaf witness, as for a contract whose class id was never updated.
    node.getPublicDataWitness.mockImplementation((_referenceBlock, leafSlot) =>
      Promise.resolve(
        new PublicDataWitness(
          0n,
          new PublicDataTreeLeafPreimage(
            new PublicDataTreeLeaf(new Fr(leafSlot.toBigInt() - 1n), Fr.ZERO),
            Fr.ZERO,
            0n,
          ),
          SiblingPath.random(PUBLIC_DATA_TREE_HEIGHT),
        ),
      ),
    );
  });

  it('returns the earliest expiry a call sets, unrounded', async () => {
    // Earlier than a never-updated contract's class id horizon, and not on a rounding boundary.
    const callExpirationTimestamp = anchorBlockTimestamp + 2n * 3600n + 1n;
    const publicInputs = new PrivateCircuitPublicInputsBuilder().build();
    publicInputs.anchorBlockHeader.globalVariables.timestamp = anchorBlockTimestamp;
    publicInputs.expirationTimestamp = callExpirationTimestamp;
    const executionResult = new PrivateExecutionResult(makeExecutionResult(publicInputs), Fr.random(), []);

    expect(await computeSimulatedMaxExpirationTimestamp(executionResult, node)).toBe(callExpirationTimestamp);
  });
});

describe('generateSimulatedProvingResult', () => {
  const anchorBlockTimestamp = 1_000_000n;
  // Not on a rounding boundary, so the expiry PXE publishes by default differs from it.
  const maxExpirationTimestamp = anchorBlockTimestamp + BigInt(MAX_TX_LIFETIME) - 1n;
  let node: ReturnType<typeof mock<AztecNode>>;

  beforeEach(() => {
    node = mock<AztecNode>();
    node.findLeavesIndexes.mockResolvedValue([]);
  });

  /** Simulates a private-only tx whose single private call emits `numNoteHashes` note hashes. */
  const simulate = (numNoteHashes: number, resolveExpirationAndPadding?: ResolveExpirationAndPadding) => {
    const builder = new PrivateCircuitPublicInputsBuilder();
    times(numNoteHashes, () => builder.addNoteHash());
    const publicInputs = builder.build();
    publicInputs.anchorBlockHeader.globalVariables.timestamp = anchorBlockTimestamp;

    const executionResult = new PrivateExecutionResult(makeExecutionResult(publicInputs), Fr.random(), []);
    return generateSimulatedProvingResult(executionResult, () => Promise.resolve('fn'), node, maxExpirationTimestamp, {
      resolveExpirationAndPadding,
    });
  };

  /** A hook keeping the expiry of a private-only tx and padding its note hashes up to `noteHashes`. */
  const padNoteHashesTo =
    (noteHashes: number): ResolveExpirationAndPadding =>
    ({ maxExpirationTimestamp, minSideEffects }) => {
      if (!minSideEffects.isPrivateOnlyTx) {
        throw new Error('Expected a private-only tx.');
      }
      return Promise.resolve({
        expirationTimestamp: maxExpirationTimestamp,
        sideEffects: { ...minSideEffects, noteHashes },
      });
    };

  it('pads side effect', async () => {
    const padded = await simulate(1, padNoteHashesTo(4));
    const real = await simulate(4);

    expect(padded.publicInputs.forRollup!.end.noteHashes.filter(noteHash => !noteHash.isZero())).toHaveLength(4);
    expect(padded.publicInputs.gasUsed).toEqual(real.publicInputs.gasUsed);
  });

  it('pads a tx with public calls in the phase the hook pads', async () => {
    // With the split counter at 2, the note hash at counter 1 is non-revertible and the one at counter 3 revertible.
    const MIN_REVERTIBLE_SIDE_EFFECT_COUNTER = 2;
    const REAL_NOTE_HASHES_PER_PHASE = 1;
    const TARGET_NON_REVERTIBLE_NOTE_HASHES = 3;
    const builder = new PrivateCircuitPublicInputsBuilder();
    builder.addNoteHash({ counter: 1 }).addNoteHash({ counter: 3 });
    const publicInputs = builder.build();
    publicInputs.anchorBlockHeader.globalVariables.timestamp = anchorBlockTimestamp;
    const executionResult = new PrivateExecutionResult(makeExecutionResult(publicInputs), Fr.random(), [
      HashedValues.random(),
    ]);

    const hook: ResolveExpirationAndPadding = ({ maxExpirationTimestamp, minSideEffects }) => {
      if (minSideEffects.isPrivateOnlyTx) {
        throw new Error('Expected a tx with public calls.');
      }
      return Promise.resolve({
        expirationTimestamp: maxExpirationTimestamp,
        sideEffects: {
          ...minSideEffects,
          nonRevertible: { ...minSideEffects.nonRevertible, noteHashes: TARGET_NON_REVERTIBLE_NOTE_HASHES },
        },
      });
    };

    const result = await generateSimulatedProvingResult(
      executionResult,
      () => Promise.resolve('fn'),
      node,
      maxExpirationTimestamp,
      {
        minRevertibleSideEffectCounterOverride: MIN_REVERTIBLE_SIDE_EFFECT_COUNTER,
        resolveExpirationAndPadding: hook,
      },
    );

    const { nonRevertibleAccumulatedData, revertibleAccumulatedData } = result.publicInputs.forPublic!;
    const countNonZero = (values: Fr[]) => values.filter(value => !value.isZero()).length;
    expect(countNonZero(nonRevertibleAccumulatedData.noteHashes)).toBe(TARGET_NON_REVERTIBLE_NOTE_HASHES);
    expect(countNonZero(revertibleAccumulatedData.noteHashes)).toBe(REAL_NOTE_HASHES_PER_PHASE);
  });

  it('publishes the expiry the hook returns', async () => {
    const hookExpirationTimestamp = anchorBlockTimestamp + 1234n;
    const hook: ResolveExpirationAndPadding = request =>
      Promise.resolve({ expirationTimestamp: hookExpirationTimestamp, sideEffects: request.minSideEffects });

    const result = await simulate(1, hook);

    expect(result.publicInputs.expirationTimestamp).toBe(hookExpirationTimestamp);
  });

  it('publishes the rounded down max expiry and adds no padding when there is no hook', async () => {
    const result = await simulate(1);

    expect(result.publicInputs.expirationTimestamp).toBe(
      roundDownTxExpirationTimestamp({ anchorBlockTimestamp, maxExpirationTimestamp }),
    );
    expect(result.publicInputs.forRollup!.end.noteHashes.filter(noteHash => !noteHash.isZero())).toHaveLength(1);
  });
});
