import { z } from 'zod';

/** Bound for the bootnode and URL lists of a remotely fetched network config. Real configs list a handful. */
const MAX_NETWORK_CONFIG_LIST_LEN = 1000;

export const NetworkConfigSchema = z
  .object({
    bootnodes: z.array(z.string()).max(MAX_NETWORK_CONFIG_LIST_LEN),
    snapshots: z.array(z.string()).max(MAX_NETWORK_CONFIG_LIST_LEN),
    blobFileStoreUrls: z.array(z.string()).max(MAX_NETWORK_CONFIG_LIST_LEN).optional(),
    txCollectionFileStoreUrls: z.array(z.string()).max(MAX_NETWORK_CONFIG_LIST_LEN).optional(),
    registryAddress: z.string(),
    feeAssetHandlerAddress: z.string().optional(),
    l1ChainId: z.number(),
    blockDurationMs: z.number().positive().optional(),
    txPublicSetupAllowListExtend: z.string().optional(),
    nodeVersion: z.string().optional(),
  })
  .passthrough(); // Allow additional unknown fields to pass through

export const NetworkConfigMapSchema = z.record(z.string(), NetworkConfigSchema);

export type NetworkConfig = z.infer<typeof NetworkConfigSchema>;
export type NetworkConfigMap = z.infer<typeof NetworkConfigMapSchema>;
