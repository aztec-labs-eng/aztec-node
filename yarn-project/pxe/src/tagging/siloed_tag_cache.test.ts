import { asyncMap } from '@aztec-labs/foundation/async-map';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { AztecAddress } from '@aztec-labs/stdlib/aztec-address';
import { MessagingSecret, OnchainDeliveryMode, SiloedTag } from '@aztec-labs/stdlib/logs';
import { randomMessagingSecret } from '@aztec-labs/stdlib/testing';
import { jest } from '@jest/globals';

import { SiloedTagCache } from './siloed_tag_cache.js';

describe('SiloedTagCache', () => {
  let cache: SiloedTagCache;
  let secret: MessagingSecret;

  beforeEach(async () => {
    cache = new SiloedTagCache();
    secret = await randomMessagingSecret(OnchainDeliveryMode.UNCONSTRAINED);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns the tag that SiloedTag.compute does', async () => {
    const preTag = { extendedSecret: secret, index: 3 };

    expect((await cache.compute(preTag)).equals(await SiloedTag.compute(preTag))).toBe(true);
  });

  it('serves a repeated tag without computing it again', async () => {
    const compute = jest.spyOn(SiloedTag, 'compute');

    const first = await cache.compute({ extendedSecret: secret, index: 3 });
    const repeated = await cache.compute({ extendedSecret: secret, index: 3 });

    expect(repeated.equals(first)).toBe(true);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('keeps the tags of one stream at different indexes apart', async () => {
    const atIndex3 = await cache.compute({ extendedSecret: secret, index: 3 });
    const atIndex4 = await cache.compute({ extendedSecret: secret, index: 4 });

    expect(atIndex4.equals(atIndex3)).toBe(false);
  });

  it('keeps the tags of different streams at the same index apart', async () => {
    const streams = [
      secret,
      new MessagingSecret(secret.secret, secret.app, OnchainDeliveryMode.CONSTRAINED),
      new MessagingSecret(secret.secret, await AztecAddress.random(), secret.deliveryMode),
      new MessagingSecret(Fr.random(), secret.app, secret.deliveryMode),
    ];

    const tags = await asyncMap(streams, extendedSecret => cache.compute({ extendedSecret, index: 3 }));

    expect(new Set(tags.map(tag => tag.toString())).size).toBe(streams.length);
  });
});
