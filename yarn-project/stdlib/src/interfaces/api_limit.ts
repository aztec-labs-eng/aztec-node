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
/** Functions in a contract artifact or contract class. */
export const MAX_CONTRACT_FUNCTIONS = 4096;
/** Return types listed for a function. Well-formed artifacts list at most one. */
export const MAX_ABI_RETURN_TYPES = 256;
/** Elements of an ABI-encoded or decoded array, tuple or struct value. */
export const MAX_ABI_VALUE_LEN = 2 ** 16;
/**
 * JSON nesting depth accepted by recursive schemas (ABI types and values, nested return values) before they recurse.
 * Real contract artifacts stay under 30 levels; parsing input thousands of levels deep overflows the stack.
 */
export const MAX_SCHEMA_NESTING_DEPTH = 256;
/** Validator addresses in admin config lists. An operator can run many validators from one node. */
export const MAX_ADMIN_VALIDATOR_LIST_LEN = 10_000;
/** Entries in other admin config lists, such as preferred peers or slots to pause proposing on. */
export const MAX_ADMIN_CONFIG_LIST_LEN = 1000;
