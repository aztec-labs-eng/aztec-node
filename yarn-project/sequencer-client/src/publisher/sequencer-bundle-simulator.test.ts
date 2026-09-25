import type { EpochCache } from '@aztec-labs/epoch-cache';
import type { RollupContract } from '@aztec-labs/ethereum/contracts';
import {
  type L1TxUtils,
  MAX_L1_TX_LIMIT,
  ReadOnlyL1TxUtils,
  defaultL1TxUtilsConfig,
} from '@aztec-labs/ethereum/l1-tx-utils';
import { SlotNumber } from '@aztec-labs/foundation/branded-types';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { createLogger } from '@aztec-labs/foundation/log';
import { EmptyL1RollupConstants } from '@aztec-labs/stdlib/epoch-helpers';
import { type MockProxy, mock } from 'jest-mock-extended';
import { type Hex, encodeFunctionResult, multicall3Abi } from 'viem';

import { SequencerBundleSimulator } from './sequencer-bundle-simulator.js';
import type { RequestWithExpiry } from './sequencer-publisher.js';

describe('SequencerBundleSimulator gas limit', () => {
  const rollupAddress = EthAddress.random().toString();
  const targetSlot = SlotNumber(12);

  let l1TxUtils: MockProxy<L1TxUtils>;
  let simulator: SequencerBundleSimulator;

  const makeRequest = (
    action: RequestWithExpiry['action'],
    extra: Partial<RequestWithExpiry> = {},
  ): RequestWithExpiry => ({
    action,
    request: { to: rollupAddress, data: '0xdeadbeef' },
    lastValidL2Slot: SlotNumber(Number(targetSlot) + 2),
    checkSuccess: () => true,
    ...extra,
  });

  /** An aggregate3 return payload with one Result entry per given outcome. */
  const aggregate3Result = (successes: boolean[]) =>
    encodeFunctionResult({
      abi: multicall3Abi,
      functionName: 'aggregate3',
      result: successes.map(success => ({ success, returnData: '0x' as Hex })),
    });

  beforeEach(() => {
    l1TxUtils = mock<L1TxUtils>();
    l1TxUtils.config = { ...defaultL1TxUtilsConfig, gasLimitBufferPercentage: 20 };
    // Run the real bumping arithmetic against the mock's config, so these tests assert on the buffer the
    // simulator chooses rather than on a second copy of the formula. It reads only config and logger.
    Object.defineProperty(l1TxUtils, 'logger', { value: createLogger('sequencer:test:l1-tx-utils') });
    l1TxUtils.bumpGasLimit.mockImplementation((gasLimit, overrides) =>
      ReadOnlyL1TxUtils.prototype.bumpGasLimit.call(l1TxUtils, gasLimit, overrides),
    );

    const rollupContract = mock<RollupContract>();
    Object.defineProperty(rollupContract, 'address', { value: rollupAddress });
    const epochCache = mock<EpochCache>();
    epochCache.getL1Constants.mockReturnValue(EmptyL1RollupConstants);

    simulator = new SequencerBundleSimulator({
      getL1TxUtils: () => l1TxUtils,
      rollupContract,
      epochCache,
      log: createLogger('sequencer:test:bundle-simulator'),
    });
  });

  it('sizes the bundle from maxUsedGas with the configured buffer, not from gasUsed', async () => {
    l1TxUtils.simulate.mockResolvedValue({
      gasUsed: 800_000n,
      maxUsedGas: 1_000_000n,
      result: aggregate3Result([true]),
    });

    const result = await simulator.simulate([makeRequest('propose')], targetSlot);

    // ceil(1_000_000 * 64 / 63) = 1_015_874, bumped by 20%. Sizing off gasUsed would give 975_238.
    expect(result).toEqual(expect.objectContaining({ kind: 'success', gasLimit: 1_219_048n }));
  });

  it('falls back to gasUsed with the same configured buffer when maxUsedGas is missing', async () => {
    l1TxUtils.simulate.mockResolvedValue({ gasUsed: 1_000_000n, result: aggregate3Result([true]) });

    const result = await simulator.simulate([makeRequest('propose')], targetSlot);

    // ceil(1_000_000 * 64 / 63) = 1_015_874, bumped by the configured 20% — same as for a reported maxUsedGas.
    expect(result).toEqual(expect.objectContaining({ kind: 'success', gasLimit: 1_219_048n }));
  });

  it('uses a larger configured buffer when maxUsedGas is missing', async () => {
    l1TxUtils.config = { ...l1TxUtils.config, gasLimitBufferPercentage: 50 };
    l1TxUtils.simulate.mockResolvedValue({ gasUsed: 1_000_000n, result: aggregate3Result([true]) });

    const result = await simulator.simulate([makeRequest('propose')], targetSlot);

    expect(result).toEqual(expect.objectContaining({ kind: 'success', gasLimit: 1_523_811n }));
  });

  it('uses a smaller configured buffer when maxUsedGas is missing', async () => {
    l1TxUtils.config = { ...l1TxUtils.config, gasLimitBufferPercentage: 10 };
    l1TxUtils.simulate.mockResolvedValue({ gasUsed: 1_000_000n, result: aggregate3Result([true]) });

    const result = await simulator.simulate([makeRequest('propose')], targetSlot);

    // The configured buffer is used as-is; a gasUsed basis is not clamped up to any minimum.
    expect(result).toEqual(expect.objectContaining({ kind: 'success', gasLimit: 1_117_461n }));
  });

  it('uses a smaller configured buffer when maxUsedGas is reported', async () => {
    l1TxUtils.config = { ...l1TxUtils.config, gasLimitBufferPercentage: 10 };
    l1TxUtils.simulate.mockResolvedValue({
      gasUsed: 800_000n,
      maxUsedGas: 1_000_000n,
      result: aggregate3Result([true]),
    });

    const result = await simulator.simulate([makeRequest('propose')], targetSlot);

    expect(result).toEqual(expect.objectContaining({ kind: 'success', gasLimit: 1_117_461n }));
  });

  it('adds the blob evaluation gas of a propose that survived', async () => {
    l1TxUtils.simulate.mockResolvedValue({
      gasUsed: 300_000n,
      maxUsedGas: 400_000n,
      result: aggregate3Result([true]),
    });

    const result = await simulator.simulate([makeRequest('propose', { blobEvaluationGas: 50_000n })], targetSlot);

    // ceil(400_000 * 64 / 63) = 406_350, bumped by 20% = 487_620, plus the blob evaluation gas.
    expect(result).toEqual(expect.objectContaining({ kind: 'success', gasLimit: 537_620n }));
  });

  it('sizes from the second pass and drops the blob allowance when propose reverts', async () => {
    const propose = makeRequest('propose', { blobEvaluationGas: 50_000n });
    const invalidate = makeRequest('invalidate-by-invalid-attestation');
    l1TxUtils.simulate
      .mockResolvedValueOnce({ gasUsed: 5_000_000n, maxUsedGas: 6_000_000n, result: aggregate3Result([false, true]) })
      .mockResolvedValueOnce({ gasUsed: 300_000n, maxUsedGas: 400_000n, result: aggregate3Result([true]) });

    const result = await simulator.simulate([propose, invalidate], targetSlot);

    expect(result).toEqual(expect.objectContaining({ kind: 'success', requests: [invalidate], gasLimit: 487_620n }));
  });

  it('does not carry a first-pass maxUsedGas into a second pass that omits it', async () => {
    const propose = makeRequest('propose');
    const invalidate = makeRequest('invalidate-by-invalid-attestation');
    l1TxUtils.simulate
      .mockResolvedValueOnce({ gasUsed: 5_000_000n, maxUsedGas: 6_000_000n, result: aggregate3Result([false, true]) })
      .mockResolvedValueOnce({ gasUsed: 1_000_000n, result: aggregate3Result([true]) });

    const result = await simulator.simulate([propose, invalidate], targetSlot);

    // The second pass reported no maxUsedGas, so its own gasUsed is the basis, bumped by the configured 20%.
    expect(result).toEqual(expect.objectContaining({ kind: 'success', gasLimit: 1_219_048n }));
  });

  it('caps the gas limit at MAX_L1_TX_LIMIT after padding and bumping', async () => {
    l1TxUtils.simulate.mockResolvedValue({
      gasUsed: MAX_L1_TX_LIMIT,
      maxUsedGas: MAX_L1_TX_LIMIT,
      result: aggregate3Result([true]),
    });

    const result = await simulator.simulate([makeRequest('propose')], targetSlot);

    expect(result).toEqual(expect.objectContaining({ kind: 'success', gasLimit: MAX_L1_TX_LIMIT }));
  });

  it('falls back when the node does not support eth_simulateV1', async () => {
    const requests = [makeRequest('propose')];
    l1TxUtils.simulate.mockResolvedValue({ gasUsed: MAX_L1_TX_LIMIT, result: '0x' });

    const result = await simulator.simulate(requests, targetSlot);

    expect(result).toEqual({ kind: 'fallback', requests, droppedRequests: [] });
  });
});
