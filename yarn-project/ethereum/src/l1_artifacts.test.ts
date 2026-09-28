import { RollupArtifact, asBytecode } from './l1_artifacts.js';

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

describe('asBytecode', () => {
  it('returns the bytecode when it is valid', () => {
    expect(asBytecode('Lib', '0xdeadBEEF')).toBe('0xdeadBEEF');
  });

  it.each([
    ['', 'empty'],
    ['0x', 'prefix only'],
    ['deadbeef', 'missing prefix'],
    ['0xdeadbee', 'odd number of digits'],
    ['0xnothex', 'non-hex digits'],
  ])('throws on %p (%s)', bytecode => {
    expect(() => asBytecode('Lib', bytecode)).toThrow('Invalid bytecode for Lib');
  });
});
