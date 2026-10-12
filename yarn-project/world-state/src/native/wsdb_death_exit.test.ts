import { MerkleTreeId } from '@aztec-labs/stdlib/trees';
import { jest } from '@jest/globals';
import { execFileSync } from 'node:child_process';

import { NativeWorldStateService } from './native_world_state.js';

// wsdb holds the forks and uncommitted state every world-state caller depends on, so the node cannot carry on
// without it: its death must take the node down, as a crash of the in-process world state used to.

jest.setTimeout(60_000);

class ProcessExit extends Error {
  constructor(public readonly code: string | number | null | undefined) {
    super(`process.exit(${code})`);
  }
}

/** The pid of the wsdb serving `ipcPath`, which it receives on its command line. */
function wsdbPid(ipcPath: string): number {
  const pids = execFileSync('pgrep', ['-f', ipcPath], { encoding: 'utf8' }).trim().split('\n').map(Number);
  const others = pids.filter(pid => pid !== process.pid);
  if (others.length !== 1) {
    throw new Error(`Expected one wsdb process for ${ipcPath}, found ${others.join(', ') || 'none'}`);
  }
  return others[0];
}

describe('wsdb death', () => {
  let ws: NativeWorldStateService;

  beforeEach(async () => {
    ws = await NativeWorldStateService.tmp();
    jest.spyOn(process, 'exit').mockImplementation(code => {
      throw new ProcessExit(code);
    });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await ws.close().catch(() => {});
  });

  it('exits the process on the next world state call', async () => {
    await ws.getCommitted().getTreeInfo(MerkleTreeId.NOTE_HASH_TREE);

    process.kill(wsdbPid(ws.getIpcPath()), 'SIGKILL');

    await expect(ws.getCommitted().getTreeInfo(MerkleTreeId.NOTE_HASH_TREE)).rejects.toEqual(new ProcessExit(1));
  });
});
