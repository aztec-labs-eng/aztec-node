import { BarretenbergSync } from '@aztec-foundation/bb.js';

export * from './poseidon/index.js';
export * from './pedersen/index.js';

await BarretenbergSync.initSingleton();
