import { deriveBlsPrivateKey } from '@aztec-labs/foundation/crypto/bls';
import { decryptBn254Keystore, loadBn254Keystore } from '@aztec-labs/foundation/crypto/bls/bn254_keystore';
import { computeBn254RegistrationDigestForPrivateKey } from '@aztec-labs/foundation/crypto/bn254';
import { loadKeystoreFile } from '@aztec-labs/node-keystore/loader';
import type { ValidatorKeyStore } from '@aztec-labs/node-keystore/types';
import { AztecAddress } from '@aztec-labs/stdlib/aztec-address';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { addValidatorKeys } from './add.js';
import {
  BLS_KEY_DERIVATION_V6_MAX_ITERATIONS,
  type BlsKeyDerivationOptions,
  BlsKeyOverIterationsError,
  resolveBlsKeyDerivationPolicy,
  selectBlsKey,
} from './bls_key_derivation.js';
import { generateBlsKeypair } from './generate_bls_keypair.js';
import { newValidatorKeystore } from './new.js';
import { buildValidatorEntries, computeBlsPublicKeyCompressed, logValidatorSummaries } from './shared.js';

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

// With TEST_MNEMONIC, the BLS key at m/12381/3600/0/0/712 needs 98 hashToPoint attempts and the one at
// m/12381/3600/0/0/712/1 needs 9.
const OVER_BOUND_ADDRESS_INDEX = 712;
const OVER_BOUND_PATH = 'm/12381/3600/0/0/712';

// Public keys the CLI derived from TEST_MNEMONIC before derivation versions existed.
const PUBKEY_0_0_0 = '0x99b85154eae381ef1a1e4d220087bf487c009c73c26621ad46dfe6d589fa946b';
const PUBKEY_0_0_1 = '0x902745c577bdb58e2f5e292129bfa529477d488eef3813ead0688d452d5e0862';
const PUBKEY_0_0_712 = '0x27e1fd07eb9ec38a5ac4d164bdb8e64a93c8913aaab3deeadea2698a7d4c306c';
const PUBKEY_0_0_712_1 = '0x8d22b1b8d3590dd85795c8005438d2054141a5bb9b1d2d859b6cc2660159fb6d';

function attempts(privateKey: string) {
  return computeBn254RegistrationDigestForPrivateKey(privateKey).attempts;
}

function blsOf(validator: ValidatorKeyStore): string {
  return (validator.attester as any).bls;
}

function withoutBls(validator: ValidatorKeyStore) {
  return { ...validator, attester: (validator.attester as any).eth };
}

describe('BLS key derivation version', () => {
  let feeRecipient: AztecAddress;
  let tmp: string;

  beforeAll(async () => {
    feeRecipient = await AztecAddress.random();
    tmp = mkdtempSync(join(tmpdir(), 'aztec-bls-derivation-'));
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const build = (
    options: BlsKeyDerivationOptions,
    overrides: Partial<Parameters<typeof buildValidatorEntries>[0]> = {},
  ) =>
    buildValidatorEntries({
      validatorCount: 1,
      accountIndex: 0,
      baseAddressIndex: OVER_BOUND_ADDRESS_INDEX,
      mnemonic: TEST_MNEMONIC,
      feeRecipient,
      blsKeyDerivation: resolveBlsKeyDerivationPolicy(options),
      ...overrides,
    });

  describe('resolveBlsKeyDerivationPolicy', () => {
    it('checks candidate 0 against v6 when no flag is given', () => {
      expect(resolveBlsKeyDerivationPolicy({})).toEqual({
        mode: 'check',
        maxIterations: BLS_KEY_DERIVATION_V6_MAX_ITERATIONS,
      });
    });

    it('retries under v6', () => {
      expect(resolveBlsKeyDerivationPolicy({ blsKeyDerivation: 'v6' })).toEqual({
        mode: 'retry',
        maxIterations: BLS_KEY_DERIVATION_V6_MAX_ITERATIONS,
      });
    });

    it.each(['v1', 'v4', 'v5'])('keeps candidate 0 unchecked under %s', version => {
      expect(resolveBlsKeyDerivationPolicy({ blsKeyDerivation: version })).toEqual({ mode: 'none' });
    });

    it('retries with an explicit max-iterations', () => {
      expect(resolveBlsKeyDerivationPolicy({ blsKeyDerivationMaxIterations: 10 })).toEqual({
        mode: 'retry',
        maxIterations: 10,
      });
    });

    it.each(['v7', 'v100', 'v0', '6', 'V6', 'v6.0', 'v06', 'latest', ''])('rejects unknown version %j', version => {
      expect(() => resolveBlsKeyDerivationPolicy({ blsKeyDerivation: version })).toThrow(
        /Unknown BLS key derivation version/,
      );
    });

    it.each([0, -1, 1.5, NaN])('rejects max-iterations %p', maxIterations => {
      expect(() => resolveBlsKeyDerivationPolicy({ blsKeyDerivationMaxIterations: maxIterations })).toThrow(
        /must be an integer >= 1/,
      );
    });

    it('rejects both flags together', () => {
      expect(() =>
        resolveBlsKeyDerivationPolicy({ blsKeyDerivation: 'v6', blsKeyDerivationMaxIterations: 10 }),
      ).toThrow(/cannot be used together/);
    });
  });

  describe('selectBlsKey', () => {
    it('stops after the maximum number of candidates', () => {
      expect(() =>
        selectBlsKey({ mode: 'retry', maxIterations: 1 }, TEST_MNEMONIC, undefined, OVER_BOUND_PATH, 3),
      ).toThrow(/No BLS key within 1 hash-to-point iterations found for m\/12381\/3600\/0\/0\/712 after 3 candidates/);
    });

    it('derives retry candidates from IKM as well', () => {
      const ikm = '0x' + '11'.repeat(32);
      const selected = selectBlsKey({ mode: 'retry', maxIterations: 1 }, undefined, ikm, 'm/12381/3600/0/0/0');
      expect(selected.path).toBe(`m/12381/3600/0/0/0${selected.candidate ? `/${selected.candidate}` : ''}`);
      expect(selected.privateKey).toBe(deriveBlsPrivateKey(undefined, ikm, selected.path));
      expect(attempts(selected.privateKey)).toBe(1);
    });
  });

  describe('buildValidatorEntries', () => {
    it('selects a BLS key within the max-iterations bound', async () => {
      const { validators } = await build(
        { blsKeyDerivationMaxIterations: 1 },
        { validatorCount: 4, baseAddressIndex: 0 },
      );
      for (const validator of validators) {
        expect(attempts(blsOf(validator))).toBeLessThanOrEqual(1);
      }
    });

    it('keeps the keys and paths of earlier releases for candidate 0', async () => {
      for (const options of [{}, { blsKeyDerivation: 'v5' }, { blsKeyDerivation: 'v6' }]) {
        const { validators, summaries } = await build(options, { validatorCount: 2, baseAddressIndex: 0 });
        expect(summaries.map(s => s.attesterBls)).toEqual([PUBKEY_0_0_0, PUBKEY_0_0_1]);
        expect(summaries.map(s => [s.blsPath, s.blsCandidate])).toEqual([
          ['m/12381/3600/0/0/0', 0],
          ['m/12381/3600/0/0/1', 0],
        ]);
        expect(validators.map(blsOf)).toEqual([
          deriveBlsPrivateKey(TEST_MNEMONIC, undefined, 'm/12381/3600/0/0/0'),
          deriveBlsPrivateKey(TEST_MNEMONIC, undefined, 'm/12381/3600/0/0/1'),
        ]);
      }
    });

    it('fails on an over-bound candidate 0 when no flag is given, suggesting both versions', async () => {
      await expect(build({})).rejects.toThrow(BlsKeyOverIterationsError);
      await expect(build({})).rejects.toThrow(
        /m\/12381\/3600\/0\/0\/712 needs 98 hash-to-point iterations, above the 64 .*--bls-key-derivation=v6.*--bls-key-derivation=v5/,
      );
    });

    it('keeps an over-bound candidate 0 under v5', async () => {
      const { summaries } = await build({ blsKeyDerivation: 'v5' });
      expect(summaries[0]).toMatchObject({ attesterBls: PUBKEY_0_0_712, blsPath: OVER_BOUND_PATH, blsCandidate: 0 });
    });

    it('retries an over-bound candidate 0 under v6, moving only the BLS key', async () => {
      const options = { publisherCount: 2, remoteSigner: undefined };
      const v5 = await build({ blsKeyDerivation: 'v5' }, options);
      const v6 = await build({ blsKeyDerivation: 'v6' }, options);

      expect(v6.summaries[0]).toMatchObject({
        attesterBls: PUBKEY_0_0_712_1,
        blsPath: `${OVER_BOUND_PATH}/1`,
        blsCandidate: 1,
      });
      expect(blsOf(v6.validators[0])).toBe(deriveBlsPrivateKey(TEST_MNEMONIC, undefined, `${OVER_BOUND_PATH}/1`));
      expect(attempts(blsOf(v6.validators[0]))).toBeLessThanOrEqual(BLS_KEY_DERIVATION_V6_MAX_ITERATIONS);

      expect(v6.validators.map(withoutBls)).toEqual(v5.validators.map(withoutBls));
      expect(v6.summaries[0].attesterEth).toBe(v5.summaries[0].attesterEth);
      expect(v6.summaries[0].publisherEth).toEqual(v5.summaries[0].publisherEth);
    });

    it('treats an explicit max-iterations like v6 with that bound', async () => {
      const { summaries: explicit } = await build({ blsKeyDerivationMaxIterations: 64 });
      const { summaries: v6 } = await build({ blsKeyDerivation: 'v6' });
      expect(explicit).toEqual(v6);

      // 98 attempts fit a bound of 98, so candidate 0 stays.
      const { summaries: loose } = await build({ blsKeyDerivationMaxIterations: 98 });
      expect(loose[0]).toMatchObject({ attesterBls: PUBKEY_0_0_712, blsCandidate: 0 });
    });

    it('selects the same keys across runs for several validators and account indices', async () => {
      const options = { blsKeyDerivationMaxIterations: 3 };
      for (const accountIndex of [0, 2]) {
        const first = await build(options, { validatorCount: 3, baseAddressIndex: 5, accountIndex });
        const second = await build(options, { validatorCount: 3, baseAddressIndex: 5, accountIndex });
        expect(second.validators).toEqual(first.validators);
        expect(new Set(first.validators.map(blsOf)).size).toBe(3);
        for (const [i, summary] of first.summaries.entries()) {
          const base = `m/12381/3600/${accountIndex}/0/${5 + i}`;
          expect(summary.blsPath).toBe(summary.blsCandidate ? `${base}/${summary.blsCandidate}` : base);
          expect(attempts(blsOf(first.validators[i]))).toBeLessThanOrEqual(3);
        }
      }
    });

    it('appends the candidate to a custom --bls-path', async () => {
      const { validators, summaries } = await build(
        { blsKeyDerivationMaxIterations: 1 },
        { baseAddressIndex: 0, blsPath: 'm/12381/3600/7/0/9' },
      );
      expect(summaries[0].blsCandidate).toBeGreaterThan(0);
      expect(summaries[0].blsPath).toBe(`m/12381/3600/7/0/9/${summaries[0].blsCandidate}`);
      expect(blsOf(validators[0])).toBe(deriveBlsPrivateKey(TEST_MNEMONIC, undefined, summaries[0].blsPath!));
    });

    it('appends the candidate to legacy paths', async () => {
      process.env.LEGACY_BLS_CLI = 'true';
      try {
        const { summaries } = await build(
          { blsKeyDerivationMaxIterations: 1 },
          { validatorCount: 2, baseAddressIndex: 3, accountIndex: 1 },
        );
        for (const [i, summary] of summaries.entries()) {
          const base = `m/12381/3600/${3 + i}/0/0`;
          expect(summary.blsPath).toBe(summary.blsCandidate ? `${base}/${summary.blsCandidate}` : base);
        }
        expect(summaries.some(s => s.blsCandidate)).toBe(true);
      } finally {
        delete process.env.LEGACY_BLS_CLI;
      }
    });
  });

  describe('logValidatorSummaries', () => {
    it('prints the derivation path of retry candidates', async () => {
      const { summaries } = await build({ blsKeyDerivation: 'v6' });
      const logs: string[] = [];
      logValidatorSummaries(s => logs.push(s), summaries);
      expect(logs.join('\n')).toContain(`bls derivation path: ${OVER_BOUND_PATH}/1 (candidate 1)`);
    });
  });

  describe('newValidatorKeystore', () => {
    it('fails without writing a keystore when no flag is given and candidate 0 is over the bound', async () => {
      const file = 'over-bound.json';
      await expect(
        newValidatorKeystore(
          { dataDir: tmp, file, mnemonic: TEST_MNEMONIC, addressIndex: OVER_BOUND_ADDRESS_INDEX, feeRecipient },
          () => {},
        ),
      ).rejects.toThrow(BlsKeyOverIterationsError);
      expect(() => readFileSync(join(tmp, file))).toThrow();
    });

    it('records the per-validator path, including the candidate, in BLS keystore files', async () => {
      const outDir = join(tmp, 'encrypted-v6');
      const password = 'password';
      await newValidatorKeystore(
        {
          dataDir: tmp,
          file: 'encrypted-v6.json',
          count: 2,
          mnemonic: TEST_MNEMONIC,
          addressIndex: OVER_BOUND_ADDRESS_INDEX - 1,
          password,
          encryptedKeystoreDir: outDir,
          feeRecipient,
          blsKeyDerivation: 'v6',
        },
        () => {},
      );

      const keystore = loadKeystoreFile(join(tmp, 'encrypted-v6.json'));
      const blsFiles = keystore.validators!.map(v => (v.attester as any).bls.path as string);
      const recorded = blsFiles.map(file => ({
        path: loadBn254Keystore(file).path,
        pubkey: loadBn254Keystore(file).pubkey,
      }));
      expect(recorded).toEqual([
        { path: 'm/12381/3600/0/0/711', pubkey: expect.any(String) },
        { path: `${OVER_BOUND_PATH}/1`, pubkey: PUBKEY_0_0_712_1 },
      ]);
      expect(await computeBlsPublicKeyCompressed(decryptBn254Keystore(blsFiles[1], password))).toBe(PUBKEY_0_0_712_1);
    });

    it('reports retry candidates in JSON output', async () => {
      const logs: string[] = [];
      await newValidatorKeystore(
        {
          dataDir: tmp,
          file: 'json-v6.json',
          mnemonic: TEST_MNEMONIC,
          addressIndex: OVER_BOUND_ADDRESS_INDEX,
          feeRecipient,
          blsKeyDerivation: 'v6',
          json: true,
        },
        s => logs.push(s),
      );
      const output = JSON.parse(logs[0]);
      expect(output.blsKeyCandidates).toEqual([
        { attesterEth: expect.any(String), bls: PUBKEY_0_0_712_1, path: `${OVER_BOUND_PATH}/1`, candidate: 1 },
      ]);
      expect(JSON.parse(readFileSync(join(tmp, 'json-v6.json'), 'utf-8'))).not.toHaveProperty('blsKeyCandidates');
    });

    it('rejects both flags before writing anything', async () => {
      await expect(
        newValidatorKeystore(
          {
            dataDir: tmp,
            file: 'both-flags.json',
            mnemonic: TEST_MNEMONIC,
            feeRecipient,
            blsKeyDerivation: 'v6',
            blsKeyDerivationMaxIterations: 10,
          },
          () => {},
        ),
      ).rejects.toThrow(/cannot be used together/);
      expect(() => readFileSync(join(tmp, 'both-flags.json'))).toThrow();
    });
  });

  describe('addValidatorKeys', () => {
    it('applies the derivation version to added validators', async () => {
      const existing = join(tmp, 'add-existing.json');
      writeFileSync(
        existing,
        JSON.stringify({ schemaVersion: 1, validators: [{ attester: '0x' + '0a'.repeat(32), feeRecipient }] }),
      );
      const options = { mnemonic: TEST_MNEMONIC, addressIndex: OVER_BOUND_ADDRESS_INDEX, feeRecipient };

      await expect(addValidatorKeys(existing, options, () => {})).rejects.toThrow(BlsKeyOverIterationsError);

      await addValidatorKeys(existing, { ...options, blsKeyDerivation: 'v6' }, () => {});
      const keystore = loadKeystoreFile(existing);
      expect(blsOf(keystore.validators![1])).toBe(
        deriveBlsPrivateKey(TEST_MNEMONIC, undefined, `${OVER_BOUND_PATH}/1`),
      );
    });
  });

  describe('generateBlsKeypair', () => {
    it('applies the derivation version and reports the candidate', async () => {
      const blsPath = OVER_BOUND_PATH;
      await expect(generateBlsKeypair({ mnemonic: TEST_MNEMONIC, blsPath }, () => {})).rejects.toThrow(
        BlsKeyOverIterationsError,
      );

      const logs: string[] = [];
      await generateBlsKeypair({ mnemonic: TEST_MNEMONIC, blsPath, blsKeyDerivation: 'v6' }, s => logs.push(s));
      expect(JSON.parse(logs[0])).toMatchObject({
        path: `${OVER_BOUND_PATH}/1`,
        candidate: 1,
        publicKey: PUBKEY_0_0_712_1,
      });

      const unchecked: string[] = [];
      await generateBlsKeypair({ mnemonic: TEST_MNEMONIC, blsPath, blsKeyDerivation: 'v5' }, s => unchecked.push(s));
      const result = JSON.parse(unchecked[0]);
      expect(result).toMatchObject({ path: OVER_BOUND_PATH, publicKey: PUBKEY_0_0_712 });
      expect(result).not.toHaveProperty('candidate');
    });
  });
});
