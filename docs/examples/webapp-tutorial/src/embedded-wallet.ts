// docs:start:embedded-wallet-imports
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { getContractInstanceFromInstantiationParams } from '@aztec-labs/aztec.js/contracts';
import { SponsoredFeePaymentMethod } from '@aztec-labs/aztec.js/fee';
import { Fr } from '@aztec-labs/aztec.js/fields';
import { SPONSORED_FPC_SALT } from '@aztec-labs/constants';
import { getInitialTestAccountsData } from '@aztec-labs/accounts/testing/lazy';
import type { ContractArtifact } from '@aztec-labs/stdlib/abi';
import { EmbeddedWallet as BaseEmbeddedWallet } from '@aztec-labs/wallets/embedded';
// docs:end:embedded-wallet-imports

// docs:start:embedded-wallet-class
/**
 * A tutorial wallet for local development.
 * Extends the official EmbeddedWallet to add SponsoredFPC fee payment
 * so users don't need to hold fee tokens.
 *
 * Inherits from the SDK's EmbeddedWallet which provides:
 * - Account creation and persistence via WalletDB
 * - Pre-simulation with gas estimation in sendTx
 * - Automatic authwitness generation
 * - Stub-account simulation (no expensive kernel proving)
 */
export class EmbeddedWallet extends BaseEmbeddedWallet {
  connectedAccount: AztecAddress | null = null;

  // docs:start:fee-options
  /**
   * Uses SponsoredFPC for fee payment by default, so users
   * don't need to hold fee tokens.
   */
  protected override async getDefaultFeePaymentMethod() {
    const fpc = await EmbeddedWallet.#getSponsoredFPCContract();
    return new SponsoredFeePaymentMethod(fpc.instance.address);
  }
  // docs:end:fee-options

  // docs:start:initialize
  /**
   * Creates a new EmbeddedWallet connected to the given Aztec node URL.
   * Sets up an in-browser PXE and registers the SponsoredFPC contract.
   */
  static async initialize(nodeUrl: string): Promise<EmbeddedWallet> {
    const isLocal =
      nodeUrl.includes('localhost') || nodeUrl.includes('127.0.0.1');
    const wallet = await EmbeddedWallet.create<EmbeddedWallet>(nodeUrl, {
      ephemeral: true,
      pxeConfig: { proverEnabled: !isLocal },
    });

    // Register SponsoredFPC so we can pay fees
    const fpc = await EmbeddedWallet.#getSponsoredFPCContract();
    await wallet.registerContract(fpc.instance, fpc.artifact);

    return wallet;
  }
  // docs:end:initialize

  static async #getSponsoredFPCContract() {
    const { SponsoredFPCContractArtifact } = await import(
      '@aztec-labs/noir-contracts.js/SponsoredFPC'
    );
    const instance = await getContractInstanceFromInstantiationParams(
      SponsoredFPCContractArtifact,
      { salt: new Fr(SPONSORED_FPC_SALT) },
    );
    return { instance, artifact: SponsoredFPCContractArtifact };
  }

  getConnectedAccount() {
    return this.connectedAccount;
  }

  // docs:start:connect-test-account
  /**
   * Connects one of the pre-deployed test accounts available on the local network.
   * Uses the inherited createSchnorrAccount which handles account creation,
   * contract registration, and WalletDB persistence.
   */
  async connectTestAccount(index: number) {
    const testAccounts = await getInitialTestAccountsData();
    const accountData = testAccounts[index];

    const accountManager = await this.createSchnorrAccount(
      accountData.secret,
      accountData.salt,
      accountData.signingKey,
    );

    this.connectedAccount = accountManager.address;
    return this.connectedAccount;
  }
  // docs:end:connect-test-account

  /**
   * Fetches a contract instance from the Aztec node (onchain) and registers it
   * with this wallet's PXE. Required before calling private functions on contracts
   * deployed by another wallet/PXE.
   */
  async registerContractFromNode(
    address: AztecAddress,
    artifact: ContractArtifact,
  ) {
    const instance = await this.aztecNode.getContract(address);
    if (!instance) {
      throw new Error(`Contract not found onchain at ${address}`);
    }
    await this.registerContract(instance, artifact);
  }
  // docs:end:embedded-wallet-class
}
