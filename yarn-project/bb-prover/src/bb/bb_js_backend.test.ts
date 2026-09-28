import { promiseWithResolvers } from '@aztec-labs/foundation/promise';
import { retryUntil } from '@aztec-labs/foundation/retry';
import { sleep } from '@aztec-labs/foundation/sleep';
import { ProvingError } from '@aztec-labs/stdlib/errors';

import { FakeBBJsFactory } from '../test/fake_bb_js.js';
import { type BBJsApi, BBJsInstance } from './bb_js_backend.js';

describe('BBJsInstance', () => {
  it('wraps bb startup failures as a retryable ProvingError', async () => {
    const err = await BBJsInstance.create('/nonexistent/bb-binary').catch(e => e);
    expect(err).toBeInstanceOf(ProvingError);
    expect(err.retry).toBe(true);
  });
});

describe('BBJsFactory pool', () => {
  let factory: FakeBBJsFactory;

  const verify = (instance: BBJsApi) => instance.verifyChonkProof([], new Uint8Array());
  const verified = { verified: true, durationMs: 1 };
  // Runs the pending microtasks, such as a released fake spawn or a borrow taking an idle instance.
  const settle = () => new Promise(resolve => setImmediate(resolve));

  afterEach(async () => {
    await factory.destroy();
  });

  it('replaces a borrowed instance whose bb died', async () => {
    factory = new FakeBBJsFactory(1);
    {
      await using first = await factory.getInstance();
      factory.created[0].kill();
      await expect(verify(first)).rejects.toThrow('Socket not connected');
    }

    await using second = await factory.getInstance();
    await expect(verify(second)).resolves.toEqual(verified);
    expect(factory.created).toHaveLength(2);
    expect(factory.created[0].destroyCount).toBe(1);
    expect(factory.created[1].chonkVerifyCalls).toBe(1);
  });

  it('skips an idle instance whose bb died and replaces it', async () => {
    factory = new FakeBBJsFactory(2);
    {
      await using _warmup = await factory.getInstance();
    }
    const [warm, other] = [factory.created[0], factory.created[1]];
    warm.kill();

    await using a = await factory.getInstance();
    await using b = await factory.getInstance();
    await expect(verify(a)).resolves.toEqual(verified);
    await expect(verify(b)).resolves.toEqual(verified);
    expect(factory.created).toHaveLength(3);
    expect(warm.chonkVerifyCalls).toBe(0);
    expect(warm.destroyCount).toBe(1);
    expect(other.chonkVerifyCalls).toBe(1);
  });

  it('loses one call to a bb that dies, not a share of the calls after it', async () => {
    factory = new FakeBBJsFactory(2);
    factory.planNextInstance(['die']);
    let failures = 0;
    for (let i = 0; i < 40; i++) {
      await using instance = await factory.getInstance();
      try {
        await verify(instance);
      } catch {
        failures++;
      }
    }
    expect(failures).toBe(1);
  });

  it('hands the replacement for a dead borrowed instance to a borrower waiting for it', async () => {
    factory = new FakeBBJsFactory(1);
    const first = await factory.getInstance();
    const waiting = factory.getInstance();
    factory.created[0].kill();
    await first[Symbol.asyncDispose]();

    await using second = await waiting;
    await expect(verify(second)).resolves.toEqual(verified);
    expect(factory.created).toHaveLength(2);
  });

  it('keeps a borrower waiting while replacements fail to spawn, and hands it the first one that starts', async () => {
    factory = new FakeBBJsFactory(1);
    const first = await factory.getInstance();
    const waiting = factory.getInstance();
    factory.created[0].kill();
    for (let i = 0; i < 3; i++) {
      factory.planNextInstance(new Error('spawn failed'));
    }
    await first[Symbol.asyncDispose]();

    await using second = await waiting;
    await expect(verify(second)).resolves.toEqual(verified);
    expect(factory.created).toHaveLength(2);
  });

  it('waits for the first instance when bb cannot start yet', async () => {
    factory = new FakeBBJsFactory(1);
    factory.planNextInstance(new Error('spawn failed'));
    factory.planNextInstance(new Error('spawn failed'));

    await using instance = await factory.getInstance();
    await expect(verify(instance)).resolves.toEqual(verified);
  });

  it('keeps the instances that started and spawns the ones that failed later', async () => {
    factory = new FakeBBJsFactory(2);
    factory.planNextInstance(new Error('spawn failed'));

    await using a = await factory.getInstance();
    await using b = await factory.getInstance();
    await expect(verify(a)).resolves.toEqual(verified);
    await expect(verify(b)).resolves.toEqual(verified);
    expect(factory.created).toHaveLength(2);
  });

  it('does not spawn past poolSize while a spawn is in flight', async () => {
    factory = new FakeBBJsFactory(1);
    const spawned = promiseWithResolvers<void>();
    factory.planNextInstance([], spawned.promise);
    const borrowing = factory.getInstance();
    // Several maintenance runs happen while the spawn is in flight.
    await sleep(50);
    spawned.resolve();

    await using _instance = await borrowing;
    expect(factory.created).toHaveLength(1);
  });

  it('does not wait for a spawn in flight when destroyed, and destroys its instance once it arrives', async () => {
    factory = new FakeBBJsFactory(1);
    const spawned = promiseWithResolvers<void>();
    factory.planNextInstance([], spawned.promise);
    const borrowFails = expect(factory.getInstance()).rejects.toThrow('destroyed while waiting');

    await factory.destroy();
    await borrowFails;
    spawned.resolve();
    await settle();
    expect(factory.created).toHaveLength(1);
    expect(factory.created[0].destroyCount).toBe(1);
  });

  it('destroys a dead instance that a borrow dropped before maintenance could', async () => {
    // Maintenance runs only once, when the pool starts.
    factory = new FakeBBJsFactory(1, 60_000);
    {
      await using _first = await factory.getInstance();
      factory.created[0].kill();
    }
    const borrowFails = expect(factory.getInstance()).rejects.toThrow('destroyed while waiting');
    // Let the borrow take the dead instance and drop it.
    await settle();

    await factory.destroy();
    await borrowFails;
    expect(factory.created).toHaveLength(1);
    expect(factory.created[0].destroyCount).toBe(1);
  });

  it('destroys every instance once when destroyed after replacing a dead idle one', async () => {
    factory = new FakeBBJsFactory(2);
    {
      await using _warmup = await factory.getInstance();
    }
    factory.created[1].kill();
    await retryUntil(() => factory.created.length === 3, 'replacement of the dead instance', 5, 0.001);

    await factory.destroy();
    expect(factory.created.map(instance => instance.destroyCount)).toEqual([1, 1, 1]);
  });
});
