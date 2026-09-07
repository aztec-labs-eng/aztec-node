import { PIPELINING_SETUP_OPTS } from '../fixtures/fixtures.js';
import { setup as e2eSetup } from '../fixtures/utils.js';
import { uniswapL1L2TestSuite } from '../shared/uniswap_l1_l2.js';

// This tests works on forked mainnet. There is a dump of the data in `dumpedState` such that we
// don't need to burn through RPC requests.
// Uses setup() with PIPELINING_SETUP_OPTS, stateLoad (anvil chain dump), and startProverNode. Delegates to
// uniswapL1L2TestSuite which drives L1 Uniswap interactions from L2. The mainnet state comes entirely from
// the dump, so this runs on its own in-process anvil and is scheduled as a simple test (see bootstrap.sh)
// even though it sits under src/composed.
const dumpedState = 'src/fixtures/dumps/uniswap_state';
// When taking a dump use the block number of the fork to improve speed.
const EXPECTED_FORKED_BLOCK = 0; //17514288;

let teardown: () => Promise<void>;

const testSetup = async () => {
  const context = await e2eSetup(2, { ...PIPELINING_SETUP_OPTS, stateLoad: dumpedState, startProverNode: true });

  teardown = context.teardown;

  return context;
};

const testCleanup = async () => {
  await teardown();
};

uniswapL1L2TestSuite(testSetup, testCleanup, EXPECTED_FORKED_BLOCK);
