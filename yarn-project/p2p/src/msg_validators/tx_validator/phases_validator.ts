import { NULL_MSG_SENDER_CONTRACT_ADDRESS } from '@aztec-labs/constants';
import { type Logger, type LoggerBindings, createLogger } from '@aztec-labs/foundation/log';
import { PublicContractsDB, getCallRequestsWithCalldataByPhase } from '@aztec-labs/simulator/server';
import { AztecAddress } from '@aztec-labs/stdlib/aztec-address';
import type { ContractDataSource } from '@aztec-labs/stdlib/contract';
import { Gas } from '@aztec-labs/stdlib/gas';
import type { AllowedElement } from '@aztec-labs/stdlib/interfaces/server';
import {
  type PublicCallRequestWithCalldata,
  TX_ERROR_DURING_VALIDATION,
  TX_ERROR_SETUP_FUNCTION_NOT_ALLOWED,
  TX_ERROR_SETUP_FUNCTION_UNKNOWN_CONTRACT,
  TX_ERROR_SETUP_INSUFFICIENT_GAS,
  TX_ERROR_SETUP_NULL_MSG_SENDER,
  TX_ERROR_SETUP_ONLY_SELF_WRONG_SENDER,
  TX_ERROR_SETUP_STATIC_CALL,
  TX_ERROR_SETUP_WRONG_CALLDATA_LENGTH,
  Tx,
  TxExecutionPhase,
  type TxValidationResult,
  type TxValidator,
} from '@aztec-labs/stdlib/tx';
import type { UInt64 } from '@aztec-labs/stdlib/types';

/** Outcome of checking one setup call against the allow list: the gas it needs if allowed, or why it is rejected. */
type AllowListCheck = { allowed: true; minGas?: Gas } | { allowed: false; reason: string };

/**
 * Validates that every setup call targets a function on the allow list, satisfies the matched entry's constraints, and
 * that the tx's gas limits leave setup at least the gas its allowed calls need.
 */
export class PhasesTxValidator implements TxValidator<Tx> {
  #log: Logger;
  private contractsDB: PublicContractsDB;

  constructor(
    contracts: ContractDataSource,
    private setupAllowList: AllowedElement[],
    private timestamp: UInt64,
    bindings?: LoggerBindings,
  ) {
    this.#log = createLogger('sequencer:tx_validator:tx_phases', bindings);
    this.contractsDB = new PublicContractsDB(contracts, bindings);
  }

  async validateTx(tx: Tx): Promise<TxValidationResult> {
    this.contractsDB.createCheckpoint();
    try {
      // TODO(@spalladino): We add this just to handle public authwit-check calls during setup
      // which are needed for public FPC flows, but fail if the account contract hasnt been deployed yet,
      // which is what we're trying to do as part of the current txs.
      // We only need to create/revert checkpoint here because of this addNewContracts call.
      this.contractsDB.addNewContracts(tx);

      if (!tx.data.forPublic) {
        this.#log.debug(
          `Tx ${tx.getTxHash().toString()} does not contain enqueued public functions. Skipping phases validation.`,
        );
        return { result: 'valid' };
      }

      const setupFns = getCallRequestsWithCalldataByPhase(tx, TxExecutionPhase.SETUP);
      let requiredSetupGas = Gas.empty();
      for (const setupFn of setupFns) {
        const check = await this.checkAllowList(setupFn, this.setupAllowList);
        if (!check.allowed) {
          this.#log.verbose(
            `Rejecting tx ${tx.getTxHash().toString()} because of setup function ${
              setupFn.request.contractAddress
            }:${setupFn.functionSelector}: ${check.reason}`,
            { allowList: this.setupAllowList },
          );

          return { result: 'invalid', reason: [check.reason] };
        }
        if (check.minGas) {
          requiredSetupGas = requiredSetupGas.add(check.minGas);
        }
      }

      // Adding to gasUsed rather than subtracting from the limits keeps this correct even if gasUsed exceeds them.
      const gasLimits = tx.data.constants.txContext.gasSettings.gasLimits;
      if (tx.data.gasUsed.add(requiredSetupGas).gtAny(gasLimits)) {
        this.#log.verbose(
          `Rejecting tx ${tx.getTxHash().toString()} because its gas limits leave too little for setup`,
          {
            gasLimits,
            gasUsed: tx.data.gasUsed,
            requiredSetupGas,
          },
        );
        return { result: 'invalid', reason: [TX_ERROR_SETUP_INSUFFICIENT_GAS] };
      }

      return { result: 'valid' };
    } catch (err) {
      this.#log.error(`Error validating phases for tx`, err);
      return { result: 'invalid', reason: [TX_ERROR_DURING_VALIDATION] };
    } finally {
      this.contractsDB.revertCheckpoint();
    }
  }

  /** Finds the allow list entry for the call and checks the call against it. */
  private async checkAllowList(
    publicCall: PublicCallRequestWithCalldata,
    allowList: AllowedElement[],
  ): Promise<AllowListCheck> {
    if (publicCall.isEmpty()) {
      return { allowed: true };
    }
    // A static call cannot write state, so in setup it can only consume gas or fail.
    if (publicCall.request.isStaticCall) {
      return { allowed: false, reason: TX_ERROR_SETUP_STATIC_CALL };
    }

    const contractAddress = publicCall.request.contractAddress;
    const functionSelector = publicCall.functionSelector;

    // Check address-based entries first since they don't require the contract class.
    for (const entry of allowList) {
      if ('address' in entry) {
        if (contractAddress.equals(entry.address) && entry.selector.equals(functionSelector)) {
          return this.checkEntryConstraints(publicCall, entry);
        }
      }
    }

    // Check class-based entries. Fetch the contract instance lazily (only once).
    let contractClassId: undefined | { value: string | undefined };
    for (const entry of allowList) {
      if (!('classId' in entry)) {
        continue;
      }

      if (contractClassId === undefined) {
        const instance = await this.contractsDB.getContractInstance(contractAddress, this.timestamp);
        contractClassId = { value: instance?.currentContractClassId.toString() };
        if (!contractClassId.value) {
          return { allowed: false, reason: TX_ERROR_SETUP_FUNCTION_UNKNOWN_CONTRACT };
        }
      }

      if (contractClassId.value === entry.classId.toString() && entry.selector.equals(functionSelector)) {
        return this.checkEntryConstraints(publicCall, entry);
      }
    }

    return { allowed: false, reason: TX_ERROR_SETUP_FUNCTION_NOT_ALLOWED };
  }

  /** Checks a call against the constraints of the allow list entry it matched. */
  private checkEntryConstraints(publicCall: PublicCallRequestWithCalldata, entry: AllowedElement): AllowListCheck {
    const { request } = publicCall;
    if (entry.calldataLength !== undefined && publicCall.calldata.length !== entry.calldataLength) {
      return { allowed: false, reason: TX_ERROR_SETUP_WRONG_CALLDATA_LENGTH };
    }
    if (entry.onlySelf && !request.msgSender.equals(request.contractAddress)) {
      return { allowed: false, reason: TX_ERROR_SETUP_ONLY_SELF_WRONG_SENDER };
    }
    if (
      entry.rejectNullMsgSender &&
      request.msgSender.equals(AztecAddress.fromBigIntUnsafe(NULL_MSG_SENDER_CONTRACT_ADDRESS))
    ) {
      return { allowed: false, reason: TX_ERROR_SETUP_NULL_MSG_SENDER };
    }
    return { allowed: true, minGas: entry.minGas };
  }
}

/** Structural interface for the allowed-setup-calls flag check. */
export interface HasAllowedSetupCallsData {
  txHash: { toString(): string };
  allowedSetupCalls: boolean;
}

/**
 * Validates that a transaction's setup-phase calls were allowed at receipt time.
 *
 * Checks the precomputed `allowedSetupCalls` flag on TxMetaData. The flag is
 * computed by running the PhasesTxValidator on the full Tx when it first enters
 * the pool. This lightweight validator is used during pending pool migration to
 * reject txs whose setup calls are not on the allow list.
 */
export class AllowedSetupCallsMetaValidator<T extends HasAllowedSetupCallsData> implements TxValidator<T> {
  #log: Logger;

  constructor(bindings?: LoggerBindings) {
    this.#log = createLogger('sequencer:tx_validator:tx_phases_meta', bindings);
  }

  validateTx(tx: T): Promise<TxValidationResult> {
    if (!tx.allowedSetupCalls) {
      this.#log.verbose(`Rejecting tx ${tx.txHash} because its setup calls are not on the allow list`);
      return Promise.resolve({ result: 'invalid', reason: [TX_ERROR_SETUP_FUNCTION_NOT_ALLOWED] });
    }
    return Promise.resolve({ result: 'valid' });
  }
}
