import type { Fr } from '@aztec-labs/foundation/curves/bn254';

/** Wire form of a Grumpkin point crossing the oracle boundary: Noir's `EmbeddedCurvePoint` serializes to `[x, y]`. */
export type EmbeddedCurvePoint = { x: Fr; y: Fr };
