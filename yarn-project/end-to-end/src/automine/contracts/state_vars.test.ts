import { AztecAddress } from '@aztec/aztec.js/addresses';
import { BatchCall, type ContractFunctionInteraction } from '@aztec/aztec.js/contracts';
import type { AztecNode } from '@aztec/aztec.js/node';
import { AuthContract } from '@aztec/noir-contracts.js/Auth';
import { StateVarsContract } from '@aztec/noir-test-contracts.js/StateVars';

import { jest } from '@jest/globals';

import type { TestWallet } from '../../test-wallet/test_wallet.js';
import { proveInteraction } from '../../test-wallet/utils.js';
import { AutomineTestContext } from '../automine_test_context.js';

const TIMEOUT = 300_000;

// Exercises PublicImmutable, PrivateMutable, PrivateImmutable, and DelayedPublicMutable state variable types
// via the StateVars and Auth contracts. Single node with AutomineSequencer.
describe('automine/contracts/state_vars', () => {
  jest.setTimeout(TIMEOUT);

  let t: AutomineTestContext;
  let aztecNode: AztecNode;
  let wallet: TestWallet;
  let defaultAccountAddress: AztecAddress;

  let teardown: () => Promise<void>;
  let contract: StateVarsContract;

  const VALUE = 2n;
  const RANDOMNESS = 2n;

  beforeAll(async () => {
    t = await AutomineTestContext.setup({ numberOfAccounts: 1 });
    ({
      teardown,
      aztecNode,
      wallet,
      accounts: [defaultAccountAddress],
    } = t.context);
    ({ contract } = await StateVarsContract.deploy(wallet).send({ from: defaultAccountAddress }));
  });

  afterAll(() => teardown());

  // Simulates an `is_*_initialized` view and asserts its boolean result, collapsing the repeated
  // initialization-status checks across the PrivateMutable and PrivateImmutable suites.
  const expectInitialized = async (isInitialized: ContractFunctionInteraction, expected: boolean) => {
    expect((await isInitialized.simulate({ from: defaultAccountAddress })).result).toEqual(expected);
  };

  // Tests for PublicImmutable: initialize-once semantics, reading from private/public/utility contexts,
  // and rejection of double-initialization.
  describe('PublicImmutable', () => {
    // Simulates a constrained private read on an uninitialized PublicImmutable; asserts the expected
    // error is thrown.
    it('private read of uninitialized PublicImmutable should fail', async () => {
      await expect(
        contract.methods.get_public_immutable_constrained_private().simulate({ from: defaultAccountAddress }),
      ).rejects.toThrow('Trying to read from uninitialized PublicImmutable');
    });

    // Sends initialize_public_immutable(1) then reads back via get_public_immutable; asserts the
    // returned struct's account field matches the caller.
    it('initialize and read PublicImmutable', async () => {
      // Initializes the public immutable and then reads the value using a utility  function
      // checking the return values:

      await contract.methods.initialize_public_immutable(1).send({ from: defaultAccountAddress });

      const { result: read } = await contract.methods.get_public_immutable().simulate({ from: defaultAccountAddress });

      expect(read).toEqual({ account: defaultAccountAddress, value: read.value });
    });

    // Reads the initialized PublicImmutable from two private contexts (direct and indirect) plus utility,
    // via a BatchCall; asserts the direct read equals utility and the indirect read equals utility.value + 1.
    it('private read of initialized PublicImmutable', async () => {
      // Reads the value using a utility function checking the return values with:
      // 1. A constrained private function that reads it directly
      // 2. A constrained private function that calls another private function that reads.
      //    The indirect, adds 1 to the point to ensure that we are returning the correct value.

      const [a, b, c] = (
        await new BatchCall(wallet, [
          contract.methods.get_public_immutable_constrained_private(),
          contract.methods.get_public_immutable_constrained_private_indirect(),
          contract.methods.get_public_immutable(),
        ]).simulate({ from: defaultAccountAddress })
      ).result.map((r: any) => r.result);

      expect(a).toEqual(c);
      expect(b).toEqual({ account: c.account, value: c.value + 1n });
      await contract.methods.match_public_immutable(c.account, c.value).send({ from: defaultAccountAddress });
    });

    // Same as the private-read test but using constrained public functions; asserts direct and indirect
    // public reads are consistent with the utility value.
    it('public read of PublicImmutable', async () => {
      // Reads the value using a utility function checking the return values with:
      // 1. A constrained public function that reads it directly
      // 2. A constrained public function that calls another public function that reads.
      //    The indirect, adds 1 to the point to ensure that we are returning the correct value.

      const [a, b, c] = (
        await new BatchCall(wallet, [
          contract.methods.get_public_immutable_constrained_public(),
          contract.methods.get_public_immutable_constrained_public_indirect(),
          contract.methods.get_public_immutable(),
        ]).simulate({ from: defaultAccountAddress })
      ).result.map((r: any) => r.result);

      expect(a).toEqual(c);
      expect(b).toEqual({ account: c.account, value: c.value + 1n });

      await contract.methods.match_public_immutable(c.account, c.value).send({ from: defaultAccountAddress });
    });

    // Calls get_public_immutable_constrained_public_multiple (reads 5 times in one function); asserts
    // the returned array equals [c, c, c, c, c] where c is the utility read result.
    it('public multiread of PublicImmutable', async () => {
      // Reads the value using a utility function checking the return values with:
      // 1. A constrained public function that reads 5 times directly (going beyond the previous 4 Field return value)

      const { result: a } = await contract.methods
        .get_public_immutable_constrained_public_multiple()
        .simulate({ from: defaultAccountAddress });
      const { result: c } = await contract.methods.get_public_immutable().simulate({ from: defaultAccountAddress });

      expect(a).toEqual([c, c, c, c, c]);
    });

    // Calls initialize_public_immutable a second time after it was already initialized in the previous
    // test (depends on sequential execution); asserts 'Attempted to emit duplicate nullifier'.
    it('initializing PublicImmutable the second time should fail', async () => {
      // Jest executes the tests sequentially and the first call to initialize_public_immutable was executed
      // in the previous test, so the call below should fail.
      await expect(
        contract.methods.initialize_public_immutable(1).simulate({ from: defaultAccountAddress }),
      ).rejects.toThrow('Attempted to emit duplicate nullifier');
    });
  });

  // Tests for PrivateMutable: initialize, read, update, and rejection of re-initialization.
  describe('PrivateMutable', () => {
    // Asserts is_private_mutable_initialized returns false before initialization, then confirms
    // get_private_mutable throws on an uninitialized slot.
    it('fail to read uninitialized PrivateMutable', async () => {
      await expectInitialized(contract.methods.is_private_mutable_initialized(defaultAccountAddress), false);
      await expect(
        contract.methods.get_private_mutable(defaultAccountAddress).simulate({ from: defaultAccountAddress }),
      ).rejects.toThrow();
    });

    // Sends initialize_private(RANDOMNESS, VALUE), verifies the tx produces 2 nullifiers (one for the
    // tx and one for the initializer), and asserts is_private_mutable_initialized returns true after.
    it('initialize PrivateMutable', async () => {
      await expectInitialized(contract.methods.is_private_mutable_initialized(defaultAccountAddress), false);
      // Send the transaction and wait for it to be mined (wait function throws if the tx is not mined)
      const { receipt: txReceipt } = await contract.methods
        .initialize_private(RANDOMNESS, VALUE)
        .send({ from: defaultAccountAddress });

      const txEffects = await aztecNode.getTxEffect(txReceipt.txHash);

      // 1 for the tx, another for the initializer
      expect(txEffects?.data.nullifiers.length).toEqual(2);
      await expectInitialized(contract.methods.is_private_mutable_initialized(defaultAccountAddress), true);
    });

    // Attempts to call initialize_private a second time; asserts it throws and the initialized flag
    // remains true.
    it('fail to reinitialize', async () => {
      await expectInitialized(contract.methods.is_private_mutable_initialized(defaultAccountAddress), true);
      await expect(
        contract.methods.initialize_private(RANDOMNESS, VALUE).send({ from: defaultAccountAddress }),
      ).rejects.toThrow();
      await expectInitialized(contract.methods.is_private_mutable_initialized(defaultAccountAddress), true);
    });

    // Reads the PrivateMutable after initialization; asserts the stored value matches VALUE.
    it('read initialized PrivateMutable', async () => {
      await expectInitialized(contract.methods.is_private_mutable_initialized(defaultAccountAddress), true);
      const {
        result: { value },
      } = await contract.methods.get_private_mutable(defaultAccountAddress).simulate({ from: defaultAccountAddress });
      expect(value).toEqual(VALUE);
    });

    // Calls update_private_mutable with the same RANDOMNESS and VALUE; asserts one new note hash and
    // 2 nullifiers (tx + old note), and the stored value is unchanged.
    it('replace with same value', async () => {
      await expectInitialized(contract.methods.is_private_mutable_initialized(defaultAccountAddress), true);
      const { result: noteBefore } = await contract.methods
        .get_private_mutable(defaultAccountAddress)
        .simulate({ from: defaultAccountAddress });
      const { receipt: txReceipt } = await contract.methods
        .update_private_mutable(RANDOMNESS, VALUE)
        .send({ from: defaultAccountAddress });

      const txEffects = await aztecNode.getTxEffect(txReceipt.txHash);

      expect(txEffects?.data.noteHashes.length).toEqual(1);
      // 1 for the tx, another for the nullifier of the previous note
      expect(txEffects?.data.nullifiers.length).toEqual(2);

      const { result: noteAfter } = await contract.methods
        .get_private_mutable(defaultAccountAddress)
        .simulate({ from: defaultAccountAddress });

      expect(noteBefore.value).toEqual(noteAfter.value);
    });

    // Calls update_private_mutable with different RANDOMNESS and VALUE; asserts one new note hash,
    // 2 nullifiers, and the stored value matches the new VALUE.
    it('replace PrivateMutable with other values', async () => {
      await expectInitialized(contract.methods.is_private_mutable_initialized(defaultAccountAddress), true);
      const { receipt: txReceipt } = await contract.methods
        .update_private_mutable(RANDOMNESS + 2n, VALUE + 1n)
        .send({ from: defaultAccountAddress });

      const txEffects = await aztecNode.getTxEffect(txReceipt.txHash);

      expect(txEffects?.data.noteHashes.length).toEqual(1);
      // 1 for the tx, another for the nullifier of the previous note
      expect(txEffects?.data.nullifiers.length).toEqual(2);

      const {
        result: { value },
      } = await contract.methods.get_private_mutable(defaultAccountAddress).simulate({ from: defaultAccountAddress });
      expect(value).toEqual(VALUE + 1n);
    });

    // Calls increase_private_value (reads then updates in private); asserts the new value is exactly
    // the prior value + 1, verifying read-then-write consistency.
    it('replace PrivateMutable dependent on prior value', async () => {
      await expectInitialized(contract.methods.is_private_mutable_initialized(defaultAccountAddress), true);
      const { result: noteBefore } = await contract.methods
        .get_private_mutable(defaultAccountAddress)
        .simulate({ from: defaultAccountAddress });
      const { receipt: txReceipt } = await contract.methods
        .increase_private_value()
        .send({ from: defaultAccountAddress });

      const txEffects = await aztecNode.getTxEffect(txReceipt.txHash);

      expect(txEffects?.data.noteHashes.length).toEqual(1);
      // 1 for the tx, another for the nullifier of the previous note
      expect(txEffects?.data.nullifiers.length).toEqual(2);

      const {
        result: { value },
      } = await contract.methods.get_private_mutable(defaultAccountAddress).simulate({ from: defaultAccountAddress });
      expect(value).toEqual(noteBefore.value + 1n);
    });
  });

  // Tests for PrivateImmutable: initialize-once semantics, reading the stored value, and rejection of
  // double-initialization.
  describe('PrivateImmutable', () => {
    // Asserts is_priv_imm_initialized is false before initialization and that view_private_immutable throws.
    it('fail to read uninitialized PrivateImmutable', async () => {
      await expectInitialized(contract.methods.is_priv_imm_initialized(defaultAccountAddress), false);
      await expect(
        contract.methods.view_private_immutable(defaultAccountAddress).simulate({ from: defaultAccountAddress }),
      ).rejects.toThrow();
    });

    // Calls initialize_private_immutable(RANDOMNESS, VALUE); asserts 1 note hash and 2 nullifiers are
    // emitted, and is_priv_imm_initialized becomes true.
    it('initialize PrivateImmutable', async () => {
      await expectInitialized(contract.methods.is_priv_imm_initialized(defaultAccountAddress), false);
      const { receipt: txReceipt } = await contract.methods
        .initialize_private_immutable(RANDOMNESS, VALUE)
        .send({ from: defaultAccountAddress });

      const txEffects = await aztecNode.getTxEffect(txReceipt.txHash);

      expect(txEffects?.data.noteHashes.length).toEqual(1);
      // 1 for the tx, another for the initializer
      expect(txEffects?.data.nullifiers.length).toEqual(2);
      await expectInitialized(contract.methods.is_priv_imm_initialized(defaultAccountAddress), true);
    });

    // Calls initialize_private_immutable a second time; asserts it throws and the flag remains true.
    it('fail to reinitialize', async () => {
      await expectInitialized(contract.methods.is_priv_imm_initialized(defaultAccountAddress), true);
      await expect(
        contract.methods.initialize_private_immutable(RANDOMNESS, VALUE).send({ from: defaultAccountAddress }),
      ).rejects.toThrow();
      await expectInitialized(contract.methods.is_priv_imm_initialized(defaultAccountAddress), true);
    });

    // Reads the PrivateImmutable after initialization; asserts the stored value matches VALUE.
    it('read initialized PrivateImmutable', async () => {
      await expectInitialized(contract.methods.is_priv_imm_initialized(defaultAccountAddress), true);
      const {
        result: { value },
      } = await contract.methods
        .view_private_immutable(defaultAccountAddress)
        .simulate({ from: defaultAccountAddress });
      expect(value).toEqual(VALUE);
    });
  });

  // Tests for DelayedPublicMutable: verifies that changing the authorized-delay alters the
  // expirationTimestamp returned in private reads by the expected amount.
  describe('DelayedPublicMutable', () => {
    let authContract: AuthContract;

    beforeAll(async () => {
      // We use the auth contract here because has a nice, clear, simple implementation of Delayed Public Mutable
      ({ contract: authContract } = await AuthContract.deploy(wallet, defaultAccountAddress).send({
        from: defaultAccountAddress,
      }));
    });

    // Lowers the authorized delay to the smallest value aztec-nr accepts, warps the chain past the scheduled
    // timestamp_of_change, then proves the private read and asserts the expirationTimestamp equals
    // anchorTimestamp + newDelay - 1.
    it('sets the expiration timestamp property', async () => {
      const oldDelay = (await authContract.methods.get_authorized_delay().simulate({ from: defaultAccountAddress }))
        .result;
      // The PXE rounds a tx's expiration down to a whole number of hours (then half hours) past the anchor block, so
      // newDelay - 1 is a whole hour to keep the exact value observable. This is also just above the smallest delay
      // aztec-nr accepts (DELAYED_PUBLIC_MUTABLE_MINIMUM_DELAY).
      const newDelay = 60n * 60n + 1n;
      expect(oldDelay).toBeGreaterThan(newDelay);

      await authContract.methods.set_authorized_delay(newDelay).send({ from: defaultAccountAddress });

      // When decreasing the delay, the timestamp of change is scheduled `oldDelay - newDelay` seconds in from the
      // current timestamp. A warp this long crosses epochs with no proofs submitted, so the pending chain must be
      // marked proven first or the rollup prunes it.
      await t.markProvenAndWarp(oldDelay - newDelay);

      // expirationTimestamp is `anchor.timestamp + effective_minimum_delay`, where the anchor is the
      // historical header the PXE pinned at the start of proveTx. Compare directly against that anchor
      // so the assertion isn't flaky against chain drift between the "latest" snapshot and proveTx's own sync.
      const tx = await proveInteraction(wallet, authContract.methods.get_authorized_in_private(), {
        from: defaultAccountAddress,
      });

      const anchorTimestamp = tx.data.constants.anchorBlockHeader.globalVariables.timestamp;
      expect(tx.data.expirationTimestamp).toEqual(anchorTimestamp + newDelay - 1n);
    });
  });
});
