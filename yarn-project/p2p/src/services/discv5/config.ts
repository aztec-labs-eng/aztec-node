import { type ConfigMappingsType, getDefaultConfig, numberConfigHelper } from '@aztec-labs/foundation/config';
import type { IDiscv5CreateOptions } from '@nethermindeth/discv5';

/**
 * Limits for the discv5 transport rate limiter, which bounds pre-auth packet decode so one host cannot force unbounded
 * decoding on the discovery path. Responses to our own queries are exempt via the expected-response bypass. A source
 * IP that exceeds its per-IP budget is banned for the lifetime of the process, so the defaults sit well above any
 * honest unsolicited burst.
 */
export interface Discv5RateLimiterConfig {
  /** Burst size, in packets, of unsolicited discv5 packets accepted from a single source IP. */
  discv5RateLimitPerIpMaxTokens: number;
  /** Time in ms for a source IP's packet budget to fully replenish. */
  discv5RateLimitPerIpReplenishMs: number;
  /** Burst size, in packets, of unsolicited discv5 packets accepted across all source IPs. */
  discv5RateLimitGlobalMaxTokens: number;
  /** Time in ms for the aggregate packet budget to fully replenish. */
  discv5RateLimitGlobalReplenishMs: number;
}

export const discv5RateLimiterConfigKeys = [
  'discv5RateLimitPerIpMaxTokens',
  'discv5RateLimitPerIpReplenishMs',
  'discv5RateLimitGlobalMaxTokens',
  'discv5RateLimitGlobalReplenishMs',
] as const satisfies readonly (keyof Discv5RateLimiterConfig)[];

export const discv5RateLimiterConfigMappings: ConfigMappingsType<Discv5RateLimiterConfig> = {
  // Defaults: ~5 packets/sec steady per source IP, burst 300.
  discv5RateLimitPerIpMaxTokens: {
    env: 'P2P_DISCV5_RATE_LIMIT_PER_IP_MAX_TOKENS',
    description:
      'Maximum burst of unsolicited discv5 packets accepted from a single source IP, replenished over P2P_DISCV5_RATE_LIMIT_PER_IP_REPLENISH_MS. A source IP that exceeds it is banned from discovery for the lifetime of the process. Responses to our own discovery queries are exempt. Raise it when many nodes share one egress IP (e.g. behind NAT). Must be a positive integer.',
    ...numberConfigHelper(300),
  },
  discv5RateLimitPerIpReplenishMs: {
    env: 'P2P_DISCV5_RATE_LIMIT_PER_IP_REPLENISH_MS',
    description:
      "Time in milliseconds for a source IP's discv5 packet budget (P2P_DISCV5_RATE_LIMIT_PER_IP_MAX_TOKENS) to fully replenish. Must be a positive integer.",
    ...numberConfigHelper(60_000),
  },
  // Defaults: ~100 packets/sec steady aggregate, burst 6000; backstop against many-IP floods.
  discv5RateLimitGlobalMaxTokens: {
    env: 'P2P_DISCV5_RATE_LIMIT_GLOBAL_MAX_TOKENS',
    description:
      'Maximum burst of unsolicited discv5 packets accepted across all source IPs, replenished over P2P_DISCV5_RATE_LIMIT_GLOBAL_REPLENISH_MS. Packets over this limit are dropped without banning the sender. Responses to our own discovery queries are exempt. Must be a positive integer.',
    ...numberConfigHelper(6_000),
  },
  discv5RateLimitGlobalReplenishMs: {
    env: 'P2P_DISCV5_RATE_LIMIT_GLOBAL_REPLENISH_MS',
    description:
      'Time in milliseconds for the aggregate discv5 packet budget (P2P_DISCV5_RATE_LIMIT_GLOBAL_MAX_TOKENS) to fully replenish. Must be a positive integer.',
    ...numberConfigHelper(60_000),
  },
};

export function getDiscv5RateLimiterDefaultConfig(): Discv5RateLimiterConfig {
  return getDefaultConfig<Discv5RateLimiterConfig>(discv5RateLimiterConfigMappings);
}

type Discv5RateLimiterOpts = NonNullable<IDiscv5CreateOptions['rateLimiterOpts']>;

/**
 * Builds the discv5 `rateLimiterOpts` from config, using the default for any limit left unset.
 * @throws If a limit is set to anything other than a positive integer. The library rejects zero but silently accepts
 * negative or NaN values, which disable the limiter, and a fractional token count below one bans every source on its
 * first packet.
 */
export function getDiscv5RateLimiterOpts(config: Partial<Discv5RateLimiterConfig>): Discv5RateLimiterOpts {
  const limits = getDiscv5RateLimiterDefaultConfig();
  for (const key of discv5RateLimiterConfigKeys) {
    const value = config[key];
    if (value === undefined) {
      continue;
    }
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(
        `Invalid ${discv5RateLimiterConfigMappings[key].env} (${key}): expected a positive integer, got ${value}`,
      );
    }
    limits[key] = value;
  }
  return {
    byIPQuota: {
      replenishAllEvery: limits.discv5RateLimitPerIpReplenishMs,
      maxTokens: limits.discv5RateLimitPerIpMaxTokens,
    },
    globalQuota: {
      replenishAllEvery: limits.discv5RateLimitGlobalReplenishMs,
      maxTokens: limits.discv5RateLimitGlobalMaxTokens,
    },
  };
}
