import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import type { Wallet } from '@aztec-labs/aztec.js/wallet';
import type { LogFn } from '@aztec-labs/foundation/log';

export async function registerSender(wallet: Wallet, address: AztecAddress, log: LogFn) {
  await wallet.registerSender(address);
  log(`Sender registered: ${address}`);
}
