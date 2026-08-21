import type { ContractArtifact } from '@aztec/stdlib/abi';

import {
  checkArtifactOracleManifest,
  checkExecutingContractManifest,
  checkOracleManifest,
  getManifestSignature,
  getServedExecutionOracleSignatures,
} from './oracle_manifest.js';
import { ORACLE_REGISTRY } from './oracle_registry.js';

function artifactWithManifest(manifest: string | undefined): ContractArtifact {
  return {
    name: 'TestContract',
    aztecVersion: '1.0.0',
    functions: [],
    nonDispatchPublicFunctions: [],
    outputs: {
      structs: {},
      globals:
        manifest === undefined
          ? {}
          : { oracles: [{ name: 'AZTEC_ORACLE_MANIFEST_TestContract', value: { kind: 'string', value: manifest } }] },
    },
    fileMap: {},
    storageLayout: {},
  };
}

describe('getManifestSignature', () => {
  it('renders the canonical wire-structural grammar', () => {
    expect(getManifestSignature('aztec_misc_getRandomField', ORACLE_REGISTRY.aztec_misc_getRandomField)).toEqual(
      'aztec_misc_getRandomField:->field',
    );
    expect(
      getManifestSignature(
        'aztec_misc_assertCompatibleOracleVersion',
        ORACLE_REGISTRY.aztec_misc_assertCompatibleOracleVersion,
      ),
    ).toEqual('aztec_misc_assertCompatibleOracleVersion:u32,u32->()');
    expect(getManifestSignature('aztec_utl_getAuthWitness', ORACLE_REGISTRY.aztec_utl_getAuthWitness)).toEqual(
      'aztec_utl_getAuthWitness:field->array(field)',
    );
  });
});

describe('getServedExecutionOracleSignatures', () => {
  it('serves every live registry oracle', () => {
    const served = getServedExecutionOracleSignatures();
    for (const [name, entry] of Object.entries(ORACLE_REGISTRY)) {
      expect(served.get(name)).toEqual(getManifestSignature(name, entry));
    }
  });

  it('serves legacy oracles with their effective wire', () => {
    const served = getServedExecutionOracleSignatures();
    // Legacy params override, return inherited from the modern oracle.
    expect(served.get('aztec_utl_getL1ToL2MembershipWitness')).toEqual(
      'aztec_utl_getL1ToL2MembershipWitness:aztec-address,field,field->{field,array(field,36)}',
    );
  });
});

describe('checkOracleManifest', () => {
  const served = getServedExecutionOracleSignatures();

  it('accepts a manifest of served oracles', () => {
    expect(
      checkOracleManifest(
        ['aztec_misc_getRandomField:->field', 'aztec_utl_getAuthWitness:field->array(field)'],
        served,
      ),
    ).toEqual([]);
  });

  it('accepts an empty manifest', () => {
    expect(checkOracleManifest([], served)).toEqual([]);
  });

  it('reports an unserved oracle', () => {
    const issues = checkOracleManifest(['aztec_utl_nonexistentOracle:field->()'], served);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("'aztec_utl_nonexistentOracle' is not served");
    expect(issues[0]).toContain('aztec_utl_nonexistentOracle:field->()');
  });

  it('reports a signature mismatch with both sides', () => {
    const issues = checkOracleManifest(['aztec_misc_getRandomField:->u32'], served);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("'aztec_misc_getRandomField' signature mismatch");
    expect(issues[0]).toContain("expects 'aztec_misc_getRandomField:->u32'");
    expect(issues[0]).toContain("serves 'aztec_misc_getRandomField:->field'");
  });
});

describe('checkArtifactOracleManifest', () => {
  it('reports a missing manifest', () => {
    const issues = checkArtifactOracleManifest(artifactWithManifest(undefined));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('compiled without an oracle manifest');
  });

  it('accepts an artifact whose manifest is served', () => {
    expect(
      checkArtifactOracleManifest(
        artifactWithManifest('aztec_misc_getRandomField:->field\naztec_utl_getAuthWitness:field->array(field)'),
      ),
    ).toEqual([]);
  });

  it('reports each incompatible oracle', () => {
    const issues = checkArtifactOracleManifest(
      artifactWithManifest('aztec_misc_getRandomField:->u32\naztec_utl_nonexistentOracle:->()'),
    );
    expect(issues).toHaveLength(2);
  });

  it('reports a malformed manifest as an issue instead of throwing', () => {
    // Only an imported contract's pooled manifest, none matching this contract's name.
    const pooledOnly = artifactWithManifest('');
    pooledOnly.outputs.globals.oracles = [
      { name: 'AZTEC_ORACLE_MANIFEST_ImportedContract', value: { kind: 'string', value: '' } },
    ];
    const pooledIssues = checkArtifactOracleManifest(pooledOnly);
    expect(pooledIssues).toHaveLength(1);
    expect(pooledIssues[0]).toContain('malformed oracle manifest');

    const nonString = artifactWithManifest('');
    nonString.outputs.globals.oracles = [
      { name: 'AZTEC_ORACLE_MANIFEST_TestContract', value: { kind: 'integer', sign: false, value: '01' } },
    ];
    const nonStringIssues = checkArtifactOracleManifest(nonString);
    expect(nonStringIssues).toHaveLength(1);
    expect(nonStringIssues[0]).toContain('malformed oracle manifest');
  });
});

describe('checkExecutingContractManifest', () => {
  it('validates the class once and caches the result', async () => {
    let loads = 0;
    const loader = () => {
      loads++;
      return Promise.resolve(artifactWithManifest('aztec_misc_getRandomField:->u32'));
    };

    const first = await checkExecutingContractManifest('0x1234', loader);
    expect(first.alreadyChecked).toBe(false);
    expect(first.issues).toHaveLength(1);

    const second = await checkExecutingContractManifest('0x1234', loader);
    expect(second.alreadyChecked).toBe(true);
    expect(second.issues).toEqual(first.issues);
    expect(loads).toBe(1);
  });

  it('shares one validation between concurrent first checks', async () => {
    let loads = 0;
    let releaseLoad!: () => void;
    const gate = new Promise<void>(resolve => (releaseLoad = resolve));
    const loader = async () => {
      loads++;
      await gate;
      return artifactWithManifest('aztec_misc_getRandomField:->u32');
    };

    const first = checkExecutingContractManifest('0x9abc', loader);
    const second = checkExecutingContractManifest('0x9abc', loader);
    releaseLoad();

    const [a, b] = await Promise.all([first, second]);
    expect(loads).toBe(1);
    expect(a.alreadyChecked).toBe(false);
    expect(b.alreadyChecked).toBe(true);
    expect(b.issues).toEqual(a.issues);
  });

  it('does not cache a synchronously throwing loader', async () => {
    const first = await checkExecutingContractManifest('0xdef0', () => {
      throw new Error('store exploded');
    });
    expect(first.alreadyChecked).toBe(false);
    expect(first.issues[0]).toContain('failed to load the artifact');
    expect(first.issues[0]).toContain('store exploded');

    const retry = await checkExecutingContractManifest('0xdef0', () => Promise.resolve(artifactWithManifest('')));
    expect(retry.alreadyChecked).toBe(false);
    expect(retry.issues).toEqual([]);
  });

  it('reports a non-Error rejection reason without throwing', async () => {
    const result = await checkExecutingContractManifest('0x1357', () => Promise.reject(Symbol('boom')));
    expect(result.alreadyChecked).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toContain('failed to load the artifact');
    expect(result.issues[0]).toContain('Symbol(boom)');
  });

  it('reports a missing artifact without caching it', async () => {
    const missing = await checkExecutingContractManifest('0x5678', () => Promise.resolve(undefined));
    expect(missing.alreadyChecked).toBe(false);
    expect(missing.issues[0]).toContain('no artifact available');

    const retry = await checkExecutingContractManifest('0x5678', () => Promise.resolve(artifactWithManifest('')));
    expect(retry.alreadyChecked).toBe(false);
    expect(retry.issues).toEqual([]);
  });
});
