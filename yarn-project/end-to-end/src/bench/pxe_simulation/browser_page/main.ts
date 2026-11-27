import { EmbeddedWallet } from '@aztec-labs/wallets/embedded';
import { Buffer } from 'buffer';

import { type Scenario, type ScenarioConfig, createScenario } from '../scenario.js';

declare global {
  interface Window {
    /** Mines a block the user is not involved in. The benchmark provides it. */
    mineBlock(): Promise<void>;
    /** The scenario, run in this page by the benchmark. */
    pxeSimulation: {
      setUp(config: ScenarioConfig): Promise<void>;
      sendTxs: Scenario['sendTxs'];
      measure: Scenario['measure'];
    };
  }
}

// Some dependencies use Buffer as a global, which a browser does not define.
Object.assign(globalThis, { Buffer });

let scenario: Scenario | undefined;

window.pxeSimulation = {
  async setUp(config) {
    scenario = await createScenario(config, {
      // The embedded wallet keeps its data in sqlite on OPFS.
      createWallet: node => EmbeddedWallet.create(node),
      mineBlock: () => window.mineBlock(),
    });
  },
  sendTxs: () => scenario!.sendTxs(),
  measure: () => scenario!.measure(),
};
