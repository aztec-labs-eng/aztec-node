import type { Fr } from '@aztec-labs/foundation/curves/bn254';
import type { Point } from '@aztec-labs/foundation/curves/grumpkin';
import type { AztecAddress } from '@aztec-labs/stdlib/aztec-address';
import type { OnchainDeliveryMode } from '@aztec-labs/stdlib/logs';

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- only referenced by a {@link} doc tag
import type { PXE } from '../pxe.js';
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- only referenced by a {@link} doc tag
import type { ResolveCustomRequest } from './resolve_custom_request.js';

/**
 * The wallet's choice of how to derive a message's messaging secret, returned by
 * {@link ResolveMessagingSecretStrategy}. This is intent (plus, for an arbitrary secret, the raw material) - PXE
 * resolves it into either a handshake for the contract to establish or a messaging secret ready to use.
 */
export type MessagingSecretStrategy =
  | {
      /**
       * Establish a non-interactive handshake through the onchain handshake registry. Backs both delivery modes.
       * Establishing it reveals to anyone who knows the recipient's address that someone performed a handshake with
       * them, though not who. As the handshake is established in the transaction that delivers the first message, it
       * also reveals that this transaction likely carries a message for them, though nothing about the contents of that
       * or any later message. An `interactive-handshake` reveals nothing, but requires the recipient's cooperation.
       */
      type: 'non-interactive-handshake';
    }
  | {
      /**
       * Establish an interactive handshake through the onchain handshake registry. Backs both delivery modes.
       * Establishing it reveals nothing about the sender or the recipient, unlike a `non-interactive-handshake`, but
       * requires the recipient to sign the handshake (served through the {@link ResolveCustomRequest} hook), so the
       * send fails when that request cannot be served.
       */
      type: 'interactive-handshake';
    }
  | {
      /**
       * Derive the secret from the sender's and the recipient's address keys, via Diffie-Hellman. Only backs
       * unconstrained delivery: constrained delivery fails with it. Reveals nothing about the sender or the recipient,
       * and needs no handshake. Anyone able to break either party's address key, for example with a quantum computer,
       * can however compute the secret, unlike that of a `recipient-tsk` one.
       *
       * The recipient only finds the message if their PXE looks for messages from the sender, which it does for its own
       * accounts and for the senders registered with {@link PXE.registerMessagingSecretSource}: the recipient must know
       * to expect messages from the sender.
       */
      type: 'address-derived';
    }
  | {
      /**
       * Derive the secret from the recipient's tagging key, regardless of the sender. Backs both delivery modes.
       * Reveals nothing about the sender or the recipient, even to someone able to break the recipient's address key,
       * for example with a quantum computer, as the tagging key is independent of it.
       *
       * Only usable when {@link MessagingSecretStrategyRequest.recipientTskAvailable} is set, typically for a local
       * account such as the sender itself - the send fails otherwise. Contracts built against an Aztec.nr version that
       * cannot constrain it get a non-interactive handshake for constrained delivery instead.
       */
      type: 'recipient-tsk';
    }
  | {
      /**
       * A raw shared secret point the two parties already share offchain (e.g. coordinated out-of-band), supplied by
       * the wallet. Only backs unconstrained delivery: constrained delivery fails with it, since nothing onchain proves
       * the recipient knows it. Reveals nothing about the sender or the recipient.
       */
      type: 'arbitrary-secret';
      /** The raw (un-siloed) shared secret point to derive the tag from. */
      secret: Point;
    };

/** @deprecated Use {@link MessagingSecretStrategy}. */
export type TaggingSecretStrategy = MessagingSecretStrategy;

/**
 * The strategy PXE applies when no {@link ResolveMessagingSecretStrategy} hook is configured, for a hook to fall back
 * to: `recipient-tsk` when `recipientTskAvailable` is set, and `non-interactive-handshake` otherwise.
 */
export function defaultMessagingSecretStrategy({
  recipientTskAvailable,
}: Pick<MessagingSecretStrategyRequest, 'recipientTskAvailable'>): MessagingSecretStrategy {
  return recipientTskAvailable ? { type: 'recipient-tsk' } : { type: 'non-interactive-handshake' };
}

/** @deprecated Use {@link defaultMessagingSecretStrategy}. */
export const defaultTaggingSecretStrategy = defaultMessagingSecretStrategy;

/** Information about the message delivery requesting a messaging secret strategy. */
export type MessagingSecretStrategyRequest = {
  contractAddress: AztecAddress;
  /**
   * The contract class ID of the executing contract, so wallets can apply class-level (not just per-address) policy.
   */
  contractClassId: Fr;
  sender: AztecAddress;
  recipient: AztecAddress;
  deliveryMode: OnchainDeliveryMode;
  /**
   * Whether PXE holds the recipient's keys and the recipient is in the execution's scopes, which dictates whether the
   * `recipient-tsk` strategy can be used.
   */
  recipientTskAvailable: boolean;
};

/** @deprecated Use {@link MessagingSecretStrategyRequest}. */
export type TaggingSecretStrategyRequest = MessagingSecretStrategyRequest;

/**
 * Hook returning the {@link MessagingSecretStrategy} for an outgoing message.
 *
 * PXE applies the returned strategy to every message without a handshake from the sender to the recipient in the
 * handshake registry, including self-sends, except when the contract chooses the derivation itself. A hook with no
 * policy for some messages can return {@link defaultMessagingSecretStrategy} for them.
 */
export type ResolveMessagingSecretStrategy = (
  request: MessagingSecretStrategyRequest,
) => Promise<MessagingSecretStrategy>;

/** @deprecated Use {@link ResolveMessagingSecretStrategy}. */
export type ResolveTaggingSecretStrategy = ResolveMessagingSecretStrategy;
