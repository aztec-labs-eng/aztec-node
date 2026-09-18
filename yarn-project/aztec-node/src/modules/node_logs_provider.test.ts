import { BlockNumber, CheckpointNumber, IndexWithinCheckpoint } from '@aztec-labs/foundation/branded-types';
import { BadRequestError } from '@aztec-labs/foundation/json-rpc';
import { AztecAddress } from '@aztec-labs/stdlib/aztec-address';
import { type BlockData, BlockHash, L2Block } from '@aztec-labs/stdlib/block';
import type { L2LogsSource } from '@aztec-labs/stdlib/interfaces/server';
import { type PrivateLogsQuery, type PublicLogsQuery, SiloedTag, Tag } from '@aztec-labs/stdlib/logs';
import { BlockHeader, GlobalVariables } from '@aztec-labs/stdlib/tx';
import { type MockProxy, mock } from 'jest-mock-extended';

import { NodeLogsProvider } from './node_logs_provider.js';
import type { UnseenBlockHoldOff } from './unseen_block_hold_off.js';

const makeBlockData = (blockNumber: BlockNumber, blockHash: BlockHash): BlockData => {
  const header = BlockHeader.empty({ globalVariables: GlobalVariables.empty({ blockNumber }) });
  header.setHash(blockHash);
  return {
    header,
    archive: L2Block.empty().archive,
    blockHash,
    checkpointNumber: CheckpointNumber(1),
    indexWithinCheckpoint: IndexWithinCheckpoint(0),
  };
};

describe('NodeLogsProvider', () => {
  let logsSource: MockProxy<L2LogsSource>;
  let holdOff: MockProxy<UnseenBlockHoldOff>;
  let provider: NodeLogsProvider;
  let tags: SiloedTag[];
  let contractAddress: AztecAddress;

  const anchorHash = BlockHash.random();
  const anchorNumber = BlockNumber(7);

  /** A private query with whatever anchor the caller wants to test, and a range the provider must leave alone. */
  const privateQuery = (referenceBlock: PrivateLogsQuery['referenceBlock']): PrivateLogsQuery => ({
    tags,
    referenceBlock,
    fromBlock: BlockNumber(2),
    toBlock: BlockNumber(anchorNumber + 1),
    includeEffects: true,
  });

  beforeAll(async () => {
    contractAddress = await AztecAddress.random();
    tags = await Promise.all([SiloedTag.computeFromTagAndApp(Tag.random(), contractAddress)]);
  });

  beforeEach(() => {
    logsSource = mock<L2LogsSource>();
    logsSource.getPrivateLogsByTags.mockResolvedValue([[]]);
    logsSource.getPublicLogsByTags.mockResolvedValue([[]]);
    holdOff = mock<UnseenBlockHoldOff>();
    holdOff.getBlockData.mockResolvedValue(makeBlockData(anchorNumber, anchorHash));
    provider = new NodeLogsProvider(logsSource, holdOff);
  });

  it('passes a query without an anchor straight through', async () => {
    await provider.getPrivateLogsByTags(privateQuery(undefined));

    expect(logsSource.getPrivateLogsByTags).toHaveBeenCalledWith({
      tags,
      fromBlock: BlockNumber(2),
      toBlock: BlockNumber(anchorNumber + 1),
      includeEffects: true,
    });
    expect(holdOff.getBlockData).not.toHaveBeenCalled();
  });

  it('reduces an anchor to the hash the logs source checks against, keeping the rest of the query', async () => {
    await provider.getPrivateLogsByTags(privateQuery({ number: anchorNumber, hash: anchorHash }));

    expect(logsSource.getPrivateLogsByTags).toHaveBeenCalledWith({
      tags,
      referenceBlock: anchorHash,
      fromBlock: BlockNumber(2),
      toBlock: BlockNumber(anchorNumber + 1),
      includeEffects: true,
    });
  });

  it('holds an anchored public query off on the anchor before reading logs', async () => {
    const publicTags = [Tag.random()];
    const query: PublicLogsQuery = {
      contractAddress,
      tags: publicTags,
      referenceBlock: { number: anchorNumber, hash: anchorHash },
    };

    await provider.getPublicLogsByTags(query);

    expect(holdOff.getBlockData).toHaveBeenCalledWith({ number: anchorNumber, hash: anchorHash });
    expect(logsSource.getPublicLogsByTags).toHaveBeenCalledWith({
      contractAddress,
      tags: publicTags,
      referenceBlock: anchorHash,
    });
  });

  it('holds a bare-hash query off and passes the hash on whether or not the block arrives', async () => {
    holdOff.getBlockData.mockResolvedValue(undefined);

    await provider.getPrivateLogsByTags(privateQuery(anchorHash));

    // The logs source's own in-transaction check stays authoritative for a bare hash, so the miss is delegated.
    expect(holdOff.getBlockData).toHaveBeenCalledWith({ hash: anchorHash });
    expect(logsSource.getPrivateLogsByTags).toHaveBeenCalledWith(
      expect.objectContaining({ referenceBlock: anchorHash }),
    );
  });

  it('fails an anchor it could not resolve rather than delegating its hash', async () => {
    holdOff.getBlockData.mockResolvedValue(undefined);

    await expect(
      provider.getPrivateLogsByTags(privateQuery({ number: anchorNumber, hash: anchorHash })),
    ).rejects.toThrow(/not found in the node/);
    expect(logsSource.getPrivateLogsByTags).not.toHaveBeenCalled();
  });

  it('surfaces the hold-off rejection of an anchor whose height does not match its hash', async () => {
    holdOff.getBlockData.mockRejectedValue(new BadRequestError('Anchor block is block 9, not the requested block 7'));

    await expect(
      provider.getPrivateLogsByTags(privateQuery({ number: anchorNumber, hash: anchorHash })),
    ).rejects.toThrow(BadRequestError);
    expect(logsSource.getPrivateLogsByTags).not.toHaveBeenCalled();
  });
});
