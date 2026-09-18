import { RollupArtifact } from './l1_artifacts.js';

describe('attester-exit deployment artifacts', () => {
  it('provides deployable bytecode for the provider library required by the rollup', () => {
    const references = Object.values(RollupArtifact.libraries.linkReferences).flatMap(Object.keys);
    expect(references).toContain('AttesterExitExtLib');
    const library = RollupArtifact.libraries.libraryCode.AttesterExitExtLib;
    expect(library.contractBytecode).toMatch(/^0x[0-9a-f]+$/i);
    expect(RollupArtifact.contractAbi).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'function', name: 'getAttesterExitLimitState' }),
        expect.objectContaining({ type: 'function', name: 'getAttesterExitWindow' }),
        expect.objectContaining({ type: 'function', name: 'initiateWithdrawByAttester' }),
        expect.objectContaining({ type: 'function', name: 'initiateWithdrawByAttesterWithSignature' }),
        expect.objectContaining({ type: 'function', name: 'initiateWithdrawByAttesterBatch' }),
        expect.objectContaining({ type: 'function', name: 'initiateWithdrawByAttesterBatchUpToLimit' }),
      ]),
    );
  });
});
