import { createLogger } from '@aztec-labs/foundation/log';
import { retryUntil } from '@aztec-labs/foundation/retry';
import { ChonkProof } from '@aztec-labs/stdlib/proofs';
import { mockTx } from '@aztec-labs/stdlib/testing';
import getPort from 'get-port';
import path from 'path';
import { fileURLToPath } from 'url';

import type { P2PConfig } from '../config.js';
import { WorkerClientManager, testChainConfig } from './worker_client_manager.js';

const NUMBER_OF_ITERATIONS = 2;
const NODES_TO_CHANGE_PORT = 1;
const WORKER_READY_TIMEOUT_MS = 120_000;
const CONNECTIVITY_TIMEOUT_MS = 120_000;
const PROPAGATION_TIMEOUT_MS = 60_000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Test Summary:
// - Start 5 clients
// - For NUMBER_OF_ITERATIONS iterations:
//    - Send a tx from a random client
//    - Allow for it to propagate to all other clients
//    - change the port for NODES_TO_CHANGE_PORT random clients
//    - Wait for the mesh to re-form after the change
describe('Port Change', () => {
  let workerClientManager: WorkerClientManager;
  let numberOfClients: number;
  let testConfig: P2PConfig;
  const logger = createLogger('testbench-ports');

  beforeEach(async () => {
    logger.info('Starting test setup');
    // Use 5 node configuration for this test
    // @dependency ../../testbench/configurations/normal-degree-5-nodes.json
    const configPath = path.join(__dirname, '../../testbench/configurations', 'normal-degree-5-nodes.json');
    logger.info(`Loading config from ${configPath}`);
    const config = await import(configPath, { with: { type: 'json' } });
    testConfig = {
      ...testChainConfig,
      ...config.default,
      boostrapNodeEnrVersionCheck: false,
      bootstrapNodesAsFullPeers: true,
    };
    numberOfClients = config.default.numberOfClients;
    logger.info(`Creating ${numberOfClients} clients`);

    workerClientManager = new WorkerClientManager(logger, testConfig);
    // The default worker-ready budget is shared with the p2p benches; forking five libp2p nodes can be
    // descheduled well past it when CI packs many containers onto one host, so this suite asks for more.
    await workerClientManager.makeWorkerClients(numberOfClients, { readyTimeoutMs: WORKER_READY_TIMEOUT_MS });

    // bootstrapNodesAsFullPeers gives every client every other client as a bootstrap node, so a settled
    // mesh is each of them holding all the others.
    const peers = await workerClientManager.waitForAllConnectivity(numberOfClients - 1, CONNECTIVITY_TIMEOUT_MS);
    expect(Math.min(...peers)).toBe(numberOfClients - 1);
    logger.info('Workers Ready');
    // Forking five libp2p nodes and settling the mesh measures ~40s at 6x oversubscription of the
    // declared CPU budget and ~75s at 12x, so the ceiling is sized to the tail rather than the mean.
  }, 120 * 1000);

  it(
    'should change port and propagate the gossip message correctly',
    async () => {
      // Run test multiple times for each client
      for (let i = 0; i < NUMBER_OF_ITERATIONS; i++) {
        // Pick a random client
        const clientIndex = Math.floor(Math.random() * numberOfClients);

        // Send tx from random client
        const tx = await mockTx(1, {
          chonkProof: ChonkProof.random(),
        });

        workerClientManager.processes[clientIndex].send({ type: 'SEND_TX', tx: tx.toBuffer() });
        logger.info(`Transaction sent from client ${clientIndex}`);

        const received = await retryUntil(
          () => {
            const count = workerClientManager.numberOfClientsThatReceivedMessage();
            return count === numberOfClients - 1 ? count : undefined;
          },
          'gossip to reach every other client',
          PROPAGATION_TIMEOUT_MS / 1000,
          0.25,
        ).catch(() => workerClientManager.numberOfClientsThatReceivedMessage());

        expect(received).toBe(numberOfClients - 1);
        logger.info('All clients received message');

        workerClientManager.purgeMessageReceivedByClient();

        logger.info(`Iteration ${i + 1} done`);

        // change port for NODES_TO_CHANGE_PORT random clients
        for (let j = 0; j < NODES_TO_CHANGE_PORT; j++) {
          const clientIndexToChangePort = Math.floor(Math.random() * numberOfClients);
          logger.info(`Changing port for client ${clientIndexToChangePort}`);
          await workerClientManager.changePort(clientIndexToChangePort, await getPort());

          // Rediscovery is what this test exercises: wait for the mesh to re-form rather than for a
          // fixed number of peer-manager heartbeats, which is what the next iteration's gossip needs.
          await workerClientManager.waitForAllConnectivity(numberOfClients - 1, CONNECTIVITY_TIMEOUT_MS);
        }
      }

      logger.info('Test passed');
    },
    20 * 60 * 1000,
  );

  afterEach(async () => {
    logger.info('Cleaning up');
    await workerClientManager.cleanup();
  });
});
