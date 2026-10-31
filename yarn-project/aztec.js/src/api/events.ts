import { DomainSeparator } from '@aztec-labs/constants';
import type { BlockNumber } from '@aztec-labs/foundation/branded-types';
import { type EventMetadataDefinition, decodeFromAbi } from '@aztec-labs/stdlib/abi';
import type { AztecAddress } from '@aztec-labs/stdlib/aztec-address';
import { computeLogTag } from '@aztec-labs/stdlib/hash';
import { MAX_LOGS_PER_TAG } from '@aztec-labs/stdlib/interfaces/api-limit';
import type { AztecNode } from '@aztec-labs/stdlib/interfaces/client';
import {
  LogCursor,
  type LogResult,
  type LogsQueryAnchor,
  type PublicLogsQuery,
  Tag,
  queryAllPublicLogsByTags,
} from '@aztec-labs/stdlib/logs';
import type { TxHash } from '@aztec-labs/stdlib/tx';

import type { PublicEvent, PublicEventFilter } from '../wallet/wallet.js';
import { EventCursor } from './event_cursor.js';

export { EventCursor };

/**
 * Selects the public events read by {@link getAllPublicEvents}.
 *
 * Either a block range or a single transaction. A block range needs a `fromBlock`, so reading the whole history of an
 * event is always explicit.
 */
export type AllPublicEventsFilter = {
  /** The address of the contract that emitted the events. */
  contractAddress: AztecAddress;
  /**
   * The latest block the caller has synced to. The read throws if that block is no longer present, and only returns
   * events up to and including it.
   */
  referenceBlock?: LogsQueryAnchor;
} & (
  | {
      /** The block number from which to read events (inclusive). */
      fromBlock: BlockNumber;
      /**
       * The block number until which to read events (not inclusive). Without it, the read includes the latest block the
       * node has.
       */
      toBlock?: BlockNumber;
      /** Not allowed with a block range. */
      txHash?: never;
    }
  | {
      /** The transaction in which the events were emitted. */
      txHash: TxHash;
      /** Not allowed with a transaction. */
      fromBlock?: never;
      /** Not allowed with a transaction. */
      toBlock?: never;
    }
);

/**
 * Result of a single page of a public event query.
 *
 * @deprecated Use {@link getAllPublicEvents}, which returns every matching event.
 */
export type GetPublicEventsResult<T> = {
  /** The decoded events with metadata. At most `MAX_LOGS_PER_TAG` (the node's per-tag page size). */
  events: PublicEvent<T>[];
  /**
   * If present, use it to fetch the next page by setting `afterEvent` to it. Absent when all events in the range have
   * been returned.
   */
  nextCursor?: EventCursor;
};

/**
 * Returns every decoded public event that matches the filter, oldest first.
 *
 * The node serves events in pages, so a single call can make many requests, and it holds all the events in memory.
 * Split long ranges into smaller ones.
 *
 * To poll for new events, read up to a chain tip, and only move on to the next range once the events have been handled.
 * Anchor the read on that tip with `referenceBlock`: a reorg during the read then throws, instead of mixing events from
 * both forks.
 *
 * ```ts
 * const tip = await node.getBlockData('checkpointed');
 * if (tip && tip.header.getBlockNumber() > lastProcessedBlock) {
 *   const referenceBlock = await tip.header.toBlockParameter();
 *   const events = await getAllPublicEvents<MyEvent>(node, MyContract.events.MyEvent, {
 *     contractAddress,
 *     fromBlock: BlockNumber(lastProcessedBlock + 1),
 *     referenceBlock,
 *   });
 *   handleEvents(events);
 *   lastProcessedBlock = referenceBlock.number;
 * }
 * ```
 *
 * @param node - The node to request events from.
 * @param eventMetadataDef - Metadata of the event. This should be the class generated from the contract.
 *   e.g. `Contract.events.Event`.
 * @param filter - The block range or transaction to read events from.
 * @returns The decoded events with metadata.
 */
export async function getAllPublicEvents<T>(
  node: AztecNode,
  eventMetadataDef: EventMetadataDefinition,
  filter: AllPublicEventsFilter,
): Promise<PublicEvent<T>[]> {
  const [logsForTag] = await queryAllPublicLogsByTags(node, {
    contractAddress: filter.contractAddress,
    tags: [await computeEventLogTag(eventMetadataDef)],
    fromBlock: filter.fromBlock,
    toBlock: filter.toBlock,
    txHash: filter.txHash,
    referenceBlock: filter.referenceBlock,
  });

  return logsForTag.map(log => decodePublicEvent<T>(log, eventMetadataDef, filter.contractAddress));
}

/**
 * Returns a page of decoded public events given search parameters.
 *
 * A single call returns at most `MAX_LOGS_PER_TAG` events (the node's per-tag page size). When more events exist,
 * `nextCursor` points past the last returned event. Pass it as `afterEvent` to fetch the next page. When `nextCursor`
 * is absent, all events in the range have been returned.
 *
 * @deprecated Use {@link getAllPublicEvents}, which returns every matching event.
 * @param node - The node to request events from.
 * @param eventMetadataDef - Metadata of the event. This should be the class generated from the contract.
 *   e.g. `Contract.events.Event`.
 * @param filter - Filter options for the event query:
 *   - `contractAddress`: The address of the contract that emitted the events. Required.
 *   - `txHash`: Transaction in which the events were emitted (mutually exclusive with `fromBlock`/`toBlock`).
 *   - `fromBlock`: The block number from which to start fetching events (inclusive). Optional.
 *   - `toBlock`: The block number until which to fetch events (not inclusive). Optional.
 *   - `afterEvent`: Cursor to resume strictly after. Optional. When set, only events after this cursor
 *     are returned.
 * @returns A page of decoded events with metadata, plus a `nextCursor` to continue (absent when done).
 */
export async function getPublicEvents<T>(
  node: AztecNode,
  eventMetadataDef: EventMetadataDefinition,
  filter: PublicEventFilter,
): Promise<GetPublicEventsResult<T>> {
  const logTag = await computeEventLogTag(eventMetadataDef);

  const afterLog = filter.afterEvent?.toLogCursor();
  const query: PublicLogsQuery = {
    contractAddress: filter.contractAddress,
    tags: [afterLog !== undefined ? { tag: logTag, afterLog } : logTag],
    fromBlock: filter.fromBlock,
    toBlock: filter.toBlock,
    txHash: filter.txHash,
  };

  const [logsForTag] = await node.getPublicLogsByTags(query);
  const events = logsForTag.map(log => decodePublicEvent<T>(log, eventMetadataDef, filter.contractAddress));

  const nextCursor =
    logsForTag.length === MAX_LOGS_PER_TAG
      ? EventCursor.fromLogCursor(LogCursor.fromLog(logsForTag[logsForTag.length - 1]))
      : undefined;

  return { events, nextCursor };
}

/** The tag under which a node indexes the public logs of this event type. */
async function computeEventLogTag(eventMetadataDef: EventMetadataDefinition): Promise<Tag> {
  // Public events are tagged with a domain-separated hash of their event type ID, so we compute
  // the same hash here to filter for logs of the requested event type.
  const logTagField = await computeLogTag(eventMetadataDef.eventSelector.toField(), DomainSeparator.EVENT_LOG_TAG);
  return new Tag(logTagField);
}

/** Decodes a public log into an event, carrying over the block and tx it was emitted in. */
function decodePublicEvent<T>(
  log: LogResult,
  eventMetadataDef: EventMetadataDefinition,
  contractAddress: AztecAddress,
): PublicEvent<T> {
  return {
    event: decodeFromAbi(eventMetadataDef.abiType, log.logData.slice(1)) as T,
    metadata: {
      l2BlockNumber: log.blockNumber,
      l2BlockHash: log.blockHash,
      txHash: log.txHash,
      contractAddress,
    },
  };
}
