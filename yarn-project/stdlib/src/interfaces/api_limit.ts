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
/** The PXE registers every public function signature of a contract class in one call. */
export const MAX_SIGNATURES_PER_REGISTER_CALL = 1000;
export const MAX_SIGNATURE_LEN = 10000;
/** Validator addresses in admin config lists. An operator can run many validators from one node. */
export const MAX_ADMIN_VALIDATOR_LIST_LEN = 10_000;
/** Entries in other admin config lists, such as preferred peers or slots to pause proposing on. */
export const MAX_ADMIN_CONFIG_LIST_LEN = 1000;
