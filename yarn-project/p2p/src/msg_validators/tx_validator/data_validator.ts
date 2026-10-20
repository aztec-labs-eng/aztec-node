import { MAX_FR_CALLDATA_TO_ALL_ENQUEUED_CALLS } from '@aztec-labs/constants';
import { type Logger, type LoggerBindings, createLogger } from '@aztec-labs/foundation/log';
import { ContractClassPublishedEvent } from '@aztec-labs/protocol-contracts/class-registry';
import { computeContractClassId } from '@aztec-labs/stdlib/contract';
import { computeCalldataHash } from '@aztec-labs/stdlib/hash';
import {
  TX_ERROR_CALLDATA_COUNT_MISMATCH,
  TX_ERROR_CALLDATA_COUNT_TOO_LARGE,
  TX_ERROR_CONTRACT_CLASS_LOGS,
  TX_ERROR_CONTRACT_CLASS_LOG_COUNT,
  TX_ERROR_CONTRACT_CLASS_LOG_LENGTH,
  TX_ERROR_CONTRACT_CLASS_LOG_SORTING,
  TX_ERROR_INCORRECT_CALLDATA,
  TX_ERROR_INCORRECT_CONTRACT_CLASS_ID,
  TX_ERROR_INCORRECT_HASH,
  TX_ERROR_MALFORMED_CONTRACT_CLASS_LOG,
  TX_ERROR_PRIVATE_LOG_PADDING,
  Tx,
  type TxValidationResult,
  type TxValidator,
} from '@aztec-labs/stdlib/tx';

export class DataTxValidator implements TxValidator<Tx> {
  public readonly identifier: symbol = Symbol('DataTxValidator');

  #log: Logger;

  constructor(bindings?: LoggerBindings) {
    this.#log = createLogger('p2p:tx_validator:tx_data', bindings);
  }

  async validateTx(tx: Tx): Promise<TxValidationResult> {
    const reason =
      (await this.#hasCorrectHash(tx)) ??
      (await this.#hasCorrectCalldata(tx)) ??
      (await this.#hasCorrectContractClassLogs(tx)) ??
      this.#hasZeroPaddedPrivateLogs(tx) ??
      (await this.#hasCorrectContractClassIds(tx));
    return reason ? { result: 'invalid', reason: [reason] } : { result: 'valid' };
  }

  async #hasCorrectHash(tx: Tx): Promise<string | undefined> {
    const expected = await Tx.computeTxHash(tx);
    if (!tx.getTxHash().equals(expected)) {
      const reason = TX_ERROR_INCORRECT_HASH;
      this.#log.verbose(
        `Rejecting tx ${tx.getTxHash().toString()}. Reason: ${reason}. Expected hash ${expected.toString()}. Got ${tx
          .getTxHash()
          .toString()}.`,
      );
      return reason;
    }
    return undefined;
  }

  /**
   * Checks the supplied public calldata entries against the calldata hashes of the public call requests. Every request
   * must have an entry, and every entry must hash to its own hash and be used by some request. Several requests may
   * share one entry, so a hash may appear at most as many times as requests use it. Both the calldata the calls receive
   * and the supplied entries are capped. All of this is checked before hashing any entry.
   */
  async #hasCorrectCalldata(tx: Tx): Promise<string | undefined> {
    const txHash = tx.getTxHash().toString();
    const calldataMap = tx.getCalldataMap();

    const requestCountByHash = new Map<string, number>();
    for (const [index, { request }] of tx.getPublicCallRequestsWithCalldata().entries()) {
      const hash = request.calldataHash.toString();
      if (!calldataMap.has(hash)) {
        const reason = TX_ERROR_INCORRECT_CALLDATA;
        this.#log.verbose(`Rejecting tx ${txHash}. Reason: ${reason}. Call request has no calldata entry.`, {
          txHash,
          callRequestIndex: index,
        });
        return reason;
      }
      requestCountByHash.set(hash, (requestCountByHash.get(hash) ?? 0) + 1);
    }

    // A wrongly labeled entry can make the calls receive less calldata than is supplied, so both totals are capped.
    const deliveredCount = tx.getDeliveredPublicCalldataCount();
    const suppliedCount = tx.getTotalPublicCalldataCount();
    if (
      deliveredCount > MAX_FR_CALLDATA_TO_ALL_ENQUEUED_CALLS ||
      suppliedCount > MAX_FR_CALLDATA_TO_ALL_ENQUEUED_CALLS
    ) {
      const reason = TX_ERROR_CALLDATA_COUNT_TOO_LARGE;
      this.#log.verbose(
        `Rejecting tx ${txHash}. Reason: ${reason}. Expected no greater than ${MAX_FR_CALLDATA_TO_ALL_ENQUEUED_CALLS} fields.`,
        { txHash, deliveredCount, suppliedCount },
      );
      return reason;
    }

    const entryCountByHash = new Map<string, number>();
    for (const [index, cd] of tx.publicFunctionCalldata.entries()) {
      const hash = cd.hash.toString();
      const entryCount = (entryCountByHash.get(hash) ?? 0) + 1;
      const requestCount = requestCountByHash.get(hash) ?? 0;
      if (entryCount > requestCount) {
        const reason = TX_ERROR_CALLDATA_COUNT_MISMATCH;
        this.#log.verbose(
          `Rejecting tx ${txHash}. Reason: ${reason}. Calldata entry is listed more times than call requests use it.`,
          { txHash, calldataIndex: index, requestCount },
        );
        return reason;
      }
      entryCountByHash.set(hash, entryCount);
    }

    for (const [index, cd] of tx.publicFunctionCalldata.entries()) {
      if (!(await computeCalldataHash(cd.values)).equals(cd.hash)) {
        const reason = TX_ERROR_INCORRECT_CALLDATA;
        this.#log.verbose(`Rejecting tx ${txHash}. Reason: ${reason}. Calldata entry does not match its hash.`, {
          txHash,
          calldataIndex: index,
        });
        return reason;
      }
    }

    return undefined;
  }

  async #hasCorrectContractClassLogs(tx: Tx): Promise<string | undefined> {
    const contractClassLogsHashes = tx.data.getNonEmptyContractClassLogsHashes();
    if (contractClassLogsHashes.length !== tx.contractClassLogFields.length) {
      this.#log.verbose(
        `Rejecting tx ${tx.getTxHash().toString()} because of mismatched number of contract class logs. Expected ${
          contractClassLogsHashes.length
        }. Got ${tx.contractClassLogFields.length}.`,
      );
      return TX_ERROR_CONTRACT_CLASS_LOG_COUNT;
    }

    const expectedHashes = await Promise.all(tx.contractClassLogFields.map(l => l.hash()));
    for (const [i, logHash] of contractClassLogsHashes.entries()) {
      const hash = expectedHashes[i];
      if (!logHash.value.equals(hash)) {
        if (expectedHashes.some(h => logHash.value.equals(h))) {
          const matchingLogIndex = expectedHashes.findIndex(l => logHash.value.equals(l));
          this.#log.verbose(
            `Rejecting tx ${tx
              .getTxHash()
              .toString()} because of mismatched contract class logs indices. Expected ${i} from the kernel's log hashes. Got ${matchingLogIndex} in the tx.`,
          );
          return TX_ERROR_CONTRACT_CLASS_LOG_SORTING;
        } else {
          this.#log.verbose(
            `Rejecting tx ${tx.getTxHash().toString()} because of mismatched contract class logs. Expected hash ${
              logHash.value
            } from the kernels. Got ${hash} in the tx.`,
          );
          return TX_ERROR_CONTRACT_CLASS_LOGS;
        }
      }

      // The private kernel tail requires every contract class log within the claimed count to have a non-zero length,
      // and the tx base treats a zero-length log as absent, so a tx carrying one can never be proven.
      if (logHash.logHash.length === 0) {
        const txHash = tx.getTxHash().toString();
        this.#log.verbose(`Rejecting tx ${txHash} because of a zero-length contract class log at index ${i}.`, {
          txHash,
          logIndex: i,
        });
        return TX_ERROR_CONTRACT_CLASS_LOG_LENGTH;
      }

      // The tx base requires exactly the trimmed length; any other length makes the tx unprovable.
      const expectedLength = 1 + tx.contractClassLogFields[i].fields.findLastIndex(f => !f.isZero());
      if (logHash.logHash.length !== expectedLength) {
        this.#log.verbose(
          `Rejecting tx ${tx
            .getTxHash()
            .toString()} because of incorrect contract class log length. Expected ${expectedLength}. Got ${
            logHash.logHash.length
          }.`,
        );
        return TX_ERROR_CONTRACT_CLASS_LOG_LENGTH;
      }
    }

    return undefined;
  }

  // The protocol circuits require every private log to be zero beyond `emittedLength`, so a tx carrying one that is
  // not can never be included. Reject it here so a sequencer does not build a block it cannot prove. Every log is
  // checked, including empty ones.
  #hasZeroPaddedPrivateLogs(tx: Tx): string | undefined {
    const privateLogs = tx.data.getPrivateLogs();
    const badLogIndex = privateLogs.findIndex(log => !log.hasZeroPadding());
    if (badLogIndex !== -1) {
      const reason = TX_ERROR_PRIVATE_LOG_PADDING;
      this.#log.verbose(
        `Rejecting tx ${tx.getTxHash().toString()}. Reason: ${reason}. Private log index: ${badLogIndex}. Emitted length: ${
          privateLogs[badLogIndex].emittedLength
        }.`,
      );
      return reason;
    }
    return undefined;
  }

  async #hasCorrectContractClassIds(tx: Tx): Promise<string | undefined> {
    const contractClassLogs = tx.getContractClassLogs();
    for (const log of contractClassLogs) {
      if (!ContractClassPublishedEvent.isContractClassPublishedEvent(log)) {
        continue;
      }

      let event;
      try {
        event = ContractClassPublishedEvent.fromLog(log);
      } catch (e) {
        this.#log.warn(`Rejecting tx ${tx.getTxHash()}: failed to parse contract class event: ${e}`);
        return TX_ERROR_MALFORMED_CONTRACT_CLASS_LOG;
      }

      try {
        const { publicBytecodeCommitment } = await event.toContractClassPublicWithBytecodeCommitment();
        const computedClassId = await computeContractClassId({
          artifactHash: event.artifactHash,
          privateFunctionsRoot: event.privateFunctionsRoot,
          publicBytecodeCommitment,
        });
        if (!computedClassId.equals(event.contractClassId)) {
          this.#log.warn(
            `Rejecting tx ${tx.getTxHash()}: contract class id mismatch. Claimed ${event.contractClassId}, computed ${computedClassId}`,
          );
          return TX_ERROR_INCORRECT_CONTRACT_CLASS_ID;
        }
      } catch (e) {
        this.#log.warn(`Rejecting tx ${tx.getTxHash()}: failed to compute contract class id: ${e}`);
        return TX_ERROR_MALFORMED_CONTRACT_CLASS_LOG;
      }
    }
    return undefined;
  }
}
