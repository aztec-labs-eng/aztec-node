import { BlockNumber } from '@aztec-labs/foundation/branded-types';
import { times } from '@aztec-labs/foundation/collection';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { type EventMetadataDefinition, EventSelector } from '@aztec-labs/stdlib/abi';
import { AztecAddress } from '@aztec-labs/stdlib/aztec-address';
import { BlockHash } from '@aztec-labs/stdlib/block';
import { MAX_LOGS_PER_TAG } from '@aztec-labs/stdlib/interfaces/api-limit';
import type { AztecNode } from '@aztec-labs/stdlib/interfaces/client';
import { LogCursor, type LogResult, type PublicLogsQuery, randomLogResult } from '@aztec-labs/stdlib/logs';
import { TxHash } from '@aztec-labs/stdlib/tx';
import { type MockProxy, mock } from 'jest-mock-extended';

import { EventCursor, getAllPublicEvents, getPublicEvents } from './events.js';

/** Builds a public log whose decoded payload is `value` */
function makeLog(value: number, { blockNumber = 1, logIndexWithinTx = 0 } = {}): LogResult {
  return {
    ...randomLogResult(),
    logData: [Fr.random(), new Fr(value)],
    blockNumber: BlockNumber(blockNumber),
    logIndexWithinTx,
  };
}

/** A page of `count` logs carrying consecutive values `start, start+1, …`. */
function page(start: number, count: number): LogResult[] {
  return Array.from({ length: count }, (_, i) => makeLog(start + i, { logIndexWithinTx: i }));
}

/** Serves `logs`, as built by {@link page}, the way a node does: one page at a time, resuming after `afterLog`. */
function servePages(node: MockProxy<AztecNode>, logs: LogResult[]) {
  node.getPublicLogsByTags.mockImplementation(({ tags: [tagQuery] }) => {
    const afterLog = 'afterLog' in tagQuery ? tagQuery.afterLog : undefined;
    const start = afterLog ? afterLog.logIndexWithinTx + 1 : 0;
    return Promise.resolve([logs.slice(start, start + MAX_LOGS_PER_TAG)]);
  });
}

describe('getAllPublicEvents', () => {
  let node: MockProxy<AztecNode>;
  let contractAddress: AztecAddress;
  let eventDef: EventMetadataDefinition;

  beforeEach(async () => {
    node = mock<AztecNode>();
    contractAddress = await AztecAddress.random();
    eventDef = { eventSelector: EventSelector.random(), abiType: { kind: 'field' }, fieldNames: ['value'] };
  });

  it.each([
    ['no events', 0],
    ['one event short of a page', MAX_LOGS_PER_TAG - 1],
    ['exactly one page', MAX_LOGS_PER_TAG],
    ['one event past a page', MAX_LOGS_PER_TAG + 1],
    ['several pages', 2 * MAX_LOGS_PER_TAG + 3],
  ])('returns every event, oldest first, with %s', async (_description, count) => {
    servePages(node, page(0, count));

    const events = await getAllPublicEvents<bigint>(node, eventDef, { contractAddress, fromBlock: BlockNumber(1) });

    expect(events.map(e => e.event)).toEqual(times(count, BigInt));
  });

  it('keeps the block range and reference block on every page', async () => {
    const fromBlock = BlockNumber(2);
    const toBlock = BlockNumber(5);
    const referenceBlock = BlockHash.random();
    servePages(node, page(0, MAX_LOGS_PER_TAG + 1));

    await getAllPublicEvents<bigint>(node, eventDef, { contractAddress, fromBlock, toBlock, referenceBlock });

    const queries = node.getPublicLogsByTags.mock.calls.map(([query]) => query);
    expect(queries).toHaveLength(2);
    for (const query of queries) {
      expect(query).toMatchObject({ contractAddress, fromBlock, toBlock, referenceBlock });
    }
  });

  it('keeps the transaction on every page', async () => {
    const txHash = TxHash.random();
    servePages(node, page(0, MAX_LOGS_PER_TAG + 1));

    await getAllPublicEvents<bigint>(node, eventDef, { contractAddress, txHash });

    const queries = node.getPublicLogsByTags.mock.calls.map(([query]) => query);
    expect(queries).toHaveLength(2);
    for (const query of queries) {
      expect(query).toMatchObject({ contractAddress, txHash });
    }
  });

  it('fails instead of returning partial results when a later page fails', async () => {
    node.getPublicLogsByTags
      .mockResolvedValueOnce([page(0, MAX_LOGS_PER_TAG)])
      .mockRejectedValueOnce(new Error('Reference block not found'));

    await expect(
      getAllPublicEvents<bigint>(node, eventDef, { contractAddress, fromBlock: BlockNumber(1) }),
    ).rejects.toThrow('Reference block not found');
  });

  it('maps block and tx metadata onto each returned event', async () => {
    const log = makeLog(42, { blockNumber: 7 });
    servePages(node, [log]);

    const [event] = await getAllPublicEvents<bigint>(node, eventDef, { contractAddress, fromBlock: BlockNumber(1) });

    expect(event.metadata).toEqual({
      l2BlockNumber: BlockNumber(7),
      l2BlockHash: log.blockHash,
      txHash: log.txHash,
      contractAddress,
    });
  });

  it('only accepts a block range with a lower bound or a single transaction', async () => {
    const fromBlock = BlockNumber(1);
    const toBlock = BlockNumber(2);
    const txHash = TxHash.random();
    servePages(node, []);

    // @ts-expect-error a filter needs a block range or a transaction
    await getAllPublicEvents<bigint>(node, eventDef, { contractAddress });
    // @ts-expect-error a block range needs a lower bound
    await getAllPublicEvents<bigint>(node, eventDef, { contractAddress, toBlock });
    // @ts-expect-error a transaction cannot be combined with a block range
    await getAllPublicEvents<bigint>(node, eventDef, { contractAddress, txHash, fromBlock });

    expect(await getAllPublicEvents<bigint>(node, eventDef, { contractAddress, fromBlock })).toEqual([]);
  });
});

describe('getPublicEvents', () => {
  let node: MockProxy<AztecNode>;
  let contractAddress: AztecAddress;
  let eventDef: EventMetadataDefinition;

  beforeEach(async () => {
    node = mock<AztecNode>();
    contractAddress = await AztecAddress.random();
    eventDef = { eventSelector: EventSelector.random(), abiType: { kind: 'field' }, fieldNames: ['value'] };
  });

  it('returns one page and reports no more when the page is not full', async () => {
    node.getPublicLogsByTags.mockResolvedValueOnce([page(0, 5)]);

    const { events, nextCursor } = await getPublicEvents<bigint>(node, eventDef, { contractAddress });

    expect(events.map(e => e.event)).toEqual([0n, 1n, 2n, 3n, 4n]);
    expect(nextCursor).toBeUndefined();
    expect(node.getPublicLogsByTags).toHaveBeenCalledTimes(1);
  });

  it('returns a nextCursor at the last event when the page is full', async () => {
    const fullPage = page(0, MAX_LOGS_PER_TAG);
    const lastLog = fullPage[fullPage.length - 1];
    node.getPublicLogsByTags.mockResolvedValueOnce([fullPage]).mockResolvedValueOnce([page(MAX_LOGS_PER_TAG, 3)]);

    const { events, nextCursor } = await getPublicEvents<bigint>(node, eventDef, { contractAddress });

    expect(events).toHaveLength(MAX_LOGS_PER_TAG);
    expect(nextCursor).toEqual(EventCursor.fromLogCursor(LogCursor.fromLog(lastLog)));
    expect(node.getPublicLogsByTags).toHaveBeenCalledTimes(1);
  });

  it('honors afterEvent by converting it to the query afterLog cursor', async () => {
    const afterEvent = EventCursor.fromLogCursor(
      LogCursor.fromLog(makeLog(0, { blockNumber: 5, logIndexWithinTx: 2 })),
    );
    node.getPublicLogsByTags.mockResolvedValueOnce([page(0, 3)]);

    await getPublicEvents<bigint>(node, eventDef, { contractAddress, afterEvent });

    const query = node.getPublicLogsByTags.mock.calls[0][0] as PublicLogsQuery;
    expect(query.contractAddress).toEqual(contractAddress);
    expect((query.tags[0] as { afterLog: LogCursor }).afterLog).toEqual(afterEvent.toLogCursor());
  });

  it('maps block and tx metadata onto each returned event', async () => {
    const log = makeLog(42, { blockNumber: 7 });
    node.getPublicLogsByTags.mockResolvedValueOnce([[log]]);

    const { events } = await getPublicEvents<bigint>(node, eventDef, { contractAddress });

    expect(events[0].metadata).toEqual({
      l2BlockNumber: BlockNumber(7),
      l2BlockHash: log.blockHash,
      txHash: log.txHash,
      contractAddress,
    });
  });
});
