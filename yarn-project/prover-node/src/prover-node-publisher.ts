import { RollupAbi } from '@aztec-foundation/l1-artifacts';

import { BatchedBlob, getEthBlobEvaluationInputs } from '@aztec-labs/blob-lib';
import { MAX_CHECKPOINTS_PER_EPOCH } from '@aztec-labs/constants';
import {
  type RollupContract,
  type ViemCommitteeAttestations,
  computeAttestationsHash,
} from '@aztec-labs/ethereum/contracts';
import type { L1TxUtils } from '@aztec-labs/ethereum/l1-tx-utils';
import { CheckpointNumber, EpochNumber } from '@aztec-labs/foundation/branded-types';
import { areArraysEqual } from '@aztec-labs/foundation/collection';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { type Logger, type LoggerBindings, createLogger } from '@aztec-labs/foundation/log';
import { backoffUntil, retry } from '@aztec-labs/foundation/retry';
import { Timer } from '@aztec-labs/foundation/timer';
import type { PublisherConfig, TxSenderConfig } from '@aztec-labs/sequencer-client';
import type { Proof } from '@aztec-labs/stdlib/proofs';
import type { CheckpointHeader, RootRollupPublicInputs } from '@aztec-labs/stdlib/rollup';
import type { L1PublishProofStats } from '@aztec-labs/stdlib/stats';
import { type TelemetryClient, getTelemetryClient } from '@aztec-labs/telemetry-client';
import { inspect } from 'util';
import { type Hex, type TransactionReceipt, encodeFunctionData, formatEther, formatGwei } from 'viem';

import { type EstimatedSubmitProofStats, ProverNodePublisherMetrics } from './metrics.js';
import type { VerbatimAttestationsSource } from './verbatim-attestations.js';

/** Arguments to the submitEpochProof method of the rollup contract */
export type L1SubmitEpochProofArgs = {
  epochSize: number;
  previousArchive: Fr;
  endArchive: Fr;
  endTimestamp: Fr;
  outHash: Fr;
  proverId: Fr;
  headers: CheckpointHeader[];
  proof: Proof;
};

/**
 * Result of a proof submission attempt. `'already-submitted'` means this prover had already registered a proof of
 * the same length for the epoch on L1, so nothing was sent; it is not a failure.
 */
export type SubmitEpochProofResult = 'published' | 'already-submitted' | 'failed';

/**
 * Cap on how long to keep re-reading the attestations posted for a checkpoint before giving up. The proof is
 * already computed by then, so it is worth riding out a rate-limited or briefly unavailable L1 RPC — but the
 * publishing service publishes one candidate at a time, so an unbounded wait would stall every other epoch.
 * The submission deadline cuts the window short whenever it lands first.
 */
const ATTESTATIONS_FETCH_BUDGET_MS = 120_000;

export class ProverNodePublisher {
  private metrics: ProverNodePublisherMetrics;

  protected log: Logger;

  protected rollupContract: RollupContract;

  protected proofSubmissionTarget: Hex;

  protected verbatimAttestations: VerbatimAttestationsSource;

  public readonly l1TxUtils: L1TxUtils;

  constructor(
    config: TxSenderConfig & PublisherConfig,
    deps: {
      rollupContract: RollupContract;
      l1TxUtils: L1TxUtils;
      verbatimAttestations: VerbatimAttestationsSource;
      proofSubmissionTarget?: EthAddress;
      telemetry?: TelemetryClient;
    },
    bindings?: LoggerBindings,
  ) {
    const telemetry = deps.telemetry ?? getTelemetryClient();

    this.metrics = new ProverNodePublisherMetrics(telemetry, 'ProverNode');
    this.log = createLogger('prover-node:l1-tx-publisher', bindings);

    this.rollupContract = deps.rollupContract;
    this.proofSubmissionTarget = deps.proofSubmissionTarget?.toString() ?? deps.rollupContract.address;
    this.l1TxUtils = deps.l1TxUtils;
    this.verbatimAttestations = deps.verbatimAttestations;
  }

  public getRollupContract() {
    return this.rollupContract;
  }

  public getSenderAddress() {
    return this.l1TxUtils.getSenderAddress();
  }

  /**
   * Recovers the attestations tuple a checkpoint was proposed with, retrying with exponential backoff until
   * {@link ATTESTATIONS_FETCH_BUDGET_MS} or the submission deadline runs out, whichever comes first.
   *
   * Every failure is treated as retryable and every attempt re-reads L1 from scratch, because each one of them
   * — an RPC error, an archiver still catching up, a node serving pruned logs — can clear on the next attempt
   * against a different RPC in the fallback set. Nothing here can succeed with the wrong bytes: the retriever
   * verifies what it decodes against the hash the rollup stored. Once the budget is spent the submission fails;
   * rebuilding the tuple from decoded attestations instead would only burn gas on a revert.
   */
  private fetchVerbatimAttestations(
    checkpointNumber: CheckpointNumber,
    deadline: Date | undefined,
  ): Promise<ViemCommitteeAttestations> {
    const budgetEnd = new Date(Date.now() + ATTESTATIONS_FETCH_BUDGET_MS);
    const until = deadline && deadline < budgetEnd ? deadline : budgetEnd;
    return retry(
      () => this.verbatimAttestations.getVerbatimAttestations(checkpointNumber),
      `read of the attestations posted for checkpoint ${checkpointNumber}`,
      backoffUntil(until),
      this.log,
    );
  }

  public async submitEpochProof(args: {
    epochNumber: EpochNumber;
    fromCheckpoint: CheckpointNumber;
    toCheckpoint: CheckpointNumber;
    publicInputs: RootRollupPublicInputs;
    proof: Proof;
    batchedBlobInputs: BatchedBlob;
    headers: CheckpointHeader[];
    /** Whether the range covers the whole epoch. Governs whether an already-overtaken proof is still worth sending. */
    kind: 'full' | 'partial';
    /** Wall-clock deadline (proof-submission window end) past which the L1 tx should stop retrying. */
    deadline?: Date;
  }): Promise<SubmitEpochProofResult> {
    const { epochNumber, fromCheckpoint, toCheckpoint, publicInputs } = args;
    const ctx = { epochNumber, fromCheckpoint, toCheckpoint };

    const timer = new Timer();

    // The rollup reverts on a second submission from the same prover for the same epoch and length, so don't
    // spend gas on one. Reachable when re-running an epoch we have already submitted a proof for, which is
    // not a failure: our reward shares for it are already registered.
    const proverId = EthAddress.fromField(publicInputs.constants.proverId);
    const length = toCheckpoint - fromCheckpoint + 1;
    if (await this.rollupContract.getHasSubmittedProof(epochNumber, length, proverId)) {
      this.log.warn(`Skipping epoch proof submission as prover already submitted a proof for this epoch`, {
        ...ctx,
        proverId,
        length,
      });
      return 'already-submitted';
    }

    // Re-read the attestations tuple from the propose calldata rather than re-deriving it from the decoded
    // attestations: the rollup checks the submission against the `attestationsHash` it stored at propose time,
    // which covers bytes (spare bitmap bits, recovery-byte form) that no decoder round-trips faithfully.
    const attestations = await this.fetchVerbatimAttestations(toCheckpoint, args.deadline);
    const submitArgs = { ...args, attestations };

    // Validate epoch proof range and hashes are correct before submitting
    const provenPrefixLength = await this.validateEpochProofSubmission(submitArgs);

    const txReceipt = await this.sendSubmitEpochProofTx(submitArgs, provenPrefixLength);
    if (!txReceipt) {
      this.log.error(`Failed to mine submitEpochProof tx`, undefined, ctx);
      return 'failed';
    }

    try {
      this.metrics.recordSenderBalance(
        await this.l1TxUtils.getSenderBalance(),
        this.l1TxUtils.getSenderAddress().toString(),
      );
    } catch (err) {
      this.log.warn(`Failed to record the ETH balance of the prover node: ${err}`);
    }

    // Tx was mined successfully
    if (txReceipt.status === 'success') {
      const tx = await this.l1TxUtils.getTransactionStats(txReceipt.transactionHash);
      const stats: L1PublishProofStats = {
        gasPrice: txReceipt.effectiveGasPrice,
        gasUsed: txReceipt.gasUsed,
        transactionHash: txReceipt.transactionHash,
        calldataGas: tx!.calldataGas,
        calldataSize: tx!.calldataSize,
        sender: tx!.sender,
        blobDataGas: 0n,
        blobGasUsed: 0n,
        eventName: 'proof-published-to-l1',
      };
      this.log.info(`Published epoch proof to L1 rollup contract`, { ...stats, ...ctx });
      this.metrics.recordSubmitProof(timer.ms(), stats);
      return 'published';
    }

    this.metrics.recordFailedTx();
    this.log.error(`Rollup submitEpochProof tx reverted ${txReceipt.transactionHash}`, undefined, ctx);
    return 'failed';
  }

  private async validateEpochProofSubmission(args: {
    fromCheckpoint: CheckpointNumber;
    toCheckpoint: CheckpointNumber;
    publicInputs: RootRollupPublicInputs;
    proof: Proof;
    batchedBlobInputs: BatchedBlob;
    attestations: ViemCommitteeAttestations;
    headers: CheckpointHeader[];
    kind: 'full' | 'partial';
  }): Promise<number> {
    const { fromCheckpoint, toCheckpoint, publicInputs, batchedBlobInputs, attestations, kind } = args;

    // Check that the checkpoint numbers match the expected epoch to be proven
    const { pending, proven } = await this.rollupContract.getTips();
    // A partial proof shorter than what is already proven earns nothing: rewards go only to provers holding
    // shares in the epoch's longest proven length, which a shorter range can never reach. A full-epoch proof
    // always matches that length, and the rollup accepts any proof whose predecessor is proven, so it still
    // registers our shares once the proven tip has run past this epoch entirely (another prover proving into a
    // later one) and stays worth sending until the epoch's submission window closes.
    if (kind === 'partial' && proven > toCheckpoint) {
      throw new Error(
        `Cannot submit epoch proof for ${fromCheckpoint}-${toCheckpoint} as proven checkpoint is ${proven}`,
      );
    }
    // toCheckpoint can't be greater than pending
    if (toCheckpoint > pending) {
      throw new Error(
        `Cannot submit epoch proof for ${fromCheckpoint}-${toCheckpoint} as proposed checkpoint is ${pending}`,
      );
    }

    // Check the archive for the immediate checkpoint before the epoch
    const checkpointLog = await this.rollupContract.getCheckpoint(CheckpointNumber(fromCheckpoint - 1));
    if (!publicInputs.previousArchiveRoot.equals(checkpointLog.archive)) {
      throw new Error(
        `Previous archive root mismatch: ${publicInputs.previousArchiveRoot.toString()} !== ${checkpointLog.archive.toString()}`,
      );
    }

    // Check the archive for the last checkpoint in the epoch
    const endCheckpointLog = await this.rollupContract.getCheckpoint(toCheckpoint);
    if (!publicInputs.endArchiveRoot.equals(endCheckpointLog.archive)) {
      throw new Error(
        `End archive root mismatch: ${publicInputs.endArchiveRoot.toString()} !== ${endCheckpointLog.archive.toString()}`,
      );
    }

    // The rollup only checks the attestations of the last checkpoint in the range, against the hash it stored
    // when that checkpoint was proposed. Checking it here turns a byte-level divergence into a named error
    // instead of an opaque `Rollup__InvalidAttestations` revert once the tx is mined.
    const submittedAttestationsHash = computeAttestationsHash(attestations);
    if (submittedAttestationsHash !== endCheckpointLog.attestationsHash.toString()) {
      throw new Error(
        `Attestations hash mismatch for checkpoint ${toCheckpoint}: ` +
          `${submittedAttestationsHash} !== ${endCheckpointLog.attestationsHash.toString()}`,
      );
    }

    // Check the batched blob inputs from the root rollup against the batched blob computed in ts
    const finalBlobAccumulator = batchedBlobInputs.toFinalBlobAccumulator();
    if (!publicInputs.blobPublicInputs.equals(finalBlobAccumulator)) {
      throw new Error(
        `Batched blob mismatch: ${inspect(publicInputs.blobPublicInputs)} !== ${inspect(finalBlobAccumulator)}`,
      );
    }

    // Compare the public inputs computed by the contract with the ones injected
    const rollupPublicInputs = await this.rollupContract.getEpochProofPublicInputs(
      this.getEpochProofPublicInputsArgs(args),
    );
    const argsPublicInputs = [...publicInputs.toFields()];

    if (!areArraysEqual(rollupPublicInputs, argsPublicInputs, (a, b) => a.equals(b))) {
      throw await reportPublicInputsMismatch({
        rollupPublicInputs,
        argsPublicInputs,
        fromCheckpoint,
        toCheckpoint,
        rollupContract: this.rollupContract,
        log: this.log,
      });
    }

    // The production rollup advances the proven tip and accounts for rewards atomically. A later proof may
    // advance it further before inclusion; the contract accepts any already-proven prefix, including a shorter one.
    return Math.max(0, proven - fromCheckpoint + 1);
  }

  /**
   * Estimates what submitting the epoch proof would have cost on L1 without actually sending it.
   * Runs the same validation as `submitEpochProof`, encodes the calldata, estimates gas, and records metrics.
   * Used when proof publishing is disabled (e.g. PROVER_NODE_DISABLE_PROOF_PUBLISH=true on mainnet).
   */
  public async analyzeEpochProofSubmission(args: {
    epochNumber: EpochNumber;
    fromCheckpoint: CheckpointNumber;
    toCheckpoint: CheckpointNumber;
    publicInputs: RootRollupPublicInputs;
    proof: Proof;
    batchedBlobInputs: BatchedBlob;
    headers: CheckpointHeader[];
    /** Whether the range covers the whole epoch. Governs whether an already-overtaken proof is still worth sending. */
    kind: 'full' | 'partial';
  }): Promise<void> {
    const { epochNumber, fromCheckpoint, toCheckpoint } = args;

    const attestations = await this.fetchVerbatimAttestations(toCheckpoint, /*deadline*/ undefined);
    const analyzeArgs = { ...args, attestations };
    const provenPrefixLength = await this.validateEpochProofSubmission(analyzeArgs);

    const data = this.encodeSubmitEpochProofCalldata(analyzeArgs, provenPrefixLength);
    const senderAddress = this.l1TxUtils.getSenderAddress();

    const [gasLimit, feesPerGas, latestBlock] = await Promise.all([
      this.l1TxUtils.estimateGas(senderAddress.toString() as `0x${string}`, { to: this.proofSubmissionTarget, data }),
      this.l1TxUtils.getFeesPerGas(),
      this.l1TxUtils.client.getBlock({ blockTag: 'latest' }),
    ]);

    const baseFeePerGas = latestBlock.baseFeePerGas ?? 0n;
    const { maxPriorityFeePerGas } = feesPerGas;

    const effectiveFeePerGas = baseFeePerGas + maxPriorityFeePerGas;
    const estimatedTotalFee = gasLimit * effectiveFeePerGas;

    const stats: EstimatedSubmitProofStats = {
      gasLimit,
      baseFeePerGas,
      maxPriorityFeePerGas,
      estimatedTotalFee,
    };

    this.log.info(`Estimated epoch proof submission cost (not submitted)`, {
      epochNumber,
      fromCheckpoint,
      toCheckpoint,
      gasLimit: gasLimit.toString(),
      baseFeePerGas: formatGwei(baseFeePerGas),
      maxPriorityFeePerGas: formatGwei(maxPriorityFeePerGas),
      estimatedTotalFeeEth: formatEther(estimatedTotalFee),
    });

    this.metrics.recordEstimatedSubmitProof(stats);
  }

  private encodeSubmitEpochProofCalldata(
    args: {
      fromCheckpoint: CheckpointNumber;
      toCheckpoint: CheckpointNumber;
      publicInputs: RootRollupPublicInputs;
      proof: Proof;
      batchedBlobInputs: BatchedBlob;
      attestations: ViemCommitteeAttestations;
      headers: CheckpointHeader[];
    },
    provenPrefixLength: number,
  ): Hex {
    return encodeFunctionData({
      abi: RollupAbi,
      functionName: 'submitEpochRootProof',
      args: [this.getSubmitEpochProofArgs(args, provenPrefixLength)],
    });
  }

  private async sendSubmitEpochProofTx(
    args: {
      fromCheckpoint: CheckpointNumber;
      toCheckpoint: CheckpointNumber;
      deadline?: Date;
      publicInputs: RootRollupPublicInputs;
      proof: Proof;
      batchedBlobInputs: BatchedBlob;
      attestations: ViemCommitteeAttestations;
      headers: CheckpointHeader[];
    },
    provenPrefixLength: number,
  ): Promise<TransactionReceipt | undefined> {
    const txArgs = [this.getSubmitEpochProofArgs(args, provenPrefixLength)] as const;

    this.log.info(`Submitting epoch proof to L1 rollup contract`, {
      proofSize: args.proof.withoutPublicInputs().length,
      fromCheckpoint: args.fromCheckpoint,
      toCheckpoint: args.toCheckpoint,
    });
    const data = encodeFunctionData({
      abi: RollupAbi,
      functionName: 'submitEpochRootProof',
      args: txArgs,
    });
    try {
      const { receipt } = await this.l1TxUtils.sendAndMonitorTransaction(
        { to: this.proofSubmissionTarget, data },
        { txTimeoutAt: args.deadline },
      );
      if (receipt.status !== 'success') {
        const errorMsg = await this.l1TxUtils.tryGetErrorFromRevertedTx(
          data,
          {
            args: [...txArgs],
            functionName: 'submitEpochRootProof',
            abi: RollupAbi,
            address: this.proofSubmissionTarget,
          },
          /*blobInputs*/ undefined,
          /*stateOverride*/ [],
        );
        this.log.error(`Rollup submit epoch proof tx reverted with ${errorMsg ?? 'unknown error'}`);
        return undefined;
      }
      return receipt;
    } catch (err) {
      this.log.error(`Rollup submit epoch proof failed`, err);
      return undefined;
    }
  }

  private getEpochProofPublicInputsArgs(args: {
    fromCheckpoint: CheckpointNumber;
    toCheckpoint: CheckpointNumber;
    publicInputs: RootRollupPublicInputs;
    batchedBlobInputs: BatchedBlob;
    headers: CheckpointHeader[];
  }) {
    // Returns arguments for EpochProofLib.sol -> getEpochProofPublicInputs()
    return [
      BigInt(args.fromCheckpoint) /*_start*/,
      BigInt(args.toCheckpoint) /*_end*/,
      {
        previousArchive: args.publicInputs.previousArchiveRoot.toString(),
        endArchive: args.publicInputs.endArchiveRoot.toString(),
        outHash: args.publicInputs.outHash.toString(),
        previousInboxRollingHash: args.publicInputs.previousInboxRollingHash.toString(),
        endInboxRollingHash: args.publicInputs.endInboxRollingHash.toString(),
        proverId: EthAddress.fromField(args.publicInputs.constants.proverId).toString(),
      } /*_args*/,
      args.headers.map(header => header.toViem()) /*_headers*/,
      getEthBlobEvaluationInputs(args.batchedBlobInputs) /*_blobPublicInputs*/,
    ] as const;
  }

  private getSubmitEpochProofArgs(
    args: {
      fromCheckpoint: CheckpointNumber;
      toCheckpoint: CheckpointNumber;
      publicInputs: RootRollupPublicInputs;
      proof: Proof;
      batchedBlobInputs: BatchedBlob;
      attestations: ViemCommitteeAttestations;
      headers: CheckpointHeader[];
    },
    provenPrefixLength: number,
  ) {
    // Returns arguments for EpochProofLib.sol -> submitEpochRootProof()
    const proofHex: Hex = `0x${args.proof.withoutPublicInputs().toString('hex')}`;
    const argsArray = this.getEpochProofPublicInputsArgs(args);
    return {
      start: argsArray[0],
      end: argsArray[1],
      args: argsArray[2],
      provenCheckpointFees: argsArray[3]
        .slice(0, provenPrefixLength)
        .map(({ coinbase, accumulatedFees }) => ({ coinbase, accumulatedFees })),
      headers: argsArray[3].slice(provenPrefixLength),
      attestations: args.attestations,
      blobInputs: argsArray[4],
      proof: proofHex,
    };
  }
}

/**
 * Decodes a `Root rollup public inputs mismatch`, fetches the on-chain CheckpointLog for any
 * mismatching `checkpointHeaderHashes[i]`, emits a structured error log, and returns a thrown-ready
 * Error with a human-readable summary.
 *
 * Layout of `RootRollupPublicInputs.toFields()`:
 *   [0]                   previousArchiveRoot
 *   [1]                   endArchiveRoot
 *   [2]                   outHash
 *   [3]                   previousInboxRollingHash
 *   [4]                   endInboxRollingHash
 *   [5 .. 5+N-1]          checkpointHeaderHashes[i] for i in 0..N-1   (N = MAX_CHECKPOINTS_PER_EPOCH)
 *   [5+N .. 5+3N-1]       fees[i] = (recipient, value) for i in 0..N-1
 *   [5+3N .. 5+3N+4]      EpochConstantData (chainId, version, vkTreeRoot, protocolContractsHash, proverId)
 *   [5+3N+5 ..]           blobPublicInputs (FinalBlobAccumulator)
 */
async function reportPublicInputsMismatch(input: {
  rollupPublicInputs: readonly Fr[];
  argsPublicInputs: readonly Fr[];
  fromCheckpoint: CheckpointNumber;
  toCheckpoint: CheckpointNumber;
  rollupContract: RollupContract;
  log: Logger;
}): Promise<Error> {
  const { rollupPublicInputs, argsPublicInputs, fromCheckpoint, toCheckpoint, rollupContract, log } = input;
  const N = MAX_CHECKPOINTS_PER_EPOCH;
  const headerHashesStart = 5;
  const constantsStart = headerHashesStart + 3 * N;
  const blobStart = constantsStart + 5;
  const constantLabels = ['chainId', 'version', 'vkTreeRoot', 'protocolContractsHash', 'proverId'];

  const diffs: { index: number; label: string; rollup: Fr; computed: Fr; checkpointIndex?: number }[] = [];
  const len = Math.max(rollupPublicInputs.length, argsPublicInputs.length);
  for (let i = 0; i < len; i++) {
    const a = rollupPublicInputs[i] ?? Fr.ZERO;
    const b = argsPublicInputs[i] ?? Fr.ZERO;
    if (a.equals(b)) {
      continue;
    }
    let label: string;
    let checkpointIndex: number | undefined;
    if (i === 0) {
      label = 'previousArchiveRoot';
    } else if (i === 1) {
      label = 'endArchiveRoot';
    } else if (i === 2) {
      label = 'outHash';
    } else if (i === 3) {
      label = 'previousInboxRollingHash';
    } else if (i === 4) {
      label = 'endInboxRollingHash';
    } else if (i < headerHashesStart + N) {
      checkpointIndex = i - headerHashesStart;
      label = `checkpointHeaderHashes[${checkpointIndex}]`;
    } else if (i < headerHashesStart + 3 * N) {
      const feePairIndex = i - (headerHashesStart + N);
      const feeIndex = Math.floor(feePairIndex / 2);
      const sub = feePairIndex % 2 === 0 ? 'recipient' : 'value';
      label = `fees[${feeIndex}].${sub}`;
    } else if (i < blobStart) {
      label = `constants.${constantLabels[i - constantsStart]}`;
    } else {
      label = `blobPublicInputs[${i - blobStart}]`;
    }
    diffs.push({ index: i, label, rollup: a, computed: b, checkpointIndex });
  }

  // For each mismatching checkpointHeaderHash, fetch the L1 CheckpointLog so the operator can
  // see what was published on-chain alongside the prover's recomputed hash.
  const onChainCheckpoints = await Promise.all(
    diffs
      .filter(d => d.checkpointIndex !== undefined)
      .map(async d => {
        const checkpointNumber = CheckpointNumber(fromCheckpoint + d.checkpointIndex!);
        try {
          const cp = await rollupContract.getCheckpoint(checkpointNumber);
          return { checkpointIndex: d.checkpointIndex!, checkpointNumber, headerHash: cp.headerHash.toString() };
        } catch (err) {
          return { checkpointIndex: d.checkpointIndex!, checkpointNumber, error: (err as Error).message };
        }
      }),
  );

  log.error(`Root rollup public inputs mismatch`, undefined, {
    fromCheckpoint,
    toCheckpoint,
    numDiffs: diffs.length,
    diffs: diffs.map(d => ({
      index: d.index,
      label: d.label,
      rollup: d.rollup.toString(),
      computed: d.computed.toString(),
    })),
    onChainCheckpoints,
  });

  const fmt = (inputs: readonly Fr[]) => inputs.map(x => x.toString()).join(', ');
  const summary = diffs.map(d => `[${d.index} ${d.label}] L1=${d.rollup} prover=${d.computed}`).join('\n');
  return new Error(
    `Root rollup public inputs mismatch (${diffs.length} fields differ):\n${summary}\n` +
      `Rollup:  ${fmt(rollupPublicInputs)}\nComputed:${fmt(argsPublicInputs)}`,
  );
}
