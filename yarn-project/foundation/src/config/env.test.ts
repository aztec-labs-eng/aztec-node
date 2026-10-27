import { getEnv } from './env.js';

describe('getEnv', () => {
  const originalProcess = globalThis.process;
  const originalEnv = process.env;

  afterEach(() => {
    globalThis.process = originalProcess;
    process.env = originalEnv;
  });

  it('returns the variables of the Node.js process', () => {
    process.env = { ...originalEnv, GET_ENV_TEST: 'value' };
    expect(getEnv().GET_ENV_TEST).toBe('value');
  });

  it('returns undefined for a variable that is not set', () => {
    process.env = {};
    expect(getEnv().GET_ENV_TEST).toBeUndefined();
  });

  it('returns an empty record in a runtime without a process', () => {
    Reflect.deleteProperty(globalThis, 'process');
    const env = getEnv();
    globalThis.process = originalProcess;
    expect(env).toEqual({});
  });

  it('returns an empty record when the process has no environment', () => {
    globalThis.process = Object.create(originalProcess, { env: { value: undefined } });
    const env = getEnv();
    globalThis.process = originalProcess;
    expect(env).toEqual({});
  });
});
