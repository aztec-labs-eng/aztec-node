import { BufferReader } from '@aztec-labs/foundation/serialize';

/**
 * Reads the presence flag of an optional wire field, accepting only the two values an encoder writes.
 *
 * `readNumber` alone treats every non-zero word as "present", so a payload from an older format whose bytes happen
 * to line up here parses as a different proposal shape rather than failing. Signature verification limits what an
 * attacker gains from that, but a decoder that accepts more than one encoding of the same message is not canonical:
 * two distinct byte strings would name one proposal.
 */
export function readOptionalFieldFlag(reader: BufferReader, field: string): boolean {
  const flag = reader.readNumber();
  if (flag !== 0 && flag !== 1) {
    throw new Error(`Invalid ${field} presence flag ${flag}; expected 0 or 1`);
  }
  return flag === 1;
}

/**
 * Runs a top-level decode and requires it to consume the whole input.
 *
 * A decoder that stops early accepts a proposal with arbitrary bytes appended, so the same message has unboundedly
 * many encodings and its byte string is no longer an identity. Only the outermost decode can make this demand: a
 * nested one is reading its part of a larger buffer, which is why decoders keep taking a {@link BufferReader} and
 * only the `Buffer` entry point is strict.
 */
export function decodeCanonical<T>(buf: Buffer | BufferReader, what: string, decode: (reader: BufferReader) => T): T {
  const nested = buf instanceof BufferReader;
  const reader = BufferReader.asReader(buf);
  const value = decode(reader);
  if (!nested && !reader.isEmpty()) {
    throw new Error(`${what} has ${reader.remainingBytes()} trailing byte(s) after its encoding`);
  }
  return value;
}
