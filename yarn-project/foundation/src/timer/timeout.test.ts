import { jest } from '@jest/globals';

import { sleep } from '../sleep/index.js';
import { execWithSignal, executeTimeout, withTimeout } from './timeout.js';

describe('timeout', () => {
  it('execs within timeout', async () => {
    const task = jest.fn<(signal: AbortSignal) => Promise<string>>(() => sleep(200).then(() => 'ok'));
    await expect(executeTimeout(task, 1000)).resolves.toEqual('ok');
    expect(task.mock.calls[0][0].aborted).toEqual(false);
  });

  it('rejects with custom error on timeout', async () => {
    const task = jest.fn<(signal: AbortSignal) => Promise<string>>(() => sleep(500).then(() => 'ok'));
    await expect(executeTimeout(task, 200, 'Timed out!')).rejects.toThrow('Timed out!');
    const signal = task.mock.calls[0][0];
    expect(signal.aborted).toEqual(true);
    expect(signal.reason.name).toEqual('TimeoutError');
  });

  it.each<{ name: string; settle: () => Promise<string>; outcome: string }>([
    { name: 'resolves', settle: () => Promise.resolve('ok'), outcome: 'ok' },
    { name: 'rejects', settle: () => Promise.reject(new Error('Failed')), outcome: 'Failed' },
    {
      name: 'throws synchronously',
      settle: () => {
        throw new Error('Failed');
      },
      outcome: 'Failed',
    },
  ])('has no effect once the function $name', async ({ settle, outcome }) => {
    let signal: AbortSignal | undefined;
    let errorCreated = false;

    const result = await executeTimeout(
      s => {
        signal = s;
        return settle();
      },
      50,
      () => {
        errorCreated = true;
        return new Error('Timed out!');
      },
    ).catch((err: Error) => err.message);
    expect(result).toEqual(outcome);

    await sleep(150);
    expect(signal?.aborted).toBe(false);
    expect(errorCreated).toBe(false);
  });

  it('rejects with the custom error when the function rejects as soon as it is aborted', async () => {
    const order: string[] = [];
    const task = (signal: AbortSignal) =>
      new Promise<string>((_, reject) =>
        signal.addEventListener('abort', () => {
          order.push('function');
          reject(new Error('Aborted by function'));
        }),
      );
    const errorFn = () => {
      order.push('timeout');
      return new Error('Timed out!');
    };
    await expect(executeTimeout(task, 20, errorFn)).rejects.toThrow('Timed out!');
    expect(order).toEqual(['timeout', 'function']);
  });

  it('rejects with the error thrown by the error factory and still aborts the function', async () => {
    let functionAborted = false;
    const task = (signal: AbortSignal) =>
      new Promise<void>(resolve =>
        signal.addEventListener('abort', () => {
          functionAborted = true;
          resolve();
        }),
      );
    const errorFn = () => {
      throw new Error('Factory failed');
    };
    await expect(executeTimeout(task, 20, errorFn)).rejects.toThrow('Factory failed');
    expect(functionAborted).toBe(true);
  });

  it.each([1.5, 2 ** 31])('rejects a timeout of %d that setTimeout cannot honour', async timeout => {
    await expect(executeTimeout(() => sleep(10), timeout)).rejects.toThrow(RangeError);
  });

  it('rejects if timeout is zero', async () => {
    await expect(executeTimeout(() => sleep(500), 0, 'Timed out!')).rejects.toThrow('Timed out!');
  });

  it('rejects if timeout is negative', async () => {
    await expect(executeTimeout(() => sleep(500), -100, 'Timed out!')).rejects.toThrow(
      /The value of .* is out of range/,
    );
  });

  it('execs with a non-aborted signal', async () => {
    const controller = new AbortController();
    await expect(execWithSignal(() => sleep(20).then(() => 'ok'), controller.signal)).resolves.toEqual('ok');
  });

  it('rejects with custom error when signal aborts', async () => {
    const controller = new AbortController();
    const promise = execWithSignal(
      () => sleep(500),
      controller.signal,
      () => new Error('Aborted!'),
    );

    controller.abort();

    await expect(promise).rejects.toThrow('Aborted!');
  });

  it('rejects with the error thrown by the error factory when the signal aborts', async () => {
    const controller = new AbortController();
    const promise = execWithSignal(
      () => sleep(500),
      controller.signal,
      () => {
        throw new Error('Factory failed');
      },
    );

    controller.abort();

    await expect(promise).rejects.toThrow('Factory failed');
  });

  it('execs with AbortSignal.timeout', async () => {
    await expect(
      execWithSignal(
        () => sleep(500),
        AbortSignal.timeout(20),
        signal => new Error(signal.reason?.name ?? 'Aborted'),
      ),
    ).rejects.toThrow('TimeoutError');
  });
});

describe('withTimeout', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('resolves with the result of the promise', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1000)).resolves.toEqual('ok');
  });

  it('rejects with the promise error', async () => {
    await expect(withTimeout(Promise.reject(new Error('Failed!')), 1000)).rejects.toThrow('Failed!');
  });

  it('rejects once the timeout elapses', async () => {
    const promise = withTimeout(new Promise(() => {}), 1000, 'Too slow!');
    jest.advanceTimersByTime(1000);
    await expect(promise).rejects.toThrow('Too slow!');
  });

  it('leaves no timer pending once the promise settles', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 60_000)).resolves.toEqual('ok');
    expect(jest.getTimerCount()).toEqual(0);
  });
});
