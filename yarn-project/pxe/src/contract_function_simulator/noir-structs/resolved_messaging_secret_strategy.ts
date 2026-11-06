import { Fr } from '@aztec-labs/foundation/curves/bn254';

// Keep in sync with aztec::messages::delivery::ResolvedMessagingSecretStrategy
const NON_INTERACTIVE_HANDSHAKE = 1;
const UNCONSTRAINED_SECRET = 2;
const INTERACTIVE_HANDSHAKE = 3;

/**
 * The outcome of the wallet's {@link MessagingSecretStrategy}.
 *
 * It is either a handshake for the contract to establish, or a messaging secret. The contract derives the message tag
 * from that secret directly, so it never sees raw key material.
 *
 * TypeScript counterpart of `ResolvedMessagingSecretStrategy` in Aztec.nr.
 */
export type ResolvedMessagingSecretStrategy =
  | {
      /** A non-interactive handshake: the recipient re-derives the secret from the onchain handshake registry. */
      type: 'non-interactive-handshake';
    }
  | {
      /**
       * An interactive handshake: the registry obtains the recipient's signed authorization through the custom
       * request oracle, and the recipient learns the secret while signing. Nothing announcing the handshake is
       * published onchain.
       */
      type: 'interactive-handshake';
    }
  | {
      /**
       * An app-siloed, recipient-directional secret, ready to use. Only sound for unconstrained delivery.
       */
      type: 'unconstrained-secret';
      /** The app-siloed directional messaging secret. */
      secret: Fr;
    };

/**
 * Serializes a {@link ResolvedMessagingSecretStrategy} to its Noir `[kind, secret]` field layout, zero-filling absent
 * fields.
 */
export function resolvedMessagingSecretStrategyToFields(resolved: ResolvedMessagingSecretStrategy): Fr[] {
  switch (resolved.type) {
    case 'non-interactive-handshake':
      return [new Fr(NON_INTERACTIVE_HANDSHAKE), Fr.ZERO];
    case 'unconstrained-secret':
      return [new Fr(UNCONSTRAINED_SECRET), resolved.secret];
    case 'interactive-handshake':
      return [new Fr(INTERACTIVE_HANDSHAKE), Fr.ZERO];
  }
}

/** Deserializes a {@link ResolvedMessagingSecretStrategy} from its `kind` discriminant and `secret` field. */
export function resolvedMessagingSecretStrategyFromFields(kind: number, secret: Fr): ResolvedMessagingSecretStrategy {
  switch (kind) {
    case NON_INTERACTIVE_HANDSHAKE:
      assertAbsentSecret(kind, secret);
      return { type: 'non-interactive-handshake' };
    case INTERACTIVE_HANDSHAKE:
      assertAbsentSecret(kind, secret);
      return { type: 'interactive-handshake' };
    case UNCONSTRAINED_SECRET:
      return { type: 'unconstrained-secret', secret };
    default:
      throw new Error(`Unrecognized resolved messaging secret strategy kind: ${kind}`);
  }
}

function assertAbsentSecret(kind: number, secret: Fr): void {
  if (!secret.isZero()) {
    throw new Error(`Resolved messaging secret strategy ${kind} must not include a secret`);
  }
}
