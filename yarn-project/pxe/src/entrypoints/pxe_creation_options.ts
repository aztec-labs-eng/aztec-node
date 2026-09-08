import type { BBPrivateKernelProverOptions } from '@aztec-labs/bb-prover/client';
import type { Logger } from '@aztec-labs/foundation/log';
import type { AztecAsyncKVStore } from '@aztec-labs/kv-store';
import type { CircuitSimulator } from '@aztec-labs/simulator/client';
import type { AztecNodeDebug, PrivateKernelProver } from '@aztec-labs/stdlib/interfaces/client';

import type { ExecutionHooks } from '../hooks/index.js';
import type { PreloadedContractsProvider } from '../pxe.js';

export type PXECreationOptions = {
  loggers?: { store?: Logger; pxe?: Logger; prover?: Logger };
  /** Actor label to include in log output (e.g., 'pxe-0', 'pxe-test'). */
  loggerActorLabel?: string;
  proverOrOptions?: PrivateKernelProver | BBPrivateKernelProverOptions;
  store?: AztecAsyncKVStore;
  simulator?: CircuitSimulator;
  /** Optional hooks to observe and influence contract execution. */
  hooks?: ExecutionHooks;
  /** Contracts to preload on startup. Replaces the default when set. */
  preloadedContractsProvider?: PreloadedContractsProvider;
  /**
   * Optional debug API client for the same node. When provided, public function signatures are registered so the
   * node can produce named public-execution stack traces. Only available on nodes started with debug endpoints
   * enabled; omitted in prod-like setups.
   */
  nodeDebug?: AztecNodeDebug;
};

/** Checks if the given value implements the PrivateKernelProver interface via duck-typing. */
export function isPrivateKernelProver(value: unknown): value is PrivateKernelProver {
  return (
    typeof value === 'object' && value !== null && typeof (value as PrivateKernelProver).createChonkProof === 'function'
  );
}
