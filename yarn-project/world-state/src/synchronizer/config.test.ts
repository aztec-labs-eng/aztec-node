import { CheckpointNumber } from '@aztec-labs/foundation/branded-types';
import { getEnv } from '@aztec-labs/foundation/config/env';

import {
  DEFAULT_HISTORY_RETENTION_CHECKPOINTS,
  type WorldStateHistoryRetention,
  getWorldStateConfigFromEnv,
  resolveWorldStateHistoryRetention,
} from './config.js';

describe('world-state history retention configuration', () => {
  const env = getEnv();
  const retentionEnvVars = ['WS_HISTORY_RETENTION', 'WS_NUM_HISTORIC_CHECKPOINTS', 'WS_NUM_HISTORIC_BLOCKS'] as const;
  const original = Object.fromEntries(retentionEnvVars.map(name => [name, env[name]]));

  beforeEach(() => {
    for (const name of retentionEnvVars) {
      delete env[name];
    }
  });

  afterEach(() => {
    for (const name of retentionEnvVars) {
      if (original[name] === undefined) {
        delete env[name];
      } else {
        env[name] = original[name];
      }
    }
  });

  it('leaves retention unset when no variable is set', () => {
    expect(getWorldStateConfigFromEnv().worldStateHistoryRetention).toBeUndefined();
  });

  it.each<[string, WorldStateHistoryRetention]>([
    ['rolling:7', { type: 'rolling', checkpoints: 7 }],
    ['pinned:12345', { type: 'pinned', checkpoint: CheckpointNumber(12345) }],
    ['archive', { type: 'archive' }],
  ])('parses %s', (value, expected) => {
    env.WS_HISTORY_RETENTION = value;
    expect(getWorldStateConfigFromEnv().worldStateHistoryRetention).toEqual(expected);
  });

  it.each<['WS_NUM_HISTORIC_CHECKPOINTS' | 'WS_NUM_HISTORIC_BLOCKS', string, WorldStateHistoryRetention]>([
    ['WS_NUM_HISTORIC_CHECKPOINTS', '10', { type: 'rolling', checkpoints: 10 }],
    ['WS_NUM_HISTORIC_CHECKPOINTS', '0', { type: 'archive' }],
    ['WS_NUM_HISTORIC_BLOCKS', '20', { type: 'rolling', checkpoints: 20 }],
  ])('maps deprecated %s=%s', (name, value, expected) => {
    env[name] = value;
    expect(getWorldStateConfigFromEnv().worldStateHistoryRetention).toEqual(expected);
  });

  it.each([
    'rolling:0',
    'pinned:0',
    'rolling:-1',
    'pinned:-1',
    'rolling:1.5',
    'pinned:1.5',
    'rolling:9007199254740992',
    'pinned:9007199254740992',
    'rolling:1e2',
    'rolling:64:1',
    'archive:1',
    '64',
    'other:64',
  ])('rejects invalid policy %s', value => {
    env.WS_HISTORY_RETENTION = value;
    expect(() => getWorldStateConfigFromEnv()).toThrow(/WS_HISTORY_RETENTION/);
  });
});

describe('resolveWorldStateHistoryRetention', () => {
  const proofSubmissionWindow = (checkpoints: number) => ({ checkpoints, purpose: 'the proof submission window' });

  it('defaults unset retention to the default rolling window when nothing is required', () => {
    expect(resolveWorldStateHistoryRetention(undefined)).toEqual({
      type: 'rolling',
      checkpoints: DEFAULT_HISTORY_RETENTION_CHECKPOINTS,
    });
  });

  it('keeps the default rolling window when the requirement is smaller', () => {
    expect(resolveWorldStateHistoryRetention(undefined, proofSubmissionWindow(24))).toEqual({
      type: 'rolling',
      checkpoints: DEFAULT_HISTORY_RETENTION_CHECKPOINTS,
    });
  });

  it.each([96, 808])('widens unset retention to a requirement of %i checkpoints', checkpoints => {
    expect(resolveWorldStateHistoryRetention(undefined, proofSubmissionWindow(checkpoints))).toEqual({
      type: 'rolling',
      checkpoints,
    });
  });

  it('rejects a configured rolling window below the requirement', () => {
    expect(() =>
      resolveWorldStateHistoryRetention({ type: 'rolling', checkpoints: 95 }, proofSubmissionWindow(96)),
    ).toThrow(/WS_HISTORY_RETENTION=rolling:95.*rolling:96/);
  });

  it('rejects an explicit rolling window of the default size when the requirement is larger', () => {
    expect(() =>
      resolveWorldStateHistoryRetention(
        { type: 'rolling', checkpoints: DEFAULT_HISTORY_RETENTION_CHECKPOINTS },
        proofSubmissionWindow(96),
      ),
    ).toThrow(/WS_HISTORY_RETENTION/);
  });

  it.each([96, 128])('keeps a configured rolling window of %i checkpoints covering the requirement', checkpoints => {
    const configured: WorldStateHistoryRetention = { type: 'rolling', checkpoints };
    expect(resolveWorldStateHistoryRetention(configured, proofSubmissionWindow(96))).toEqual(configured);
  });

  it('keeps a configured rolling window below the default when nothing is required', () => {
    const configured: WorldStateHistoryRetention = { type: 'rolling', checkpoints: 2 };
    expect(resolveWorldStateHistoryRetention(configured)).toEqual(configured);
  });

  it.each<WorldStateHistoryRetention>([{ type: 'archive' }, { type: 'pinned', checkpoint: CheckpointNumber(7) }])(
    'keeps configured $type retention regardless of the requirement',
    configured => {
      expect(resolveWorldStateHistoryRetention(configured, proofSubmissionWindow(808))).toEqual(configured);
    },
  );
});
