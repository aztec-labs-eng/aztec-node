import { describeAcrossL1Forks, describeNameOnL1Fork, describeWithAnvil } from './l1_hardfork.js';

describe('l1_hardfork', () => {
  const originalHardfork = process.env.ANVIL_HARDFORK;

  afterEach(() => {
    if (originalHardfork === undefined) {
      delete process.env.ANVIL_HARDFORK;
    } else {
      process.env.ANVIL_HARDFORK = originalHardfork;
    }
  });

  describe('describeNameOnL1Fork', () => {
    it('keeps the name when ANVIL_HARDFORK is unset', () => {
      delete process.env.ANVIL_HARDFORK;
      expect(describeNameOnL1Fork('Registry')).toBe('Registry');
    });

    it('keeps the name when ANVIL_HARDFORK is empty', () => {
      process.env.ANVIL_HARDFORK = '';
      expect(describeNameOnL1Fork('Registry')).toBe('Registry');
    });

    it('appends the hardfork when ANVIL_HARDFORK is set', () => {
      process.env.ANVIL_HARDFORK = 'amsterdam';
      expect(describeNameOnL1Fork('Registry')).toBe('Registry (amsterdam)');
    });

    it('appends the normalized hardfork name', () => {
      process.env.ANVIL_HARDFORK = ' Osaka ';
      expect(describeNameOnL1Fork('Registry')).toBe('Registry (osaka)');
    });

    it('throws on an unknown hardfork', () => {
      process.env.ANVIL_HARDFORK = 'prague';
      expect(() => describeNameOnL1Fork('Registry')).toThrow(/Unknown ANVIL_HARDFORK 'prague'/);
    });
  });

  it.each([
    ['describeAcrossL1Forks', describeAcrossL1Forks],
    ['describeWithAnvil', describeWithAnvil],
  ])('%s forwards skip and only', (_name, tagged) => {
    expect(typeof tagged).toBe('function');
    expect(typeof tagged.skip).toBe('function');
    expect(typeof tagged.only).toBe('function');
  });
});
