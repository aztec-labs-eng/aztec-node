import { existsSync } from 'fs';
import { join, resolve } from 'path';

import { getPathToFile, getPathToFndFile } from './index.js';

const repoRoot = getPathToFile('');

// The foundation repository checks this one out as its `labs` submodule, and is the only place the protocol circuit
// sources exist. Detecting it independently of the resolver keeps a wrong resolution a failure rather than a skip.
const fndRoot = resolve(repoRoot, '..');
const inFndCheckout = existsSync(join(fndRoot, 'noir-projects/fnd'));

describe('getPathToFndFile', () => {
  (inFndCheckout ? it : it.skip)('resolves against the repository this one is a submodule of', () => {
    expect(getPathToFndFile('noir-projects/fnd/noir-protocol-circuits/crates')).toEqual(
      join(fndRoot, 'noir-projects/fnd/noir-protocol-circuits/crates'),
    );
    expect(existsSync(getPathToFndFile('noir-projects/fnd/noir-protocol-circuits/crates'))).toBe(true);
  });

  (inFndCheckout ? it.skip : it)('names the target and the repository holding it outside such a checkout', () => {
    expect(() => getPathToFndFile('noir-projects/fnd/noir-protocol-circuits/crates/blob/src/blob.nr')).toThrow(
      /noir-projects\/fnd\/noir-protocol-circuits\/crates\/blob\/src\/blob\.nr[\s\S]*aztec-packages/,
    );
  });
});
