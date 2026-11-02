import { MAX_PROCESSABLE_L2_GAS, MAX_TX_DA_GAS } from '@aztec-labs/constants';
import { BlockNumber } from '@aztec-labs/foundation/branded-types';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { GrumpkinScalar, Point } from '@aztec-labs/foundation/curves/grumpkin';
import type { KeyStore } from '@aztec-labs/key-store';
import { WASMSimulator } from '@aztec-labs/simulator/client';
import { FunctionSelector } from '@aztec-labs/stdlib/abi';
import type { AuthWitness } from '@aztec-labs/stdlib/auth-witness';
import { AztecAddress } from '@aztec-labs/stdlib/aztec-address';
import { BlockHash, type L2TipsProvider } from '@aztec-labs/stdlib/block';
import { CompleteAddress } from '@aztec-labs/stdlib/contract';
import { Gas, GasFees, GasSettings } from '@aztec-labs/stdlib/gas';
import { siloNullifier } from '@aztec-labs/stdlib/hash';
import type { AztecNode } from '@aztec-labs/stdlib/interfaces/server';
import { AppTaggingSecret, OnchainDeliveryMode } from '@aztec-labs/stdlib/logs';
import { makeInvalidAztecAddress } from '@aztec-labs/stdlib/testing';
import { BlockHeader, CallContext, type Capsule, TxContext } from '@aztec-labs/stdlib/tx';
import { jest } from '@jest/globals';
import { type MockProxy, mock } from 'jest-mock-extended';

import type { ContractSyncService } from '../../contract/contract_sync_service.js';
import type { ResolveCustomRequest } from '../../hooks/resolve_custom_request.js';
import type {
  ResolveTaggingSecretStrategy,
  TaggingSecretStrategy,
} from '../../hooks/resolve_tagging_secret_strategy.js';
import type { TxResolverService } from '../../messages/tx_resolver_service.js';
import type { AddressStore } from '../../storage/address_store/address_store.js';
import { CapsuleService } from '../../storage/capsule_store/capsule_service.js';
import type { CapsuleStore } from '../../storage/capsule_store/capsule_store.js';
import { FactService } from '../../storage/fact_store/index.js';
import type { FactStore } from '../../storage/fact_store/index.js';
import type { NoteStore } from '../../storage/note_store/note_store.js';
import type { PrivateEventStore } from '../../storage/private_event_store/private_event_store.js';
import type { RecipientTaggingStore } from '../../storage/tagging_store/recipient_tagging_store.js';
import type { SenderTaggingStore } from '../../storage/tagging_store/sender_tagging_store.js';
import type { TaggingSecretSourcesStore } from '../../storage/tagging_store/tagging_secret_sources_store.js';
import type { AnchoredContractData } from '../anchored_contract_data.js';
import { EphemeralArrayService } from '../ephemeral_array_service.js';
import { ExecutionNoteCache } from '../execution_note_cache.js';
import { ExecutionTaggingIndexCache } from '../execution_tagging_index_cache.js';
import { HashedValuesCache } from '../hashed_values_cache.js';
import { EphemeralArray } from '../noir-structs/ephemeral_array.js';
import { Option } from '../noir-structs/option.js';
import { TransientArrayService } from '../transient_array_service.js';
import { PrivateExecutionOracle, type PrivateExecutionOracleArgs } from './private_execution_oracle.js';

const INVALID_ADDRESS = makeInvalidAztecAddress();

describe('PrivateExecutionOracle', () => {
  let contractAddress: AztecAddress;
  let callContext: CallContext;
  let txContext: TxContext;

  beforeAll(async () => {
    contractAddress = await AztecAddress.random();
    callContext = new CallContext(
      AztecAddress.fromFieldUnsafe(Fr.MAX_FIELD_VALUE),
      contractAddress,
      FunctionSelector.empty(),
      false,
    );
    txContext = TxContext.from({
      chainId: new Fr(10),
      version: new Fr(20),
      gasSettings: GasSettings.fallback({
        gasLimits: new Gas(MAX_TX_DA_GAS, MAX_PROCESSABLE_L2_GAS),
        maxFeesPerGas: new GasFees(10, 10),
      }),
    });
  });

  describe('senderForTags', () => {
    it('returns the initial default', async () => {
      const wallet = await AztecAddress.random();
      const oracle = makeOracle({ senderForTags: wallet });

      const result = await oracle.getSenderForTags();
      expect(result.value).toEqual(wallet);
    });

    it('returns none when no default was provided', async () => {
      const oracle = makeOracle();

      const result = await oracle.getSenderForTags();
      expect(result.isNone()).toBe(true);
    });
  });

  describe('getAppAddressDerivedTaggingSecret', () => {
    it('rejects a sender outside the execution scopes', async () => {
      const inScopeSender = await AztecAddress.random();
      const outOfScopeSender = await AztecAddress.random();
      const recipient = await AztecAddress.random();
      const oracle = makeOracle({ scopes: [inScopeSender] });

      await expect(oracle.getAppAddressDerivedTaggingSecret(outOfScopeSender, recipient)).rejects.toThrow(
        'is not in the allowed scopes list',
      );
    });

    it('returns a secret for a sender inside the execution scopes', async () => {
      const account = await makeAccount();
      const recipient = (await CompleteAddress.random()).address;

      const oracle = makeOracle(account.oracleArgs);

      const result = await oracle.getAppAddressDerivedTaggingSecret(account.address, recipient);
      expect(result.isSome()).toBe(true);
    });

    it('returns none for an invalid recipient', async () => {
      const account = await makeAccount();

      const oracle = makeOracle(account.oracleArgs);

      const result = await oracle.getAppAddressDerivedTaggingSecret(account.address, INVALID_ADDRESS);
      expect(result.isNone()).toBe(true);
    });
  });

  describe('resolveTaggingStrategy', () => {
    let sender: AztecAddress;
    let recipient: AztecAddress;

    beforeAll(async () => {
      sender = await AztecAddress.random();
      recipient = await AztecAddress.random();
    });

    it('defaults an unconstrained self-send to an address-derived shared secret', async () => {
      const account = await makeAccount();
      const oracle = makeOracle(account.oracleArgs);

      await expect(
        oracle.resolveTaggingStrategy(account.address, account.address, OnchainDeliveryMode.UNCONSTRAINED),
      ).resolves.toEqual({
        type: 'unconstrained-secret',
        secret: await addressDerivedSecret(account, account.address),
      });
    });

    it('keeps a hooked interactive handshake on an unconstrained self-send', async () => {
      const { oracle } = makeHookedOracle({ strategy: { type: 'interactive-handshake' } });

      await expect(oracle.resolveTaggingStrategy(sender, sender, OnchainDeliveryMode.UNCONSTRAINED)).resolves.toEqual({
        type: 'interactive-handshake',
      });
    });

    it('resolves an address-derived strategy to the unconstrained secret', async () => {
      const account = await makeAccount();
      const { oracle } = makeHookedOracle({ strategy: { type: 'address-derived' }, ...account.oracleArgs });

      await expect(
        oracle.resolveTaggingStrategy(account.address, recipient, OnchainDeliveryMode.UNCONSTRAINED),
      ).resolves.toEqual({ type: 'unconstrained-secret', secret: await addressDerivedSecret(account, recipient) });
    });

    it('rejects an address-derived strategy for a sender outside the execution scopes', async () => {
      const { oracle } = makeHookedOracle({ strategy: { type: 'address-derived' }, scopes: [recipient] });

      await expect(oracle.resolveTaggingStrategy(sender, recipient, OnchainDeliveryMode.UNCONSTRAINED)).rejects.toThrow(
        'is not in the allowed scopes list',
      );
    });

    it('rejects an address-derived strategy for an invalid recipient', async () => {
      const account = await makeAccount();
      const { oracle } = makeHookedOracle({ strategy: { type: 'address-derived' }, ...account.oracleArgs });

      await expect(
        oracle.resolveTaggingStrategy(account.address, INVALID_ADDRESS, OnchainDeliveryMode.UNCONSTRAINED),
      ).rejects.toThrow(`invalid recipient ${INVALID_ADDRESS}`);
    });

    it('app-silos a raw arbitrary-secret point before handing it to the contract', async () => {
      const point = await Point.random();
      const { oracle } = makeHookedOracle({ strategy: { type: 'arbitrary-secret', secret: point } });

      const expected = await AppTaggingSecret.computeDirectional(point, contractAddress, recipient);
      await expect(
        oracle.resolveTaggingStrategy(sender, recipient, OnchainDeliveryMode.UNCONSTRAINED),
      ).resolves.toEqual({ type: 'unconstrained-secret', secret: expected.secret });
    });

    it('keeps a hooked non-interactive handshake on an unconstrained self-send', async () => {
      const { oracle } = makeHookedOracle({ strategy: { type: 'non-interactive-handshake' } });

      await expect(oracle.resolveTaggingStrategy(sender, sender, OnchainDeliveryMode.UNCONSTRAINED)).resolves.toEqual({
        type: 'non-interactive-handshake',
      });
    });

    it('passes the correct message context to the hook', async () => {
      const contractClassId = Fr.random();
      const { oracle, resolveTaggingSecretStrategy } = makeHookedOracle({
        strategy: { type: 'non-interactive-handshake' },
        contractClassId,
      });

      await oracle.resolveTaggingStrategy(sender, recipient, OnchainDeliveryMode.CONSTRAINED);

      expect(resolveTaggingSecretStrategy).toHaveBeenCalledWith({
        contractAddress,
        contractClassId,
        sender,
        recipient,
        deliveryMode: OnchainDeliveryMode.CONSTRAINED,
      });
    });

    const makeHookedOracle = ({
      strategy,
      contractClassId = Fr.random(),
      ...overrides
    }: {
      strategy: TaggingSecretStrategy;
      contractClassId?: Fr;
    } & Partial<PrivateExecutionOracleArgs>) => {
      const resolveTaggingSecretStrategy = jest.fn<ResolveTaggingSecretStrategy>().mockResolvedValue(strategy);
      const anchoredContractData = mock<AnchoredContractData>();
      anchoredContractData.getCurrentClassId.mockResolvedValue(contractClassId);
      const oracle = makeOracle({ hooks: { resolveTaggingSecretStrategy }, anchoredContractData, ...overrides });
      return { oracle, resolveTaggingSecretStrategy };
    };

    const addressDerivedSecret = async (account: Account, recipient: AztecAddress) => {
      const secret = await AppTaggingSecret.computeViaEcdh(
        account.completeAddress,
        account.ivsk,
        recipient,
        contractAddress,
        recipient,
      );
      return secret!.secret;
    };
  });

  describe('getNullifierStatuses', () => {
    const pending = new Fr(1);
    const settled = new Fr(2);
    const missing = new Fr(3);
    const settledBlock = { l2BlockNumber: BlockNumber(7), l2BlockHash: BlockHash.random() };

    const service = new EphemeralArrayService();
    let noteCache: ExecutionNoteCache;
    let aztecNode: MockProxy<AztecNode>;
    let oracle: PrivateExecutionOracle;

    const getNullifierStatuses = async (innerNullifiers: Fr[]) =>
      (await oracle.getNullifierStatuses(EphemeralArray.fromValues(service, innerNullifiers))).readAll(service);

    beforeEach(async () => {
      noteCache = new ExecutionNoteCache(Fr.ZERO);
      await noteCache.nullifierCreated(contractAddress, pending);

      const settledSiloed = await siloNullifier(contractAddress, settled);
      aztecNode = mock<AztecNode>();
      aztecNode.findLeavesIndexes.mockImplementation((_referenceBlock, _treeId, leaves) =>
        Promise.resolve(leaves.map(leaf => (leaf.equals(settledSiloed) ? { data: 0n, ...settledBlock } : undefined))),
      );

      oracle = makeOracle({ noteCache, aztecNode, anchorBlockHeader: BlockHeader.empty() });
    });

    it('reports a nullifier emitted in this transaction as existing with no origin block, without querying the node', async () => {
      await expect(getNullifierStatuses([pending])).resolves.toEqual([{ exists: true, originBlock: Option.none() }]);
      expect(aztecNode.findLeavesIndexes).not.toHaveBeenCalled();
    });

    it('reports a settled nullifier with the block it was included in', async () => {
      await expect(getNullifierStatuses([settled])).resolves.toEqual([
        {
          exists: true,
          originBlock: Option.some({ blockNumber: 7, blockHash: new Fr(settledBlock.l2BlockHash.toBuffer()) }),
        },
      ]);
    });

    it('keeps results aligned across pending, settled and nonexistent nullifiers', async () => {
      const statuses = await getNullifierStatuses([missing, pending, settled, pending]);

      expect(statuses.map(status => status.exists)).toEqual([false, true, true, true]);
      expect(statuses.map(status => status.originBlock.isSome())).toEqual([false, false, true, false]);
    });
  });

  describe('resolveCustomRequest', () => {
    it('relays the request to the hook with the issuing contract context and returns its result', async () => {
      const result = [Fr.random(), Fr.random()];
      const resolveCustomRequest = jest.fn<ResolveCustomRequest>().mockResolvedValue(result);
      const contractClassId = Fr.random();
      const anchoredContractData = mock<AnchoredContractData>();
      anchoredContractData.getCurrentClassId.mockResolvedValue(contractClassId);
      const oracle = makeOracle({ hooks: { resolveCustomRequest }, anchoredContractData });

      const kind = Fr.random();
      const payload = [Fr.random(), Fr.random(), Fr.random()];
      await expect(oracle.resolveCustomRequest(kind, payload)).resolves.toEqual(result);
      expect(resolveCustomRequest).toHaveBeenCalledWith({ contractAddress, contractClassId, kind, payload });
    });

    it('throws when no resolveCustomRequest hook is configured', async () => {
      const oracle = makeOracle();
      await expect(oracle.resolveCustomRequest(Fr.random(), [Fr.random()])).rejects.toThrow(
        'no resolveCustomRequest hook',
      );
    });
  });

  type Account = Awaited<ReturnType<typeof makeAccount>>;

  /** An account with its keys in the stores of `oracleArgs`, which also put it in the execution scopes. */
  const makeAccount = async () => {
    const completeAddress = await CompleteAddress.random();
    const ivsk = GrumpkinScalar.random();

    const addressStore = mock<AddressStore>();
    addressStore.getCompleteAddress.mockResolvedValue(completeAddress);
    const keyStore = mock<KeyStore>();
    keyStore.getMasterIncomingViewingSecretKey.mockResolvedValue(ivsk);

    const address = completeAddress.address;
    return { address, completeAddress, ivsk, oracleArgs: { scopes: [address], addressStore, keyStore } };
  };

  const makeOracle = (overrides: Partial<PrivateExecutionOracleArgs> = {}): PrivateExecutionOracle => {
    return new PrivateExecutionOracle({
      argsHash: Fr.ZERO,
      txContext,
      protocolNullifier: Fr.ZERO,
      callContext,
      anchorBlockHeader: mock<BlockHeader>(),
      utilityExecutor: () => Promise.resolve(),
      authWitnesses: [] as AuthWitness[],
      capsules: [] as Capsule[],
      executionCache: HashedValuesCache.create([]),
      noteCache: new ExecutionNoteCache(Fr.ZERO),
      taggingIndexCache: new ExecutionTaggingIndexCache(),
      anchoredContractData: mock<AnchoredContractData>(),
      noteStore: mock<NoteStore>(),
      keyStore: mock<KeyStore>(),
      addressStore: mock<AddressStore>(),
      aztecNode: mock<AztecNode>(),
      senderTaggingStore: mock<SenderTaggingStore>(),
      recipientTaggingStore: mock<RecipientTaggingStore>(),
      taggingSecretSourcesStore: mock<TaggingSecretSourcesStore>(),
      capsuleService: new CapsuleService(mock<CapsuleStore>(), []),
      factService: new FactService(mock<FactStore>(), []),
      privateEventStore: mock<PrivateEventStore>(),
      txResolver: mock<TxResolverService>(),
      contractSyncService: mock<ContractSyncService>(),
      l2TipsStore: mock<L2TipsProvider>(),
      changeSetId: 'test',
      scopes: [],
      simulator: new WASMSimulator(),
      transientArrayService: new TransientArrayService(),
      ...overrides,
    });
  };
});
