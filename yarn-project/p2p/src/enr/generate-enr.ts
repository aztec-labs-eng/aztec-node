import type { LogFn } from '@aztec-labs/foundation/log';
import { type ChainConfig, emptyChainConfig } from '@aztec-labs/stdlib/config';
import type { ComponentsVersions } from '@aztec-labs/stdlib/versioning';
import type { PeerId } from '@libp2p/interface';
import { type Multiaddr, multiaddr } from '@multiformats/multiaddr';
import { ENR, SignableENR } from '@nethermindeth/enr';

import { AZTEC_ENR_CLIENT_VERSION_KEY, AZTEC_ENR_KEY } from '../types/index.js';
import { convertToMultiaddr, createLibP2PPeerIdFromPrivateKey } from '../util.js';
import { setAztecClientVersionEnrKey, setAztecEnrKey } from '../versioning.js';

export { ENR };

/**
 * Creates an ENR for our own identity with a sequence number seeded from the wall clock.
 *
 * Peers only replace a stored ENR when they see a higher sequence, so a node restarting with the same identity at a new
 * address must advertise a sequence above anything a previous run published. Seeding with the current time in ms
 * guarantees that without persisting a counter (which a crash or a wiped data directory would lose), as long as a
 * single run does not bump the sequence more times than milliseconds elapse before the next start.
 */
function createLocalEnr(peerId: PeerId): SignableENR {
  const enr = SignableENR.createFromPeerId(peerId);
  enr.seq = BigInt(Date.now());
  return enr;
}

export async function createBootnodeENRandPeerId(
  privateKey: string,
  p2pIp: string,
  p2pBroadcastPort: number,
  l1ChainId: number,
): Promise<{ enr: SignableENR; peerId: PeerId }> {
  const peerId = await createLibP2PPeerIdFromPrivateKey(privateKey);
  const enr = createLocalEnr(peerId);
  const publicAddr = multiaddr(convertToMultiaddr(p2pIp, p2pBroadcastPort, 'udp'));
  enr.setLocationMultiaddr(publicAddr);

  const config: ChainConfig = {
    ...emptyChainConfig,
    l1ChainId,
  };

  setAztecEnrKey(enr, config);
  return { enr, peerId };
}

export function createNodeENR(
  peerId: PeerId,
  multiAddrUdp: Multiaddr | undefined,
  multiAddrTcp: Multiaddr | undefined,
  chainConfig: ChainConfig,
  packageVersion: string,
): { enr: SignableENR; versions: ComponentsVersions } {
  // create ENR from PeerId
  const enr = createLocalEnr(peerId);
  // Add aztec identification to ENR
  const versions = setAztecEnrKey(enr, chainConfig);
  // Add aztec client version to ENR
  setAztecClientVersionEnrKey(enr, packageVersion);

  // set location multiaddr in ENR record
  if (multiAddrUdp) {
    enr.setLocationMultiaddr(multiAddrUdp);
  }
  if (multiAddrTcp) {
    enr.setLocationMultiaddr(multiAddrTcp);
  }

  return { enr, versions };
}

export async function printENR(enr: string, log: LogFn) {
  const decoded = ENR.decodeTxt(enr);
  log(`PeerID: ${await decoded.peerId()}`);
  log(`IP: ${decoded.ip}`);
  log(`UDP: ${decoded.udp}`);
  log(`TCP: ${decoded.tcp}`);

  const aztec = decoded.kvs.get(AZTEC_ENR_KEY);
  log(`Aztec version: ${aztec?.toString()}`);

  const aztecClientVersion = decoded.kvs.get(AZTEC_ENR_CLIENT_VERSION_KEY);
  log(`Aztec client version ${aztecClientVersion ? aztecClientVersion!.toString() : 'N/A'}`);
}
