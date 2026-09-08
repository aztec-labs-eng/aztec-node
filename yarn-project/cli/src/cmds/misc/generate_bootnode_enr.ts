import type { LogFn } from '@aztec-labs/foundation/log';
import { createBootnodeENRandPeerId } from '@aztec-labs/p2p/enr';

export async function generateEncodedBootnodeENR(
  privateKey: string,
  p2pIp: string,
  p2pPort: number,
  l1ChainId: number,
  log: LogFn,
) {
  const { enr } = await createBootnodeENRandPeerId(privateKey, p2pIp, p2pPort, l1ChainId);
  log(`ENR: ${enr.encodeTxt()}`);
}
