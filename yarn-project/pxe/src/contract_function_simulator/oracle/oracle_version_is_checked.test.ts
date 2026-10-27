import { PRIVATE_CONTEXT_INPUTS_LENGTH } from '@aztec-labs/constants';
import { times } from '@aztec-labs/foundation/collection';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { KeyStore } from '@aztec-labs/key-store';
import { OracleVersionCheckContractArtifact } from '@aztec-labs/noir-test-contracts.js/OracleVersionCheck';
import { type ACIRCallback, WASMSimulator, toACVMWitness } from '@aztec-labs/simulator/client';
import { FunctionSelector, FunctionType, countArgumentsSize } from '@aztec-labs/stdlib/abi';
import { AztecAddress } from '@aztec-labs/stdlib/aztec-address';
import type { L2TipsProvider } from '@aztec-labs/stdlib/block';
import type { AztecNode } from '@aztec-labs/stdlib/interfaces/server';
import { BlockHeader, CallContext } from '@aztec-labs/stdlib/tx';
import { mock } from 'jest-mock-extended';

import type { ContractClassService } from '../../contract/contract_class_service.js';
import type { ContractSyncService } from '../../contract/contract_sync_service.js';
import type { TxResolverService } from '../../messages/tx_resolver_service.js';
import { ORACLE_VERSION_MAJOR, ORACLE_VERSION_MINOR } from '../../oracle_version.js';
import type { AddressStore } from '../../storage/address_store/address_store.js';
import { CapsuleService } from '../../storage/capsule_store/capsule_service.js';
import type { CapsuleStore } from '../../storage/capsule_store/capsule_store.js';
import type { ContractStore } from '../../storage/contract_store/contract_store.js';
import { FactService } from '../../storage/fact_store/index.js';
import type { FactStore } from '../../storage/fact_store/index.js';
import type { NoteStore } from '../../storage/note_store/note_store.js';
import type { PrivateEventStore } from '../../storage/private_event_store/private_event_store.js';
import type { RecipientTaggingStore } from '../../storage/tagging_store/recipient_tagging_store.js';
import type { TaggingSecretSourcesStore } from '../../storage/tagging_store/tagging_secret_sources_store.js';
import { AnchoredContractData } from '../anchored_contract_data.js';
import { TransientArrayService } from '../transient_array_service.js';
import { buildACIRCallback } from './acir_callback.js';
import { UtilityExecutionOracle } from './utility_execution_oracle.js';

describe('Oracle Version Check test suite', () => {
  const simulator = new WASMSimulator();

  let contractStore: ReturnType<typeof mock<ContractStore>>;
  let contractClassService: ReturnType<typeof mock<ContractClassService>>;
  let noteStore: ReturnType<typeof mock<NoteStore>>;
  let keyStore: ReturnType<typeof mock<KeyStore>>;
  let addressStore: ReturnType<typeof mock<AddressStore>>;
  let aztecNode: ReturnType<typeof mock<AztecNode>>;
  let recipientTaggingStore: ReturnType<typeof mock<RecipientTaggingStore>>;
  let taggingSecretSourcesStore: ReturnType<typeof mock<TaggingSecretSourcesStore>>;
  let capsuleStore: ReturnType<typeof mock<CapsuleStore>>;
  let factStore: ReturnType<typeof mock<FactStore>>;
  let privateEventStore: ReturnType<typeof mock<PrivateEventStore>>;
  let contractSyncService: ReturnType<typeof mock<ContractSyncService>>;
  let txResolver: ReturnType<typeof mock<TxResolverService>>;
  let l2TipsStore: ReturnType<typeof mock<L2TipsProvider>>;
  let contractAddress: AztecAddress;
  let anchorBlockHeader: BlockHeader;

  beforeEach(async () => {
    contractStore = mock<ContractStore>();
    noteStore = mock<NoteStore>();
    keyStore = mock<KeyStore>();
    addressStore = mock<AddressStore>();
    aztecNode = mock<AztecNode>();
    recipientTaggingStore = mock<RecipientTaggingStore>();
    taggingSecretSourcesStore = mock<TaggingSecretSourcesStore>();
    capsuleStore = mock<CapsuleStore>();
    factStore = mock<FactStore>();
    privateEventStore = mock<PrivateEventStore>();
    contractSyncService = mock<ContractSyncService>();
    txResolver = mock<TxResolverService>();
    l2TipsStore = mock<L2TipsProvider>();

    anchorBlockHeader = BlockHeader.random();
    contractAddress = await AztecAddress.random();
    contractClassService = mock<ContractClassService>();
  });

  describe('private and utility functions', () => {
    // Enumerated from the artifact rather than listed by name: it also holds functions the contract does not declare.
    const functions = OracleVersionCheckContractArtifact.functions.filter(
      fn => fn.functionType === FunctionType.PRIVATE || fn.functionType === FunctionType.UTILITY,
    );

    it.each(functions)('$name checks the oracle version before calling any other oracle', async fn => {
      const oracleCalls: string[] = [];
      // Halting at the first oracle call keeps the test independent of what the function does after it.
      const callback = new Proxy<ACIRCallback>(
        {},
        {
          get: (_target, oracleName: string) => () => {
            oracleCalls.push(oracleName);
            return Promise.reject(new Error(`Halted at oracle ${oracleName}`));
          },
        },
      );

      // Private functions take the private context inputs ahead of their arguments.
      const privateContextInputsSize = fn.functionType === FunctionType.PRIVATE ? PRIVATE_CONTEXT_INPUTS_LENGTH : 0;
      const initialWitness = toACVMWitness(
        0,
        times(privateContextInputsSize + countArgumentsSize(fn), () => Fr.ZERO),
      );

      await expect(
        simulator.executeUserCircuit(
          initialWitness,
          { ...fn, contractName: OracleVersionCheckContractArtifact.name },
          callback,
        ),
      ).rejects.toThrow();

      expect(oracleCalls).toEqual(['aztec_misc_assertCompatibleOracleVersion']);
    });
  });

  describe('oracle version mismatch error messages', () => {
    let oracle: UtilityExecutionOracle;

    beforeEach(() => {
      oracle = new UtilityExecutionOracle({
        callContext: new CallContext(AztecAddress.NULL_MSG_SENDER, contractAddress, FunctionSelector.empty(), true),
        authWitnesses: [],
        capsules: [],
        anchorBlockHeader,
        anchoredContractData: new AnchoredContractData(contractStore, contractClassService, anchorBlockHeader),
        noteStore,
        keyStore,
        addressStore,
        aztecNode,
        recipientTaggingStore,
        taggingSecretSourcesStore,
        capsuleService: new CapsuleService(capsuleStore, []),
        factService: new FactService(factStore, []),
        privateEventStore,
        txResolver,
        contractSyncService,
        changeSetId: 'test',
        scopes: [],
        l2TipsStore,
        simulator,
        utilityExecutor: () => Promise.resolve(),
        transientArrayService: new TransientArrayService(),
      });
    });

    it('suggests upgrading PXE when contract major oracle version is newer', () => {
      const newerMajor = ORACLE_VERSION_MAJOR + 1;
      expect(() => oracle.assertCompatibleOracleVersion(newerMajor, ORACLE_VERSION_MINOR)).toThrow(
        /Incompatible private environment version:.*Upgrade your private environment to a compatible version.*See https:\/\/docs\.aztec\.network\/errors\/8/,
      );
    });

    it('suggests recompiling the contract when contract major oracle version is older', () => {
      const olderMajor = ORACLE_VERSION_MAJOR - 1;
      expect(() => oracle.assertCompatibleOracleVersion(olderMajor, ORACLE_VERSION_MINOR)).toThrow(
        /Incompatible private environment version:.*Recompile the contract with a compatible version of Aztec\.nr.*See https:\/\/docs\.aztec\.network\/errors\/8/,
      );
    });

    it('does not throw when major version matches', () => {
      expect(() => oracle.assertCompatibleOracleVersion(ORACLE_VERSION_MAJOR, ORACLE_VERSION_MINOR)).not.toThrow();
    });

    it('does not throw when contract minor version is higher than PXE minor version', () => {
      // We don't throw if AZTEC_NR_MINOR > PXE_MINOR because if a contract is updated to use a newer Aztec.nr
      // dependency without actually using any of the new oracles then there is no reason to throw.
      const higherMinor = ORACLE_VERSION_MINOR + 5;
      expect(() => oracle.assertCompatibleOracleVersion(ORACLE_VERSION_MAJOR, higherMinor)).not.toThrow();
    });

    it('stores the contract oracle version for later diagnostics', () => {
      oracle.assertCompatibleOracleVersion(ORACLE_VERSION_MAJOR, 3);
      expect(oracle.nonOracleFunctionGetContractOracleVersion()).toEqual({ major: ORACLE_VERSION_MAJOR, minor: 3 });
    });

    it('provides enhanced error when oracle not found and contract minor > PXE minor', () => {
      // Register a higher minor version (contract expects oracles the PXE doesn't have)
      oracle.assertCompatibleOracleVersion(ORACLE_VERSION_MAJOR, ORACLE_VERSION_MINOR + 1);

      // Build the ACIR callback and try to call a non-existent oracle
      const callback = buildACIRCallback(oracle);
      const contractVersion = `${ORACLE_VERSION_MAJOR}\\.${ORACLE_VERSION_MINOR + 1}`;
      const pxeVersion = `${ORACLE_VERSION_MAJOR}\\.${ORACLE_VERSION_MINOR}`;
      expect(() => callback['aztec_utl_someNewOracle']()).toThrow(
        new RegExp(
          `Oracle 'aztec_utl_someNewOracle' not found\\. This usually means the contract requires a newer private execution environment than you have\\. Upgrade your private execution environment to a compatible version\\. The contract was compiled with Aztec\\.nr oracle version ${contractVersion}, but this private execution environment only supports up to ${pxeVersion}\\.`,
        ),
      );
    });

    it('suggests contract bug when oracle not found and contract minor <= PXE minor', () => {
      const contractMinor = 0;
      oracle.assertCompatibleOracleVersion(ORACLE_VERSION_MAJOR, contractMinor);

      const callback = buildACIRCallback(oracle);
      expect(() => callback['aztec_utl_someNewOracle']()).toThrow(
        new RegExp(
          `Oracle 'aztec_utl_someNewOracle' not found\\. The contract's oracle version \\(${ORACLE_VERSION_MAJOR}\\.${contractMinor}\\) is compatible with this private execution environment \\(${ORACLE_VERSION_MAJOR}\\.${ORACLE_VERSION_MINOR}\\), so all standard oracles should be available\\. This could mean the contract was compiled against a modified version of Aztec\\.nr, or that it references an oracle that does not exist\\.`,
        ),
      );
    });
  });
});
