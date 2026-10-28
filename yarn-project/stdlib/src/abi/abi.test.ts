import { jsonStringify } from '@aztec-labs/foundation/json-rpc';
import { countZodIssues } from '@aztec-labs/foundation/testing';

import { getTestContractArtifact } from '../tests/fixtures.js';
import {
  type AbiType,
  AbiTypeSchema,
  AbiValueSchema,
  type ContractArtifact,
  ContractArtifactSchema,
  type FunctionArtifact,
  FunctionType,
  getDefaultInitializer,
  getFunctionReturnType,
  getInitializer,
} from './abi.js';

describe('abi', () => {
  describe('getDefaultInitializer', () => {
    it('does not return non initializer functions', () => {
      const contract = { functions: [{ isInitializer: false }] } as ContractArtifact;
      expect(getDefaultInitializer(contract)).toBeUndefined();
    });

    it('returns the single initializer in a contract', () => {
      const contract = {
        functions: [
          { name: 'non-init', isInitializer: false },
          { name: 'init', isInitializer: true },
        ],
      } as ContractArtifact;
      expect(getDefaultInitializer(contract)?.name).toEqual('init');
    });

    it('prefers functions based on name', () => {
      const contract = {
        functions: [
          { name: 'foo', isInitializer: true },
          { name: 'constructor', isInitializer: true },
        ],
      } as ContractArtifact;
      expect(getDefaultInitializer(contract)?.name).toEqual('constructor');
    });

    it('prefers functions based on parameter length', () => {
      const contract = {
        functions: [
          { name: 'foo', parameters: [{}], isInitializer: true },
          { name: 'bar', parameters: [], isInitializer: true },
        ],
      } as ContractArtifact;
      expect(getDefaultInitializer(contract)?.name).toEqual('bar');
    });

    it('prefers functions based on type', () => {
      const contract = {
        functions: [
          { name: 'foo', isInitializer: true, functionType: FunctionType.PUBLIC },
          { name: 'bar', isInitializer: true, functionType: FunctionType.PRIVATE },
        ],
      } as ContractArtifact;
      expect(getDefaultInitializer(contract)?.name).toEqual('bar');
    });

    it('returns an initializer if there is any', () => {
      const contract = {
        functions: [
          { name: 'foo', isInitializer: true },
          { name: 'bar', isInitializer: true },
        ],
      } as ContractArtifact;
      expect(getDefaultInitializer(contract)?.name).toBeDefined();
    });
  });

  describe('getInitializer', () => {
    it('returns initializer based on name', () => {
      const contract = {
        functions: [
          { name: 'foo', isInitializer: true },
          { name: 'bar', isInitializer: true },
        ],
      } as ContractArtifact;
      expect(getInitializer(contract, 'bar')?.name).toEqual('bar');
    });

    it('fails if named initializer not found', () => {
      const contract = {
        functions: [
          { name: 'foo', isInitializer: true },
          { name: 'bar', isInitializer: true },
        ],
      } as ContractArtifact;
      expect(() => getInitializer(contract, 'baz')).toThrow();
    });

    it('fails if named initializer not an initializer', () => {
      const contract = {
        functions: [
          { name: 'foo', isInitializer: true },
          { name: 'bar', isInitializer: false },
        ],
      } as ContractArtifact;
      expect(() => getInitializer(contract, 'bar')).toThrow();
    });

    it('falls back to default initializer on undefined argument', () => {
      const contract = {
        functions: [
          { name: 'foo', isInitializer: true },
          { name: 'initializer', isInitializer: true },
        ],
      } as ContractArtifact;
      expect(getInitializer(contract, undefined)?.name).toEqual('initializer');
    });

    it('passes artifact through', () => {
      const contract = {} as ContractArtifact;
      const artifact = { name: 'foo', isInitializer: true } as FunctionArtifact;
      expect(getInitializer(contract, artifact)?.name).toEqual('foo');
    });

    it('validates artifact is initializer', () => {
      const contract = {} as ContractArtifact;
      const artifact = { name: 'foo', isInitializer: false } as FunctionArtifact;
      expect(() => getInitializer(contract, artifact)).toThrow();
    });
  });

  describe('getFunctionReturnType', () => {
    const boolean: AbiType = { kind: 'boolean' };
    const field: AbiType = { kind: 'field' };

    it('returns the type a function returns', () => {
      expect(getFunctionReturnType({ returnType: boolean })).toEqual(boolean);
    });

    it('returns undefined when the function returns nothing', () => {
      expect(getFunctionReturnType({})).toBeUndefined();
    });

    it('falls back to the deprecated list when only it is present', () => {
      expect(getFunctionReturnType({ returnTypes: [boolean] })).toEqual(boolean);
    });

    it('reads an empty deprecated list as returning nothing', () => {
      expect(getFunctionReturnType({ returnTypes: [] })).toBeUndefined();
    });

    it('prefers the singular type when both are present', () => {
      expect(getFunctionReturnType({ returnType: boolean, returnTypes: [field] })).toEqual(boolean);
    });

    it('rejects a deprecated list holding more than one type', () => {
      expect(() => getFunctionReturnType({ returnTypes: [boolean, field] })).toThrow(
        'Expected at most one return type',
      );
    });
  });

  describe('schemas', () => {
    const nestedType = (depth: number): AbiType => {
      let type: AbiType = { kind: 'field' };
      for (let i = 0; i < depth; i++) {
        type = { kind: 'array', length: 1, type };
      }
      return type;
    };

    it('parses nested types of realistic depth', () => {
      expect(AbiTypeSchema.parse(nestedType(20))).toEqual(nestedType(20));
    });

    it('rejects a deeply nested type without overflowing the stack', () => {
      expect(AbiTypeSchema.safeParse(nestedType(20_000)).success).toBe(false);
    });

    it('rejects a deeply nested value without overflowing the stack', () => {
      let value: unknown = { kind: 'boolean', value: true };
      for (let i = 0; i < 20_000; i++) {
        value = { kind: 'array', value: [value] };
      }
      expect(AbiValueSchema.safeParse(value).success).toBe(false);
    });

    it('rejects an artifact with an oversized storage layout without parsing each entry', () => {
      const json = JSON.parse(jsonStringify(getTestContractArtifact()));
      json.storageLayout = Object.fromEntries(Array.from({ length: 10_000 }, (_, i) => [`slot${i}`, {}]));
      const result = ContractArtifactSchema.safeParse(json);
      expect(result.success).toBe(false);
      expect(countZodIssues(result.error!.issues)).toBeLessThan(10);
    });
  });
});
