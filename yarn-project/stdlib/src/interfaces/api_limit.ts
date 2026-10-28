export const MAX_RPC_LEN = 100;
export const MAX_RPC_TXS_LEN = 50;
export const MAX_RPC_BLOCKS_LEN = 50;
export const MAX_RPC_CHECKPOINTS_LEN = 50;
/** Checkpoint data carries no attestations or block bodies, so a page can be larger than a full checkpoint response. */
export const MAX_RPC_CHECKPOINTS_DATA_LEN = 200;
export const MAX_LOGS_PER_TAG = 20;
/** Overrides are written into a public data tree fork before simulation, outside the simulated tx's gas budget. */
export const MAX_RPC_PUBLIC_STORAGE_OVERRIDES_LEN = 200;
export const MAX_RPC_CONTRACT_OVERRIDES_LEN = 50;
export const MAX_SIGNATURES_PER_REGISTER_CALL = 100;
export const MAX_SIGNATURE_LEN = 10000;
/**
 * Bound for arrays whose length no protocol constant caps, such as artifact, debug, profiling and offchain-effect
 * data. It is far above anything well-formed and only makes an oversized array fail on its length before zod parses
 * its elements.
 */
export const MAX_UNCAPPED_ARRAY_LEN = 2 ** 20;
