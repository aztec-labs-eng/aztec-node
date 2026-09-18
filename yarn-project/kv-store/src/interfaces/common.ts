/** The key type for use with the kv-store */
export type Key = string | number | Uint8Array | Array<string | number>;

export type Value = NonNullable<any>;

/** A range of keys of arbitrary type. */
export type CustomRange<K> = {
  /** Where iteration begins: inclusive going forwards, exclusive going in reverse */
  start?: K;
  /** Where iteration stops: exclusive going forwards, inclusive going in reverse */
  end?: K;
  /** Whether to iterate in reverse */
  reverse?: boolean;
  /** The maximum number of items to iterate over */
  limit?: number;
};

/** Maps a custom range into a range of valid key types to iterate over. */
export function mapRange<CK, K extends Key = Key>(range: CustomRange<CK>, mapFn: (key: CK) => K): CustomRange<K> {
  return {
    start: range.start !== undefined ? mapFn(range.start) : undefined,
    end: range.end !== undefined ? mapFn(range.end) : undefined,
    reverse: range.reverse,
    limit: range.limit,
  };
}

/**
 * The boundaries a range over keys of type `K` may be expressed with.
 *
 * Array keys order element-wise in every backend, so a prefix of a tuple key is a well-defined
 * boundary: it sorts immediately before every key that extends it. A store keyed by
 * `[address, timestamp, blockNumber, index]` can therefore bracket one address with `[address]`, or
 * one address and timestamp with `[address, timestamp]`, without inventing values for the components
 * it does not want to constrain. Key types that are not tuples accept only themselves.
 */
export type KeyPrefix<K> = (K extends readonly [...infer Init, unknown] ? K | KeyPrefix<Init> : K) & Key;

/** A range of keys to iterate over, bounded by whole keys or by prefixes of them. */
export type Range<K extends Key = Key> = CustomRange<KeyPrefix<K>>;

export type StoreSize = { mappingSize: number; physicalFileSize: number; actualSize: number; numItems: number };
