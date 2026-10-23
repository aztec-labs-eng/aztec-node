import { jest } from '@jest/globals';

import type { L1RpcGraderConfig } from './l1_reader.js';
import { L1RpcGrader } from './l1_rpc_grader.js';

const CHAIN_ID = 31337;

/** What a fake URL answers to the grader's probes: a block number, or an error. */
type Answer = bigint | 'error';

describe('L1RpcGrader', () => {
  const urls = ['https://a.example/key-a', 'https://b.example/key-b', 'https://c.example/key-c'];

  let answers: Answer[];
  let chainIds: number[];
  let orders: (readonly number[])[];

  const defaults: L1RpcGraderConfig = {
    l1RpcGraderIntervalMS: 4_000,
    l1RpcGraderProbeTimeoutMS: 1_000,
    l1RpcGraderMaxBlocksBehind: 2,
    l1RpcGraderThreshold: 3,
    l1RpcGraderWindow: 3,
    l1RpcGraderKeepDemoted: false,
  };

  const makeGrader = (config: Partial<L1RpcGraderConfig> = {}) =>
    new L1RpcGrader(
      urls,
      {
        getBlockNumber: index => {
          const answer = answers[index];
          return answer === 'error' ? Promise.reject(new Error('unreachable')) : Promise.resolve(answer);
        },
        getChainId: index =>
          answers[index] === 'error' ? Promise.reject(new Error('unreachable')) : Promise.resolve(chainIds[index]),
      },
      { config: { ...defaults, ...config }, chainId: CHAIN_ID, onOrderChange: order => orders.push(order) },
    );

  const probeTimes = async (grader: L1RpcGrader, times: number) => {
    for (let i = 0; i < times; i++) {
      await grader.probeAll();
    }
  };

  beforeEach(() => {
    answers = [100n, 100n, 100n];
    chainIds = [CHAIN_ID, CHAIN_ID, CHAIN_ID];
    orders = [];
  });

  it('keeps the configured order before any probe', () => {
    expect(makeGrader().getOrder()).toEqual([0, 1, 2]);
  });

  it('keeps the configured order while every URL is healthy', async () => {
    const grader = makeGrader();
    await probeTimes(grader, 5);
    expect(grader.getOrder()).toEqual([0, 1, 2]);
    expect(orders).toEqual([]);
  });

  it('demotes a lagging URL after enough lagging samples and restores it after enough good ones', async () => {
    const grader = makeGrader();
    answers = [90n, 100n, 99n];

    await probeTimes(grader, 2);
    expect(grader.getOrder()).toEqual([0, 1, 2]);

    await grader.probeAll();
    expect(grader.getOrder()).toEqual([1, 2]);

    answers = [100n, 100n, 100n];
    await probeTimes(grader, 2);
    expect(grader.getOrder()).toEqual([1, 2]);

    await grader.probeAll();
    expect(grader.getOrder()).toEqual([0, 1, 2]);
    expect(orders).toEqual([
      [1, 2],
      [0, 1, 2],
    ]);
  });

  it('does not count a URL within the allowed blocks behind as lagging', async () => {
    const grader = makeGrader();
    answers = [98n, 100n, 100n];
    await probeTimes(grader, 5);
    expect(grader.getOrder()).toEqual([0, 1, 2]);
  });

  it('demotes a URL whose probes fail', async () => {
    const grader = makeGrader();
    answers = [100n, 'error', 100n];

    await probeTimes(grader, 3);
    expect(grader.getOrder()).toEqual([0, 2]);

    answers = [100n, 100n, 100n];
    await probeTimes(grader, 3);
    expect(grader.getOrder()).toEqual([0, 1, 2]);
  });

  it('demotes a URL whose probes time out', async () => {
    const grader = new L1RpcGrader(
      urls.slice(0, 2),
      {
        getBlockNumber: index => (index === 0 ? new Promise<bigint>(() => {}) : Promise.resolve(100n)),
        getChainId: () => Promise.resolve(CHAIN_ID),
      },
      {
        config: { ...defaults, l1RpcGraderProbeTimeoutMS: 10, l1RpcGraderThreshold: 1, l1RpcGraderWindow: 1 },
        chainId: CHAIN_ID,
      },
    );
    await grader.probeAll();
    expect(grader.getOrder()).toEqual([1]);
  });

  it('keeps a lagging URL out when its probes fail before it catches up', async () => {
    const grader = makeGrader();
    answers = [90n, 100n, 100n];
    await probeTimes(grader, 3);
    expect(grader.getOrder()).toEqual([1, 2]);

    answers = ['error', 100n, 100n];
    await probeTimes(grader, 3);
    expect(grader.getOrder()).toEqual([1, 2]);

    // Answering again, but still behind: reachable, yet still lagging.
    answers = [90n, 100n, 100n];
    await probeTimes(grader, 4);
    expect(grader.getOrder()).toEqual([1, 2]);

    answers = [100n, 100n, 100n];
    await probeTimes(grader, 3);
    expect(grader.getOrder()).toEqual([0, 1, 2]);
  });

  it('does not let failed probes count towards restoring a lagging URL', async () => {
    const grader = makeGrader();
    answers = [90n, 100n, 100n];
    await probeTimes(grader, 3);

    answers = [100n, 100n, 100n];
    await probeTimes(grader, 2);
    answers = ['error', 100n, 100n];
    await grader.probeAll();
    answers = [100n, 100n, 100n];
    await grader.probeAll();

    expect(grader.getOrder()).toEqual([1, 2]);
  });

  it('demotes a URL that alternates between good and lagging answers', async () => {
    const grader = makeGrader({ l1RpcGraderThreshold: 3, l1RpcGraderWindow: 5 });
    for (let i = 0; i < 6; i++) {
      answers = [i % 2 === 0 ? 100n : 90n, 100n, 100n];
      await grader.probeAll();
    }
    expect(grader.getOrder()).toEqual([1, 2]);
  });

  it('never uses a URL on the wrong chain', async () => {
    chainIds = [CHAIN_ID, 1, CHAIN_ID];
    answers = [100n, 1_000n, 100n];
    const grader = makeGrader();

    await grader.probeAll();
    expect(grader.getOrder()).toEqual([0, 2]);

    chainIds = [CHAIN_ID, CHAIN_ID, CHAIN_ID];
    await probeTimes(grader, 5);
    expect(grader.getOrder()).toEqual([0, 2]);
  });

  it('does not let a URL on the wrong chain set the head', async () => {
    chainIds = [1, CHAIN_ID, CHAIN_ID];
    answers = [1_000n, 100n, 100n];
    const grader = makeGrader();
    await probeTimes(grader, 5);
    expect(grader.getOrder()).toEqual([1, 2]);
  });

  it('keeps demoted URLs after the healthy ones when asked to', async () => {
    const grader = makeGrader({ l1RpcGraderKeepDemoted: true });
    answers = [90n, 'error', 100n];
    await probeTimes(grader, 3);
    expect(grader.getOrder()).toEqual([2, 0, 1]);
  });

  it('falls back to the configured order when every URL is demoted', async () => {
    const grader = makeGrader();
    answers = [90n, 100n, 100n];
    await probeTimes(grader, 3);
    expect(grader.getOrder()).toEqual([1, 2]);

    answers = ['error', 'error', 'error'];
    await probeTimes(grader, 3);
    expect(grader.getOrder()).toEqual([0, 1, 2]);
  });

  it('rejects a threshold larger than the window', () => {
    expect(() => makeGrader({ l1RpcGraderThreshold: 4, l1RpcGraderWindow: 3 })).toThrow(/threshold/);
  });

  describe('on its interval', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('probes right away and then on every interval until stopped', async () => {
      const grader = makeGrader();
      answers = [90n, 100n, 100n];
      grader.start();

      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(defaults.l1RpcGraderIntervalMS * 2);
      expect(grader.getOrder()).toEqual([1, 2]);

      await grader.stop();
      answers = [100n, 100n, 100n];
      await jest.advanceTimersByTimeAsync(defaults.l1RpcGraderIntervalMS * 10);
      expect(grader.getOrder()).toEqual([1, 2]);
    });
  });
});
