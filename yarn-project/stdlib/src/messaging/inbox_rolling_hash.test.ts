import { Fr } from '@aztec-labs/foundation/curves/bn254';

import { accumulateInboxRollingHash, updateInboxRollingHash } from './inbox_rolling_hash.js';

describe('inbox rolling hash', () => {
  // Shared test vectors pinned against the noir `accumulate_inbox_rolling_hash` helper (FI-02). Any divergence here
  // means the L1 / noir / TS rolling hashes would disagree.
  const range = (from: number, to: number) =>
    Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => new Fr(from + i));

  it('chains a single leaf from zero', () => {
    expect(accumulateInboxRollingHash(Fr.ZERO, [new Fr(11)])).toEqual(
      Fr.fromHexString('0x00066dfa22681f66d50aae7d84f190e3555d2d82e4a5e33c2291c3060d441f04'),
    );
  });

  it('chains three leaves from zero', () => {
    expect(accumulateInboxRollingHash(Fr.ZERO, [new Fr(11), new Fr(22), new Fr(33)])).toEqual(
      Fr.fromHexString('0x0077423b713a725ce4bf0b792847c68da87c316d52921de25652756bfe4c3e81'),
    );
  });

  it('chains 256 leaves from zero', () => {
    expect(accumulateInboxRollingHash(Fr.ZERO, range(1, 256))).toEqual(
      Fr.fromHexString('0x0030493fcb5915459bba42f03f283b58dfaa082dac02fbb3a494d5db8063238b'),
    );
  });

  it('chains from a non-zero start', () => {
    expect(accumulateInboxRollingHash(new Fr(0x2a), [new Fr(7), new Fr(8)])).toEqual(
      Fr.fromHexString('0x00a64d14c4b0234f5d835dc202bf8f9a857bc0734baf281dccd4b4978a48b2f9'),
    );
  });

  it('is continuous across segments', () => {
    const start = new Fr(0x2a);
    const mid = updateInboxRollingHash(start, new Fr(7));
    expect(mid).toEqual(Fr.fromHexString('0x0048097cafad7fed00ccb578806b3855d5ee7bf11045fb8d41b2880ba36ef28f'));
    // chain(chain(0x2a, [7]), [8]) == chain(0x2a, [7, 8])
    expect(accumulateInboxRollingHash(mid, [new Fr(8)])).toEqual(
      accumulateInboxRollingHash(start, [new Fr(7), new Fr(8)]),
    );
  });

  it('returns the start unchanged for an empty list', () => {
    const start = new Fr(0x2a);
    expect(accumulateInboxRollingHash(start, [])).toEqual(start);
  });

  // The counts an L1 bucket rollover and a cap-sized checkpoint actually produce. The hash chains one leaf at a
  // time, so where a prefix is cut never changes the result: a 257-message L1 batch split across two buckets and
  // two L2 blocks ends at the same hash as one unsplit run, which is what makes a block's signed prefix reference
  // comparable to a validator's own view however the messages were grouped.
  it.each([0, 1, 255, 256, 257, 1024, 1025])('is split-invariant over %i leaves', count => {
    const leaves = range(1, count);
    const whole = accumulateInboxRollingHash(Fr.ZERO, leaves);

    for (const cut of [0, 1, Math.min(256, count), count]) {
      const prefix = accumulateInboxRollingHash(Fr.ZERO, leaves.slice(0, cut));
      expect(accumulateInboxRollingHash(prefix, leaves.slice(cut))).toEqual(whole);
    }

    // Every prefix is distinct from the whole unless it is the whole, so a short prefix can never pass as a
    // complete one.
    if (count > 0) {
      expect(accumulateInboxRollingHash(Fr.ZERO, leaves.slice(0, count - 1))).not.toEqual(whole);
    } else {
      expect(whole).toEqual(Fr.ZERO);
    }
  });
});
