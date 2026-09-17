import { ManualDateProvider } from '../timer/index.js';
import { backoffUntil } from './index.js';

describe('backoffUntil', () => {
  let dateProvider: ManualDateProvider;

  const deadlineIn = (seconds: number) => new Date(dateProvider.now() + seconds * 1000);

  beforeEach(() => {
    dateProvider = new ManualDateProvider();
  });

  it('doubles the interval up to the cap', () => {
    const backoff = backoffUntil(deadlineIn(3600), { dateProvider, maxIntervalSeconds: 8 });

    expect([...Array(6)].map(() => backoff.next().value)).toEqual([1, 2, 4, 8, 8, 8]);
  });

  it('trims the interval so a retry never sleeps past the deadline', () => {
    const backoff = backoffUntil(deadlineIn(2.5), { dateProvider });

    expect(backoff.next().value).toEqual(1);
    dateProvider.advanceTime(1);
    // 1.5s left, so the 2s interval is cut short.
    expect(backoff.next().value).toEqual(1.5);
  });

  it('ends once the deadline has passed', () => {
    const backoff = backoffUntil(deadlineIn(10), { dateProvider });

    expect(backoff.next().done).toBe(false);
    dateProvider.advanceTime(10);
    expect(backoff.next().done).toBe(true);
  });

  it('yields nothing for a deadline already in the past, leaving a single attempt', () => {
    expect([...backoffUntil(deadlineIn(-1), { dateProvider })]).toEqual([]);
  });
});
