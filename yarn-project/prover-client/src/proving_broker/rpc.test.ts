import { findUnboundedContainersInApi } from '@aztec-labs/foundation/testing';
import { ProvingRequestType } from '@aztec-labs/stdlib/proofs';

import {
  ProvingJobBrokerSchemaWithDebug,
  ProvingJobConsumerSchema,
  ProvingJobFilterSchema,
  ProvingJobProducerSchema,
} from './rpc.js';

describe('ProvingJobFilterSchema', () => {
  it('accepts a small allowList of distinct proving-request types', () => {
    const parsed = ProvingJobFilterSchema.parse({
      allowList: [ProvingRequestType.PUBLIC_VM, ProvingRequestType.ROOT_ROLLUP],
    });
    expect(parsed.allowList).toEqual([ProvingRequestType.PUBLIC_VM, ProvingRequestType.ROOT_ROLLUP]);
  });

  it('rejects an oversized allowList packed with duplicates before the broker clones/sorts/scans it', () => {
    const huge = new Array(100_000).fill(ProvingRequestType.PUBLIC_VM);
    expect(() => ProvingJobFilterSchema.parse({ allowList: huge })).toThrow();
  });
});

describe('ProvingJobProducerSchema parameters', () => {
  it('bound every array and record before parsing their entries', () => {
    expect(findUnboundedContainersInApi(ProvingJobProducerSchema)).toEqual([]);
  });
});

describe('ProvingJobConsumerSchema parameters', () => {
  it('bound every array and record before parsing their entries', () => {
    expect(findUnboundedContainersInApi(ProvingJobConsumerSchema)).toEqual([]);
  });
});

describe('ProvingJobBrokerSchemaWithDebug parameters', () => {
  it('bound every array and record before parsing their entries', () => {
    expect(findUnboundedContainersInApi(ProvingJobBrokerSchemaWithDebug)).toEqual([]);
  });
});
