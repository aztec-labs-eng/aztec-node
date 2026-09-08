import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { AvmTestContractArtifact } from '@aztec-labs/noir-test-contracts.js/AvmTest';
import { ProtocolContractAddress } from '@aztec-labs/protocol-contracts';
import { defaultGlobals } from '@aztec-labs/simulator/public/fixtures';
import { AztecAddress } from '@aztec-labs/stdlib/aztec-address';
import type { ContractInstanceWithAddress } from '@aztec-labs/stdlib/contract';
import {
  DelayedPublicMutableValuesWithHash,
  ScheduledDelayChange,
  ScheduledValueChange,
} from '@aztec-labs/stdlib/delayed-public-mutable';
import type { UInt64 } from '@aztec-labs/stdlib/types';
import { NativeWorldStateService } from '@aztec-labs/world-state';

import { AvmProvingTester } from './avm_proving_tester.js';

const TIMEOUT = 60_000;

describe('AVM check-circuit - contract updates', () => {
  const sender = AztecAddress.fromNumberUnsafe(42);

  const avmTestContractClassSeed = 0;
  let avmTestContractInstance: ContractInstanceWithAddress;

  let worldStateService: NativeWorldStateService;
  let tester: AvmProvingTester | undefined;

  beforeEach(async () => {
    worldStateService = await NativeWorldStateService.tmp();
  });

  afterEach(async () => {
    await tester?.close();
    tester = undefined;
    await worldStateService.close();
  });

  const writeContractUpdate = async (
    tester: AvmProvingTester,
    contractAddress: AztecAddress,
    previousClassId: Fr,
    nextClassId: Fr,
    timestampOfChange: UInt64,
  ) => {
    const { delayedPublicMutableSlot } =
      await DelayedPublicMutableValuesWithHash.getContractUpdateSlots(contractAddress);

    const valueChange = new ScheduledValueChange([previousClassId], [nextClassId], timestampOfChange);
    const delayChange = ScheduledDelayChange.empty();
    const delayedPublicMutableValuesWithHash = new DelayedPublicMutableValuesWithHash(valueChange, delayChange);

    const writeToTree = async (storageSlot: Fr, value: Fr) => {
      await tester.setPublicStorage(ProtocolContractAddress.ContractInstanceRegistry, storageSlot, value);
    };

    await delayedPublicMutableValuesWithHash.writeToTree(delayedPublicMutableSlot, writeToTree);
  };

  it(
    'should execute an updated contract',
    async () => {
      // Contract was not originally the avmTestContract
      const originalClassId = new Fr(27);
      const globals = defaultGlobals();
      tester = await AvmProvingTester.new(worldStateService, /*checkCircuitOnly*/ true, globals);

      avmTestContractInstance = await tester.registerAndDeployContract(
        /*constructorArgs=*/ [],
        sender,
        /*contractArtifact=*/ AvmTestContractArtifact,
        /*skipNullifierInsertion=*/ false,
        /*seed=*/ avmTestContractClassSeed,
        /*contractClassSeed=*/ avmTestContractClassSeed,
        /*originalContractClassId=*/ originalClassId, // upgraded from
      );

      await writeContractUpdate(
        tester,
        avmTestContractInstance.address,
        avmTestContractInstance.originalContractClassId,
        avmTestContractInstance.currentContractClassId,
        globals.timestamp,
      );

      await tester.simProveVerify(
        sender,
        /*setupCalls=*/ [],
        /*appCalls=*/ [
          { address: avmTestContractInstance.address, fnName: 'add_args_return', args: [new Fr(1), new Fr(2)] },
        ],
        /*teardownCall=*/ undefined,
        /*expectRevert=*/ false,
      );
    },
    TIMEOUT,
  );

  it(
    'should fail if trying to execute an updated contract which has not been updated yet',
    async () => {
      // Contract was not originally the avmTestContract
      const originalClassId = new Fr(27);
      const globals = defaultGlobals();
      tester = await AvmProvingTester.new(worldStateService, /*checkCircuitOnly*/ true, globals);
      avmTestContractInstance = await tester.registerAndDeployContract(
        /*constructorArgs=*/ [],
        sender,
        /*contractArtifact=*/ AvmTestContractArtifact,
        /*skipNullifierInsertion=*/ false,
        /*seed=*/ avmTestContractClassSeed,
        /*contractClassSeed=*/ avmTestContractClassSeed,
        /*originalContractClassId=*/ originalClassId, // upgraded from
      );

      await writeContractUpdate(
        tester,
        avmTestContractInstance.address,
        avmTestContractInstance.originalContractClassId,
        avmTestContractInstance.currentContractClassId,
        globals.timestamp + 1n,
      );

      await expect(
        tester.simProveVerify(
          sender,
          /*setupCalls=*/ [],
          /*appCalls=*/ [
            { address: avmTestContractInstance.address, fnName: 'add_args_return', args: [new Fr(1), new Fr(2)] },
          ],
          /*teardownCall=*/ undefined,
          /*expectRevert=*/ false,
        ),
      ).rejects.toThrow();
    },
    TIMEOUT,
  );

  it(
    'should execute a not yet updated contract',
    async () => {
      // Contract was not originally the avmTestContract
      const newClassId = new Fr(27);

      const globals = defaultGlobals();
      tester = await AvmProvingTester.new(worldStateService, /*checkCircuitOnly*/ true, globals);
      avmTestContractInstance = await tester.registerAndDeployContract(
        /*constructorArgs=*/ [],
        sender,
        /*contractArtifact=*/ AvmTestContractArtifact,
        /*skipNullifierInsertion=*/ false,
        /*seed=*/ avmTestContractClassSeed,
      );

      await writeContractUpdate(
        tester,
        avmTestContractInstance.address,
        avmTestContractInstance.currentContractClassId,
        newClassId,
        globals.timestamp + 1n,
      );

      await tester.simProveVerify(
        sender,
        /*setupCalls=*/ [],
        /*appCalls=*/ [
          { address: avmTestContractInstance.address, fnName: 'add_args_return', args: [new Fr(1), new Fr(2)] },
        ],
        /*teardownCall=*/ undefined,
        /*expectRevert=*/ false,
      );
    },
    TIMEOUT,
  );

  it(
    'should fail if trying to execute the old class of a contract which has been updated already',
    async () => {
      // Contract was not originally the avmTestContract
      const newClassId = new Fr(27);

      const globals = defaultGlobals();
      tester = await AvmProvingTester.new(worldStateService, /*checkCircuitOnly*/ true, globals);
      avmTestContractInstance = await tester.registerAndDeployContract(
        /*constructorArgs=*/ [],
        sender,
        /*contractArtifact=*/ AvmTestContractArtifact,
        /*skipNullifierInsertion=*/ false,
        /*seed=*/ avmTestContractClassSeed,
      );

      await writeContractUpdate(
        tester,
        avmTestContractInstance.address,
        avmTestContractInstance.currentContractClassId,
        newClassId,
        globals.timestamp - 1n,
      );

      await expect(
        tester.simProveVerify(
          sender,
          /*setupCalls=*/ [],
          /*appCalls=*/ [
            { address: avmTestContractInstance.address, fnName: 'add_args_return', args: [new Fr(1), new Fr(2)] },
          ],
          /*teardownCall=*/ undefined,
          /*expectRevert=*/ false,
        ),
      ).rejects.toThrow();
    },
    TIMEOUT,
  );
});
