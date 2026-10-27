import type { LogFn } from '@aztec-labs/foundation/log';
import type { Command } from 'commander';

import { nodeOption } from '../../utils/commands.js';

export function injectCommands(program: Command, log: LogFn) {
  program
    .command('setup-protocol-contracts')
    .description('Bootstrap the blockchain by initializing all the protocol contracts')
    .addOption(nodeOption)
    .option('--testAccounts', 'Deploy funded test accounts.')
    .option('--json', 'Output the contract addresses in JSON format')
    .action(async options => {
      const { setupL2Contracts } = await import('./setup_l2_contract.js');
      await setupL2Contracts(options.nodeUrl, options.testAccounts, options.json, log);
    });

  return program;
}
