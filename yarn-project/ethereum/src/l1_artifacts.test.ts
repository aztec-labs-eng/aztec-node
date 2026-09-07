import { RollupArtifact } from './l1_artifacts.js';

describe('Rollup deployment artifacts', () => {
  it('supplies deployable bytecode for every linked library', () => {
    const libraries: Record<string, { contractBytecode: string }> = RollupArtifact.libraries.libraryCode;
    for (const references of Object.values(RollupArtifact.libraries.linkReferences)) {
      for (const name of Object.keys(references)) {
        expect(libraries[name]).toBeDefined();
        expect(libraries[name]?.contractBytecode).toMatch(/^0x[0-9a-f]+$/i);
      }
    }
  });
});
