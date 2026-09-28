import { DomainSeparator, TX_REQUEST_LENGTH } from '@aztec-labs/constants';
import { poseidon2HashWithSeparator } from '@aztec-labs/foundation/crypto/poseidon';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { BufferReader, serializeToBuffer, serializeToFields } from '@aztec-labs/foundation/serialize';
import type { FieldsOf } from '@aztec-labs/foundation/types';

import { AztecAddress } from '../aztec-address/index.js';
import { computeProtocolNullifier } from '../hash/hash.js';
import { FunctionData } from './function_data.js';
import { TxContext } from './tx_context.js';

/**
 * Transaction request.
 */
export class TxRequest {
  // docs:start:constructor
  constructor(
    /** Sender. */
    public origin: AztecAddress,
    /** Pedersen hash of function arguments. */
    public argsHash: Fr,
    /** Transaction context. */
    public txContext: TxContext,
    /** Function data representing the function to call. */
    public functionData: FunctionData,
    /**
     * A fresh random field drawn by the wallet, acting as the tx request's nonce. With `origin`, `chainId` and `version`
     * it is the whole preimage of the protocol nullifier, so it keeps that nullifier unpredictable and unique. The kernel
     * cannot check that it is random; draw it fresh for every transaction, since two requests with the same origin and
     * salt are mutually exclusive.
     */
    public salt: Fr,
  ) {}
  // docs:end:constructor

  static getFields(fields: FieldsOf<TxRequest>) {
    return [fields.origin, fields.argsHash, fields.txContext, fields.functionData, fields.salt] as const;
  }

  static from(fields: FieldsOf<TxRequest>): TxRequest {
    return new TxRequest(...TxRequest.getFields(fields));
  }

  /**
   * Serialize as a buffer.
   * @returns The buffer.
   */
  toBuffer() {
    return serializeToBuffer([...TxRequest.getFields(this)]);
  }

  /**
   * The unsiloed value of the protocol nullifier: the transaction's nonce commitment.
   * The preimage is only `origin`, `chainId`, `version` and `salt`. Gas settings and the first call's arguments are
   * left out so that a fee bump or a cancellation that reuses the salt produces the same nullifier.
   */
  computeProtocolNullifierValue(): Promise<Fr> {
    return poseidon2HashWithSeparator(
      [this.origin.toField(), this.txContext.chainId, this.txContext.version, this.salt],
      DomainSeparator.PROTOCOL_NULLIFIER,
    );
  }

  /**
   * The protocol nullifier as inserted into the nullifier tree, and as every private call receives it in
   * `PrivateCircuitPublicInputs.protocolNullifier`: the value above siloed under `NULL_MSG_SENDER`.
   */
  async computeProtocolNullifier(): Promise<Fr> {
    return computeProtocolNullifier(await this.computeProtocolNullifierValue());
  }

  toFields(): Fr[] {
    const fields = serializeToFields(...TxRequest.getFields(this));
    if (fields.length !== TX_REQUEST_LENGTH) {
      throw new Error(`Invalid number of fields for TxRequest. Expected ${TX_REQUEST_LENGTH}, got ${fields.length}`);
    }
    return fields;
  }

  /**
   * Deserializes from a buffer or reader, corresponding to a write in cpp.
   * @param buffer - Buffer to read from.
   * @returns The deserialized TxRequest object.
   */
  static fromBuffer(buffer: Buffer | BufferReader): TxRequest {
    const reader = BufferReader.asReader(buffer);
    return new TxRequest(
      reader.readObject(AztecAddress),
      Fr.fromBuffer(reader),
      reader.readObject(TxContext),
      reader.readObject(FunctionData),
      Fr.fromBuffer(reader),
    );
  }

  static empty() {
    return new TxRequest(AztecAddress.ZERO, Fr.zero(), TxContext.empty(), FunctionData.empty(), Fr.zero());
  }

  isEmpty() {
    return (
      this.origin.isZero() &&
      this.argsHash.isZero() &&
      this.txContext.isEmpty() &&
      this.functionData.isEmpty() &&
      this.salt.isZero()
    );
  }
}
