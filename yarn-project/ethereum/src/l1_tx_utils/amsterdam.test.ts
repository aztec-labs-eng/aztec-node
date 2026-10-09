import { TestDateProvider } from '@aztec-labs/foundation/timer';
import { type Hex, formatBlock, toHex } from 'viem';

import { AmsterdamForkDetector, getMaxL1TxGasLimit, isAmsterdamBlock } from './amsterdam.js';
import { AMSTERDAM_MAX_L1_TX_LIMIT, MAX_L1_TX_LIMIT } from './constants.js';

describe('Amsterdam fork detection', () => {
  const blockAccessListHash: Hex = toHex(1, { size: 32 });
  const preAmsterdamBlock = { number: 1n, timestamp: 12n };
  const amsterdamBlock = { ...preAmsterdamBlock, blockAccessListHash };

  describe('isAmsterdamBlock', () => {
    it('detects a block with a blockAccessListHash', () => {
      expect(isAmsterdamBlock(amsterdamBlock)).toBe(true);
    });

    it('rejects a block without a blockAccessListHash', () => {
      expect(isAmsterdamBlock(preAmsterdamBlock)).toBe(false);
      expect(isAmsterdamBlock({ ...preAmsterdamBlock, blockAccessListHash: null })).toBe(false);
      expect(isAmsterdamBlock(null)).toBe(false);
      expect(isAmsterdamBlock(undefined)).toBe(false);
    });

    it('detects a raw RPC block once formatted by viem', () => {
      const rpcBlock: Record<'number' | 'timestamp' | 'gasLimit', Hex> & { transactions: Hex[] } = {
        number: '0x1',
        timestamp: '0xc',
        gasLimit: '0x2faf080',
        transactions: [],
      };
      const rpcAmsterdamBlock = { ...rpcBlock, blockAccessListHash };
      expect(isAmsterdamBlock(formatBlock(rpcAmsterdamBlock))).toBe(true);
      expect(isAmsterdamBlock(formatBlock(rpcBlock))).toBe(false);
    });
  });

  it('picks the gas limit cap depending on the fork', () => {
    expect(getMaxL1TxGasLimit(false)).toBe(MAX_L1_TX_LIMIT);
    expect(getMaxL1TxGasLimit(true)).toBe(AMSTERDAM_MAX_L1_TX_LIMIT);
  });

  describe('AmsterdamForkDetector', () => {
    let latestBlock: object;
    let dateProvider: TestDateProvider;
    let detector: AmsterdamForkDetector;

    beforeEach(() => {
      latestBlock = preAmsterdamBlock;
      dateProvider = new TestDateProvider();
      detector = new AmsterdamForkDetector(
        { getBlock: () => Promise.resolve(latestBlock) },
        { maxBlockAgeMs: 12_000, dateProvider },
      );
    });

    it('reports the fork from the latest L1 block', async () => {
      expect(await detector.isActive()).toBe(false);

      latestBlock = amsterdamBlock;
      dateProvider.advanceTime(12);
      expect(await detector.isActive()).toBe(true);
    });

    it('stays active once detected', async () => {
      latestBlock = amsterdamBlock;
      expect(await detector.isActive()).toBe(true);

      latestBlock = preAmsterdamBlock;
      dateProvider.advanceTime(60);
      expect(await detector.isActive()).toBe(true);
    });

    it('answers from a recently observed block until it is stale', async () => {
      latestBlock = amsterdamBlock;
      detector.observe(preAmsterdamBlock);
      expect(await detector.isActive()).toBe(false);

      dateProvider.advanceTime(12);
      expect(await detector.isActive()).toBe(true);
    });

    it('activates from an observed post-Amsterdam block', async () => {
      detector.observe(amsterdamBlock);
      expect(await detector.isActive()).toBe(true);
    });

    it('answers as requested when the latest block cannot be fetched', async () => {
      detector = new AmsterdamForkDetector({ getBlock: () => Promise.reject(new Error('rpc down')) }, { dateProvider });
      expect(await detector.isActive()).toBe(false);
      expect(await detector.isActive({ assumeActiveOnError: true })).toBe(true);
    });
  });
});
