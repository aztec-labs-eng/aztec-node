import { formatLogLevelSpec, isValidLogLevelSpec, parseLogLevelEnvVar } from './log-filters.js';

describe('parseEnv', () => {
  const defaultLevel = 'info';

  it('returns default level and empty filters when env is empty', () => {
    const env = '';
    const [level, filters] = parseLogLevelEnvVar(env, defaultLevel);
    expect(level).toBe(defaultLevel);
    expect(filters).toEqual([]);
  });

  it('parses level and filters from env string', () => {
    const env = 'debug;warn:module1,module2;error:module3';
    const [level, filters] = parseLogLevelEnvVar(env, defaultLevel);
    expect(level).toBe('debug');
    expect(filters).toEqual([
      ['module3', 'error'],
      ['module2', 'warn'],
      ['module1', 'warn'],
    ]);
  });

  it('handles spaces in env string', () => {
    const env = 'debug; warn: module1, module2; error: module3';
    const [level, filters] = parseLogLevelEnvVar(env, defaultLevel);
    expect(level).toBe('debug');
    expect(filters).toEqual([
      ['module3', 'error'],
      ['module2', 'warn'],
      ['module1', 'warn'],
    ]);
  });

  it('throws an error for invalid default log level', () => {
    const env = 'invalid;module1:warn';
    expect(() => parseLogLevelEnvVar(env, defaultLevel)).toThrow('Invalid log level: invalid');
  });

  it('throws an error for invalid log level in filter', () => {
    const env = 'invalid;warn:module';
    expect(() => parseLogLevelEnvVar(env, defaultLevel)).toThrow('Invalid log level: invalid');
  });

  it('throws an error for invalid log filter statement', () => {
    const defaultLevel = 'info';
    const env = 'debug;warn:module1;error:';
    expect(() => parseLogLevelEnvVar(env, defaultLevel)).toThrow('Invalid log filter statement: error');
  });
});

describe('formatLogLevelSpec', () => {
  it('renders a level without filters', () => {
    expect(formatLogLevelSpec('info', [])).toBe('info');
  });

  it('drops empty modules so the spec can be formatted back', () => {
    const [level, filters] = parseLogLevelEnvVar('info;debug:foo, ;trace: ', 'info');
    expect(filters).toEqual([['foo', 'debug']]);
    expect(formatLogLevelSpec(level, filters)).toBe('info;debug:foo');
  });

  it('round-trips through parseLogLevelEnvVar', () => {
    const [level, filters] = parseLogLevelEnvVar('debug;warn:module1,module2;error:module3', 'info');
    const spec = formatLogLevelSpec(level, filters);
    expect(parseLogLevelEnvVar(spec, 'info')).toEqual([level, filters]);
  });
});

describe('isValidLogLevelSpec', () => {
  it('accepts valid specs', () => {
    expect(isValidLogLevelSpec('info')).toBe(true);
    expect(isValidLogLevelSpec('debug;trace:sequencer,p2p;warn:archiver')).toBe(true);
  });

  it('rejects invalid specs', () => {
    expect(isValidLogLevelSpec('loud')).toBe(false);
    expect(isValidLogLevelSpec('debug;trace:')).toBe(false);
  });

  it('rejects module filters that could backtrack catastrophically', () => {
    expect(isValidLogLevelSpec('info;debug:(.+)+z')).toBe(false);
    expect(isValidLogLevelSpec('info;debug:p2p.*')).toBe(false);
    expect(isValidLogLevelSpec('info;debug:^p2p$|sequencer:checkpoint-proposal')).toBe(true);
  });
});
