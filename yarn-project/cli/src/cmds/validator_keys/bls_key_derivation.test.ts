import {
  AMSTERDAM_PROOF_OF_POSSESSION_GAS_MODEL,
  estimateBlsKeyProofOfPossessionGas,
} from '@aztec-labs/ethereum/bn254';
import { deriveBlsPrivateKey } from '@aztec-labs/foundation/crypto/bls';
import { decryptBn254Keystore, loadBn254Keystore } from '@aztec-labs/foundation/crypto/bls/bn254_keystore';
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
  resolveBlsKeyDerivationPolicy,
  selectBlsKey,
} from './bls_key_derivation.js';
import { generateBlsKeypair } from './generate_bls_keypair.js';
import { newValidatorKeystore } from './new.js';
import { buildValidatorEntries, computeBlsPublicKeyCompressed, logValidatorSummaries } from './shared.js';

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

// With TEST_MNEMONIC, the BLS key at m/12381/3600/0/0/384795 needs 98 hashToPoint attempts and 19 square roots
// (estimated 271,106 gas, over the v6 budget); the one at m/12381/3600/0/0/384795/1 needs 3 and 1 (138,820 gas).
const OVER_BUDGET_ADDRESS_INDEX = 384795;
const OVER_BUDGET_PATH = 'm/12381/3600/0/0/384795';

// The key at m/12381/3600/0/0/1769 needs 65 attempts but only 6 square roots (194,055 gas), so it fits.
const MANY_ATTEMPTS_ADDRESS_INDEX = 1769;

// Public keys the CLI derived from TEST_MNEMONIC before derivation versions existed.
const PUBKEY_0_0_0 = '0x99b85154eae381ef1a1e4d220087bf487c009c73c26621ad46dfe6d589fa946b';
const PUBKEY_0_0_1 = '0x902745c577bdb58e2f5e292129bfa529477d488eef3813ead0688d452d5e0862';
const PUBKEY_OVER_BUDGET = '0x1915ab7cc335d839a4c974752227a5d9f6854c9e446617c08666d81c03913236';
const PUBKEY_OVER_BUDGET_1 = '0xabcb7faa8c1e5c588506368c9a35014e35b9709e3e6eb00dd5195b640b9bfe34';

// Lowest estimate any key can have: one attempt that reaches the square root and succeeds.
const MIN_ESTIMATE = 132_694 + 515 + 4_580 + 1;

// A version whose budget only fits keys with a handful of attempts and one square root, to force retries.
const TIGHT_VERSION = { ...BLS_KEY_DERIVATION_V6, budget: 140_000 };
const TIGHT: BlsKeyDerivationPolicy = { mode: 'retry', version: TIGHT_VERSION };

function estimate(privateKey: string, version = BLS_KEY_DERIVATION_V6) {
  return estimateBlsKeyProofOfPossessionGas(version.gasModel, privateKey);
}

async function errorMessage(promise: Promise<unknown>): Promise<string | undefined> {
  return await promise.then(
    () => undefined,
    (err: Error) => err.message,
  );
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

  describe('v6', () => {
    it('freezes the amsterdam gas model and a 10% margin under the 300k cap', () => {
      // v6 must keep selecting the same keys: if the measured model changes, add a new derivation version instead.
      expect(BLS_KEY_DERIVATION_V6.gasModel).toEqual(AMSTERDAM_PROOF_OF_POSSESSION_GAS_MODEL);
      expect(BLS_KEY_DERIVATION_V6.gasModel).toEqual({
        fixed: 132_694,
        perAttempt: 515,
        perSqrtCall: 4_580,
        memoryNumerator: 95_975,
        memoryDenominator: 1_000_000,
      });
      expect(BLS_KEY_DERIVATION_V6.budget).toBe(300_000 * 0.9);
    });

    it('puts sk = 693083 over the budget', () => {
      // 97 attempts and 23 square roots; its measured min stipend is 288,787 gas.
      expect(estimate(`0x${(693083).toString(16).padStart(64, '0')}`)).toBeGreaterThan(BLS_KEY_DERIVATION_V6.budget);
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
      expect(() => resolveBlsKeyDerivationPolicy({ blsKeyDerivationMaxGas: 270_001 })).toThrow(
        /can only lower the budget: 270001 is above the 270000 gas budget of BLS key derivation v6/,
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
      ).toThrow(/No BLS key within the 270000 gas budget found for .*384795 after 1 candidates/);
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
        /m\/12381\/3600\/0\/0\/384795 is estimated at 271106 gas, above the 270000 budget of BLS key derivation v6/,
      );
      expect(error?.message).toMatch(/--bls-key-derivation-v6 .*--skip-bls-key-gas-check/);
      expect(error?.message).not.toMatch(/generated its mnemonic/);
    });

    it('tells the operator how to keep a mnemonic generated and shown by this run', async () => {
      await expect(build({}, { generatedMnemonic: 'shown' })).rejects.toThrow(
        /re-running without --mnemonic generates a new one: to keep this mnemonic, pass it back with --mnemonic/,
      );
    });

    it('suggests a plain re-run when this run generated its mnemonic without showing it', async () => {
      const message = await errorMessage(build({}, { generatedMnemonic: 'hidden' }));
      expect(message).toMatch(/This run generated a mnemonic without showing it, so re-running derives new keys/);
      expect(message).not.toMatch(/pass it back with --mnemonic/);
    });

    it('leaves the mnemonic out of the error when the BLS key comes from --ikm', async () => {
      const ikm = '0x' + '11'.repeat(32);
      const estimatedGas = estimate(deriveBlsPrivateKey(undefined, ikm, 'm/12381/3600/0/0/0'));
      const policy: BlsKeyDerivationPolicy = {
        mode: 'check',
        version: BLS_KEY_DERIVATION_V6,
        maxGas: estimatedGas - 1,
      };
      for (const generatedMnemonic of ['shown', 'hidden'] as const) {
        const message = await errorMessage(build(policy, { ikm, baseAddressIndex: 0, generatedMnemonic }));
        expect(message).toContain(`estimated at ${estimatedGas} gas`);
        expect(message).not.toMatch(/mnemonic/);
      }
    });

    it('keeps a candidate 0 with many attempts but few square roots', async () => {
      const { summaries } = await build({}, { baseAddressIndex: MANY_ATTEMPTS_ADDRESS_INDEX });
      expect(summaries[0]).toMatchObject({ blsPath: 'm/12381/3600/0/0/1769', blsCandidate: 0 });
    });

    it.each([{ skipBlsKeyGasCheck: true }])('keeps an over-budget candidate 0 with %j', async options => {
      const { summaries } = await build(options);
      expect(summaries[0]).toMatchObject({
        attesterBls: PUBKEY_OVER_BUDGET,
        blsPath: OVER_BUDGET_PATH,
        blsCandidate: 0,
      });
    });

    it('retries an over-budget candidate 0 under v6, moving only the BLS key', async () => {
      const options = { publisherCount: 2 };
      const unchecked = await build({ skipBlsKeyGasCheck: true }, options);
      const v6 = await build({ blsKeyDerivationV6: true }, options);

      expect(v6.summaries[0]).toMatchObject({
        attesterBls: PUBKEY_OVER_BUDGET_1,
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
      // Candidates 1 to 9 estimate at least 138,820 gas; candidate 10 estimates 138,305.
      const { validators, summaries } = await build({ blsKeyDerivationV6: true, blsKeyDerivationMaxGas: 138_500 });
      expect(summaries[0]).toMatchObject({ blsPath: `${OVER_BUDGET_PATH}/10`, blsCandidate: 10, blsMaxGas: 138_500 });
      expect(estimate(blsOf(validators[0]))).toBeLessThanOrEqual(138_500);

      // An explicit max gas is recorded whenever a retry candidate was selected; without one, nothing is recorded.
      const { summaries: loose } = await build({ blsKeyDerivationV6: true, blsKeyDerivationMaxGas: 270_000 });
      expect(loose[0]).toMatchObject({ blsCandidate: 1, blsMaxGas: 270_000 });
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
      const { summaries } = await build({ blsKeyDerivationV6: true, blsKeyDerivationMaxGas: 138_500 });
      const logs: string[] = [];
      logValidatorSummaries(s => logs.push(s), summaries);
      expect(logs.join('\n')).toContain(`bls derivation path: ${OVER_BUDGET_PATH}/10 (candidate 10, max gas 138500)`);
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

    it('asks to pass back a generated mnemonic only when it was printed before the error', async () => {
      // Almost every key estimates over the minimum, so one of several fresh validators fails the check.
      const options = { dataDir: tmp, count: 8, feeRecipient, blsKeyDerivationMaxGas: MIN_ESTIMATE };
      const logs: string[] = [];
      const printed = await errorMessage(newValidatorKeystore({ ...options, file: 'printed.json' }, s => logs.push(s)));
      expect(logs.join('\n')).toContain('Using new mnemonic:');
      expect(printed).toMatch(/pass it back with --mnemonic/);

      for (const hidden of [{ json: true }, { password: 'password', encryptedKeystoreDir: join(tmp, 'hidden') }]) {
        const message = await errorMessage(
          newValidatorKeystore({ ...options, ...hidden, file: 'hidden.json' }, () => {}),
        );
        expect(message).toMatch(/without showing it, so re-running derives new keys/);
        expect(message).not.toMatch(/pass it back with --mnemonic/);
      }
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
        { path: 'm/12381/3600/0/0/384794', pubkey: expect.any(String) },
        { path: `${OVER_BUDGET_PATH}/1`, pubkey: PUBKEY_OVER_BUDGET_1 },
      ]);
      expect(await computeBlsPublicKeyCompressed(decryptBn254Keystore(blsFiles[1], password))).toBe(
        PUBKEY_OVER_BUDGET_1,
      );
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
        { attesterEth: expect.any(String), bls: PUBKEY_OVER_BUDGET_1, path: `${OVER_BUDGET_PATH}/1`, candidate: 1 },
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
          blsKeyDerivationMaxGas: 138_500,
          json: true,
        },
        s => logs.push(s),
      );
      expect(JSON.parse(logs[0]).blsKeyCandidates).toEqual([
        {
          attesterEth: expect.any(String),
          bls: expect.any(String),
          path: `${OVER_BUDGET_PATH}/10`,
          candidate: 10,
          maxGas: 138_500,
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
    it('never asks to pass back the mnemonic it generates, since it does not print it', async () => {
      const existing = join(tmp, 'add-generated.json');
      writeFileSync(existing, JSON.stringify({ schemaVersion: 1, validators: [] }));
      const options = { count: 8, feeRecipient, blsKeyDerivationMaxGas: MIN_ESTIMATE };
      const message = await errorMessage(addValidatorKeys(existing, options, () => {}));
      expect(message).toMatch(/without showing it, so re-running derives new keys/);
      expect(message).not.toMatch(/pass it back with --mnemonic/);
    });

    it('records an empty derivation path for plaintext BLS keys that were already in the file', async () => {
      const existing = join(tmp, 'add-encrypt-existing.json');
      const existingBls = deriveBlsPrivateKey(TEST_MNEMONIC, undefined, 'm/12381/3600/0/0/5');
      writeFileSync(
        existing,
        JSON.stringify({
          schemaVersion: 1,
          validators: [{ attester: { eth: '0x' + '0a'.repeat(32), bls: existingBls }, feeRecipient }],
        }),
      );
      const options = { mnemonic: TEST_MNEMONIC, addressIndex: 7, password: 'password', feeRecipient };
      await addValidatorKeys(existing, { ...options, dataDir: join(tmp, 'add-encrypt-existing') }, () => {});

      const keystore = loadKeystoreFile(existing);
      const recorded = keystore.validators!.map(v => loadBn254Keystore((v.attester as any).bls.path).path);
      expect(recorded).toEqual(['', 'm/12381/3600/0/0/7']);
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
        publicKey: PUBKEY_OVER_BUDGET_1,
      });

      const unchecked: string[] = [];
      await generateBlsKeypair({ mnemonic: TEST_MNEMONIC, blsPath, skipBlsKeyGasCheck: true }, s => unchecked.push(s));
      const result = JSON.parse(unchecked[0]);
      expect(result).toMatchObject({ path: OVER_BUDGET_PATH, publicKey: PUBKEY_OVER_BUDGET });
      expect(result).not.toHaveProperty('candidate');
    });
  });
});
