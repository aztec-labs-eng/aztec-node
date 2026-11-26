import { LruMap, getOrComputeAsync } from '@aztec-labs/foundation/collection';
import { type PreTag, SiloedTag } from '@aztec-labs/stdlib/logs';

import { UNFINALIZED_TAGGING_INDEXES_WINDOW_LEN } from './constants.js';

/**
 * How many messaging secrets' full tagging windows {@link SiloedTagCache} holds, which is how many secrets can be
 * synced again without rehashing when every sync scans a whole window: enough for the secrets that several operations
 * sync, at roughly 10 MiB.
 */
const SILOED_TAG_CACHE_WINDOWS = 200;

const SILOED_TAG_CACHE_MAX_ENTRIES = SILOED_TAG_CACHE_WINDOWS * UNFINALIZED_TAGGING_INDEXES_WINDOW_LEN;

/**
 * Serves repeated siloed tag computations from memory.
 *
 * A tag sync computes the siloed tag of every index it scans for each secret it syncs, and consecutive syncs scan
 * nearly the same indexes, so most of that hashing repeats. The cache keeps the most recently used tags.
 */
export class SiloedTagCache {
  readonly #tags = new LruMap<string, Promise<SiloedTag>>(SILOED_TAG_CACHE_MAX_ENTRIES);

  /**
   * Returns the siloed tag of `preTag`.
   *
   * The tag is the one {@link SiloedTag.compute} returns, computed only if it is not cached.
   */
  compute(preTag: PreTag): Promise<SiloedTag> {
    return getOrComputeAsync(this.#tags, `${preTag.extendedSecret.toString()}:${preTag.index}`, () =>
      SiloedTag.compute(preTag),
    );
  }
}
