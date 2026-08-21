import { checkOracleManifest } from '@aztec/pxe/simulator';

import { TXE_ORACLE_REGISTRY, getServedTxeOracleSignatures } from './txe_oracle_registry.js';

describe('getServedTxeOracleSignatures', () => {
  it('serves every TXE registry oracle', () => {
    const served = getServedTxeOracleSignatures();
    expect(served.size).toEqual(Object.keys(TXE_ORACLE_REGISTRY).length);
    expect(served.get('aztec_txe_assertCompatibleOracleManifest')).toEqual(
      'aztec_txe_assertCompatibleOracleManifest:str->()',
    );
    expect(served.get('aztec_misc_assertCompatibleOracleManifest')).toEqual(
      'aztec_misc_assertCompatibleOracleManifest:->()',
    );
  });

  it('detects a tampered manifest line with a per-oracle diagnostic', () => {
    const served = getServedTxeOracleSignatures();
    expect(
      checkOracleManifest(
        ['aztec_txe_deploy:str,str,vector(field),field,field,aztec-address->array(field,12)'],
        served,
      ),
    ).toEqual([]);

    const issues = checkOracleManifest(['aztec_txe_deploy:str->()', 'aztec_txe_notServed:->()'], served);
    expect(issues).toHaveLength(2);
    expect(issues[0]).toContain("'aztec_txe_deploy' signature mismatch");
    expect(issues[1]).toContain("'aztec_txe_notServed' is not served");
  });
});
