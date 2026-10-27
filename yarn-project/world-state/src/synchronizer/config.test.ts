import { CheckpointNumber } from '@aztec-labs/foundation/branded-types';
import { getEnv } from '@aztec-labs/foundation/config/env';

import { type WorldStateHistoryRetention, getWorldStateConfigFromEnv } from './config.js';

describe('world-state history retention configuration', () => {
  const env = getEnv();
  const original = env.WS_HISTORY_RETENTION;

  afterEach(() => {
    if (original === undefined) {
      delete env.WS_HISTORY_RETENTION;
    } else {
      env.WS_HISTORY_RETENTION = original;
    }
  });

  it.each<[string, WorldStateHistoryRetention]>([
    ['rolling:7', { type: 'rolling', checkpoints: 7 }],
    ['pinned:12345', { type: 'pinned', checkpoint: CheckpointNumber(12345) }],
    ['archive', { type: 'archive' }],
  ])('parses %s', (value, expected) => {
    env.WS_HISTORY_RETENTION = value;
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
