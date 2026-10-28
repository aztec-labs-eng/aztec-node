import { findUnboundedContainersInApi } from '@aztec-labs/foundation/testing';

import { TXEDispatcherApiSchema } from './index.js';
import { OracleTestRpcHandlerSchema } from './oracle/test-resolver/index.js';

describe('TXE API schema parameters', () => {
  it.each([
    ['TXEDispatcherApiSchema', TXEDispatcherApiSchema],
    ['OracleTestRpcHandlerSchema', OracleTestRpcHandlerSchema],
  ])('%s bounds every array and record before parsing their entries', (_name, schema) => {
    expect(findUnboundedContainersInApi(schema)).toEqual([]);
  });
});
