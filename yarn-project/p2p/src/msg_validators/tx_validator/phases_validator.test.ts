import { NULL_MSG_SENDER_CONTRACT_ADDRESS, PUBLIC_TX_L2_GAS_OVERHEAD, TX_DA_GAS_OVERHEAD } from '@aztec-labs/constants';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { addNewContractInstanceToTx } from '@aztec-labs/simulator/public/fixtures';
import { STANDARD_AUTH_REGISTRY_ADDRESS } from '@aztec-labs/standard-contracts/auth-registry';
import type { FunctionSelector } from '@aztec-labs/stdlib/abi';
import { AztecAddress } from '@aztec-labs/stdlib/aztec-address';
import { type ContractDataSource, SerializableContractInstance } from '@aztec-labs/stdlib/contract';
import { Gas } from '@aztec-labs/stdlib/gas';
import type { AllowedElement } from '@aztec-labs/stdlib/interfaces/server';
import { makeAztecAddress, makeSelector, mockTx } from '@aztec-labs/stdlib/testing';
import {
  TX_ERROR_SETUP_FUNCTION_NOT_ALLOWED,
  TX_ERROR_SETUP_FUNCTION_UNKNOWN_CONTRACT,
  TX_ERROR_SETUP_INSUFFICIENT_GAS,
  TX_ERROR_SETUP_NULL_MSG_SENDER,
  TX_ERROR_SETUP_ONLY_SELF_WRONG_SENDER,
  TX_ERROR_SETUP_STATIC_CALL,
  TX_ERROR_SETUP_WRONG_CALLDATA_LENGTH,
  type Tx,
} from '@aztec-labs/stdlib/tx';
import { type MockProxy, mock, mockFn } from 'jest-mock-extended';

import { getDefaultAllowedSetupFunctions } from './allowed_public_setup.js';
import { PhasesTxValidator } from './phases_validator.js';
import { patchNonRevertibleFn } from './test_utils.js';

describe('PhasesTxValidator', () => {
  const timestamp = 27n;
  let contractDataSource: MockProxy<ContractDataSource>;
  let txValidator: PhasesTxValidator;
  let allowedContractClass: Fr;
  let allowedContract: AztecAddress;
  let allowedSetupSelector1: FunctionSelector;
  let allowedSetupSelector2: FunctionSelector;

  const expectValid = async (tx: Tx) => {
    await expect(txValidator.validateTx(tx)).resolves.toEqual({ result: 'valid' });
  };

  const expectInvalid = async (tx: Tx, reason: string) => {
    await expect(txValidator.validateTx(tx)).resolves.toEqual({ result: 'invalid', reason: [reason] });
  };

  beforeEach(() => {
    allowedContractClass = Fr.random();
    allowedContract = makeAztecAddress();
    allowedSetupSelector1 = makeSelector(1);
    allowedSetupSelector2 = makeSelector(2);

    contractDataSource = mock<ContractDataSource>({
      getContract: mockFn().mockImplementation((_address, atTimestamp) => {
        if (timestamp !== atTimestamp) {
          throw new Error('Unexpected timestamp');
        }
        return {
          currentContractClassId: Fr.random(),
          originalContractClassId: Fr.random(),
        };
      }),
    });

    txValidator = new PhasesTxValidator(
      contractDataSource,
      [
        {
          classId: allowedContractClass,
          selector: allowedSetupSelector1,
        },
        {
          address: allowedContract,
          selector: allowedSetupSelector1,
        },
        {
          classId: allowedContractClass,
          selector: allowedSetupSelector2,
        },
        {
          address: allowedContract,
          selector: allowedSetupSelector2,
        },
      ],
      timestamp,
    );
  });

  it('allows setup functions on the contracts allow list', async () => {
    const tx = await mockTx(1, { numberOfNonRevertiblePublicCallRequests: 1 });
    await patchNonRevertibleFn(tx, 0, { address: allowedContract, selector: allowedSetupSelector1 });

    await expectValid(tx);
  });

  it('allows setup functions on the contracts class allow list', async () => {
    const tx = await mockTx(1, { numberOfNonRevertiblePublicCallRequests: 1 });
    const address = await patchNonRevertibleFn(tx, 0, { selector: allowedSetupSelector1 });

    contractDataSource.getContract.mockImplementationOnce((contractAddress, atTimestamp) => {
      if (timestamp !== atTimestamp) {
        throw new Error('Unexpected timestamp');
      }
      if (address.equals(contractAddress)) {
        return Promise.resolve({
          currentContractClassId: allowedContractClass,
          originalContractClassId: Fr.random(),
        } as any);
      } else {
        return Promise.resolve(undefined);
      }
    });

    await expectValid(tx);
  });

  it('rejects txs with setup functions not on the allow list', async () => {
    const tx = await mockTx(1, { numberOfNonRevertiblePublicCallRequests: 2 });

    await expectInvalid(tx, TX_ERROR_SETUP_FUNCTION_NOT_ALLOWED);
  });

  it('rejects setup functions not on the contracts class list', async () => {
    const tx = await mockTx(1, { numberOfNonRevertiblePublicCallRequests: 1 });
    // good selector, bad contract class
    const address = await patchNonRevertibleFn(tx, 0, { selector: allowedSetupSelector1 });
    contractDataSource.getContract.mockImplementationOnce((contractAddress, atTimestamp) => {
      if (timestamp !== atTimestamp) {
        throw new Error('Unexpected timestamp');
      }
      if (address.equals(contractAddress)) {
        return Promise.resolve({
          currentContractClassId: Fr.random(),
          originalContractClassId: Fr.random(),
        } as any);
      } else {
        return Promise.resolve(undefined);
      }
    });

    await expectInvalid(tx, TX_ERROR_SETUP_FUNCTION_NOT_ALLOWED);
  });

  it('allows multiple setup functions on the allow list', async () => {
    const tx = await mockTx(1, { numberOfNonRevertiblePublicCallRequests: 2 });
    await patchNonRevertibleFn(tx, 0, { address: allowedContract, selector: allowedSetupSelector1 });
    await patchNonRevertibleFn(tx, 1, { address: allowedContract, selector: allowedSetupSelector2 });

    await expectValid(tx);
  });

  it('rejects if one setup functions is not on the allow list', async () => {
    const tx = await mockTx(1, { numberOfNonRevertiblePublicCallRequests: 2 });
    await patchNonRevertibleFn(tx, 0, { address: allowedContract, selector: allowedSetupSelector1 });

    await expectInvalid(tx, TX_ERROR_SETUP_FUNCTION_NOT_ALLOWED);
  });

  it('rejects address match with wrong selector', async () => {
    const tx = await mockTx(1, { numberOfNonRevertiblePublicCallRequests: 1 });
    const wrongSelector = makeSelector(99);
    await patchNonRevertibleFn(tx, 0, { address: allowedContract, selector: wrongSelector });

    await expectInvalid(tx, TX_ERROR_SETUP_FUNCTION_NOT_ALLOWED);
  });

  it('rejects class match with wrong selector', async () => {
    const tx = await mockTx(1, { numberOfNonRevertiblePublicCallRequests: 1 });
    const wrongSelector = makeSelector(99);
    const address = await patchNonRevertibleFn(tx, 0, { selector: wrongSelector });

    contractDataSource.getContract.mockImplementationOnce((contractAddress, atTimestamp) => {
      if (timestamp !== atTimestamp) {
        throw new Error('Unexpected timestamp');
      }
      if (address.equals(contractAddress)) {
        return Promise.resolve({
          currentContractClassId: allowedContractClass,
          originalContractClassId: Fr.random(),
        } as any);
      } else {
        return Promise.resolve(undefined);
      }
    });

    await expectInvalid(tx, TX_ERROR_SETUP_FUNCTION_NOT_ALLOWED);
  });

  it('rejects with unknown contract error when contract is not found', async () => {
    const tx = await mockTx(1, { numberOfNonRevertiblePublicCallRequests: 1 });
    const address = await patchNonRevertibleFn(tx, 0, { selector: allowedSetupSelector1 });

    contractDataSource.getContract.mockImplementationOnce((contractAddress, atTimestamp) => {
      if (timestamp !== atTimestamp) {
        throw new Error('Unexpected timestamp');
      }
      if (address.equals(contractAddress)) {
        return Promise.resolve(undefined);
      }
      return Promise.resolve(undefined);
    });

    await expectInvalid(tx, TX_ERROR_SETUP_FUNCTION_UNKNOWN_CONTRACT);
  });

  describe('contracts published by the tx', () => {
    const makeTxPublishingCallee = async (revertible: boolean) => {
      const tx = await mockTx(1, { numberOfNonRevertiblePublicCallRequests: 1 });
      const address = await patchNonRevertibleFn(tx, 0, { selector: allowedSetupSelector1 });
      const instance = await SerializableContractInstance.random({ currentContractClassId: allowedContractClass });
      await addNewContractInstanceToTx(
        tx,
        instance.withAddress(address),
        /*skipNullifierInsertion=*/ false,
        revertible,
      );
      return tx;
    };

    beforeEach(() => {
      contractDataSource.getContract.mockResolvedValue(undefined);
    });

    it('allows a setup call to a contract the tx publishes in its non-revertible half', async () => {
      await expectValid(await makeTxPublishingCallee(false));
    });

    it('rejects a setup call to a contract the tx publishes in its revertible half', async () => {
      await expectInvalid(await makeTxPublishingCallee(true), TX_ERROR_SETUP_FUNCTION_UNKNOWN_CONTRACT);
    });
  });

  describe('address entries', () => {
    const makeTxCallingAllowedContract = async () => {
      const tx = await mockTx(1, { numberOfNonRevertiblePublicCallRequests: 1 });
      await patchNonRevertibleFn(tx, 0, { address: allowedContract, selector: allowedSetupSelector1 });
      return tx;
    };

    it('allows a setup call to an address entry whose contract is deployed', async () => {
      await expectValid(await makeTxCallingAllowedContract());
    });

    it('rejects a setup call to an address entry with no contract deployed', async () => {
      contractDataSource.getContract.mockResolvedValue(undefined);
      await expectInvalid(await makeTxCallingAllowedContract(), TX_ERROR_SETUP_FUNCTION_UNKNOWN_CONTRACT);
    });
  });

  describe('onlySelf validation', () => {
    let allowedOnlySelfSelector: FunctionSelector;
    let allowedOnlySelfContract: AztecAddress;
    let allowedOnlySelfClass: Fr;

    beforeEach(() => {
      allowedOnlySelfSelector = makeSelector(10);
      allowedOnlySelfContract = makeAztecAddress();
      allowedOnlySelfClass = Fr.random();

      txValidator = new PhasesTxValidator(
        contractDataSource,
        [
          {
            address: allowedOnlySelfContract,
            selector: allowedOnlySelfSelector,
            onlySelf: true,
          },
          {
            classId: allowedOnlySelfClass,
            selector: allowedOnlySelfSelector,
            onlySelf: true,
          },
          {
            address: allowedContract,
            selector: allowedSetupSelector1,
          },
        ],
        timestamp,
      );
    });

    it('allows onlySelf address entry when msgSender equals contractAddress', async () => {
      const tx = await mockTx(1, { numberOfNonRevertiblePublicCallRequests: 1 });
      await patchNonRevertibleFn(tx, 0, {
        address: allowedOnlySelfContract,
        selector: allowedOnlySelfSelector,
        msgSender: allowedOnlySelfContract,
      });

      await expectValid(tx);
    });

    it('rejects onlySelf address entry when msgSender differs from contractAddress', async () => {
      const tx = await mockTx(1, { numberOfNonRevertiblePublicCallRequests: 1 });
      await patchNonRevertibleFn(tx, 0, {
        address: allowedOnlySelfContract,
        selector: allowedOnlySelfSelector,
        msgSender: makeAztecAddress(999),
      });

      await expectInvalid(tx, TX_ERROR_SETUP_ONLY_SELF_WRONG_SENDER);
    });

    it('allows onlySelf class entry when msgSender equals contractAddress', async () => {
      const tx = await mockTx(1, { numberOfNonRevertiblePublicCallRequests: 1 });
      const address = await patchNonRevertibleFn(tx, 0, {
        selector: allowedOnlySelfSelector,
        msgSender: undefined, // will be patched below
      });

      // Patch msgSender to equal contractAddress
      tx.data.forPublic!.nonRevertibleAccumulatedData.publicCallRequests[0].msgSender = address;

      contractDataSource.getContract.mockImplementationOnce((contractAddress, atTimestamp) => {
        if (timestamp !== atTimestamp) {
          throw new Error('Unexpected timestamp');
        }
        if (address.equals(contractAddress)) {
          return Promise.resolve({
            currentContractClassId: allowedOnlySelfClass,
            originalContractClassId: Fr.random(),
          } as any);
        }
        return Promise.resolve(undefined);
      });

      await expectValid(tx);
    });

    it('rejects onlySelf class entry when msgSender differs from contractAddress', async () => {
      const tx = await mockTx(1, { numberOfNonRevertiblePublicCallRequests: 1 });
      const address = await patchNonRevertibleFn(tx, 0, {
        selector: allowedOnlySelfSelector,
        msgSender: makeAztecAddress(),
      });

      contractDataSource.getContract.mockImplementationOnce((contractAddress, atTimestamp) => {
        if (timestamp !== atTimestamp) {
          throw new Error('Unexpected timestamp');
        }
        if (address.equals(contractAddress)) {
          return Promise.resolve({
            currentContractClassId: allowedOnlySelfClass,
            originalContractClassId: Fr.random(),
          } as any);
        }
        return Promise.resolve(undefined);
      });

      await expectInvalid(tx, TX_ERROR_SETUP_ONLY_SELF_WRONG_SENDER);
    });

    it('allows non-onlySelf entry with different msgSender', async () => {
      const tx = await mockTx(1, { numberOfNonRevertiblePublicCallRequests: 1 });
      await patchNonRevertibleFn(tx, 0, {
        address: allowedContract,
        selector: allowedSetupSelector1,
        msgSender: makeAztecAddress(),
      });

      await expectValid(tx);
    });
  });

  describe('calldataLength validation', () => {
    const expectedLength = 4; // 1 selector + 3 args
    let calldataContract: AztecAddress;
    let calldataSelector: FunctionSelector;
    let calldataClassId: Fr;

    beforeEach(() => {
      calldataContract = makeAztecAddress(70);
      calldataSelector = makeSelector(70);
      calldataClassId = Fr.random();

      txValidator = new PhasesTxValidator(
        contractDataSource,
        [
          {
            address: calldataContract,
            selector: calldataSelector,
            calldataLength: expectedLength,
          },
          {
            classId: calldataClassId,
            selector: calldataSelector,
            calldataLength: expectedLength,
          },
        ],
        timestamp,
      );
    });

    it('allows address entry with correct calldata length', async () => {
      const tx = await mockTx(1, { numberOfNonRevertiblePublicCallRequests: 1 });
      await patchNonRevertibleFn(tx, 0, {
        address: calldataContract,
        selector: calldataSelector,
        args: [Fr.random(), Fr.random(), Fr.random()],
      });

      await expectValid(tx);
    });

    it('rejects address entry with too short calldata', async () => {
      const tx = await mockTx(1, { numberOfNonRevertiblePublicCallRequests: 1 });
      await patchNonRevertibleFn(tx, 0, {
        address: calldataContract,
        selector: calldataSelector,
        args: [Fr.random()],
      });

      await expectInvalid(tx, TX_ERROR_SETUP_WRONG_CALLDATA_LENGTH);
    });

    it('rejects address entry with too long calldata', async () => {
      const tx = await mockTx(1, { numberOfNonRevertiblePublicCallRequests: 1 });
      await patchNonRevertibleFn(tx, 0, {
        address: calldataContract,
        selector: calldataSelector,
        args: [Fr.random(), Fr.random(), Fr.random(), Fr.random(), Fr.random()],
      });

      await expectInvalid(tx, TX_ERROR_SETUP_WRONG_CALLDATA_LENGTH);
    });

    it('rejects class entry with wrong calldata length', async () => {
      const tx = await mockTx(1, { numberOfNonRevertiblePublicCallRequests: 1 });
      const address = await patchNonRevertibleFn(tx, 0, {
        selector: calldataSelector,
        args: [Fr.random()],
      });

      contractDataSource.getContract.mockImplementationOnce((contractAddress, atTimestamp) => {
        if (timestamp !== atTimestamp) {
          throw new Error('Unexpected timestamp');
        }
        if (address.equals(contractAddress)) {
          return Promise.resolve({
            currentContractClassId: calldataClassId,
            originalContractClassId: Fr.random(),
          } as any);
        }
        return Promise.resolve(undefined);
      });

      await expectInvalid(tx, TX_ERROR_SETUP_WRONG_CALLDATA_LENGTH);
    });

    it('allows any calldata length when calldataLength is not set', async () => {
      txValidator = new PhasesTxValidator(
        contractDataSource,
        [
          {
            address: calldataContract,
            selector: calldataSelector,
          },
        ],
        timestamp,
      );

      const tx = await mockTx(1, { numberOfNonRevertiblePublicCallRequests: 1 });
      await patchNonRevertibleFn(tx, 0, {
        address: calldataContract,
        selector: calldataSelector,
        args: [Fr.random(), Fr.random(), Fr.random(), Fr.random(), Fr.random(), Fr.random()],
      });

      await expectValid(tx);
    });
  });

  describe('rejectNullMsgSender validation', () => {
    const nullMsgSender = AztecAddress.fromBigIntUnsafe(NULL_MSG_SENDER_CONTRACT_ADDRESS);
    let rejectNullContract: AztecAddress;
    let rejectNullSelector: FunctionSelector;
    let noRejectNullContract: AztecAddress;
    let noRejectNullSelector: FunctionSelector;

    beforeEach(() => {
      rejectNullContract = makeAztecAddress(50);
      rejectNullSelector = makeSelector(50);
      noRejectNullContract = makeAztecAddress(51);
      noRejectNullSelector = makeSelector(51);

      txValidator = new PhasesTxValidator(
        contractDataSource,
        [
          {
            address: rejectNullContract,
            selector: rejectNullSelector,
            rejectNullMsgSender: true,
          },
          {
            address: noRejectNullContract,
            selector: noRejectNullSelector,
          },
        ],
        timestamp,
      );
    });

    it('rejects when msgSender is NULL_MSG_SENDER_CONTRACT_ADDRESS', async () => {
      const tx = await mockTx(1, { numberOfNonRevertiblePublicCallRequests: 1 });
      await patchNonRevertibleFn(tx, 0, {
        address: rejectNullContract,
        selector: rejectNullSelector,
        msgSender: nullMsgSender,
      });

      await expectInvalid(tx, TX_ERROR_SETUP_NULL_MSG_SENDER);
    });

    it('allows when msgSender is a normal address', async () => {
      const tx = await mockTx(1, { numberOfNonRevertiblePublicCallRequests: 1 });
      await patchNonRevertibleFn(tx, 0, {
        address: rejectNullContract,
        selector: rejectNullSelector,
        msgSender: makeAztecAddress(100),
      });

      await expectValid(tx);
    });

    it('allows null msgSender on entries without the flag', async () => {
      const tx = await mockTx(1, { numberOfNonRevertiblePublicCallRequests: 1 });
      await patchNonRevertibleFn(tx, 0, {
        address: noRejectNullContract,
        selector: noRejectNullSelector,
        msgSender: nullMsgSender,
      });

      await expectValid(tx);
    });
  });

  describe('minGas validation', () => {
    const gasUsed = new Gas(1_000, 50_000);
    const minGas1 = new Gas(64, 30_000);
    const minGas2 = new Gas(128, 20_000);
    let unmeteredSelector: FunctionSelector;

    beforeEach(() => {
      unmeteredSelector = makeSelector(90);
      txValidator = new PhasesTxValidator(
        contractDataSource,
        [
          { address: allowedContract, selector: allowedSetupSelector1, minGas: minGas1 },
          { address: allowedContract, selector: allowedSetupSelector2, minGas: minGas2 },
          { address: allowedContract, selector: unmeteredSelector },
        ],
        timestamp,
      );
    });

    const makeTx = async (selectors: FunctionSelector[], gasLimits: Gas) => {
      const tx = await mockTx(1, {
        numberOfNonRevertiblePublicCallRequests: selectors.length,
        numberOfRevertiblePublicCallRequests: 0,
        gasUsed,
        gasLimits,
      });
      for (const [i, selector] of selectors.entries()) {
        await patchNonRevertibleFn(tx, i, { address: allowedContract, selector });
      }
      return tx;
    };

    it('allows gas limits that leave setup exactly the minGas', async () => {
      await expectValid(await makeTx([allowedSetupSelector1], gasUsed.add(minGas1)));
    });

    it('rejects gas limits that leave setup one unit of L2 gas short', async () => {
      const tx = await makeTx([allowedSetupSelector1], gasUsed.add(minGas1).sub(new Gas(0, 1)));
      await expectInvalid(tx, TX_ERROR_SETUP_INSUFFICIENT_GAS);
    });

    it('rejects gas limits that leave setup one unit of DA gas short', async () => {
      const tx = await makeTx([allowedSetupSelector1], gasUsed.add(minGas1).sub(new Gas(1, 0)));
      await expectInvalid(tx, TX_ERROR_SETUP_INSUFFICIENT_GAS);
    });

    it('sums the minGas of every setup call', async () => {
      const selectors = [allowedSetupSelector1, allowedSetupSelector2];
      const required = gasUsed.add(minGas1).add(minGas2);

      await expectValid(await makeTx(selectors, required));
      await expectInvalid(await makeTx(selectors, required.sub(new Gas(0, 1))), TX_ERROR_SETUP_INSUFFICIENT_GAS);
    });

    it('imposes no gas requirement for entries without minGas', async () => {
      await expectValid(await makeTx([unmeteredSelector], gasUsed));
    });
  });

  describe('default allow list', () => {
    const privateGasUsed = new Gas(TX_DA_GAS_OVERHEAD, PUBLIC_TX_L2_GAS_OVERHEAD);
    let setAuthorized: AllowedElement;

    beforeEach(async () => {
      const defaults = await getDefaultAllowedSetupFunctions();
      setAuthorized = defaults.find(
        e => 'address' in e && e.address.equals(STANDARD_AUTH_REGISTRY_ADDRESS) && !e.onlySelf,
      )!;
      txValidator = new PhasesTxValidator(contractDataSource, defaults, timestamp);
    });

    // Without explicit gas limits, mockTx uses the per-tx maximums, which leave setup plenty of gas.
    const makeSetAuthorizedTx = async (opts: { isStaticCall: boolean; gasLimits?: Gas }) => {
      const tx = await mockTx(1, {
        numberOfNonRevertiblePublicCallRequests: 1,
        numberOfRevertiblePublicCallRequests: 0,
        gasUsed: privateGasUsed,
        ...(opts.gasLimits ? { gasLimits: opts.gasLimits } : {}),
      });
      await patchNonRevertibleFn(tx, 0, {
        address: STANDARD_AUTH_REGISTRY_ADDRESS,
        selector: setAuthorized.selector,
        args: [new Fr(7), new Fr(1)],
        msgSender: makeAztecAddress(),
        isStaticCall: opts.isStaticCall,
      });
      return tx;
    };

    it('allows a non-static set_authorized setup call with enough gas', async () => {
      const tx = await makeSetAuthorizedTx({ isStaticCall: false });
      await expectValid(tx);
    });

    it('allows a set_authorized setup call while no instance of the standard AuthRegistry is known', async () => {
      contractDataSource.getContract.mockResolvedValue(undefined);
      const tx = await makeSetAuthorizedTx({ isStaticCall: false });
      await expectValid(tx);
    });

    it('rejects a static set_authorized setup call', async () => {
      const tx = await makeSetAuthorizedTx({ isStaticCall: true });
      await expectInvalid(tx, TX_ERROR_SETUP_STATIC_CALL);
    });

    it('rejects a set_authorized setup call when the gas limits leave no gas for setup', async () => {
      const tx = await makeSetAuthorizedTx({ isStaticCall: false, gasLimits: privateGasUsed });
      await expectInvalid(tx, TX_ERROR_SETUP_INSUFFICIENT_GAS);
    });
  });
});
