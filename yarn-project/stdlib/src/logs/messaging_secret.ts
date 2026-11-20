import { DomainSeparator } from '@aztec-labs/constants';
import { poseidon2Hash, poseidon2HashWithSeparator } from '@aztec-labs/foundation/crypto/poseidon';
import { type Fq, Fr } from '@aztec-labs/foundation/curves/bn254';
import type { GrumpkinScalar, Point } from '@aztec-labs/foundation/curves/grumpkin';
import { z } from 'zod';

import { AztecAddress } from '../aztec-address/index.js';
import type { CompleteAddress } from '../contract/complete_address.js';
import { computeAppTaggingSecretKey } from '../keys/derivation.js';
import type { PublicKey } from '../keys/public_key.js';
import { OnchainDeliveryMode } from './onchain_delivery_mode.js';
import { computeAddressDerivedSharedSecretPoint, deriveEcdhSharedSecretPoint } from './shared_secret_derivation.js';

const OnchainDeliveryModeSchema = z.union([
  z.literal(OnchainDeliveryMode.UNCONSTRAINED),
  z.literal(OnchainDeliveryMode.CONSTRAINED),
]);

/** Domain separator for the recipient tsk secret. Mirrors the separator of the same name in aztec-nr. */
const DOM_SEP__RECIPIENT_TSK_SECRET = 1256167324;

/**
 * Domain separator for the messaging secrets computed from hybrid shared secrets. Mirrors the separator of the same
 * name in aztec-nr.
 */
const DOM_SEP__HYBRID_MESSAGING_SECRET = 3760126800;

/**
 * Messaging secret used for log tagging and message encryption.
 *
 * It bundles a secret siloed to an app contract with the delivery mode whose tag stream it backs. Each way of deriving
 * the secret has one constructor, so that the sending and the receiving side agree on it:
 * {@link computeAddressDerived}, {@link computeFromRecipientTsk}, {@link computeFromArbitrarySecret} and
 * {@link computeFromHandshakeSecret}. Only the receiving side derives a handshake secret, as the sender gets the
 * app-siloed secret from the handshake registry.
 *
 * Secrets that arrive already derived, such as those supplied by a contract, are wrapped with the class constructor.
 *
 * ## From raw secret to messaging secret
 *
 * Every mechanism starts from a raw secret that apps never see, and silos it to an app so that an app can only compute
 * its own tags. Shared secret points are siloed with {@link computeMessagingSecretFromPoint}, hybrid shared secrets
 * with {@link computeHybridMessagingSecret}, and the recipient's tagging secret key with
 * {@link computeAppTaggingSecretKey}.
 *
 * Siloing is what keeps contracts apart. A contract asks the PXE for a secret with public inputs only, such as an
 * address and an ephemeral public key, so without siloing any contract could get the secret another contract gets,
 * find that contract's tagged logs and decrypt its messages. For the same reason, a contract cannot request the
 * messaging secrets of another contract: that would need a way for a contract to allow trusted contracts to do so.
 *
 * - **Address-derived** ({@link computeAddressDerived}): the raw secret is the ECDH exchange between the sender's and
 *   the recipient's addresses, which either of them can compute. It is app-siloed and directed to `recipient`. It only
 *   backs unconstrained delivery.
 * - **Arbitrary secret** ({@link computeFromArbitrarySecret}): the raw secret is a point the two parties agreed on
 *   themselves. It is app-siloed and directed to `recipient`. It only backs unconstrained delivery.
 * - **Handshake** ({@link computeFromHandshakeSecret}): the raw secret is the point the handshake registry stores for
 *   the pair. It is app-siloed, and backs both delivery modes.
 * - **Recipient tsk** ({@link computeFromRecipientTsk}): the raw secret is the recipient's master tagging secret key
 *   `tsk_m`. It is app-siloed into `tsk_app` and hashed with `recipient`'s address, and backs both delivery modes.
 *
 * ## From messaging secret to tag
 *
 * Each log uses the next `index` of the stream of its secret, app and delivery mode. In the formulas below `h` is
 * poseidon2, and a leading `DOM_SEP__` input is its domain separator:
 *
 * ```
 * rawTag    = h(secret, index)
 * logTag    = h(DOM_SEP__UNCONSTRAINED_MSG_LOG_TAG, rawTag)   // or DOM_SEP__CONSTRAINED_MSG_LOG_TAG
 * siloedTag = h(DOM_SEP__PRIVATE_LOG_FIRST_FIELD, app, logTag)
 * ```
 *
 * The first two are computed by the contract and the last one by the kernel, and `siloedTag` is what appears onchain.
 *
 * The separator depends on the delivery mode because a handshake or recipient tsk secret backs both, each with its own
 * index sequence. Mechanisms need no separators of their own at this step, as different derivations already yield
 * different secrets.
 */
export class MessagingSecret {
  constructor(
    public readonly secret: Fr,
    public readonly app: AztecAddress,
    public readonly deliveryMode: OnchainDeliveryMode,
  ) {}

  /**
   * Derives the messaging secret for an arbitrary shared secret point.
   *
   * @param sharedSecretPoint - The shared secret point
   * @param app - Contract address to silo the secret to
   * @param recipient - Recipient of the log. Defines the "direction of the secret".
   * @returns The secret that can be used along with an index to compute a tag to be included in a log.
   */
  static computeFromArbitrarySecret(
    sharedSecretPoint: Point,
    app: AztecAddress,
    recipient: AztecAddress,
  ): Promise<MessagingSecret> {
    return MessagingSecret.#computeDirectional(sharedSecretPoint, app, recipient);
  }

  /**
   * Derives the messaging secret for a handshake's shared secret point.
   *
   * The secret is the bare value from {@link computeMessagingSecretFromPoint}, under the given delivery mode.
   */
  static async computeFromHandshakeSecret(
    sharedSecretPoint: Point,
    app: AztecAddress,
    deliveryMode: OnchainDeliveryMode,
  ): Promise<MessagingSecret> {
    return new MessagingSecret(await computeMessagingSecretFromPoint(sharedSecretPoint, app), app, deliveryMode);
  }

  /**
   * Derives the messaging secret two addresses share through ECDH.
   *
   * Each party derives the same secret using its own keys as the local side of the exchange.
   *
   * @returns The secret, or undefined if `externalAddress` is not a valid address.
   */
  static async computeAddressDerived({
    localAddress,
    localIvsk,
    externalAddress,
    app,
    recipient,
  }: {
    /** The party whose keys are used for the exchange. */
    localAddress: CompleteAddress;
    /** The master incoming viewing secret key of `localAddress`. */
    localIvsk: Fq;
    /** The other party of the exchange. */
    externalAddress: AztecAddress;
    /** Contract address to silo the secret to. */
    app: AztecAddress;
    /** Recipient of the log, which is one of the two parties. Defines the "direction of the secret". */
    recipient: AztecAddress;
  }): Promise<MessagingSecret | undefined> {
    const sharedSecretPoint = await computeAddressDerivedSharedSecretPoint(localAddress, localIvsk, externalAddress);
    if (!sharedSecretPoint) {
      return undefined;
    }

    return MessagingSecret.#computeDirectional(sharedSecretPoint, app, recipient);
  }

  /**
   * Derives the messaging secret from the recipient's tagging secret key.
   *
   * The secret is the recipient's app-siloed tagging key hashed with their address, under the given delivery mode.
   * Hashing in the address gives accounts that share a tagging key separate tag streams.
   */
  static async computeFromRecipientTsk(
    recipientTsk: Fq,
    app: AztecAddress,
    recipient: AztecAddress,
    deliveryMode: OnchainDeliveryMode,
  ): Promise<MessagingSecret> {
    const tskApp = await computeAppTaggingSecretKey(recipientTsk, app);
    const secret = await poseidon2HashWithSeparator([tskApp, recipient], DOM_SEP__RECIPIENT_TSK_SECRET);

    return new MessagingSecret(secret, app, deliveryMode);
  }

  toString(): string {
    return `${this.deliveryMode}:${this.secret.toString()}:${this.app.toString()}`;
  }

  static fromString(str: string): MessagingSecret {
    const parts = str.split(':');
    if (parts.length !== 3) {
      throw new Error(`Invalid MessagingSecret string: ${str}`);
    }
    const [deliveryModeStr, secretStr, appStr] = parts;
    return new MessagingSecret(
      Fr.fromString(secretStr),
      AztecAddress.fromStringUnsafe(appStr),
      onchainDeliveryModeFromString(deliveryModeStr),
    );
  }

  /**
   * App-silos a shared secret point via {@link computeMessagingSecretFromPoint}, then directs the result to
   * `recipient`: `h([messagingSecret, recipient])`. The directional step stops a symmetric shared secret from
   * colliding bidirectionally, so two parties never share a tag sequence.
   */
  static async #computeDirectional(
    sharedSecretPoint: Point,
    app: AztecAddress,
    recipient: AztecAddress,
  ): Promise<MessagingSecret> {
    const messagingSecret = await computeMessagingSecretFromPoint(sharedSecretPoint, app);
    const directionalMessagingSecret = await poseidon2Hash([messagingSecret, recipient]);

    return new MessagingSecret(directionalMessagingSecret, app, OnchainDeliveryMode.UNCONSTRAINED);
  }
}

/** @deprecated Use {@link MessagingSecret}. */
export const AppTaggingSecret = MessagingSecret;
/** @deprecated Use {@link MessagingSecret}. */
export type AppTaggingSecret = MessagingSecret;

/**
 * Parses a stored `MessagingSecret` string key.
 */
export function messagingSecretFromString(str: string): MessagingSecret {
  return MessagingSecret.fromString(str);
}

/** @deprecated Use {@link messagingSecretFromString}. */
export const appTaggingSecretFromString = messagingSecretFromString;

export const MessagingSecretSchema = z
  .object({
    deliveryMode: OnchainDeliveryModeSchema,
    secret: Fr.schema,
    app: AztecAddress.schema,
  })
  .transform(({ deliveryMode, secret, app }) => new MessagingSecret(secret, app, deliveryMode));

/** @deprecated Use {@link MessagingSecretSchema}. */
export const AppTaggingSecretSchema = MessagingSecretSchema;

function onchainDeliveryModeFromString(deliveryMode: string): OnchainDeliveryMode {
  switch (deliveryMode) {
    case OnchainDeliveryMode.CONSTRAINED:
      return OnchainDeliveryMode.CONSTRAINED;
    case OnchainDeliveryMode.UNCONSTRAINED:
      return OnchainDeliveryMode.UNCONSTRAINED;
    default:
      throw new Error(`Invalid MessagingSecret delivery mode: ${deliveryMode}`);
  }
}

/**
 * Derives the messaging secret of an ECDH exchange: ECDHs `S = secretKey * publicKey` via
 * {@link deriveEcdhSharedSecretPoint}, then app-silos it via {@link computeMessagingSecretFromPoint}.
 *
 * @param secretKey - The secret key used to derive shared secret.
 * @param publicKey - The public key used to derive shared secret.
 * @param contractAddress - The address of the calling contract, used for app-siloing.
 * @returns The messaging secret as a Field.
 * @throws If the publicKey is zero.
 */
export async function computeEcdhMessagingSecret(
  secretKey: GrumpkinScalar,
  publicKey: PublicKey,
  contractAddress: AztecAddress,
): Promise<Fr> {
  const rawSharedSecret = await deriveEcdhSharedSecretPoint(secretKey, publicKey);
  return computeMessagingSecretFromPoint(rawSharedSecret, contractAddress);
}

/** @deprecated Use {@link computeEcdhMessagingSecret}. */
export const appSiloEcdhSharedSecret = computeEcdhMessagingSecret;

/**
 * Computes a shared secret point's messaging secret by app-siloing it:
 * `h(DOM_SEP__APP_SILOED_ECDH_SHARED_SECRET, S.x, S.y, app)`.
 *
 * Mirrors `compute_messaging_secret_from_point` in aztec-nr.
 *
 * @param point - The raw shared secret point `S`.
 * @param app - The contract address to silo to.
 */
export function computeMessagingSecretFromPoint(point: Point, app: AztecAddress): Promise<Fr> {
  // The separator name is ECDH-specific, but this silos any shared secret point, not only ECDH ones.
  return poseidon2HashWithSeparator([point.x, point.y, app], DomainSeparator.APP_SILOED_ECDH_SHARED_SECRET);
}

/** @deprecated Use {@link computeMessagingSecretFromPoint}. */
export const computeAppSiloedSharedSecretFromPoint = computeMessagingSecretFromPoint;

/** @deprecated Use {@link computeMessagingSecretFromPoint}. */
export const appSiloEcdhSharedSecretPoint = computeMessagingSecretFromPoint;

/**
 * Computes a hybrid shared secret's messaging secret by app-siloing it:
 * `h(DOM_SEP__HYBRID_MESSAGING_SECRET, hybridSharedSecret, app)`.
 *
 * Mirrors `compute_hybrid_messaging_secret` in aztec-nr.
 */
export function computeHybridMessagingSecret(hybridSharedSecret: Fr, app: AztecAddress): Promise<Fr> {
  return poseidon2HashWithSeparator([hybridSharedSecret, app], DOM_SEP__HYBRID_MESSAGING_SECRET);
}
