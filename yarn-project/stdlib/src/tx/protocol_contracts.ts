import { DomainSeparator, MAX_PROTOCOL_CONTRACTS } from '@aztec-labs/constants';
import { makeTuple } from '@aztec-labs/foundation/array';
import { arraySerializedSizeOfNonEmpty } from '@aztec-labs/foundation/collection';
import { poseidon2HashWithSeparator } from '@aztec-labs/foundation/crypto/poseidon';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import {
  BufferReader,
  FieldReader,
  type Tuple,
  assertLength,
  serializeToBuffer,
  serializeToFields,
} from '@aztec-labs/foundation/serialize';
import type { FieldsOf } from '@aztec-labs/foundation/types';
import { z } from 'zod';

import { AztecAddress } from '../aztec-address/index.js';

export class ProtocolContracts {
  constructor(public derivedAddresses: Tuple<AztecAddress, typeof MAX_PROTOCOL_CONTRACTS>) {}

  static from(fields: FieldsOf<ProtocolContracts>) {
    return new ProtocolContracts(...ProtocolContracts.getFields(fields));
  }

  static getFields(fields: FieldsOf<ProtocolContracts>) {
    return [fields.derivedAddresses] as const;
  }

  static fromFields(fields: Fr[] | FieldReader): ProtocolContracts {
    const reader = FieldReader.asReader(fields);
    return new ProtocolContracts(reader.readArray(MAX_PROTOCOL_CONTRACTS, AztecAddress));
  }

  toFields(): Fr[] {
    return serializeToFields(...ProtocolContracts.getFields(this));
  }

  static fromBuffer(buffer: Buffer | BufferReader): ProtocolContracts {
    const reader = BufferReader.asReader(buffer);
    return new ProtocolContracts(reader.readArray(MAX_PROTOCOL_CONTRACTS, AztecAddress));
  }

  toBuffer() {
    return serializeToBuffer(...ProtocolContracts.getFields(this));
  }

  static empty() {
    return new ProtocolContracts(makeTuple(MAX_PROTOCOL_CONTRACTS, () => AztecAddress.zero()));
  }

  /**
   * Creates a ProtocolContracts instance from a plain object without Zod validation.
   * This method is optimized for performance and skips validation, making it suitable
   * for deserializing trusted data (e.g., from C++ via MessagePack).
   * @param obj - Plain object containing ProtocolContracts fields
   * @returns A ProtocolContracts instance
   */
  static fromPlainObject(obj: any): ProtocolContracts {
    return new ProtocolContracts(
      assertLength(
        obj.derivedAddresses.map((addr: any) => AztecAddress.fromPlainObject(addr)),
        MAX_PROTOCOL_CONTRACTS,
      ),
    );
  }

  getSize() {
    return arraySerializedSizeOfNonEmpty(this.derivedAddresses);
  }

  hash() {
    return poseidon2HashWithSeparator(this.derivedAddresses, DomainSeparator.PROTOCOL_CONTRACTS);
  }

  static get schema() {
    return z
      .object({
        derivedAddresses: AztecAddress.schema.array().min(MAX_PROTOCOL_CONTRACTS).max(MAX_PROTOCOL_CONTRACTS),
      })
      .transform(
        ({ derivedAddresses }) => new ProtocolContracts(assertLength(derivedAddresses, MAX_PROTOCOL_CONTRACTS)),
      );
  }
}
