import { STANDARD_POST_QUANTUM_PUBLIC_KEY_REGISTRY_ADDRESS } from '@aztec-labs/standard-contracts/post-quantum-public-key-registry/constants';
import { type ABIParameterVisibility, type FunctionAbi, FunctionType } from '@aztec-labs/stdlib/abi';
import type { AztecAddress } from '@aztec-labs/stdlib/aztec-address';
import { PostQuantumPublicKey } from '@aztec-labs/stdlib/keys';
import type { TxProfileResult } from '@aztec-labs/stdlib/tx';

import { ContractFunctionInteraction } from '../contract/contract_function_interaction.js';
import type {
  InteractionWaitOptions,
  ProfileInteractionOptions,
  SendInteractionOptions,
  SendInteractionOptionsWithoutWait,
  SendReturn,
  SimulateInteractionOptions,
  SimulationResult,
  TxSendResultMined,
} from '../contract/interaction_options.js';
import type { Wallet } from '../wallet/index.js';

/**
 * Interaction that registers an account's post-quantum public key in the standard post-quantum public key registry.
 *
 * An account can register a key only once, so the interaction is always sent from the account whose key it is. Derive
 * an account's key with `derivePostQuantumKeyPair`.
 */
export class RegisterPostQuantumPublicKeyInteraction extends ContractFunctionInteraction {
  constructor(
    wallet: Wallet,
    private readonly account: AztecAddress,
    publicKey: PostQuantumPublicKey,
  ) {
    super(wallet, STANDARD_POST_QUANTUM_PUBLIC_KEY_REGISTRY_ADDRESS, getRegisterAbi(), [
      { fields: publicKey.toFields() },
    ]);
  }

  /**
   * Simulates the registration from the account whose key it is.
   * @param options - The simulation options, without `from`, which is always the account.
   */
  public override simulate(
    options: Omit<SimulateInteractionOptions, 'from'> = {} as Omit<SimulateInteractionOptions, 'from'>,
  ): Promise<SimulationResult> {
    return super.simulate({ ...options, from: this.account } as SimulateInteractionOptions);
  }

  /**
   * Profiles the registration from the account whose key it is.
   * @param options - The profiling options, without `from`, which is always the account.
   */
  public override profile(
    options: Omit<ProfileInteractionOptions, 'from'> = { profileMode: 'gates' },
  ): Promise<TxProfileResult> {
    return super.profile({ ...options, from: this.account });
  }

  /**
   * Sends the registration from the account whose key it is.
   * @param options - The send options, without `from`, which is always the account.
   */
  public override send(options?: Omit<SendInteractionOptionsWithoutWait, 'from'>): Promise<TxSendResultMined>;
  // Generic overload for explicit wait values
  // eslint-disable-next-line jsdoc/require-jsdoc
  public override send<W extends InteractionWaitOptions>(
    options?: Omit<SendInteractionOptions<W>, 'from'>,
  ): Promise<SendReturn<W>>;
  // eslint-disable-next-line jsdoc/require-jsdoc
  public override send(
    options?: Omit<SendInteractionOptions<InteractionWaitOptions>, 'from'>,
  ): Promise<SendReturn<InteractionWaitOptions>> {
    return super.send({ ...options, from: this.account });
  }
}

/** ABI of the registry's `register` function, written out so that this module does not load the registry's artifact. */
function getRegisterAbi(): FunctionAbi {
  return {
    name: 'register',
    isInitializer: false,
    functionType: FunctionType.PRIVATE,
    isOnlySelf: false,
    isStatic: false,
    parameters: [
      {
        name: 'public_key',
        type: {
          kind: 'struct',
          path: 'aztec::keys::post_quantum::mlkem768::PostQuantumPublicKey',
          fields: [
            {
              name: 'fields',
              type: { kind: 'array', length: PostQuantumPublicKey.SIZE_IN_FIELDS, type: { kind: 'field' } },
            },
          ],
        },
        visibility: 'private' as ABIParameterVisibility,
      },
    ],
    errorTypes: {},
  };
}
