import type { CheckpointProposalHash, SlotNumber } from '@aztec-labs/foundation/branded-types';
import type { AztecNodeAdminConfig } from '@aztec-labs/stdlib/interfaces/client';
import type { P2PClient, P2PConnectivity, PeerInfo, ProposalsForSlot } from '@aztec-labs/stdlib/interfaces/server';
import type { CheckpointAttestation } from '@aztec-labs/stdlib/p2p';
import type { Tx, TxHash } from '@aztec-labs/stdlib/tx';

/**
 * The p2p client of a TXE node. There are no peers and no tx pool: the queries the node makes while serving the
 * TXE get the answer an idle, disconnected client would give, and everything else is refused.
 */
export class DummyP2P implements P2PClient {
  public getPendingTxs(): Promise<Tx[]> {
    throw new Error('DummyP2P does not implement "getPendingTxs"');
  }

  public getPendingTxCount(): Promise<number> {
    throw new Error('DummyP2P does not implement "getPendingTxCount"');
  }

  public getEncodedEnr(): Promise<string | undefined> {
    throw new Error('DummyP2P does not implement "getEncodedEnr"');
  }

  public getPeers(_includePending?: boolean): Promise<PeerInfo[]> {
    throw new Error('DummyP2P does not implement "getPeers"');
  }

  public getP2PConnectivity(): Promise<P2PConnectivity> {
    return Promise.resolve({ enabled: false, connectedPeers: 0 });
  }

  public getCheckpointAttestationsForSlot(
    _slot: SlotNumber,
    _proposalPayloadHash?: CheckpointProposalHash,
  ): Promise<CheckpointAttestation[]> {
    throw new Error('DummyP2P does not implement "getCheckpointAttestationsForSlot"');
  }

  public addOwnCheckpointAttestations(_attestations: CheckpointAttestation[]): Promise<void> {
    throw new Error('DummyP2P does not implement "addOwnCheckpointAttestations"');
  }

  public getProposalsForSlot(_slot: SlotNumber): Promise<ProposalsForSlot> {
    return Promise.resolve({ blockProposals: [], checkpointProposals: [] });
  }

  public hasCheckpointProposalForSlot(_slot: SlotNumber): Promise<boolean> {
    return Promise.resolve(false);
  }

  public sendTx(_tx: Tx): Promise<void> {
    throw new Error('DummyP2P does not implement "sendTx"');
  }

  public getTxByHashFromPool(_txHash: TxHash): Promise<Tx | undefined> {
    throw new Error('DummyP2P does not implement "getTxByHashFromPool"');
  }

  public getTxsByHashFromPool(_txHashes: TxHash[]): Promise<(Tx | undefined)[]> {
    throw new Error('DummyP2P does not implement "getTxsByHashFromPool"');
  }

  public getTxStatus(_txHash: TxHash): Promise<'pending' | 'mined' | undefined> {
    // In TXE there is no concept of transactions but we need to implement this because of tagging. We return 'mined'
    // tx status for any tx hash.
    return Promise.resolve('mined');
  }

  public iteratePendingTxs(): AsyncIterableIterator<Tx> {
    throw new Error('DummyP2P does not implement "iteratePendingTxs"');
  }

  public isReady(): boolean {
    throw new Error('DummyP2P does not implement "isReady"');
  }

  public updateP2PConfig(_config: Partial<AztecNodeAdminConfig>): Promise<void> {
    throw new Error('DummyP2P does not implement "updateP2PConfig"');
  }

  public clear(): Promise<void> {
    throw new Error('DummyP2P does not implement "clear".');
  }
}
