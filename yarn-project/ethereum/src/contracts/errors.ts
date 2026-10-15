export class BlockTagTooOldError extends Error {
  constructor(blockTag: bigint | number, latestBlock: bigint | number) {
    super(`Block tag ${blockTag} is more than 128 blocks behind the latest block ${latestBlock}`);
    this.name = 'BlockTagTooOldError';
  }
}

export class NoCommitteeError extends Error {
  constructor() {
    super('The committee does not exist on L1');
    this.name = 'NoCommitteeError';
  }
}

/**
 * The committee for an epoch cannot be served yet because its sample seed can still change on L1: the randao it
 * samples has not been checkpointed, and the epoch that would checkpoint it is not over.
 */
export class CommitteeNotStableError extends Error {
  constructor(
    public readonly epoch: bigint,
    public readonly l1BlockNumber: bigint,
  ) {
    super(`The committee for epoch ${epoch} is not stable yet as of L1 block ${l1BlockNumber}`);
    this.name = 'CommitteeNotStableError';
  }
}
