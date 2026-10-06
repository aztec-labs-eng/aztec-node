import { deriveBlsPrivateKey } from '@aztec-labs/foundation/crypto/bls';
import { decryptBn254Keystore, loadBn254Keystore } from '@aztec-labs/foundation/crypto/bls/bn254_keystore';
import { computeBn254RegistrationDigest } from '@aztec-labs/foundation/crypto/bn254';
import { loadKeystoreFile } from '@aztec-labs/node-keystore/loader';
import type { ValidatorKeyStore } from '@aztec-labs/node-keystore/types';
import { AztecAddress } from '@aztec-labs/stdlib/aztec-address';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { addValidatorKeys } from './add.js';
import {
  BLS_KEY_DERIVATION_V6,
  type BlsKeyDerivationOptions,
  type BlsKeyDerivationPolicy,
  BlsKeyOverGasBudgetError,
  estimateBlsKeyProofOfPossessionGas,
  estimateProofOfPossessionGas,
  resolveBlsKeyDerivationPolicy,
  selectBlsKey,
} from './bls_key_derivation.js';
import gasVectors from './fixtures/bn254_pop_gas_vectors.json' with { type: 'json' };
import { generateBlsKeypair } from './generate_bls_keypair.js';
import { newValidatorKeystore } from './new.js';
import { buildValidatorEntries, computeBlsPublicKeyCompressed, logValidatorSummaries } from './shared.js';

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

// With TEST_MNEMONIC, the BLS key at m/12381/3600/0/0/712 needs 98 hashToPoint attempts and 11 square roots
// (estimated 234,466 gas, over the v6 budget); the one at m/12381/3600/0/0/712/1 needs 9 and 3 (151,077 gas).
const OVER_BUDGET_ADDRESS_INDEX = 712;
const OVER_BUDGET_PATH = 'm/12381/3600/0/0/712';

// The key at m/12381/3600/0/0/1769 needs 65 attempts but only 6 square roots (194,055 gas), so it fits.
const MANY_ATTEMPTS_ADDRESS_INDEX = 1769;

// Public keys the CLI derived from TEST_MNEMONIC before derivation versions existed.
const PUBKEY_0_0_0 = '0x99b85154eae381ef1a1e4d220087bf487c009c73c26621ad46dfe6d589fa946b';
const PUBKEY_0_0_1 = '0x902745c577bdb58e2f5e292129bfa529477d488eef3813ead0688d452d5e0862';
const PUBKEY_0_0_712 = '0x27e1fd07eb9ec38a5ac4d164bdb8e64a93c8913aaab3deeadea2698a7d4c306c';
const PUBKEY_0_0_712_1 = '0x8d22b1b8d3590dd85795c8005438d2054141a5bb9b1d2d859b6cc2660159fb6d';

// Lowest estimate any key can have: one attempt that reaches the square root and succeeds.
const MIN_ESTIMATE = 132_694 + 515 + 4_580 + 1;

// A version whose budget only fits keys with a handful of attempts and one square root, to force retries.
const TIGHT_VERSION = { ...BLS_KEY_DERIVATION_V6, budget: 140_000 };
const TIGHT: BlsKeyDerivationPolicy = { mode: 'retry', version: TIGHT_VERSION };

function estimate(privateKey: string, version = BLS_KEY_DERIVATION_V6) {
  return estimateBlsKeyProofOfPossessionGas(version.gasModel, privateKey);
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
    policy: BlsKeyDerivationOptions | BlsKeyDerivationPolicy,
    overrides: Partial<Parameters<typeof buildValidatorEntries>[0]> = {},
  ) =>
    buildValidatorEntries({
      validatorCount: 1,
      accountIndex: 0,
      baseAddressIndex: OVER_BUDGET_ADDRESS_INDEX,
      mnemonic: TEST_MNEMONIC,
      feeRecipient,
      blsKeyDerivation: 'mode' in policy ? policy : resolveBlsKeyDerivationPolicy(policy),
      ...overrides,
    });

  describe('v6 gas model', () => {
    const { minStipend } = gasVectors.model.amsterdam;

    it('uses the measured amsterdam min-stipend model and a 10% margin under the 250k cap', () => {
      expect(BLS_KEY_DERIVATION_V6.gasModel).toEqual({
        fixed: minStipend.F,
        perAttempt: minStipend.A,
        perSqrtCall: minStipend.S,
        memoryNumerator: minStipend.QNumerator,
        memoryDenominator: minStipend.QDenominator,
      });
      expect(BLS_KEY_DERIVATION_V6.budget).toBe(250_000 * 0.9);
    });

    it.each(gasVectors.vectors.map(v => [v.label, v] as const))(
      'bounds the measured min stipend of %s tightly',
      (_label, vector) => {
        const digest = computeBn254RegistrationDigest({ x: BigInt(vector.pk1.x), y: BigInt(vector.pk1.y) });
        expect(digest).toEqual({
          point: { x: BigInt(vector.digest.x), y: BigInt(vector.digest.y) },
          attempts: vector.attempts,
          sqrtCalls: vector.sqrtCalls,
        });

        const estimated = estimateProofOfPossessionGas(
          BLS_KEY_DERIVATION_V6.gasModel,
          vector.attempts,
          vector.sqrtCalls,
        );
        const measured = vector.gas.amsterdam.minStipend;
        expect(estimated).toBeGreaterThanOrEqual(measured);
        expect(estimated - measured).toBeLessThanOrEqual(200);
      },
    );

    it('rounds the memory term up', () => {
      // 0.095975 * 3^2 = 0.863775, rounded up to 1.
      expect(estimateProofOfPossessionGas(BLS_KEY_DERIVATION_V6.gasModel, 3, 1)).toBe(132_694 + 3 * 515 + 4_580 + 1);
    });

    it('puts sk = 57193 over the budget', () => {
      const vector = gasVectors.vectors.find(v => v.label === 'tail-57193')!;
      expect(vector).toMatchObject({ attempts: 95, sqrtCalls: 18 });
      expect(estimate(`0x${(57193).toString(16).padStart(64, '0')}`)).toBeGreaterThan(BLS_KEY_DERIVATION_V6.budget);
    });
  });

  describe('resolveBlsKeyDerivationPolicy', () => {
    it('checks candidate 0 against v6 when no flag is given', () => {
      expect(resolveBlsKeyDerivationPolicy({})).toEqual({ mode: 'check', version: BLS_KEY_DERIVATION_V6 });
    });

    it('retries under --bls-key-derivation-v6', () => {
      expect(resolveBlsKeyDerivationPolicy({ blsKeyDerivationV6: true })).toEqual({
        mode: 'retry',
        version: BLS_KEY_DERIVATION_V6,
      });
    });

    it('keeps candidate 0 unchecked when the gas check is skipped', () => {
      expect(resolveBlsKeyDerivationPolicy({ skipBlsKeyGasCheck: true })).toEqual({ mode: 'none' });
    });

    it('applies a max gas with or without v6', () => {
      expect(resolveBlsKeyDerivationPolicy({ blsKeyDerivationMaxGas: 200_000 })).toEqual({
        mode: 'check',
        version: BLS_KEY_DERIVATION_V6,
        maxGas: 200_000,
      });
      expect(resolveBlsKeyDerivationPolicy({ blsKeyDerivationV6: true, blsKeyDerivationMaxGas: 200_000 })).toEqual({
        mode: 'retry',
        version: BLS_KEY_DERIVATION_V6,
        maxGas: 200_000,
      });
    });

    it('accepts max gas at both ends of its range', () => {
      for (const maxGas of [MIN_ESTIMATE, BLS_KEY_DERIVATION_V6.budget]) {
        expect(resolveBlsKeyDerivationPolicy({ blsKeyDerivationMaxGas: maxGas })).toMatchObject({ maxGas });
      }
    });

    it('rejects a max gas above the v6 budget', () => {
      expect(() => resolveBlsKeyDerivationPolicy({ blsKeyDerivationMaxGas: 225_001 })).toThrow(
        /can only lower the budget: 225001 is above the 225000 gas budget of BLS key derivation v6/,
      );
    });

    it('rejects a max gas no key could fit', () => {
      expect(() => resolveBlsKeyDerivationPolicy({ blsKeyDerivationMaxGas: MIN_ESTIMATE - 1 })).toThrow(
        new RegExp(`${MIN_ESTIMATE - 1} is below ${MIN_ESTIMATE}, the lowest .* so no key could fit`),
      );
      expect(() => resolveBlsKeyDerivationPolicy({ blsKeyDerivationMaxGas: 1.5 })).toThrow(/must be an integer/);
    });

    it.each([
      [{ blsKeyDerivationV6: true, skipBlsKeyGasCheck: true }, /--bls-key-derivation-v6 and --skip-bls-key-gas-check/],
      [
        { blsKeyDerivationMaxGas: 200_000, skipBlsKeyGasCheck: true },
        /--bls-key-derivation-max-gas and --skip-bls-key-gas-check/,
      ],
    ])('rejects %j', (options, error) => {
      expect(() => resolveBlsKeyDerivationPolicy(options)).toThrow(error);
    });
  });

  describe('selectBlsKey', () => {
    it('stops after the maximum number of candidates', () => {
      expect(() =>
        selectBlsKey(resolveBlsKeyDerivationPolicy({ blsKeyDerivationV6: true }), {
          mnemonic: TEST_MNEMONIC,
          perValidatorPath: OVER_BUDGET_PATH,
          maxCandidates: 1,
        }),
      ).toThrow(/No BLS key within the 225000 gas budget found for .*712 after 1 candidates/);
    });

    it('derives retry candidates from IKM as well', () => {
      const ikm = '0x' + '11'.repeat(32);
      const selected = selectBlsKey(TIGHT, { ikm, perValidatorPath: 'm/12381/3600/0/0/0' });
      expect(selected.path).toBe(`m/12381/3600/0/0/0${selected.candidate ? `/${selected.candidate}` : ''}`);
      expect(selected.privateKey).toBe(deriveBlsPrivateKey(undefined, ikm, selected.path));
      expect(estimate(selected.privateKey)).toBeLessThanOrEqual(TIGHT_VERSION.budget);
    });
  });

  describe('buildValidatorEntries', () => {
    it('selects BLS keys within the budget', async () => {
      const { validators } = await build(TIGHT, { validatorCount: 4, baseAddressIndex: 0 });
      for (const validator of validators) {
        expect(estimate(blsOf(validator))).toBeLessThanOrEqual(TIGHT_VERSION.budget);
      }
    });

    it('keeps the keys and paths of earlier releases for candidate 0', async () => {
      for (const options of [
        {},
        { blsKeyDerivationV6: true },
        { blsKeyDerivationMaxGas: 200_000 },
        { skipBlsKeyGasCheck: true },
      ]) {
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

    it('fails on an over-budget candidate 0 when no flag is given, suggesting v6 or skipping the check', async () => {
      await expect(build({})).rejects.toThrow(BlsKeyOverGasBudgetError);
      const error = await build({}).then(
        () => undefined,
        (err: Error) => err,
      );
      expect(error?.message).toMatch(
        /m\/12381\/3600\/0\/0\/712 is estimated at 234466 gas, above the 225000 budget of BLS key derivation v6/,
      );
      expect(error?.message).toMatch(/--bls-key-derivation-v6 .*--skip-bls-key-gas-check/);
      expect(error?.message).not.toMatch(/generated its mnemonic/);
    });

    it('tells the operator how to keep a mnemonic generated by this run', async () => {
      await expect(build({}, { mnemonicGenerated: true })).rejects.toThrow(
        /re-running without --mnemonic generates a new one: to keep this mnemonic, pass it back with --mnemonic/,
      );
    });

    it('keeps a candidate 0 with many attempts but few square roots', async () => {
      const { summaries } = await build({}, { baseAddressIndex: MANY_ATTEMPTS_ADDRESS_INDEX });
      expect(summaries[0]).toMatchObject({ blsPath: 'm/12381/3600/0/0/1769', blsCandidate: 0 });
    });

    it.each([{ skipBlsKeyGasCheck: true }])('keeps an over-budget candidate 0 with %j', async options => {
      const { summaries } = await build(options);
      expect(summaries[0]).toMatchObject({
        attesterBls: PUBKEY_0_0_712,
        blsPath: OVER_BUDGET_PATH,
        blsCandidate: 0,
      });
    });

    it('retries an over-budget candidate 0 under v6, moving only the BLS key', async () => {
      const options = { publisherCount: 2 };
      const unchecked = await build({ skipBlsKeyGasCheck: true }, options);
      const v6 = await build({ blsKeyDerivationV6: true }, options);

      expect(v6.summaries[0]).toMatchObject({
        attesterBls: PUBKEY_0_0_712_1,
        blsPath: `${OVER_BUDGET_PATH}/1`,
        blsCandidate: 1,
      });
      expect(blsOf(v6.validators[0])).toBe(deriveBlsPrivateKey(TEST_MNEMONIC, undefined, `${OVER_BUDGET_PATH}/1`));
      expect(estimate(blsOf(v6.validators[0]))).toBeLessThanOrEqual(BLS_KEY_DERIVATION_V6.budget);

      expect(v6.validators.map(withoutBls)).toEqual(unchecked.validators.map(withoutBls));
      expect(v6.summaries[0].attesterEth).toBe(unchecked.summaries[0].attesterEth);
      expect(v6.summaries[0].publisherEth).toEqual(unchecked.summaries[0].publisherEth);
    });

    it('retries until a candidate fits --bls-key-derivation-max-gas under v6', async () => {
      // Candidates 1 and 2 estimate 151,077 and 166,971 gas; candidate 3 estimates 147,014.
      const { validators, summaries } = await build({ blsKeyDerivationV6: true, blsKeyDerivationMaxGas: 150_000 });
      expect(summaries[0]).toMatchObject({ blsPath: `${OVER_BUDGET_PATH}/3`, blsCandidate: 3, blsMaxGas: 150_000 });
      expect(estimate(blsOf(validators[0]))).toBeLessThanOrEqual(150_000);

      // An explicit max gas is recorded whenever a retry candidate was selected; without one, nothing is recorded.
      const { summaries: loose } = await build({ blsKeyDerivationV6: true, blsKeyDerivationMaxGas: 225_000 });
      expect(loose[0]).toMatchObject({ blsCandidate: 1, blsMaxGas: 225_000 });
      const { summaries: unset } = await build({ blsKeyDerivationV6: true });
      expect(unset[0].blsMaxGas).toBeUndefined();
    });

    it('fails on a candidate 0 over --bls-key-derivation-max-gas without v6', async () => {
      // The key at m/12381/3600/0/0/1 estimates 143,916 gas.
      await expect(build({ blsKeyDerivationMaxGas: 140_000 }, { baseAddressIndex: 1 })).rejects.toThrow(
        /0\/0\/1 is estimated at 143916 gas, above the 140000 budget set by --bls-key-derivation-max-gas. Re-run with --bls-key-derivation-v6 .* or with a higher --bls-key-derivation-max-gas/,
      );
      const { summaries } = await build({ blsKeyDerivationMaxGas: 143_916 }, { baseAddressIndex: 1 });
      expect(summaries[0]).toMatchObject({ blsCandidate: 0, attesterBls: PUBKEY_0_0_1 });
      expect(summaries[0].blsMaxGas).toBeUndefined();
    });

    it('selects the same keys across runs for several validators and account indices', async () => {
      for (const accountIndex of [0, 2]) {
        const first = await build(TIGHT, { validatorCount: 3, baseAddressIndex: 5, accountIndex });
        const second = await build(TIGHT, { validatorCount: 3, baseAddressIndex: 5, accountIndex });
        expect(second.validators).toEqual(first.validators);
        expect(new Set(first.validators.map(blsOf)).size).toBe(3);
        for (const [i, summary] of first.summaries.entries()) {
          const base = `m/12381/3600/${accountIndex}/0/${5 + i}`;
          expect(summary.blsPath).toBe(summary.blsCandidate ? `${base}/${summary.blsCandidate}` : base);
          expect(estimate(blsOf(first.validators[i]))).toBeLessThanOrEqual(TIGHT_VERSION.budget);
        }
      }
    });

    it('appends the candidate to a custom --bls-path', async () => {
      const { validators, summaries } = await build(TIGHT, { baseAddressIndex: 0, blsPath: 'm/12381/3600/7/0/9' });
      expect(summaries[0].blsCandidate).toBeGreaterThan(0);
      expect(summaries[0].blsPath).toBe(`m/12381/3600/7/0/9/${summaries[0].blsCandidate}`);
      expect(blsOf(validators[0])).toBe(deriveBlsPrivateKey(TEST_MNEMONIC, undefined, summaries[0].blsPath!));
    });

    it('appends the candidate to legacy paths', async () => {
      process.env.LEGACY_BLS_CLI = 'true';
      try {
        const { summaries } = await build(TIGHT, { validatorCount: 3, baseAddressIndex: 3, accountIndex: 1 });
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
      const { summaries } = await build({ blsKeyDerivationV6: true });
      const logs: string[] = [];
      logValidatorSummaries(s => logs.push(s), summaries);
      expect(logs.join('\n')).toContain(`bls derivation path: ${OVER_BUDGET_PATH}/1 (candidate 1)`);
    });

    it('prints the max gas that selected a retry candidate', async () => {
      const { summaries } = await build({ blsKeyDerivationV6: true, blsKeyDerivationMaxGas: 150_000 });
      const logs: string[] = [];
      logValidatorSummaries(s => logs.push(s), summaries);
      expect(logs.join('\n')).toContain(`bls derivation path: ${OVER_BUDGET_PATH}/3 (candidate 3, max gas 150000)`);
    });
  });

  describe('newValidatorKeystore', () => {
    it('fails without writing a keystore when no flag is given and candidate 0 is over the budget', async () => {
      const file = 'over-budget.json';
      await expect(
        newValidatorKeystore(
          { dataDir: tmp, file, mnemonic: TEST_MNEMONIC, addressIndex: OVER_BUDGET_ADDRESS_INDEX, feeRecipient },
          () => {},
        ),
      ).rejects.toThrow(BlsKeyOverGasBudgetError);
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
          addressIndex: OVER_BUDGET_ADDRESS_INDEX - 1,
          password,
          encryptedKeystoreDir: outDir,
          feeRecipient,
          blsKeyDerivationV6: true,
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
        { path: `${OVER_BUDGET_PATH}/1`, pubkey: PUBKEY_0_0_712_1 },
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
          addressIndex: OVER_BUDGET_ADDRESS_INDEX,
          feeRecipient,
          blsKeyDerivationV6: true,
          json: true,
        },
        s => logs.push(s),
      );
      const output = JSON.parse(logs[0]);
      expect(output.blsKeyCandidates).toEqual([
        { attesterEth: expect.any(String), bls: PUBKEY_0_0_712_1, path: `${OVER_BUDGET_PATH}/1`, candidate: 1 },
      ]);
      expect(JSON.parse(readFileSync(join(tmp, 'json-v6.json'), 'utf-8'))).not.toHaveProperty('blsKeyCandidates');
    });

    it('records --bls-key-derivation-max-gas next to the candidate in JSON output', async () => {
      const logs: string[] = [];
      await newValidatorKeystore(
        {
          dataDir: tmp,
          file: 'json-max-gas.json',
          mnemonic: TEST_MNEMONIC,
          addressIndex: OVER_BUDGET_ADDRESS_INDEX,
          feeRecipient,
          blsKeyDerivationV6: true,
          blsKeyDerivationMaxGas: 150_000,
          json: true,
        },
        s => logs.push(s),
      );
      expect(JSON.parse(logs[0]).blsKeyCandidates).toEqual([
        {
          attesterEth: expect.any(String),
          bls: expect.any(String),
          path: `${OVER_BUDGET_PATH}/3`,
          candidate: 3,
          maxGas: 150_000,
        },
      ]);
    });

    it('rejects both flags before writing anything', async () => {
      await expect(
        newValidatorKeystore(
          {
            dataDir: tmp,
            file: 'both-flags.json',
            mnemonic: TEST_MNEMONIC,
            feeRecipient,
            blsKeyDerivationV6: true,
            skipBlsKeyGasCheck: true,
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
      const options = { mnemonic: TEST_MNEMONIC, addressIndex: OVER_BUDGET_ADDRESS_INDEX, feeRecipient };

      await expect(addValidatorKeys(existing, options, () => {})).rejects.toThrow(BlsKeyOverGasBudgetError);

      await addValidatorKeys(existing, { ...options, blsKeyDerivationV6: true }, () => {});
      const keystore = loadKeystoreFile(existing);
      expect(blsOf(keystore.validators![1])).toBe(
        deriveBlsPrivateKey(TEST_MNEMONIC, undefined, `${OVER_BUDGET_PATH}/1`),
      );
    });
  });

  describe('generateBlsKeypair', () => {
    it('applies the derivation version and reports the candidate', async () => {
      const blsPath = OVER_BUDGET_PATH;
      await expect(generateBlsKeypair({ mnemonic: TEST_MNEMONIC, blsPath }, () => {})).rejects.toThrow(
        BlsKeyOverGasBudgetError,
      );

      const logs: string[] = [];
      await generateBlsKeypair({ mnemonic: TEST_MNEMONIC, blsPath, blsKeyDerivationV6: true }, s => logs.push(s));
      expect(JSON.parse(logs[0])).toMatchObject({
        path: `${OVER_BUDGET_PATH}/1`,
        candidate: 1,
        publicKey: PUBKEY_0_0_712_1,
      });

      const unchecked: string[] = [];
      await generateBlsKeypair({ mnemonic: TEST_MNEMONIC, blsPath, skipBlsKeyGasCheck: true }, s => unchecked.push(s));
      const result = JSON.parse(unchecked[0]);
      expect(result).toMatchObject({ path: OVER_BUDGET_PATH, publicKey: PUBKEY_0_0_712 });
      expect(result).not.toHaveProperty('candidate');
    });
  });
});
