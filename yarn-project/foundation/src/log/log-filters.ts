import { type LogLevel, LogLevels } from './log-levels.js';

export type LogFilters = [string, LogLevel][];

export function getLogLevelFromFilters(filters: LogFilters, module: string): LogLevel | undefined {
  for (const [filterModule, level] of filters) {
    try {
      const regex = new RegExp(filterModule);
      if (regex.test(module)) {
        return level as LogLevel;
      }
    } catch {
      // If regex is invalid, fall back to startsWith check
      if (module.startsWith(filterModule)) {
        return level as LogLevel;
      }
    }
  }
  return undefined;
}

/**
 * Parses the LOG_LEVEL env string into a default level and per-module filter overrides.
 *
 * Format: `<default_level>;<level>:<module1>,<module2>;<level>:<module3>;...`
 * - First segment (before the first `;`) is the default log level for all modules.
 * - Remaining segments are `level:module` pairs: apply the given level to the listed modules (comma-separated).
 * - Later filters override earlier ones for overlapping module matches.
 * - The `aztec:` prefix is stripped from module names; spaces are trimmed.
 *
 * @example
 * ```ts
 * parseLogLevel('debug;warn:module1,module2;error:module3', 'info')
 * // => ['debug', [['module3', 'error'], ['module2', 'warn'], ['module1', 'warn']]]
 * ```
 */
export function parseLogLevelEnvVar(
  logLevelEnvVar: string | undefined,
  defaultLevel: LogLevel,
): [LogLevel, LogFilters] {
  if (!logLevelEnvVar) {
    return [defaultLevel, []];
  }
  const [level] = logLevelEnvVar.split(';', 1);
  assertValidLogLevel(level);
  return [level, parseFilters(logLevelEnvVar.slice(level.length + 1))];
}

/**
 * Renders a default level and per-module filters into the `LOG_LEVEL` env var format.
 * Inverse of {@link parseLogLevelEnvVar}: parsing the returned string yields the same level and filters.
 */
export function formatLogLevelSpec(defaultLevel: LogLevel, filters: LogFilters): string {
  const statements = [...filters].reverse().map(([module, level]) => `${level}:${module}`);
  return [defaultLevel, ...statements].join(';');
}

// Module filters are evaluated as regexes, so filters from untrusted sources are restricted to characters that cannot
// form quantifiers or groups, which is what catastrophic backtracking needs.
const SAFE_MODULE_FILTER = /^[\w:.\-/|^$]+$/;

/**
 * Returns whether the given string is a valid log level spec in the `LOG_LEVEL` env var format whose module filters
 * are safe to evaluate: plain module names, optionally with `|` alternatives and `^`/`$` anchors.
 */
export function isValidLogLevelSpec(spec: string): boolean {
  try {
    const [, filters] = parseLogLevelEnvVar(spec, 'info');
    return filters.every(([module]) => SAFE_MODULE_FILTER.test(module));
  } catch {
    return false;
  }
}

function assertValidLogLevel(level: string): asserts level is LogLevel {
  if (!LogLevels.includes(level as LogLevel)) {
    throw new Error(`Invalid log level: ${level}`);
  }
}

function parseFilters(definition: string | undefined): LogFilters {
  if (!definition) {
    return [];
  }

  const statements = definition.split(';');
  const filters: LogFilters = [];
  for (const statement of statements) {
    const [level] = statement.split(':', 1);
    const modules = statement.slice(level.length + 1);
    if (!modules || !level) {
      throw new Error(`Invalid log filter statement: ${statement}`);
    }
    const sanitizedLevel = level.trim().toLowerCase();
    assertValidLogLevel(sanitizedLevel);
    for (const module of modules.split(',')) {
      const sanitizedModule = module
        .trim()
        .toLowerCase()
        .replace(/^aztec:/, '');
      // An empty module would compile to a regex matching every module, and could not be formatted back into a spec.
      if (sanitizedModule) {
        filters.push([sanitizedModule, sanitizedLevel as LogLevel | 'silent']);
      }
    }
  }
  return filters.reverse();
}
