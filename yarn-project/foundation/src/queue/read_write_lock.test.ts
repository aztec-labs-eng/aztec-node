import { promiseWithResolvers } from '../promise/index.js';
import { sleep } from '../sleep/index.js';
import { ReadWriteLock } from './read_write_lock.js';

describe('ReadWriteLock', () => {
  let lock: ReadWriteLock;
  let log: string[];

  beforeEach(() => {
    lock = new ReadWriteLock();
    log = [];
  });

  /** Work that logs when it starts, and finishes, logging again, when `finish` is called. */
  function work(name: string) {
    const done = promiseWithResolvers<void>();
    const run = async () => {
      log.push(`${name} start`);
      await done.promise;
      log.push(`${name} end`);
    };
    return { run, finish: () => done.resolve() };
  }

  /** Lets every callback already due run. */
  const flush = () => sleep(0);

  it('runs shared holders at the same time', async () => {
    const a = work('a');
    const b = work('b');
    const runs = [lock.runShared(a.run), lock.runShared(b.run)];
    await flush();
    expect(log).toEqual(['a start', 'b start']);

    a.finish();
    b.finish();
    await Promise.all(runs);
  });

  it('starts an exclusive holder once running shared holders finish, and holds new ones back until done', async () => {
    const before = work('before');
    const exclusive = work('exclusive');
    const after = work('after');
    const runs = [lock.runShared(before.run)];
    await flush();
    runs.push(lock.runExclusive(exclusive.run));
    await flush();
    runs.push(lock.runShared(after.run));
    await flush();
    expect(log).toEqual(['before start']);

    before.finish();
    await flush();
    expect(log).toEqual(['before start', 'before end', 'exclusive start']);

    exclusive.finish();
    await flush();
    expect(log).toEqual(['before start', 'before end', 'exclusive start', 'exclusive end', 'after start']);

    after.finish();
    await Promise.all(runs);
  });

  it('runs exclusive holders one at a time, in the order they asked', async () => {
    const first = work('first');
    const second = work('second');
    const runs = [lock.runExclusive(first.run), lock.runExclusive(second.run)];
    await flush();
    expect(log).toEqual(['first start']);

    first.finish();
    await flush();
    expect(log).toEqual(['first start', 'first end', 'second start']);

    second.finish();
    await Promise.all(runs);
  });

  it('lets shared holders that asked during an exclusive turn in before the next exclusive holder', async () => {
    const first = work('first');
    const shared = work('shared');
    const second = work('second');
    const runs = [lock.runExclusive(first.run), lock.runExclusive(second.run)];
    await flush();
    runs.push(lock.runShared(shared.run));
    await flush();

    first.finish();
    await flush();
    expect(log).toEqual(['first start', 'first end', 'shared start']);

    shared.finish();
    await flush();
    expect(log).toEqual(['first start', 'first end', 'shared start', 'shared end', 'second start']);

    second.finish();
    await Promise.all(runs);
  });

  it('frees the lock when a holder throws', async () => {
    await expect(lock.runShared(() => Promise.reject(new Error('shared failed')))).rejects.toThrow('shared failed');
    await expect(lock.runExclusive(() => Promise.reject(new Error('exclusive failed')))).rejects.toThrow(
      'exclusive failed',
    );
    await expect(lock.runExclusive(() => Promise.resolve('ran'))).resolves.toBe('ran');
    await expect(lock.runShared(() => Promise.resolve('ran'))).resolves.toBe('ran');
  });
});
