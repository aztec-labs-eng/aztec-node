import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { Point } from '@aztec-labs/foundation/curves/grumpkin';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { FunctionSelector } from '@aztec-labs/stdlib/abi';
import { AztecAddress } from '@aztec-labs/stdlib/aztec-address';
import { makeBlockHeader } from '@aztec-labs/stdlib/testing';
import { FunctionData } from '@aztec-labs/stdlib/tx';

import { mapFunctionDataFromNoir, mapFunctionDataToNoir } from './client.js';
import {
  mapAztecAddressFromNoir,
  mapAztecAddressToNoir,
  mapBlockHeaderFromNoir,
  mapBlockHeaderToNoir,
  mapEthAddressFromNoir,
  mapEthAddressToNoir,
  mapFieldFromNoir,
  mapFieldToNoir,
  mapFunctionSelectorFromNoir,
  mapFunctionSelectorToNoir,
  mapPointFromNoir,
  mapPointToNoir,
} from './common.js';

describe('Noir<>stdlib type conversion test suite', () => {
  describe('Round trip', () => {
    it('should map fields', () => {
      const field = new Fr(27n);
      expect(mapFieldFromNoir(mapFieldToNoir(field))).toEqual(field);
    });

    const point = new Point(new Fr(27n), new Fr(28n));

    it('should map points', () => {
      expect(mapPointFromNoir(mapPointToNoir(point))).toEqual(point);
    });

    it('should map aztec addresses', async () => {
      const aztecAddress = await AztecAddress.random();
      expect(mapAztecAddressFromNoir(mapAztecAddressToNoir(aztecAddress))).toEqual(aztecAddress);
    });

    it('should map eth addresses', () => {
      const ethAddress = EthAddress.random();
      expect(mapEthAddressFromNoir(mapEthAddressToNoir(ethAddress))).toEqual(ethAddress);
    });

    const functionSelector = new FunctionSelector(34);

    it('should map function selectors', () => {
      expect(mapFunctionSelectorFromNoir(mapFunctionSelectorToNoir(functionSelector))).toEqual(functionSelector);
    });

    const functionData = new FunctionData(functionSelector, /*isPrivate=*/ true);

    it('should map function data', () => {
      expect(mapFunctionDataFromNoir(mapFunctionDataToNoir(functionData))).toEqual(functionData);
    });

    it('should map block header', () => {
      const header = makeBlockHeader(35);
      expect(mapBlockHeaderFromNoir(mapBlockHeaderToNoir(header))).toEqual(header);
    });
  });
});
