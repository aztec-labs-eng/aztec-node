import type { BlockNumber } from '@aztec-labs/foundation/branded-types';
import type { Fr } from '@aztec-labs/foundation/curves/bn254';
import type { GrumpkinScalar } from '@aztec-labs/foundation/curves/grumpkin';
import { type Logger, type LoggerBindings, createLogger } from '@aztec-labs/foundation/log';
import { allToCompletion } from '@aztec-labs/foundation/promise';
import type { KeyStore } from '@aztec-labs/key-store';
import { AztecAddress } from '@aztec-labs/stdlib/aztec-address';
import type { L2TipsProvider } from '@aztec-labs/stdlib/block';
import type { CompleteAddress } from '@aztec-labs/stdlib/contract';
import type { AztecNode } from '@aztec-labs/stdlib/interfaces/server';
import { AppTaggingSecret, type LogResult, OnchainDeliveryMode, SiloedTag } from '@aztec-labs/stdlib/logs';
import type { BlockHeader } from '@aztec-labs/stdlib/tx';
import type { UInt64 } from '@aztec-labs/stdlib/types';

import {
  type LogRetrievalRequest,
  LogSource,
} from '../contract_function_simulator/noir-structs/log_retrieval_request.js';
import type { TxOnchainContext } from '../messages/tx_resolver_service.js';
import { AddressStore } from '../storage/address_store/address_store.js';
import { assertAllowedScope } from '../storage/allowed_scopes.js';
import type { ChangeSetId } from '../storage/staged_write_coordinator.js';
import type { RecipientTaggingStore } from '../storage/tagging_store/recipient_tagging_store.js';
import type { TaggingSecretSourcesStore } from '../storage/tagging_store/tagging_secret_sources_store.js';
import {
  type LogQueryAnchor,
  getAllPrivateLogsByTags,
  getAllPublicLogsByTagsFromContract,
  syncTaggedPrivateLogs,
} from '../tagging/index.js';

/** Key used to group requests by their (fromBlock, toBlock) range so each group becomes a single node call. */
type RangeKey = string;
const rangeKey = (fromBlock?: BlockNumber, toBlock?: BlockNumber): RangeKey => `${fromBlock ?? ''}-${toBlock ?? ''}`;

/** The recipient key material that tagging secret derivation needs. */
type RecipientKeys = { completeAddress: CompleteAddress; ivsk: GrumpkinScalar };

export class LogService {
  private log: Logger;

  constructor(
    private readonly aztecNode: AztecNode,
    private readonly anchorBlockHeader: BlockHeader,
    private readonly l2TipsStore: L2TipsProvider,
    private readonly keyStore: KeyStore,
    private readonly recipientTaggingStore: RecipientTaggingStore,
    private readonly taggingSecretSourcesStore: TaggingSecretSourcesStore,
    private readonly addressStore: AddressStore,
    private readonly scopes: AztecAddress[],
    private readonly changeSetId: ChangeSetId,
    bindings?: LoggerBindings,
  ) {
    this.log = createLogger('pxe:log_service', bindings);
  }

  /** Fetches all logs matching each request's tag, returning an array of log arrays (one per request). */
  public async fetchLogsByTag(
    contractAddress: AztecAddress,
    logRetrievalRequests: LogRetrievalRequest[],
  ): Promise<RetrievedTaggedLog[][]> {
    for (const request of logRetrievalRequests) {
      if (!contractAddress.equals(request.contractAddress)) {
        throw new Error(`Got a log retrieval request from ${request.contractAddress}, expected ${contractAddress}`);
      }
    }

    if (logRetrievalRequests.length === 0) {
      return [];
    }

    const anchor = await this.anchorBlockHeader.toBlockParameter();

    const [publicLogsPerRequest, privateLogsPerRequest] = await allToCompletion([
      this.#fetchPublicLogs(contractAddress, logRetrievalRequests, anchor),
      this.#fetchPrivateLogs(logRetrievalRequests, anchor),
    ]);

    return logRetrievalRequests.map((_request, i) => [
      ...publicLogsPerRequest[i].map(LogService.#toRetrievedTaggedLog),
      ...privateLogsPerRequest[i].map(LogService.#toRetrievedTaggedLog),
    ]);
  }

  async #fetchPublicLogs(
    contractAddress: AztecAddress,
    requests: LogRetrievalRequest[],
    anchor: LogQueryAnchor,
  ): Promise<LogResult[][]> {
    const indices = requests.flatMap((r, i) => (r.source !== LogSource.PRIVATE ? [i] : []));
    if (indices.length === 0) {
      return requests.map(() => []);
    }

    const resultsPerRequest: LogResult[][] = requests.map(() => []);
    const groups = LogService.#groupByRange(indices.map(i => ({ index: i, request: requests[i] })));

    await allToCompletion(
      Array.from(groups.values()).map(async group => {
        const tags = group.entries.map(e => e.request.tag);
        const results = await getAllPublicLogsByTagsFromContract(this.aztecNode, contractAddress, tags, anchor, {
          fromBlock: group.fromBlock,
          toBlock: group.toBlock,
          includeEffects: true,
        });
        group.entries.forEach((entry, i) => {
          resultsPerRequest[entry.index] = results[i];
        });
      }),
    );

    return resultsPerRequest;
  }

  async #fetchPrivateLogs(requests: LogRetrievalRequest[], anchor: LogQueryAnchor): Promise<LogResult[][]> {
    const indices = requests.flatMap((r, i) => (r.source !== LogSource.PUBLIC ? [i] : []));
    if (indices.length === 0) {
      return requests.map(() => []);
    }

    const resultsPerRequest: LogResult[][] = requests.map(() => []);
    const groups = LogService.#groupByRange(indices.map(i => ({ index: i, request: requests[i] })));

    await allToCompletion(
      Array.from(groups.values()).map(async group => {
        const siloedTags = await allToCompletion(
          group.entries.map(e => SiloedTag.computeFromTagAndApp(e.request.tag, e.request.contractAddress)),
        );
        const results = await getAllPrivateLogsByTags(this.aztecNode, siloedTags, anchor, {
          fromBlock: group.fromBlock,
          toBlock: group.toBlock,
          includeEffects: true,
        });
        group.entries.forEach((entry, i) => {
          resultsPerRequest[entry.index] = results[i];
        });
      }),
    );

    return resultsPerRequest;
  }

  /**
   * Groups requests by their (fromBlock, toBlock) range so each distinct range becomes a single node call with
   * the range pushed down into the query (no in-memory filter).
   */
  static #groupByRange(
    entries: Array<{ index: number; request: LogRetrievalRequest }>,
  ): Map<RangeKey, { fromBlock?: BlockNumber; toBlock?: BlockNumber; entries: typeof entries }> {
    const groups = new Map<RangeKey, { fromBlock?: BlockNumber; toBlock?: BlockNumber; entries: typeof entries }>();
    for (const entry of entries) {
      const fromBlock = entry.request.fromBlock.value;
      const toBlock = entry.request.toBlock.value;
      const key = rangeKey(fromBlock, toBlock);
      const existing = groups.get(key);
      if (existing) {
        existing.entries.push(entry);
      } else {
        groups.set(key, { fromBlock, toBlock, entries: [entry] });
      }
    }
    return groups;
  }

  static #toRetrievedTaggedLog(log: LogResult): RetrievedTaggedLog {
    // includeEffects: true was used, so noteHashes and nullifiers are populated. Every tx has at least one nullifier
    // (the first nullifier derived from the tx hash); empty here would indicate a buggy node.
    const noteHashes = log.noteHashes!;
    const nullifiers = log.nullifiers!;
    if (nullifiers.length === 0) {
      throw new Error(`Log for tx ${log.txHash} returned no nullifiers from the node`);
    }
    return {
      logData: log.logData,
      txHash: log.txHash,
      noteHashes,
      nullifiers,
      blockNumber: log.blockNumber,
      blockTimestamp: log.blockTimestamp,
      blockHash: log.blockHash,
      // The log index and the tx receipt both count the tx's position in `block.body.txEffects`, so this is the same
      // index a receipt reports. Note ordering depends on the two staying in agreement.
      txIndexInBlock: log.txIndexWithinBlock,
    };
  }

  /**
   * Fetches the pending tagged logs for a recipient across all its tagging secrets for the contract.
   *
   * @param providedSecrets - App-siloed secrets that PXE cannot enumerate itself, passed in by the contract as it
   * syncs, such as those of the handshakes it discovers onchain. PXE searches them alongside the secrets derived from
   * the recipient's keys and those registered for the recipient.
   */
  public async fetchTaggedLogs(
    contractAddress: AztecAddress,
    recipient: AztecAddress,
    providedSecrets: AppTaggingSecret[],
  ): Promise<RetrievedTaggedLog[]> {
    assertAllowedScope(recipient, this.scopes);

    this.log.verbose(
      `Fetching tagged logs for contract ${contractAddress.toString()} and recipient ${recipient.toString()}`,
    );

    const l2Tips = await this.l2TipsStore.getL2Tips();

    // Without the recipient's keys we'd be unable to decrypt any messages found, so we skip them and only search for
    // `providedSecrets`.
    const recipientKeys = await this.#getRecipientKeys(recipient);
    if (!recipientKeys) {
      this.log.warn(`Searching only provided tagging secrets for ${recipient}, whose keys are not held`, {
        recipient,
        contractAddress,
      });
    }
    const [keyDerivedSecrets, registeredSecrets] = recipientKeys
      ? await allToCompletion([
          this.#getSecretsDerivedFromRecipientKeys(recipientKeys, contractAddress),
          this.#getSecretsRegisteredForRecipient(recipient, contractAddress),
        ])
      : [[], []];

    // These can overlap (a sender that is also a PXE account, or a registered secret that coincides with a key-derived
    // or provided one), so we deduplicate the combined set.
    const combinedSecrets = [...keyDerivedSecrets, ...registeredSecrets, ...providedSecrets];
    const secrets = Array.from(new Map(combinedSecrets.map(secret => [secret.toString(), secret])).values());

    const logs = await syncTaggedPrivateLogs(
      secrets,
      this.aztecNode,
      this.recipientTaggingStore,
      this.anchorBlockHeader,
      l2Tips.finalized.block.number,
      this.changeSetId,
    );

    return logs.map(log => LogService.#toRetrievedTaggedLog(log));
  }

  /** The recipient's key material, if PXE holds it. */
  async #getRecipientKeys(recipient: AztecAddress): Promise<RecipientKeys | undefined> {
    const completeAddress = await this.addressStore.getCompleteAddress(recipient);
    if (!completeAddress || !(await this.keyStore.hasAccount(recipient))) {
      return undefined;
    }
    return { completeAddress, ivsk: await this.keyStore.getMasterIncomingViewingSecretKey(recipient) };
  }

  /** Computes one tagging secret per known sender via ECDH. */
  async #getSecretsDerivedFromRecipientKeys(
    recipientKeys: RecipientKeys,
    contractAddress: AztecAddress,
  ): Promise<AppTaggingSecret[]> {
    // We implicitly add all PXE accounts as senders, this helps us decrypt tags on notes that we send to ourselves
    // (recipient = us, sender = us).
    const allSenders = [...(await this.taggingSecretSourcesStore.getSenders()), ...(await this.keyStore.getAccounts())];

    return allToCompletion(
      allSenders.map(async sender => {
        const secret = await AppTaggingSecret.computeAddressDerived({
          localAddress: recipientKeys.completeAddress,
          localIvsk: recipientKeys.ivsk,
          externalAddress: sender,
          app: contractAddress,
          recipient: recipientKeys.completeAddress.address,
        });

        if (!secret) {
          // Note that all senders originate from either the TaggingSecretSourcesStore or the KeyStore.
          throw new Error(
            `Failed to compute a tagging secret for sender ${sender} - this implies this is an invalid address, which should not happen as they have been previously registered in PXE.`,
          );
        }

        return secret;
      }),
    );
  }

  /**
   * Computes the tagging secrets registered for a recipient. An arbitrary secret is only used for unconstrained
   * delivery, so it yields one app tagging secret, while a handshake can be used for either delivery mode and yields
   * one for each.
   */
  async #getSecretsRegisteredForRecipient(
    recipient: AztecAddress,
    contractAddress: AztecAddress,
  ): Promise<AppTaggingSecret[]> {
    const registeredSecrets = await this.taggingSecretSourcesStore.getSharedSecretsForRecipient(recipient);

    return allToCompletion(
      registeredSecrets.flatMap(({ kind, secret }) => {
        switch (kind) {
          case 'arbitrary-secret':
            return [AppTaggingSecret.computeFromArbitrarySecret(secret, contractAddress, recipient)];
          case 'handshake':
            // A handshake-backed sender tags messages with the bare app-siloed secret, one tag domain per delivery
            // mode.
            return [
              AppTaggingSecret.computeFromHandshakeSecret(secret, contractAddress, OnchainDeliveryMode.UNCONSTRAINED),
              AppTaggingSecret.computeFromHandshakeSecret(secret, contractAddress, OnchainDeliveryMode.CONSTRAINED),
            ];
          default: {
            const _exhaustive: never = kind;
            throw new Error(`Unhandled shared secret kind: ${_exhaustive}`);
          }
        }
      }),
    );
  }
}

/** A tagged log fetched from the node, together with the onchain context of the tx that emitted it. */
export type RetrievedTaggedLog = TxOnchainContext & {
  /** The raw log payload, tag included. */
  logData: Fr[];
  blockTimestamp: UInt64;
};
