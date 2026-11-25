import { BlockNumber } from '@aztec-labs/foundation/branded-types';
import type { Fr } from '@aztec-labs/foundation/curves/bn254';
import type { EthAddress } from '@aztec-labs/foundation/eth-address';
import { getVKTreeRoot } from '@aztec-labs/noir-protocol-circuits-types/vk-tree';
import { protocolContractsHash } from '@aztec-labs/protocol-contracts';
import type { CheckpointSubTreeOrchestrator } from '@aztec-labs/prover-client/orchestrator';
import type { PublicProcessor, PublicProcessorFactory } from '@aztec-labs/simulator/server';
import { PublicSimulatorConfig } from '@aztec-labs/stdlib/avm';
import type { L2Block } from '@aztec-labs/stdlib/block';
import type { ForkMerkleTreeOperations } from '@aztec-labs/stdlib/interfaces/server';
import { CheckpointConstantData } from '@aztec-labs/stdlib/rollup';
import { MerkleTreeId } from '@aztec-labs/stdlib/trees';
import type { GlobalVariables, ProcessedTx, Tx } from '@aztec-labs/stdlib/tx';

/** What re-executing a block needs besides the block itself. */
export type BlockExecutionDeps = {
  publicProcessorFactory: PublicProcessorFactory;
  dbProvider: Pick<ForkMerkleTreeOperations, 'fork'>;
  proverId: EthAddress;
  /** Deadline for public execution, if any. */
  deadline: Date | undefined;
};

/**
 * The constants every proving job of a checkpoint commits to. A checkpoint is valid only if each of its blocks
 * carries the checkpoint header's slot, coinbase, fee recipient and gas fees in its global variables, so these
 * constants are the same whether they are read from the checkpoint header or from any block of the checkpoint.
 */
export function makeCheckpointConstants(
  globalVariables: Pick<
    GlobalVariables,
    'chainId' | 'version' | 'slotNumber' | 'coinbase' | 'feeRecipient' | 'gasFees'
  >,
  proverId: EthAddress,
): CheckpointConstantData {
  return CheckpointConstantData.from({
    chainId: globalVariables.chainId,
    version: globalVariables.version,
    vkTreeRoot: getVKTreeRoot(),
    protocolContractsHash: protocolContractsHash,
    proverId: proverId.toField(),
    slotNumber: globalVariables.slotNumber,
    coinbase: globalVariables.coinbase,
    feeRecipient: globalVariables.feeRecipient,
    gasFees: globalVariables.gasFees,
  });
}

/**
 * Re-executes one block and hands it to the sub-tree, which enqueues the block's proving jobs. Blocks of a
 * checkpoint must be passed in order. Returns false if `signal` aborted before the block was completed; the
 * sub-tree is then left part-way through the block and must be cancelled.
 *
 * @param blockTxs - The block's transactions, in block order.
 * @param l1ToL2Messages - The L1-to-L2 messages this block consumes.
 */
export async function executeBlock(
  subTree: CheckpointSubTreeOrchestrator,
  block: L2Block,
  blockTxs: Tx[],
  l1ToL2Messages: Fr[],
  deps: BlockExecutionDeps,
  signal: AbortSignal,
): Promise<boolean> {
  const globalVariables = block.header.globalVariables;
  await subTree.startNewBlock(block.number, globalVariables.timestamp, blockTxs.length, l1ToL2Messages);
  if (signal.aborted) {
    return false;
  }

  const db = await deps.dbProvider.fork(BlockNumber(block.number - 1));
  try {
    await db.appendLeaves(MerkleTreeId.L1_TO_L2_MESSAGE_TREE, l1ToL2Messages);
    if (signal.aborted) {
      return false;
    }
    const config = PublicSimulatorConfig.from({
      proverId: deps.proverId.toField(),
      skipFeeEnforcement: false,
      collectDebugLogs: false,
      collectHints: true,
      collectPublicInputs: true,
      collectStatistics: false,
    });
    const publicProcessor = deps.publicProcessorFactory.create(db, globalVariables, config);
    const processed = await processTxs(publicProcessor, blockTxs, deps.deadline, signal);
    if (signal.aborted) {
      return false;
    }
    await subTree.addTxs(processed);
  } finally {
    await db.close();
  }
  if (signal.aborted) {
    return false;
  }

  await subTree.setBlockCompleted(block.number, block.header);
  return true;
}

/**
 * Runs public execution and requires every transaction to succeed. An aborted run returns fewer transactions than
 * it was given, so it throws here too; the caller tells an abort from a failure by its own signal.
 */
async function processTxs(
  publicProcessor: PublicProcessor,
  txs: Tx[],
  deadline: Date | undefined,
  signal: AbortSignal,
): Promise<ProcessedTx[]> {
  const [processedTxs, failedTxs] = await publicProcessor.process(txs, { deadline, signal });

  if (failedTxs.length) {
    const failedTxHashes = await Promise.all(failedTxs.map(({ tx }) => tx.getTxHash()));
    throw new Error(
      `Txs failed processing: ${failedTxs.map(({ error }, index) => `${failedTxHashes[index]} (${error})`).join(', ')}`,
    );
  }

  if (processedTxs.length !== txs.length) {
    throw new Error(`Failed to process all txs: processed ${processedTxs.length} out of ${txs.length}`);
  }

  return processedTxs;
}
