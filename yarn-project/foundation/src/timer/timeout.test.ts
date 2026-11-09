import { jest } from '@jest/globals';

import { sleep } from '../sleep/index.js';
import { TimeoutTask, execWithSignal, executeTimeout } from './timeout.js';

describe('timeout', () => {
  it('execs within timeout', async () => {
    const task = jest.fn<(signal: AbortSignal) => Promise<string>>(() => sleep(200).then(() => 'ok'));
    await expect(executeTimeout(task, 1000)).resolves.toEqual('ok');
    expect(task.mock.calls[0][0].aborted).toEqual(false);
  });

  it('rejects with custom error on timeout', async () => {
    const task = jest.fn<(signal: AbortSignal) => Promise<string>>(() => sleep(500).then(() => 'ok'));
    await expect(executeTimeout(task, 200, 'Timed out!')).rejects.toThrow('Timed out!');
    expect(task.mock.calls[0][0].aborted).toEqual(true);
  });

  it('has no effect once the function has settled', async () => {
    let signal: AbortSignal | undefined;
    let abortCallbackRan = false;
    let errorCreated = false;

    await expect(
      executeTimeout(
        s => {
          signal = s;
          return Promise.resolve('ok');
        },
        50,
        () => {
          errorCreated = true;
          return new Error('Timed out!');
        },
        () => {
          abortCallbackRan = true;
        },
      ),
    ).resolves.toEqual('ok');

    await sleep(150);
    expect(signal?.aborted).toBe(false);
    expect(abortCallbackRan).toBe(false);
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
    await expect(executeTimeout(task, 20, 'Timed out!', () => order.push('onAbort'))).rejects.toThrow('Timed out!');
    expect(order).toEqual(['onAbort', 'function']);
  });

  it('rejects with the error thrown by the error factory', async () => {
    const errorFn = () => {
      throw new Error('Factory failed');
    };
    await expect(executeTimeout(() => sleep(500), 20, errorFn)).rejects.toThrow('Factory failed');
  });

  it('rejects with the error thrown by onAbort and still aborts the function', async () => {
    const task = jest.fn<(signal: AbortSignal) => Promise<void>>(() => sleep(500));
    const onAbort = () => {
      throw new Error('onAbort failed');
    };
    await expect(executeTimeout(task, 20, 'Timed out!', onAbort)).rejects.toThrow('onAbort failed');
    expect(task.mock.calls[0][0].aborted).toBe(true);
  });

  it('records the execution time when the function throws', async () => {
    const task = new TimeoutTask(
      () => sleep(50).then(() => Promise.reject(new Error('Failed'))),
      1000,
      () => new Error('Timed out!'),
    );
    await expect(task.exec()).rejects.toThrow('Failed');
    expect(task.getTime()).toBeGreaterThanOrEqual(40);
  });

  it('records the execution time when the function times out', async () => {
    const task = new TimeoutTask(
      () => sleep(500),
      50,
      () => new Error('Timed out!'),
    );
    await expect(task.exec()).rejects.toThrow('Timed out!');
    expect(task.getTime()).toBeGreaterThanOrEqual(40);
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
