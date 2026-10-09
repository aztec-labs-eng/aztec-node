// 1_000_000_000 Gwei = 1 ETH
// 1_000_000_000 Wei = 1 Gwei
// 1_000_000_000_000_000_000 Wei = 1 ETH
export const WEI_CONST = 1_000_000_000n;

// Our conservative ceiling on the total gas limit of any L1 tx we send (2^24), matching the EIP-7825 cap.
// EIP-8037 keeps 2^24 as the execution cap but would allow a higher total; see AMSTERDAM_MAX_L1_TX_LIMIT.
export const MAX_L1_TX_LIMIT = 16_777_216n;

// Once Amsterdam (EIP-8037) is active, 2^24 bounds only execution gas, and state gas is drawn from whatever the tx gas
// limit exceeds 2^24 by, so a tx sent with exactly 2^24 must fit execution and state gas together in 16.7M. Executing a
// slashing round is dominated by state gas: the worst case per slashed validator is an ejection that leaves a remainder,
// costing ~930k state gas and ~210k execution gas, on top of ~1.8M fixed plus ~10.7k per vote. With the maximum of 128
// votes, a round slashing 39 validators uses ~47.4M gas and fits a 50M limit, while 40 do not (the 63/64 call-forwarding
// rule needs headroom above the gas used); we cap at 35 to leave margin below that. 50M is also the default gas cap RPC
// nodes apply to eth_estimateGas, eth_call and eth_simulateV1, so we cannot simulate anything larger; both values can be
// raised once RPCs allow more than 50M.
export const AMSTERDAM_MAX_L1_TX_LIMIT = 50_000_000n;
export const AMSTERDAM_MAX_SLASHED_VALIDATORS_PER_ROUND = 35;

// How long a publisher whose send was rejected for insufficient funds is skipped by publisher selection if its balance
// does not increase in the meantime.
export const INSUFFICIENT_FUNDS_BACKOFF_MS = 5 * 60 * 1000;

// setting a minimum bump percentage to 10% due to geth's implementation
// https://github.com/ethereum/go-ethereum/blob/e3d61e6db028c412f74bc4d4c7e117a9e29d0de0/core/txpool/legacypool/list.go#L298
export const MIN_REPLACEMENT_BUMP_PERCENTAGE = 10;

// setting a minimum bump percentage to 100% due to geth's implementation
// https://github.com/ethereum/go-ethereum/blob/e3d61e6db028c412f74bc4d4c7e117a9e29d0de0/core/txpool/blobpool/config.go#L34
export const MIN_BLOB_REPLACEMENT_BUMP_PERCENTAGE = 100;

// Avg ethereum block time is ~12s
export const BLOCK_TIME_MS = 12_000;

// Gas per blob (EIP-4844)
export const GAS_PER_BLOB = 131072n;

// Blob capacity schedule based on Ethereum upgrades
export const BLOB_CAPACITY_SCHEDULE = [
  { timestamp: 1734357600, target: 14, max: 21 }, // BPO2: Dec 17, 2025
  { timestamp: 1733752800, target: 10, max: 15 }, // BPO1: Dec 9, 2025
  { timestamp: 1733234400, target: 6, max: 9 }, // Fusaka: Dec 3, 2025
  { timestamp: 0, target: 6, max: 9 }, // Pectra/earlier
];
