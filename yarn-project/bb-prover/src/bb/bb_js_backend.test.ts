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

  it('fails the borrow when a replacement cannot be spawned, and spawns it on the next borrow', async () => {
    factory = new FakeBBJsFactory(1);
    {
      await using first = await factory.getInstance();
      factory.created[0].kill();
    }
    factory.planNextInstance(new Error('spawn failed'));

    await expect(factory.getInstance()).rejects.toThrow('spawn failed');
    await using second = await factory.getInstance();
    await expect(verify(second)).resolves.toEqual(verified);
  });

  it('retries pool initialization after a failed spawn', async () => {
    factory = new FakeBBJsFactory(1);
    factory.planNextInstance(new Error('spawn failed'));

    await expect(factory.getInstance()).rejects.toThrow('spawn failed');
    await using instance = await factory.getInstance();
    await expect(verify(instance)).resolves.toEqual(verified);
  });
});
