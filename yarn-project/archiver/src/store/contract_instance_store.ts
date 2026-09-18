import type { BlockNumber } from '@aztec-labs/foundation/branded-types';
import type { Fr } from '@aztec-labs/foundation/curves/bn254';
import { first } from '@aztec-labs/foundation/iterable';
import type { AztecAsyncKVStore, AztecAsyncMap } from '@aztec-labs/kv-store';
import { isProtocolContract } from '@aztec-labs/protocol-contracts';
import type { AztecAddress } from '@aztec-labs/stdlib/aztec-address';
import {
  type ContractInstanceUpdateWithAddress,
  type ContractInstanceWithAddress,
  SerializableContractInstance,
  SerializableContractInstanceUpdate,
} from '@aztec-labs/stdlib/contract';
import type { UInt64 } from '@aztec-labs/stdlib/types';

/** Stored key: contract address, scheduling timestamp, block number, and index within the block. */
type ContractInstanceUpdateKey = [string, string, BlockNumber, number];

/**
 * Renders a timestamp so that lexicographic ordering of the encoded strings matches numeric ordering,
 * which the key comparison relies on. Twenty digits cover the whole uint64 range plus the exclusive
 * upper boundary a lookup builds from it.
 */
function encodeTimestamp(timestamp: bigint): string {
  return timestamp.toString().padStart(20, '0');
}

/**
 * LMDB-based contract instance storage for the archiver.
 */
export class ContractInstanceStore {
  #contractInstances: AztecAsyncMap<string, Buffer>;
  #contractInstancePublishedAt: AztecAsyncMap<string, number>;
  #contractInstanceUpdates: AztecAsyncMap<ContractInstanceUpdateKey, Buffer>;

  constructor(private db: AztecAsyncKVStore) {
    this.#contractInstances = db.openMap('archiver_contract_instances');
    this.#contractInstancePublishedAt = db.openMap('archiver_contract_instances_publication_block_number');
    this.#contractInstanceUpdates = db.openMap('archiver_contract_instance_updates');
  }

  /**
   * Adds multiple contract instances to the store.
   * @param data - Contract instances to add.
   * @param blockNumber - L2 block number where the instances were deployed.
   * @returns True if every insert succeeded.
   */
  async addContractInstances(data: ContractInstanceWithAddress[], blockNumber: number): Promise<boolean> {
    return (await Promise.all(data.map(c => this.addContractInstance(c, blockNumber)))).every(Boolean);
  }

  /**
   * Removes multiple contract instances from the store.
   * @param data - Contract instances to delete.
   * @returns True if every delete succeeded.
   */
  async deleteContractInstances(data: ContractInstanceWithAddress[]): Promise<boolean> {
    return (await Promise.all(data.map(c => this.deleteContractInstance(c)))).every(Boolean);
  }

  /**
   * Adds multiple contract instance updates to the store.
   * @param data - Contract instance updates to add.
   * @param timestamp - Timestamp at which the updates were scheduled.
   * @param blockNumber - L2 block that carried the updates.
   * @returns True if every insert succeeded.
   */
  async addContractInstanceUpdates(
    data: ContractInstanceUpdateWithAddress[],
    timestamp: UInt64,
    blockNumber: BlockNumber,
  ): Promise<boolean> {
    return (
      await Promise.all(
        data.map((update, logIndex) => this.addContractInstanceUpdate(update, timestamp, blockNumber, logIndex)),
      )
    ).every(Boolean);
  }

  /**
   * Removes multiple contract instance updates from the store.
   * @param data - Contract instance updates to delete.
   * @param timestamp - Timestamp at which the updates were scheduled.
   * @param blockNumber - L2 block that carried the updates.
   * @returns True if every delete succeeded.
   */
  async deleteContractInstanceUpdates(
    data: ContractInstanceUpdateWithAddress[],
    timestamp: UInt64,
    blockNumber: BlockNumber,
  ): Promise<boolean> {
    return (
      await Promise.all(
        data.map((update, logIndex) => this.deleteContractInstanceUpdate(update, timestamp, blockNumber, logIndex)),
      )
    ).every(Boolean);
  }

  addContractInstance(contractInstance: ContractInstanceWithAddress, blockNumber: number): Promise<void> {
    return this.db.transactionAsync(async () => {
      const key = contractInstance.address.toString();
      if (await this.#contractInstances.hasAsync(key)) {
        // Protocol contracts are preloaded at block 0, so a later on-chain (re-)publish of a bundled
        // protocol instance is valid and must be a no-op. Keep the existing block-0 entry untouched.
        if (isProtocolContract(contractInstance.address)) {
          return;
        }
        const existingBlockNumber = await this.#contractInstancePublishedAt.getAsync(key);
        // An L1 reorg can re-present an already-stored checkpoint, replaying this instance at the same
        // block; treat that as a no-op. A duplicate at a different block still signals double-processing.
        if (existingBlockNumber === blockNumber) {
          return;
        }
        throw new Error(
          `Contract instance at ${key} already exists (deployed at block ${existingBlockNumber}), cannot add again at block ${blockNumber}`,
        );
      }
      await this.#contractInstances.set(key, new SerializableContractInstance(contractInstance).toBuffer());
      await this.#contractInstancePublishedAt.set(key, blockNumber);
    });
  }

  deleteContractInstance(contractInstance: ContractInstanceWithAddress): Promise<void> {
    // Protocol contracts are preloaded at block 0 and must never be deleted, even when the block that
    // (re-)published them on-chain is unwound by a reorg.
    if (isProtocolContract(contractInstance.address)) {
      return Promise.resolve();
    }
    return this.db.transactionAsync(async () => {
      await this.#contractInstances.delete(contractInstance.address.toString());
      await this.#contractInstancePublishedAt.delete(contractInstance.address.toString());
    });
  }

  private getUpdateRangeKey(contractAddress: AztecAddress, timestamp: bigint): [string, string] {
    return [contractAddress.toString(), encodeTimestamp(timestamp)];
  }

  private getUpdateKey(
    contractAddress: AztecAddress,
    timestamp: UInt64,
    blockNumber: BlockNumber,
    logIndex: number,
  ): ContractInstanceUpdateKey {
    return [contractAddress.toString(), encodeTimestamp(timestamp), blockNumber, logIndex];
  }

  addContractInstanceUpdate(
    contractInstanceUpdate: ContractInstanceUpdateWithAddress,
    timestamp: UInt64,
    blockNumber: BlockNumber,
    logIndex: number,
  ): Promise<void> {
    return this.#contractInstanceUpdates.set(
      this.getUpdateKey(contractInstanceUpdate.address, timestamp, blockNumber, logIndex),
      new SerializableContractInstanceUpdate(contractInstanceUpdate).toBuffer(),
    );
  }

  deleteContractInstanceUpdate(
    contractInstanceUpdate: ContractInstanceUpdateWithAddress,
    timestamp: UInt64,
    blockNumber: BlockNumber,
    logIndex: number,
  ): Promise<void> {
    return this.#contractInstanceUpdates.delete(
      this.getUpdateKey(contractInstanceUpdate.address, timestamp, blockNumber, logIndex),
    );
  }

  async getCurrentContractInstanceClassId(address: AztecAddress, timestamp: UInt64, originalClassId: Fr): Promise<Fr> {
    // We need to find the last update before the given timestamp
    const serializedUpdate = await first(
      this.#contractInstanceUpdates.valuesAsync({
        reverse: true,
        start: this.getUpdateRangeKey(address, 0n), // Make sure we only look at updates for this contract
        end: this.getUpdateRangeKey(address, timestamp + 1n), // No update can match this key since it carries no block or log index. We want the highest key <= timestamp
        limit: 1,
      }),
    );
    if (serializedUpdate === undefined) {
      return originalClassId;
    }

    const update = SerializableContractInstanceUpdate.fromBuffer(serializedUpdate);
    if (timestamp < update.timestampOfChange) {
      return update.prevContractClassId.isZero() ? originalClassId : update.prevContractClassId;
    }
    return update.newContractClassId;
  }

  async getContractInstance(
    address: AztecAddress,
    timestamp: UInt64,
  ): Promise<ContractInstanceWithAddress | undefined> {
    const contractInstance = await this.#contractInstances.getAsync(address.toString());
    if (!contractInstance) {
      return undefined;
    }

    const instance = SerializableContractInstance.fromBuffer(contractInstance).withAddress(address);
    instance.currentContractClassId = await this.getCurrentContractInstanceClassId(
      address,
      timestamp,
      instance.originalContractClassId,
    );
    return instance;
  }

  getContractInstanceDeploymentBlockNumber(address: AztecAddress): Promise<number | undefined> {
    return this.#contractInstancePublishedAt.getAsync(address.toString());
  }
}
