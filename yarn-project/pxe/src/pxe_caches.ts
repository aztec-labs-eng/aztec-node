import { SiloedTagCache } from './tagging/siloed_tag_cache.js';

/**
 * The in-memory caches a PXE keeps across operations. Each holds values it can compute again, so losing one only costs
 * time, and each lives as long as the PXE that created it.
 */
export type PxeCaches = {
  siloedTags: SiloedTagCache;
};

/** Creates an empty set of caches for one PXE. */
export function createPxeCaches(): PxeCaches {
  return { siloedTags: new SiloedTagCache() };
}
