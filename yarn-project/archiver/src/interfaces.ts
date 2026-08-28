import type { L2BlockSource } from '@aztec-labs/stdlib/block';
import type { ContractDataSource } from '@aztec-labs/stdlib/contract';
import type { L2LogsSource } from '@aztec-labs/stdlib/interfaces/server';
import type { L1ToL2MessageSource } from '@aztec-labs/stdlib/messaging';

/**
 * Helper interface to combine all sources this archiver implementation provides.
 */
export type ArchiverDataSource = L2BlockSource & L2LogsSource & ContractDataSource & L1ToL2MessageSource;
