import { Grumpkin } from '@aztec-labs/foundation/crypto/grumpkin';
import { poseidon2Hash, poseidon2HashWithSeparator } from '@aztec-labs/foundation/crypto/poseidon';
import { type Fq, Fr } from '@aztec-labs/foundation/curves/bn254';
import type { Point } from '@aztec-labs/foundation/curves/grumpkin';
import { z } from 'zod';

import { AztecAddress } from '../aztec-address/index.js';
import type { CompleteAddress } from '../contract/complete_address.js';
import { computeAddressSecret, computeAppTaggingSecretKey, computePreaddress } from '../keys/derivation.js';
import { OnchainDeliveryMode } from './onchain_delivery_mode.js';
import { computeAppSiloedSharedSecretFromPoint } from './shared_secret_derivation.js';

const OnchainDeliveryModeSchema = z.union([
  z.literal(OnchainDeliveryMode.UNCONSTRAINED),
  z.literal(OnchainDeliveryMode.CONSTRAINED),
]);

/** Domain separator for the recipient tsk secret. Mirrors the separator of the same name in aztec-nr. */
const DOM_SEP__RECIPIENT_TSK_SECRET = 1256167324;

/**
 * Application tagging secret used for log tagging.
 *
 * It bundles a secret siloed to an app contract with the delivery mode whose tag stream it backs. Each way of deriving
 * the secret has one constructor, so that the sending and the receiving side agree on it:
 * {@link computeAddressDerived}, {@link computeFromRecipientTsk}, {@link computeFromArbitrarySecret} and
 * {@link computeFromHandshakeSecret}. Only the receiving side derives a handshake secret, as the sender gets the
 * app-siloed secret from the handshake registry.
 *
 * Secrets that arrive already derived, such as those supplied by a contract, are wrapped with the class constructor.
 *
 * ## From raw secret to app tagging secret
 *
 * Every mechanism starts from a raw secret that apps never see, and silos it to an app so that an app can only compute
 * its own tags. Shared secret points are siloed with {@link computeAppSiloedSharedSecretFromPoint}, and the recipient's
 * tagging secret key with {@link computeAppTaggingSecretKey}.
 *
 * - **Address-derived** ({@link computeAddressDerived}): the raw secret is the ECDH exchange between the sender's and
 *   the recipient's addresses, which either of them can compute. It is app-siloed and directed to `recipient`. It only
 *   backs unconstrained delivery.
 * - **Arbitrary secret** ({@link computeFromArbitrarySecret}): the raw secret is a point the two parties agreed on
 *   themselves. It is app-siloed and directed to `recipient`. It only backs unconstrained delivery.
 * - **Handshake** ({@link computeFromHandshakeSecret}): the raw secret is the point the handshake registry stores for
 *   the pair. It is app-siloed, and backs both delivery modes. The registry validates it, by recomputing the app-siloed
 *   secret from the point for the calling contract.
 * - **Recipient tsk** ({@link computeFromRecipientTsk}): the raw secret is the recipient's master tagging secret key
 *   `tsk_m`. It is app-siloed into `tsk_app` and directed to `recipient`. It only backs unconstrained delivery. The
 *   kernel can validate `tsk_app`, by recomputing it from `tsk_m` for the calling contract.
 *
 * ## From app tagging secret to tag
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
 * The separator depends on the delivery mode because a handshake secret backs both, each with its own index sequence.
 * Mechanisms need no separators of their own at this step, as different derivations already yield different secrets.
 */
export class AppTaggingSecret {
  constructor(
    public readonly secret: Fr,
    public readonly app: AztecAddress,
    public readonly deliveryMode: OnchainDeliveryMode,
  ) {}

  /**
   * Derives the tagging secret for an arbitrary shared secret point.
   *
   * The secret is app-siloed and directed to `recipient`, for unconstrained delivery. The sender and the recipient
   * agree on the point themselves.
   *
   * @param taggingSecretPoint - The shared secret point
   * @param app - Contract address to silo the secret to
   * @param recipient - Recipient of the log. Defines the "direction of the secret".
   * @returns The secret that can be used along with an index to compute a tag to be included in a log.
   */
  static computeFromArbitrarySecret(
    taggingSecretPoint: Point,
    app: AztecAddress,
    recipient: AztecAddress,
  ): Promise<AppTaggingSecret> {
    return AppTaggingSecret.#computeDirectional(taggingSecretPoint, app, recipient);
  }

  /**
   * Derives the tagging secret for a handshake's shared secret point.
   *
   * The secret is the bare app-siloed value from {@link computeAppSiloedSharedSecretFromPoint}, under the given
   * delivery mode.
   */
  static async computeFromHandshakeSecret(
    taggingSecretPoint: Point,
    app: AztecAddress,
    deliveryMode: OnchainDeliveryMode,
  ): Promise<AppTaggingSecret> {
    return new AppTaggingSecret(
      await computeAppSiloedSharedSecretFromPoint(taggingSecretPoint, app),
      app,
      deliveryMode,
    );
  }

  /**
   * Derives the tagging secret two addresses share through ECDH.
   *
   * The secret is app-siloed and directed to `recipient`, for unconstrained delivery. Each party derives the same
   * secret using its own keys as the local side of the exchange.
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
  }): Promise<AppTaggingSecret | undefined> {
    const taggingSecretPoint = await computeSharedTaggingSecret(localAddress, localIvsk, externalAddress);
    if (!taggingSecretPoint) {
      return undefined;
    }

    return AppTaggingSecret.#computeDirectional(taggingSecretPoint, app, recipient);
  }

  /**
   * Derives the tagging secret from the recipient's tagging secret key.
   *
   * The secret is the recipient's app-siloed tagging key hashed with their address, for unconstrained delivery. Hashing
   * in the address gives accounts that share a tagging key separate tag streams. The secret is a property of the
   * recipient alone, so whoever sends the log has to know `recipientTsk`, and the recipient finds the log without
   * knowing who sent it.
   */
  static async computeFromRecipientTsk(
    recipientTsk: Fq,
    app: AztecAddress,
    recipient: AztecAddress,
  ): Promise<AppTaggingSecret> {
    const tskApp = await computeAppTaggingSecretKey(recipientTsk, app);
    const secret = await poseidon2HashWithSeparator([tskApp, recipient], DOM_SEP__RECIPIENT_TSK_SECRET);

    return new AppTaggingSecret(secret, app, OnchainDeliveryMode.UNCONSTRAINED);
  }

  toString(): string {
    return `${this.deliveryMode}:${this.secret.toString()}:${this.app.toString()}`;
  }

  static fromString(str: string): AppTaggingSecret {
    const parts = str.split(':');
    if (parts.length !== 3) {
      throw new Error(`Invalid AppTaggingSecret string: ${str}`);
    }
    const [deliveryModeStr, secretStr, appStr] = parts;
    return new AppTaggingSecret(
      Fr.fromString(secretStr),
      AztecAddress.fromStringUnsafe(appStr),
      onchainDeliveryModeFromString(deliveryModeStr),
    );
  }

  /**
   * App-silos a shared secret point via {@link computeAppSiloedSharedSecretFromPoint}, then directs the result to
   * `recipient`: `h([s_app, recipient])`. The directional step stops a symmetric shared secret from colliding
   * bidirectionally, so two parties never share a tag sequence.
   */
  static async #computeDirectional(
    taggingSecretPoint: Point,
    app: AztecAddress,
    recipient: AztecAddress,
  ): Promise<AppTaggingSecret> {
    const appSiloedSecret = await computeAppSiloedSharedSecretFromPoint(taggingSecretPoint, app);
    const directionalAppTaggingSecret = await poseidon2Hash([appSiloedSecret, recipient]);

    return new AppTaggingSecret(directionalAppTaggingSecret, app, OnchainDeliveryMode.UNCONSTRAINED);
  }
}

/**
 * Parses a stored `AppTaggingSecret` string key.
 */
export function appTaggingSecretFromString(str: string): AppTaggingSecret {
  return AppTaggingSecret.fromString(str);
}

export const AppTaggingSecretSchema = z
  .object({
    deliveryMode: OnchainDeliveryModeSchema,
    secret: Fr.schema,
    app: AztecAddress.schema,
  })
  .transform(({ deliveryMode, secret, app }) => new AppTaggingSecret(secret, app, deliveryMode));

function onchainDeliveryModeFromString(deliveryMode: string): OnchainDeliveryMode {
  switch (deliveryMode) {
    case OnchainDeliveryMode.CONSTRAINED:
      return OnchainDeliveryMode.CONSTRAINED;
    case OnchainDeliveryMode.UNCONSTRAINED:
      return OnchainDeliveryMode.UNCONSTRAINED;
    default:
      throw new Error(`Invalid AppTaggingSecret delivery mode: ${deliveryMode}`);
  }
}

/**
 * Computes the shared tagging secret point between a local address (i.e. one for which the privacy keys are known) and
 * an external one via a Diffie-Hellman key exchange.
 *
 * Returns undefined if `externalAddress` is an invalid address.
 */
export async function computeSharedTaggingSecret(
  localAddress: CompleteAddress,
  localIvsk: Fq,
  externalAddress: AztecAddress,
): Promise<Point | undefined> {
  // An invalid address has no corresponding address point
  if (!(await externalAddress.isValid())) {
    return undefined;
  }

  const externalAddressPoint = await externalAddress.toAddressPoint();

  const localPreaddress = await computePreaddress(await localAddress.publicKeys.hash(), localAddress.partialAddress);
  const localAddressSecret = await computeAddressSecret(localPreaddress, localIvsk);

  // For a given local address A and external address B, the shared tagging secret S is (h_A + ivsk_A) * Addr_Point_B
  // (conceptually, in reality we don't use h_A + ivsk_A directly but rather the actual address secret, which is the
  // same but with an optional sign adjustment to prevent A's address point from having a negative y-coordinate).
  return Grumpkin.mul(externalAddressPoint, localAddressSecret);
}
