import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { FunctionSelector } from '@aztec-labs/stdlib/abi';
import { AztecAddress } from '@aztec-labs/stdlib/aztec-address';
import { Gas } from '@aztec-labs/stdlib/gas';

import { getP2PDefaultConfig, parseAllowList } from './config.js';

describe('config', () => {
  it('parses allow list with required selectors', async () => {
    const instanceFunction = { address: await AztecAddress.random(), selector: FunctionSelector.random() };
    const classFunction = { classId: Fr.random(), selector: FunctionSelector.random() };

    const config = [instanceFunction, classFunction];

    const configStrings = [
      `I:${instanceFunction.address}:${instanceFunction.selector}`,
      `C:${classFunction.classId}:${classFunction.selector}`,
    ];
    const stringifiedAllowList = configStrings.join(',');

    const allowList = parseAllowList(stringifiedAllowList);
    expect(allowList).toEqual(config);
  });

  it('parses entries with flags', async () => {
    const address = await AztecAddress.random();
    const selector = FunctionSelector.random();
    const classId = Fr.random();
    const classSelector = FunctionSelector.random();

    const allowList = parseAllowList(`I:${address}:${selector}:os+cl=4,C:${classId}:${classSelector}:rn+os+cl=10`);

    expect(allowList).toEqual([
      { address, selector, onlySelf: true, calldataLength: 4 },
      { classId, selector: classSelector, rejectNullMsgSender: true, onlySelf: true, calldataLength: 10 },
    ]);
  });

  it('parses entries without flags (backward compat)', async () => {
    const address = await AztecAddress.random();
    const selector = FunctionSelector.random();

    const allowList = parseAllowList(`I:${address}:${selector}`);
    expect(allowList).toEqual([{ address, selector }]);
  });

  it('rejects entry with unknown flag', async () => {
    const address = await AztecAddress.random();
    const selector = FunctionSelector.random();
    expect(() => parseAllowList(`I:${address}:${selector}:unknown`)).toThrow('unknown flag');
  });

  it('rejects entry with invalid calldataLength', async () => {
    const address = await AztecAddress.random();
    const selector = FunctionSelector.random();
    expect(() => parseAllowList(`I:${address}:${selector}:cl=abc`)).toThrow('invalid calldataLength');
  });

  it('parses minimum setup gas flags', async () => {
    const address = await AztecAddress.random();
    const selector = FunctionSelector.random();
    const classId = Fr.random();

    const allowList = parseAllowList(
      `I:${address}:${selector}:l2=1000+da=64,C:${classId}:${selector}:l2=500,I:${address}:${selector}:da=32+os`,
    );

    expect(allowList).toEqual([
      { address, selector, minGas: new Gas(64, 1000) },
      { classId, selector, minGas: new Gas(0, 500) },
      { address, selector, minGas: new Gas(32, 0), onlySelf: true },
    ]);
  });

  it.each(['l2=abc', 'da=-1', 'l2=', 'l2=1e6', 'l2=40k', 'da=64gas', 'l2=40_000', 'da=4294967296'])(
    'rejects entry with invalid minimum gas flag %s',
    async flag => {
      const address = await AztecAddress.random();
      const selector = FunctionSelector.random();
      expect(() => parseAllowList(`I:${address}:${selector}:${flag}`)).toThrow('invalid minimum');
    },
  );

  it.each(['cl=4x', 'cl=', 'cl=4294967296'])('rejects entry with invalid calldataLength flag %s', async flag => {
    const address = await AztecAddress.random();
    const selector = FunctionSelector.random();
    expect(() => parseAllowList(`I:${address}:${selector}:${flag}`)).toThrow('invalid calldataLength');
  });

  it('accepts the largest UInt32 in numeric flags', async () => {
    const address = await AztecAddress.random();
    const selector = FunctionSelector.random();
    expect(parseAllowList(`I:${address}:${selector}:l2=4294967295+cl=4294967295`)).toEqual([
      { address, selector, minGas: new Gas(0, 4294967295), calldataLength: 4294967295 },
    ]);
  });

  it('rejects instance entry without selector', async () => {
    const address = await AztecAddress.random();
    expect(() => parseAllowList(`I:${address}`)).toThrow('selector is required');
  });

  it('rejects class entry without selector', () => {
    const classId = Fr.random();
    expect(() => parseAllowList(`C:${classId}`)).toThrow('selector is required');
  });

  it('rejects entry with unknown type', () => {
    expect(() => parseAllowList(`X:0x1234:0x12345678`)).toThrow('unknown type');
  });

  it('parses empty string', () => {
    expect(parseAllowList('')).toEqual([]);
  });

  it('handles whitespace in entries', async () => {
    const instanceFunction = { address: await AztecAddress.random(), selector: FunctionSelector.random() };
    const allowList = parseAllowList(` I:${instanceFunction.address}:${instanceFunction.selector} `);
    expect(allowList).toEqual([instanceFunction]);
  });

  it('defaults public IP service URLs', () => {
    const config = getP2PDefaultConfig();
    expect(config.publicIpServices).toEqual([
      'https://api.ipify.org/',
      'https://checkip.amazonaws.com/',
      'https://ifconfig.me/ip',
      'https://icanhazip.com/',
    ]);
  });
});
