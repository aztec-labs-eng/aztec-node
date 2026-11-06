import { findUnboundedContainersInApi } from '@aztec-labs/foundation/testing';

import { P2PBootstrapApiSchema } from './p2p-bootstrap.js';

describe('P2PBootstrapApiSchema parameters', () => {
  it('bound every array and record before parsing their entries', () => {
    expect(findUnboundedContainersInApi(P2PBootstrapApiSchema)).toEqual([]);
  });
});
