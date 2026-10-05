import type { LogFn } from '@aztec-labs/foundation/log';
import { writeFile } from 'fs/promises';

import { type BlsKeyDerivationOptions, resolveBlsKeyDerivationPolicy, selectBlsKey } from './bls_key_derivation.js';
import { computeBlsPublicKeyCompressed, withValidatorIndex } from './shared.js';
import { defaultBlsPath } from './utils.js';

export type GenerateBlsKeypairOptions = {
  mnemonic?: string;
  ikm?: string;
  blsPath?: string;
  g2?: boolean;
  compressed?: boolean;
  json?: boolean;
  out?: string;
} & BlsKeyDerivationOptions;

export async function generateBlsKeypair(options: GenerateBlsKeypairOptions, log: LogFn) {
  const { mnemonic, ikm, blsPath, compressed = true, json, out } = options;
  const blsKeyDerivation = resolveBlsKeyDerivationPolicy(options);
  const {
    path,
    privateKey: priv,
    candidate,
  } = selectBlsKey(blsKeyDerivation, {
    mnemonic,
    ikm,
    perValidatorPath: withValidatorIndex(blsPath ?? defaultBlsPath, 0),
  });
  const pub = await computeBlsPublicKeyCompressed(priv);
  const result = {
    path,
    ...(candidate > 0 ? { candidate } : {}),
    privateKey: priv,
    publicKey: pub,
    format: compressed ? 'compressed' : 'uncompressed',
  };
  if (out) {
    await writeFile(out, JSON.stringify(result, null, 2), { encoding: 'utf-8' });
    if (!json) {
      log(`Wrote BLS keypair to ${out}`);
      if (candidate > 0) {
        log(`BLS key derived from candidate ${candidate} at ${path}`);
      }
    }
  }
  if (json || !out) {
    log(JSON.stringify(result, null, 2));
  }
}
