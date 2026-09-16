// The node service and what it takes to construct one, without the factory that assembles a node's subsystems.
// Consumers that wire their own collaborators (the TXE) import from here, so their dependency closure stops at
// the service instead of reaching every subsystem `createAztecNodeService` knows how to build.
export * from './aztec-node/server.js';
export { NextBlockPredictor } from './aztec-node/next_block/index.js';
export type { AztecNodeConfig } from './aztec-node/config.js';
