import type { Fr } from '@aztec-labs/foundation/curves/bn254';
import type { OnchainDeliveryMode } from '@aztec-labs/stdlib/logs';

/** A tagging secret an app supplies explicitly to `getPendingTaggedLogsV2` when PXE cannot derive it internally. */
export type ProvidedSecret = { secret: Fr; mode: OnchainDeliveryMode };
