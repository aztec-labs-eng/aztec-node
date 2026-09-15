import { RollupArtifact } from './l1_artifacts.js';

describe('provider-exit deployment artifacts', () => {
  it('provides deployable bytecode for the provider library required by the rollup', () => {
    const references = Object.values(RollupArtifact.libraries.linkReferences).flatMap(Object.keys);
    expect(references).toContain('ProviderExitExtLib');
    const library = RollupArtifact.libraries.libraryCode.ProviderExitExtLib;
    expect(library.contractBytecode).toMatch(/^0x[0-9a-f]+$/i);
    expect(RollupArtifact.contractAbi).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'function', name: 'getProviderExitLimitState' }),
        expect.objectContaining({ type: 'function', name: 'getProviderExitWindow' }),
        expect.objectContaining({ type: 'function', name: 'initiateProviderExit' }),
      ]),
    );
  });
});
