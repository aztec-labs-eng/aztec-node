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
  // The fake spawns settle within microtasks, so one macrotask lets every pending spawn and waiting borrow progress.
  const settle = () => new Promise(resolve => setImmediate(resolve));

  afterEach(async () => {
    await factory.destroy();
  });

  it('evicts a borrowed instance whose bb died instead of returning it to the pool', async () => {
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

  it('skips an idle instance whose bb died and spawns a replacement', async () => {
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
    // Let the second borrow start waiting on the full pool before the borrowed instance dies.
    await settle();
    factory.created[0].kill();
    await first[Symbol.asyncDispose]();

    await using second = await waiting;
    await expect(verify(second)).resolves.toEqual(verified);
    expect(factory.created).toHaveLength(2);
  });

  it('fails waiting borrows once the instance they wait for dies and cannot be replaced', async () => {
    factory = new FakeBBJsFactory(1);
    const first = await factory.getInstance();
    const waiting = [factory.getInstance(), factory.getInstance()];
    await settle();
    factory.created[0].kill();
    // More failures than spawns: the background replacement, then a spawn by each waiting borrow when it re-checks.
    for (let i = 0; i < 10; i++) {
      factory.planNextInstance(new Error('spawn failed'));
    }
    await first[Symbol.asyncDispose]();

    const results = await Promise.allSettled(waiting);
    expect(results.map(r => r.status)).toEqual(['rejected', 'rejected']);
  });

  it('fails a borrow when no instance exists and none can be spawned, and spawns one on the next borrow', async () => {
    factory = new FakeBBJsFactory(1);
    {
      await using _first = await factory.getInstance();
      factory.created[0].kill();
      // One spawn when the dead instance is returned, one by the next borrow.
      factory.planNextInstance(new Error('spawn failed'));
      factory.planNextInstance(new Error('spawn failed'));
    }
    await settle();

    await expect(factory.getInstance()).rejects.toThrow('spawn failed');
    await using second = await factory.getInstance();
    await expect(verify(second)).resolves.toEqual(verified);
  });

  it('waits for a borrowed instance when a replacement cannot be spawned', async () => {
    factory = new FakeBBJsFactory(2);
    const first = await factory.getInstance();
    {
      await using _second = await factory.getInstance();
      factory.created[1].kill();
      factory.planNextInstance(new Error('spawn failed'));
      factory.planNextInstance(new Error('spawn failed'));
    }
    await settle();

    const waiting = factory.getInstance();
    // Let the borrow fail its spawn and start waiting before the live instance comes back.
    await settle();
    await first[Symbol.asyncDispose]();

    await using third = await waiting;
    await expect(verify(third)).resolves.toEqual(verified);
    expect(factory.created).toHaveLength(2);
  });

  it('keeps the instances that started when pool initialization partly fails', async () => {
    factory = new FakeBBJsFactory(2);
    factory.planNextInstance(new Error('spawn failed'));

    await using instance = await factory.getInstance();
    await expect(verify(instance)).resolves.toEqual(verified);
    expect(factory.created).toHaveLength(1);
  });

  it('retries pool initialization when no instance started', async () => {
    factory = new FakeBBJsFactory(1);
    factory.planNextInstance(new Error('spawn failed'));

    await expect(factory.getInstance()).rejects.toThrow('spawn failed');
    await using instance = await factory.getInstance();
    await expect(verify(instance)).resolves.toEqual(verified);
  });
});
