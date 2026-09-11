#!/usr/bin/env -S node --experimental-strip-types --no-warnings --test
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { isNightlyTag } from "./devnet_utils.ts";

describe("isNightlyTag", () => {
  it("accepts the canonical tag the nightly schedule cuts", () => {
    assert.equal(isNightlyTag("v4.0.0-nightly.20260209"), true);
    assert.equal(isNightlyTag("v10.11.12-nightly.20260209"), true);
  });

  it("accepts a manually dispatched nightly's suffix", () => {
    assert.equal(isNightlyTag("v4.0.0-nightly.20260209.hotfix"), true);
    assert.equal(isNightlyTag("v4.0.0-nightly.20260209.rerun-2"), true);
    assert.equal(isNightlyTag("v4.0.0-nightly.20260209.a1"), true);
  });

  it("rejects a suffix the release-tag workflow would not have produced", () => {
    assert.equal(isNightlyTag("v4.0.0-nightly.20260209.HOTFIX"), false);
    assert.equal(isNightlyTag("v4.0.0-nightly.20260209.hot_fix"), false);
    assert.equal(isNightlyTag("v4.0.0-nightly.20260209.2nd"), false);
    assert.equal(isNightlyTag("v4.0.0-nightly.20260209.a.b"), false);
    assert.equal(isNightlyTag("v4.0.0-nightly.20260209.hot fix"), false);
  });

  it("rejects an empty suffix", () => {
    assert.equal(isNightlyTag("v4.0.0-nightly.20260209."), false);
  });

  it("rejects a malformed date", () => {
    assert.equal(isNightlyTag("v4.0.0-nightly.2026029"), false);
    assert.equal(isNightlyTag("v4.0.0-nightly.202602099"), false);
    assert.equal(isNightlyTag("v4.0.0-nightly.2026-02-09"), false);
    assert.equal(isNightlyTag("v4.0.0-nightly."), false);
    assert.equal(isNightlyTag("v4.0.0-nightly"), false);
  });

  it("rejects tags from the other release channels", () => {
    assert.equal(isNightlyTag("v4.0.0"), false);
    assert.equal(isNightlyTag("v4.0.0-rc.1"), false);
    assert.equal(isNightlyTag("v4.0.0-devnet.6-patch.0"), false);
    assert.equal(isNightlyTag("4.0.0-nightly.20260209"), false);
  });

  it("is anchored at both ends", () => {
    assert.equal(isNightlyTag(" v4.0.0-nightly.20260209"), false);
    assert.equal(isNightlyTag("xv4.0.0-nightly.20260209"), false);
    assert.equal(isNightlyTag("v4.0.0-nightly.20260209 "), false);
    assert.equal(isNightlyTag("v4.0.0-nightly.20260209\nv5.0.0"), false);
  });
});
