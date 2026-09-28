import { createLogger } from '@aztec-labs/foundation/log';
import { ChildProcess } from 'node:child_process';

import { WorkerClientManager } from './worker_client_manager.js';

describe('WorkerClientManager connectivity', () => {
  function managerWithMeshCounts(counts: number[]) {
    const manager = new WorkerClientManager(createLogger('test:worker-client-manager'), {});
    manager.processes = counts.map(meshCount => {
      const worker = new ChildProcess();
      worker.send = () => {
        queueMicrotask(() => worker.emit('message', { type: 'PEER_COUNT', count: 4, meshCount }));
        return true;
      };
      return worker;
    });
    return manager;
  }

  it('returns the counts when every worker has the required mesh', async () => {
    const manager = managerWithMeshCounts([4, 4, 4, 4, 4]);
    await expect(manager.waitForAllConnectivity(4, 1)).resolves.toEqual([4, 4, 4, 4, 4]);
    expect(manager.processes.every(worker => worker.listenerCount('message') === 0)).toBe(true);
  });

  it('rejects if one worker never rejoins despite having transport connections', async () => {
    const manager = managerWithMeshCounts([4, 4, 0, 4, 4]);
    await expect(manager.waitForAllConnectivity(4, 1)).rejects.toThrow('all clients to reach 4 mesh peers');
    expect(manager.processes.every(worker => worker.listenerCount('message') === 0)).toBe(true);
  });

  it('rejects an empty worker set', async () => {
    await expect(managerWithMeshCounts([]).waitForAllConnectivity(4, 1)).rejects.toThrow();
  });
});
