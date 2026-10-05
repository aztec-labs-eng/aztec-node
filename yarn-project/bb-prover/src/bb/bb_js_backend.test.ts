import { ProvingError } from '@aztec-labs/stdlib/errors';

import { FakeBBJsFactory } from '../test/fake_bb_js.js';
import { BBJsInstance } from './bb_js_backend.js';

describe('BBJsInstance', () => {
  it('wraps bb startup failures as a retryable ProvingError', async () => {
    const err = await BBJsInstance.create('/nonexistent/bb-binary').catch(e => e);
    expect(err).toBeInstanceOf(ProvingError);
    expect(err.retry).toBe(true);
  });
});

describe('BBJsFactory pool', () => {
  const tick = () => new Promise(resolve => setImmediate(resolve));

  it('reuses its instances, starting no more than the pool holds', async () => {
    const factory = new FakeBBJsFactory(1);
    const borrow = async () => {
      await using _instance = await factory.getInstance();
      await tick();
    };
    await Promise.all([borrow(), borrow(), borrow()]);
    expect(factory.created).toHaveLength(1);

    await factory.destroy();
    expect(factory.created[0].destroyCount).toBe(1);
  });

  it('gives a slot whose bb failed to start to the next borrower, which starts it again', async () => {
    const factory = new FakeBBJsFactory(1);
    factory.planNextInstance(new Error('spawn failed'));
    await expect(factory.getInstance()).rejects.toThrow('spawn failed');

    await using _instance = await factory.getInstance();
    expect(factory.created).toHaveLength(1);
  });

  it('releases a borrower waiting for a slot at once on destroy, and one starting bb when its start ends', async () => {
    const factory = new FakeBBJsFactory(1);
    let finishStart!: () => void;
    factory.planNextInstance([], new Promise<void>(resolve => (finishStart = resolve)));
    const starting = factory.getInstance();
    const waiting = factory.getInstance();
    await tick();

    const destroying = factory.destroy();
    await expect(waiting).rejects.toThrow(/destroyed/);
    finishStart();
    await expect(starting).rejects.toThrow(/destroyed/);
    await destroying;
    expect(factory.created[0].destroyCount).toBe(1);
  });

  it('destroys an instance borrowed across destroy when it is released, rather than pooling it', async () => {
    const factory = new FakeBBJsFactory(1);
    const instance = await factory.getInstance();
    await factory.destroy();
    expect(factory.created[0].destroyCount).toBe(0);

    await instance[Symbol.asyncDispose]();
    expect(factory.created[0].destroyCount).toBe(1);
    await expect(factory.getInstance()).rejects.toThrow(/destroyed/);
  });
});
