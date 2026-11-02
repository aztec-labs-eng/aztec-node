import { Grumpkin } from '@aztec-labs/foundation/crypto/grumpkin';
import { poseidon2Hash } from '@aztec-labs/foundation/crypto/poseidon';
import { type Fq, Fr } from '@aztec-labs/foundation/curves/bn254';
import type { Point } from '@aztec-labs/foundation/curves/grumpkin';
import { z } from 'zod';

import { AztecAddress } from '../aztec-address/index.js';
import type { CompleteAddress } from '../contract/complete_address.js';
import { computeAddressSecret, computePreaddress } from '../keys/derivation.js';
import { OnchainDeliveryMode } from './onchain_delivery_mode.js';
import { computeAppSiloedSharedSecretFromPoint } from './shared_secret_derivation.js';

const OnchainDeliveryModeSchema = z.union([
  z.literal(OnchainDeliveryMode.UNCONSTRAINED),
  z.literal(OnchainDeliveryMode.CONSTRAINED),
]);

/**
 * Application tagging secret used for log tagging.
 *
 * It bundles a secret siloed to an app contract with the delivery mode whose tag stream it backs. Each way of deriving
 * the secret has one constructor, so that the sending and the receiving side agree on it:
 * {@link computeAddressDerived}, {@link computeFromArbitrarySecret} and {@link computeFromHandshakeSecret}. Only the
 * receiving side derives a handshake secret, as the sender gets the app-siloed secret from the handshake registry.
 *
 * Secrets that arrive already derived, such as those supplied by a contract, are wrapped with the class constructor.
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
