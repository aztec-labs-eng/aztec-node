import type { AztecAsyncKVStore } from '@aztec-labs/kv-store';
import { openTmpStore } from '@aztec-labs/kv-store/lmdb-v2';
import { GENESIS_BLOCK_HEADER_HASH } from '@aztec-labs/stdlib/block';
import { testL2TipsStore } from '@aztec-labs/stdlib/block/test';

import { L2TipsKVStore } from './l2_tips_store.js';

describe('L2TipsStore', () => {
  let kvStore: AztecAsyncKVStore;

  afterEach(async () => {
    await kvStore.delete();
  });

  testL2TipsStore(async () => {
    kvStore = await openTmpStore('test', true);
    return new L2TipsKVStore(kvStore, 'test', GENESIS_BLOCK_HEADER_HASH);
  });
});
