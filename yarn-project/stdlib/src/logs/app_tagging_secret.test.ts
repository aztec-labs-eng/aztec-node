import { DomainSeparator } from '@aztec-labs/constants';
import { poseidon2Hash } from '@aztec-labs/foundation/crypto/poseidon';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { Point } from '@aztec-labs/foundation/curves/grumpkin';
import { jsonStringify } from '@aztec-labs/foundation/json-rpc';

import { AztecAddress } from '../aztec-address/index.js';
import { CompleteAddress } from '../contract/complete_address.js';
import { computeLogTag, computeSiloedPrivateLogFirstField } from '../hash/hash.js';
import { deriveMasterIncomingViewingSecretKey } from '../keys/derivation.js';
import { randomAppTaggingSecret } from '../tests/factories.js';
import { AppTaggingSecret, AppTaggingSecretSchema, computeSharedTaggingSecret } from './app_tagging_secret.js';
import { OnchainDeliveryMode } from './onchain_delivery_mode.js';
import { SiloedTag } from './siloed_tag.js';
import { TaggingIndexRangeSchema } from './tagging_index_range.js';

describe('AppTaggingSecret', () => {
  describe('TaggingIndexRangeSchema', () => {
    it('preserves the constrained delivery mode when parsing a TaggingIndexRange', async () => {
      const original = await randomAppTaggingSecret(OnchainDeliveryMode.CONSTRAINED);

      const parsed = TaggingIndexRangeSchema.parse({
        extendedSecret: {
          deliveryMode: OnchainDeliveryMode.CONSTRAINED,
          secret: original.secret.toString(),
          app: original.app.toString(),
        },
        lowestIndex: 0,
        highestIndex: 3,
      });

      expect(parsed.extendedSecret).toBeInstanceOf(AppTaggingSecret);
      expect(parsed.extendedSecret.deliveryMode).toBe(OnchainDeliveryMode.CONSTRAINED);
    });

    it('rejects a TaggingIndexRange with no delivery mode', async () => {
      const original = await randomAppTaggingSecret(OnchainDeliveryMode.UNCONSTRAINED);

      expect(() =>
        TaggingIndexRangeSchema.parse({
          extendedSecret: {
            secret: original.secret.toString(),
            app: original.app.toString(),
          },
          lowestIndex: 0,
          highestIndex: 3,
        }),
      ).toThrow();
    });
  });

  describe('AppTaggingSecretSchema', () => {
    it('round-trips a constrained secret through JSON', async () => {
      const original = await randomAppTaggingSecret(OnchainDeliveryMode.CONSTRAINED);

      const parsed = AppTaggingSecretSchema.parse(JSON.parse(jsonStringify(original)));

      expect(parsed).toEqual(original);
    });

    it('round-trips an unconstrained secret through JSON', async () => {
      const original = await randomAppTaggingSecret(OnchainDeliveryMode.UNCONSTRAINED);

      const parsed = AppTaggingSecretSchema.parse(JSON.parse(jsonStringify(original)));

      expect(parsed).toEqual(original);
    });
  });

  describe('computeDirectional', () => {
    it('is a deterministic function of the point, app and recipient', async () => {
      const point = await Point.random();
      const app = await AztecAddress.random();
      const recipient = await AztecAddress.random();

      const a = await AppTaggingSecret.computeDirectional(point, app, recipient);
      const b = await AppTaggingSecret.computeDirectional(point, app, recipient);
      expect(b.secret).toEqual(a.secret);

      const otherApp = await AppTaggingSecret.computeDirectional(point, await AztecAddress.random(), recipient);
      expect(otherApp.secret).not.toEqual(a.secret);

      const otherRecipient = await AppTaggingSecret.computeDirectional(point, app, await AztecAddress.random());
      expect(otherRecipient.secret).not.toEqual(a.secret);
    });

    // Registering a pre-shared tagging secret point directly must yield the same directional secret as the ECDH-derived
    // sender path. Both sides of the Diffie-Hellman exchange compute the same shared point, so a recipient that
    // registers that point discovers exactly the tags a sender would emit.
    it('a directly registered shared point matches the ECDH-derived sender secret', async () => {
      const recipientSecretKey = Fr.random();
      const recipientComplete = await CompleteAddress.fromSecretKeyAndPartialAddress(recipientSecretKey, Fr.random());
      const recipientIvsk = deriveMasterIncomingViewingSecretKey(recipientSecretKey);

      const senderSecretKey = Fr.random();
      const senderComplete = await CompleteAddress.fromSecretKeyAndPartialAddress(senderSecretKey, Fr.random());
      const senderIvsk = deriveMasterIncomingViewingSecretKey(senderSecretKey);

      const app = await AztecAddress.random();

      // The recipient derives the shared point against the sender.
      const pointFromRecipient = await computeSharedTaggingSecret(
        recipientComplete,
        recipientIvsk,
        senderComplete.address,
      );
      // The sender derives the same point against the recipient (Diffie-Hellman symmetry).
      const pointFromSender = await computeSharedTaggingSecret(senderComplete, senderIvsk, recipientComplete.address);

      expect(pointFromRecipient).toBeDefined();
      expect(pointFromSender).toEqual(pointFromRecipient);

      const secretViaEcdh = await AppTaggingSecret.computeDirectional(
        pointFromRecipient!,
        app,
        recipientComplete.address,
      );
      // Registering the shared point directly (bypassing ECDH) derives the identical secret.
      const secretViaRegistration = await AppTaggingSecret.computeDirectional(
        pointFromSender!,
        app,
        recipientComplete.address,
      );

      expect(secretViaRegistration.secret).toEqual(secretViaEcdh.secret);
      expect(secretViaRegistration.app).toEqual(app);
    });
  });

  describe('fromString', () => {
    it('round-trips an unconstrained secret', async () => {
      const original = await randomAppTaggingSecret(OnchainDeliveryMode.UNCONSTRAINED);
      const parsed = AppTaggingSecret.fromString(original.toString());

      expect(parsed).toBeInstanceOf(AppTaggingSecret);
      expect(parsed.deliveryMode).toBe(OnchainDeliveryMode.UNCONSTRAINED);
      expect(parsed.toString()).toBe(original.toString());
    });

    it('round-trips a constrained secret', async () => {
      const original = await randomAppTaggingSecret(OnchainDeliveryMode.CONSTRAINED);
      const parsed = AppTaggingSecret.fromString(original.toString());

      expect(parsed).toBeInstanceOf(AppTaggingSecret);
      expect(parsed.deliveryMode).toBe(OnchainDeliveryMode.CONSTRAINED);
      expect(parsed.toString()).toBe(original.toString());
    });

    it('rejects a string that is not three-part', async () => {
      const original = await randomAppTaggingSecret(OnchainDeliveryMode.UNCONSTRAINED);

      expect(() => AppTaggingSecret.fromString(`${original.secret.toString()}:${original.app.toString()}`)).toThrow(
        /Invalid AppTaggingSecret string/,
      );
    });

    it('rejects unknown delivery mode prefixes', async () => {
      const original = await randomAppTaggingSecret(OnchainDeliveryMode.UNCONSTRAINED);

      expect(() =>
        AppTaggingSecret.fromString(`invalid:${original.secret.toString()}:${original.app.toString()}`),
      ).toThrow(/Invalid AppTaggingSecret delivery mode/);
    });
  });

  describe('SiloedTag.compute', () => {
    it('matches the manual constrained-tag formula for a constrained secret', async () => {
      const secret = await randomAppTaggingSecret(OnchainDeliveryMode.CONSTRAINED);
      const index = 7;

      const computed = await SiloedTag.compute({ extendedSecret: secret, index });

      const expectedInner = await poseidon2Hash([secret.secret, new Fr(index)]);
      const expectedLogTag = await computeLogTag(expectedInner, DomainSeparator.CONSTRAINED_MSG_LOG_TAG);
      const expectedSiloed = await computeSiloedPrivateLogFirstField(secret.app, expectedLogTag);

      expect(computed.value.toString()).toEqual(expectedSiloed.toString());
    });

    it('matches the unconstrained-tag formula for an unconstrained secret', async () => {
      const secret = await randomAppTaggingSecret(OnchainDeliveryMode.UNCONSTRAINED);
      const index = 7;

      const computed = await SiloedTag.compute({ extendedSecret: secret, index });

      const expectedInner = await poseidon2Hash([secret.secret, new Fr(index)]);
      const expectedLogTag = await computeLogTag(expectedInner, DomainSeparator.UNCONSTRAINED_MSG_LOG_TAG);
      const expectedSiloed = await computeSiloedPrivateLogFirstField(secret.app, expectedLogTag);

      expect(computed.value.toString()).toEqual(expectedSiloed.toString());
    });

    it('produces different tags for the two flavors even when the underlying Fr matches', async () => {
      const constrained = await randomAppTaggingSecret(OnchainDeliveryMode.CONSTRAINED);
      const unconstrained = new AppTaggingSecret(constrained.secret, constrained.app);

      const unconstrainedTag = await SiloedTag.compute({ extendedSecret: unconstrained, index: 0 });
      const constrainedTag = await SiloedTag.compute({ extendedSecret: constrained, index: 0 });

      expect(unconstrainedTag.value.toString()).not.toEqual(constrainedTag.value.toString());
    });
  });
});
