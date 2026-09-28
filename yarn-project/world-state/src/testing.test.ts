import { GENESIS_ARCHIVE_ROOT } from '@aztec-labs/constants';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { DEFAULT_GENESIS_DATA, ProtocolContractGenesisNullifiers } from '@aztec-labs/protocol-contracts';
import { MerkleTreeId, PublicDataTreeLeaf } from '@aztec-labs/stdlib/trees';
import { EMPTY_GENESIS_DATA, type GenesisData } from '@aztec-labs/stdlib/world-state';
import { jest } from '@jest/globals';

import { NativeWorldStateService } from './native/index.js';
import { getGenesisValues } from './testing.js';

jest.setTimeout(60_000);

const archiveRoot = async (ws: NativeWorldStateService) =>
  new Fr((await ws.getCommitted().getTreeInfo(MerkleTreeId.ARCHIVE)).root);

describe('generateGenesisValues world state backend equivalence', () => {
  const genesis: GenesisData = {
    ...DEFAULT_GENESIS_DATA,
    prefilledPublicData: [
      new PublicDataTreeLeaf(new Fr(1000), new Fr(2000)),
      new PublicDataTreeLeaf(new Fr(3000), new Fr(4000)),
    ],
    genesisTimestamp: 1234567890n,
  };

  // The consensus-critical guarantee behind computing genesis values on the fsync-off ephemeral
  // backend instead of tmp: both backends must derive the exact same on-chain genesis archive root.
  it('ephemeral and tmp produce identical genesis archive roots', async () => {
    const tmpWs = await NativeWorldStateService.tmp(/*cleanupTmpDir=*/ true, genesis);
    const ephemeralWs = await NativeWorldStateService.ephemeral(genesis);
    try {
      const tmpRoot = await archiveRoot(tmpWs);
      const ephemeralRoot = await archiveRoot(ephemeralWs);
      expect(ephemeralRoot).toEqual(tmpRoot);
    } finally {
      await tmpWs.close();
      await ephemeralWs.close();
    }
  });
});

describe('genesis prefilled nullifiers', () => {
  const nullifierIndices = (ws: NativeWorldStateService, nullifiers: Fr[]) =>
    ws.getCommitted().findLeafIndices(
      MerkleTreeId.NULLIFIER_TREE,
      nullifiers.map(n => n.toBuffer()),
    );

  it('the default world state seeds every protocol contract registration nullifier', async () => {
    const ws = await NativeWorldStateService.ephemeral();
    try {
      const indices = await nullifierIndices(ws, ProtocolContractGenesisNullifiers);
      expect(ProtocolContractGenesisNullifiers.length).toBeGreaterThan(0);
      expect(indices.every(index => index !== undefined)).toBe(true);
    } finally {
      await ws.close();
    }
  });

  it('the default genesis archive root matches the pinned GENESIS_ARCHIVE_ROOT constant', async () => {
    const ws = await NativeWorldStateService.ephemeral(DEFAULT_GENESIS_DATA);
    try {
      expect(await archiveRoot(ws)).toEqual(new Fr(GENESIS_ARCHIVE_ROOT));
    } finally {
      await ws.close();
    }
    const { genesisArchiveRoot } = await getGenesisValues([]);
    expect(genesisArchiveRoot).toEqual(new Fr(GENESIS_ARCHIVE_ROOT));
  });

  it('an explicitly empty genesis seeds no protocol nullifiers and yields a different root', async () => {
    const ws = await NativeWorldStateService.ephemeral(EMPTY_GENESIS_DATA);
    try {
      const indices = await nullifierIndices(ws, ProtocolContractGenesisNullifiers);
      expect(indices.every(index => index === undefined)).toBe(true);
      expect(await archiveRoot(ws)).not.toEqual(new Fr(GENESIS_ARCHIVE_ROOT));
    } finally {
      await ws.close();
    }
  });

  it('getGenesisValues seeds the protocol baseline plus the additional nullifiers, sorted', async () => {
    // Values must exceed the padding leaves that fill the initial prefill region.
    const additional = [new Fr(3000n), new Fr(1000n), new Fr(2000n)];
    const additionalCopy = [...additional];
    const { genesis, genesisArchiveRoot } = await getGenesisValues([], undefined, [], 0n, additional);

    expect(additional).toEqual(additionalCopy);
    expect(genesis.prefilledNullifiers).toEqual(
      [...ProtocolContractGenesisNullifiers, ...additional].sort((a, b) => (a.toBigInt() < b.toBigInt() ? -1 : 1)),
    );

    const ws = await NativeWorldStateService.ephemeral(genesis);
    try {
      expect(await archiveRoot(ws)).toEqual(genesisArchiveRoot);
      const indices = await nullifierIndices(ws, [...ProtocolContractGenesisNullifiers, ...additional]);
      expect(indices.every(index => index !== undefined)).toBe(true);
    } finally {
      await ws.close();
    }
  });

  it('getGenesisValues rejects additional nullifiers that duplicate the protocol baseline', async () => {
    await expect(getGenesisValues([], undefined, [], 0n, [ProtocolContractGenesisNullifiers[0]])).rejects.toThrow(
      'Duplicate genesis nullifier',
    );
    await expect(getGenesisValues([], undefined, [], 0n, [new Fr(1000n), new Fr(1000n)])).rejects.toThrow(
      'Duplicate genesis nullifier',
    );
  });

  // The defensive TS-side check rejects prefilled nullifiers that are not unique and strictly increasing before
  // handing them to the native tree.
  it('rejects prefilled nullifiers that are not strictly increasing', async () => {
    const descending: GenesisData = {
      prefilledPublicData: [],
      genesisTimestamp: 0n,
      prefilledNullifiers: [new Fr(3000n), new Fr(1000n)],
    };
    await expect(NativeWorldStateService.ephemeral(descending)).rejects.toThrow(
      'Prefilled genesis nullifiers must be unique and strictly increasing',
    );

    const duplicate: GenesisData = {
      prefilledPublicData: [],
      genesisTimestamp: 0n,
      prefilledNullifiers: [new Fr(1000n), new Fr(1000n)],
    };
    await expect(NativeWorldStateService.ephemeral(duplicate)).rejects.toThrow(
      'Prefilled genesis nullifiers must be unique and strictly increasing',
    );
  });
});
