import { getBindings, withLoggerBindings } from './pino-logger-server.js';
import { createLogger } from './pino-logger.js';

describe('withLoggerBindings', () => {
  const currentActor = () => createLogger('bindings-test').getBindings().actor;

  it('binds loggers created within the callback', async () => {
    await expect(withLoggerBindings({ actor: 'prover-1' }, () => Promise.resolve(currentActor()))).resolves.toEqual(
      'prover-1',
    );
  });

  it('binds loggers created by callees that bind nothing themselves', async () => {
    const callee = () => Promise.resolve(currentActor());
    await expect(withLoggerBindings({ actor: 'prover-2' }, callee)).resolves.toEqual('prover-2');
  });

  it('lets an inner binding replace the outer one instead of merging with it', async () => {
    const bindings = await withLoggerBindings({ actor: 'prover-1', instanceId: 'epoch-3' }, () =>
      withLoggerBindings({ actor: 'prover-2' }, () => Promise.resolve(createLogger('bindings-test').getBindings())),
    );

    expect(bindings).toEqual({ actor: 'prover-2', instanceId: undefined });
  });

  it('unbinds once the callback settles', async () => {
    await withLoggerBindings({ actor: 'prover-1' }, () => Promise.resolve());

    expect(getBindings()).toBeUndefined();
    expect(currentActor()).toBeUndefined();
  });
});
