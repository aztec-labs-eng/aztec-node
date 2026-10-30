import { findUnboundedContainersInApi } from '@aztec-labs/foundation/testing';

import { BotRunnerApiSchema } from './interface.js';

describe('BotRunnerApiSchema parameters', () => {
  it('bound every array and record before parsing their entries', () => {
    expect(findUnboundedContainersInApi(BotRunnerApiSchema)).toEqual([]);
  });
});
