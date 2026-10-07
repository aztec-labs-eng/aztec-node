import { getConfigFromMappings, getDefaultConfig } from '@aztec-labs/foundation/config';

import { type BootnodeConfig, bootnodeConfigMappings, getP2PConfigFromEnv, getP2PDefaultConfig } from '../../config.js';
import { type Discv5RateLimiterConfig, getDiscv5RateLimiterOpts } from './config.js';

describe('discv5 rate limiter config', () => {
  const previousLimits = {
    byIPQuota: { replenishAllEvery: 60_000, maxTokens: 300 },
    globalQuota: { replenishAllEvery: 60_000, maxTokens: 6_000 },
  };

  const envVars = {
    P2P_DISCV5_RATE_LIMIT_PER_IP_MAX_TOKENS: '1200',
    P2P_DISCV5_RATE_LIMIT_PER_IP_REPLENISH_MS: '30000',
    P2P_DISCV5_RATE_LIMIT_GLOBAL_MAX_TOKENS: '24000',
    P2P_DISCV5_RATE_LIMIT_GLOBAL_REPLENISH_MS: '45000',
  };

  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = Object.fromEntries(Object.keys(envVars).map(key => [key, process.env[key]]));
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('defaults to the previously hardcoded limits for nodes and bootnodes', () => {
    expect(getDiscv5RateLimiterOpts(getP2PDefaultConfig())).toEqual(previousLimits);
    expect(getDiscv5RateLimiterOpts(getDefaultConfig<BootnodeConfig>(bootnodeConfigMappings))).toEqual(previousLimits);
  });

  it('uses the default for any limit left unset', () => {
    expect(getDiscv5RateLimiterOpts({})).toEqual(previousLimits);
    expect(getDiscv5RateLimiterOpts({ discv5RateLimitPerIpMaxTokens: 900 })).toEqual({
      ...previousLimits,
      byIPQuota: { replenishAllEvery: 60_000, maxTokens: 900 },
    });
  });

  it('reads limits from env vars for nodes and bootnodes', () => {
    Object.assign(process.env, envVars);
    const expected = {
      byIPQuota: { replenishAllEvery: 30_000, maxTokens: 1_200 },
      globalQuota: { replenishAllEvery: 45_000, maxTokens: 24_000 },
    };

    expect(getDiscv5RateLimiterOpts(getP2PConfigFromEnv())).toEqual(expected);
    expect(getDiscv5RateLimiterOpts(getConfigFromMappings<BootnodeConfig>(bootnodeConfigMappings))).toEqual(expected);
  });

  it.each<[keyof Discv5RateLimiterConfig, number]>([
    ['discv5RateLimitPerIpMaxTokens', 0],
    ['discv5RateLimitPerIpMaxTokens', -1],
    ['discv5RateLimitPerIpMaxTokens', 0.5],
    ['discv5RateLimitPerIpReplenishMs', 0],
    ['discv5RateLimitGlobalMaxTokens', NaN],
    ['discv5RateLimitGlobalReplenishMs', -60_000],
  ])('rejects %s = %d', (key, value) => {
    expect(() => getDiscv5RateLimiterOpts({ [key]: value })).toThrow(key);
  });
});
