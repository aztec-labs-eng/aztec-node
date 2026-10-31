import { DomainSeparator } from '@aztec-labs/constants';
import { Grumpkin } from '@aztec-labs/foundation/crypto/grumpkin';
import { poseidon2Hash } from '@aztec-labs/foundation/crypto/poseidon';
import { type Fq, Fr } from '@aztec-labs/foundation/curves/bn254';
import { Point } from '@aztec-labs/foundation/curves/grumpkin';
import { jsonStringify } from '@aztec-labs/foundation/json-rpc';

import { AztecAddress } from '../aztec-address/index.js';
import { CompleteAddress } from '../contract/complete_address.js';
import { computeLogTag, computeSiloedPrivateLogFirstField } from '../hash/hash.js';
import { deriveMasterIncomingViewingSecretKey } from '../keys/derivation.js';
import { makeInvalidAztecAddress, randomAppTaggingSecret } from '../tests/factories.js';
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

  // Tags are computed from these secrets, so a changed value stops PXE from finding messages that were already sent.
  describe('pinned secret values', () => {
    const app = AztecAddress.fromNumberUnsafe(42);

    it('keeps the address-derived secret in both directions', async () => {
      const aliceSecretKey = new Fr(1);
      const alice = await CompleteAddress.fromSecretKeyAndPartialAddress(aliceSecretKey, new Fr(2));
      const bobSecretKey = new Fr(3);
      const bob = await CompleteAddress.fromSecretKeyAndPartialAddress(bobSecretKey, new Fr(4));

      const toBob = await AppTaggingSecret.computeAddressDerived({
        localAddress: alice,
        localIvsk: deriveMasterIncomingViewingSecretKey(aliceSecretKey),
        externalAddress: bob.address,
        app,
        recipient: bob.address,
      });
      const toAlice = await AppTaggingSecret.computeAddressDerived({
        localAddress: bob,
        localIvsk: deriveMasterIncomingViewingSecretKey(bobSecretKey),
        externalAddress: alice.address,
        app,
        recipient: alice.address,
      });

      expect(toBob).toEqual(
        new AppTaggingSecret(
          Fr.fromString('0x1d459a547ae9f4f9722f87f546f68f95c39f8a8d5e39b1c74987861f022d8996'),
          app,
          OnchainDeliveryMode.UNCONSTRAINED,
        ),
      );
      expect(toAlice).toEqual(
        new AppTaggingSecret(
          Fr.fromString('0x13248ff9c26fb866d1e19fb9751a63de581e3da206ad9852fb7adeb8a778f272'),
          app,
          OnchainDeliveryMode.UNCONSTRAINED,
        ),
      );
    });

    it('keeps the arbitrary secret in both directions', async () => {
      const alice = AztecAddress.fromNumberUnsafe(43);
      const bob = AztecAddress.fromNumberUnsafe(44);

      const toAlice = await AppTaggingSecret.computeFromArbitrarySecret(Grumpkin.generator, app, alice);
      const toBob = await AppTaggingSecret.computeFromArbitrarySecret(Grumpkin.generator, app, bob);

      expect(toAlice).toEqual(
        new AppTaggingSecret(
          Fr.fromString('0x13dab2df9c5620bf35513fd9507f3e1fde9e3216f9aaf8f81e63a734100001e2'),
          app,
          OnchainDeliveryMode.UNCONSTRAINED,
        ),
      );
      expect(toBob).toEqual(
        new AppTaggingSecret(
          Fr.fromString('0x058478bb8005f81e295a50ff31f199b9823d5c2dbd2ba7d4bdd45a6103baae25'),
          app,
          OnchainDeliveryMode.UNCONSTRAINED,
        ),
      );
    });

    it.each([OnchainDeliveryMode.UNCONSTRAINED, OnchainDeliveryMode.CONSTRAINED])(
      'keeps the handshake secret under %s delivery',
      async deliveryMode => {
        const secret = await AppTaggingSecret.computeFromHandshakeSecret(Grumpkin.generator, app, deliveryMode);

        expect(secret).toEqual(
          new AppTaggingSecret(
            Fr.fromString('0x1468ba5a8215f9b6144892815d1e629017837b65534223792f1840485f5aff80'),
            app,
            deliveryMode,
          ),
        );
      },
    );
  });

  describe('computeFromArbitrarySecret', () => {
    it('is a deterministic function of the point, app and recipient', async () => {
      const point = await Point.random();
      const app = await AztecAddress.random();
      const recipient = await AztecAddress.random();

      const a = await AppTaggingSecret.computeFromArbitrarySecret(point, app, recipient);
      const b = await AppTaggingSecret.computeFromArbitrarySecret(point, app, recipient);
      expect(b.secret).toEqual(a.secret);

      const otherApp = await AppTaggingSecret.computeFromArbitrarySecret(point, await AztecAddress.random(), recipient);
      expect(otherApp.secret).not.toEqual(a.secret);

      const otherRecipient = await AppTaggingSecret.computeFromArbitrarySecret(point, app, await AztecAddress.random());
      expect(otherRecipient.secret).not.toEqual(a.secret);
    });
  });

  describe('computeAddressDerived', () => {
    let app: AztecAddress;
    let sender: CompleteAddress;
    let senderIvsk: Fq;
    let recipient: CompleteAddress;
    let recipientIvsk: Fq;

    beforeEach(async () => {
      app = await AztecAddress.random();

      const senderSecretKey = Fr.random();
      sender = await CompleteAddress.fromSecretKeyAndPartialAddress(senderSecretKey, Fr.random());
      senderIvsk = deriveMasterIncomingViewingSecretKey(senderSecretKey);

      const recipientSecretKey = Fr.random();
      recipient = await CompleteAddress.fromSecretKeyAndPartialAddress(recipientSecretKey, Fr.random());
      recipientIvsk = deriveMasterIncomingViewingSecretKey(recipientSecretKey);
    });

    it('derives the same secret on the sending and the receiving side', async () => {
      const onSendingSide = await AppTaggingSecret.computeAddressDerived({
        localAddress: sender,
        localIvsk: senderIvsk,
        externalAddress: recipient.address,
        app,
        recipient: recipient.address,
      });
      const onReceivingSide = await AppTaggingSecret.computeAddressDerived({
        localAddress: recipient,
        localIvsk: recipientIvsk,
        externalAddress: sender.address,
        app,
        recipient: recipient.address,
      });

      expect(onSendingSide).toBeDefined();
      expect(onReceivingSide).toEqual(onSendingSide);
    });

    it('derives a different secret for each direction', async () => {
      const toRecipient = await AppTaggingSecret.computeAddressDerived({
        localAddress: sender,
        localIvsk: senderIvsk,
        externalAddress: recipient.address,
        app,
        recipient: recipient.address,
      });
      const toSender = await AppTaggingSecret.computeAddressDerived({
        localAddress: sender,
        localIvsk: senderIvsk,
        externalAddress: recipient.address,
        app,
        recipient: sender.address,
      });

      expect(toRecipient!.secret).not.toEqual(toSender!.secret);
    });

    // Registering a pre-shared tagging secret point directly must yield the same directional secret as the ECDH-derived
    // sender path. Both sides of the Diffie-Hellman exchange compute the same shared point, so a recipient that
    // registers that point discovers exactly the tags a sender would emit.
    it('a directly registered shared point matches the ECDH-derived sender secret', async () => {
      const pointFromRecipient = await computeSharedTaggingSecret(recipient, recipientIvsk, sender.address);

      const secretViaEcdh = await AppTaggingSecret.computeAddressDerived({
        localAddress: sender,
        localIvsk: senderIvsk,
        externalAddress: recipient.address,
        app,
        recipient: recipient.address,
      });
      const secretViaRegistration = await AppTaggingSecret.computeFromArbitrarySecret(
        pointFromRecipient!,
        app,
        recipient.address,
      );

      expect(secretViaRegistration).toEqual(secretViaEcdh);
    });

    it('returns undefined for an invalid external address', async () => {
      const invalidAddress = makeInvalidAztecAddress();

      const secret = await AppTaggingSecret.computeAddressDerived({
        localAddress: sender,
        localIvsk: senderIvsk,
        externalAddress: invalidAddress,
        app,
        recipient: invalidAddress,
      });

      expect(secret).toBeUndefined();
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
      const unconstrained = new AppTaggingSecret(
        constrained.secret,
        constrained.app,
        OnchainDeliveryMode.UNCONSTRAINED,
      );

      const unconstrainedTag = await SiloedTag.compute({ extendedSecret: unconstrained, index: 0 });
      const constrainedTag = await SiloedTag.compute({ extendedSecret: constrained, index: 0 });

      expect(unconstrainedTag.value.toString()).not.toEqual(constrainedTag.value.toString());
    });
  });
});
