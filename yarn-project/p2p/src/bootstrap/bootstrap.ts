import { type Logger, type LoggerBindings, createLogger } from '@aztec-labs/foundation/log';
import type { AztecAsyncKVStore } from '@aztec-labs/kv-store';
import type { P2PBootstrapApi } from '@aztec-labs/stdlib/interfaces/server';
import { OtelMetricsAdapter, type TelemetryClient } from '@aztec-labs/telemetry-client';
import type { PeerId } from '@libp2p/interface';
import { type Multiaddr, multiaddr } from '@multiformats/multiaddr';
import { Discv5, type Discv5EventEmitter } from '@nethermindeth/discv5';
import { ENR, type SignableENR } from '@nethermindeth/enr';

import type { BootnodeConfig } from '../config.js';
import { createBootnodeENRandPeerId } from '../enr/generate-enr.js';
import { convertToMultiaddr, getPeerIdPrivateKey, getPublicIp } from '../util.js';
import { validateAztecEnrVersion } from '../versioning.js';

/**
 * Encapsulates a 'Bootstrap' node, used for the purpose of assisting new joiners in acquiring peers.
 */
export class BootstrapNode implements P2PBootstrapApi {
  private node?: Discv5EventEmitter = undefined;
  private peerId?: PeerId;
  private logger: Logger;

  constructor(
    private store: AztecAsyncKVStore,
    private telemetry: TelemetryClient,
    bindings?: LoggerBindings,
  ) {
    this.logger = createLogger('p2p:bootstrap', bindings);
  }

  /**
   * Starts the bootstrap node.
   * @param config - A partial P2P configuration. No need for TCP values as well as aztec node specific values.
   * @returns An empty promise.
   */
  public async start(config: BootnodeConfig) {
    const { p2pPort, listenAddress, p2pBroadcastPort, queryForIp } = config;
    let p2pIp = config.p2pIp;
    this.logger.info(`Starting bootstrap node with config: ${JSON.stringify(config)}`);
    if (!p2pIp) {
      if (queryForIp) {
        this.logger.info('Querying for public IP address...');
        const publicIp = await getPublicIp(config.publicIpServices);
        p2pIp = publicIp;
        this.logger.info(`Found public IP address: ${publicIp}`);
      }
    }

    if (!p2pIp) {
      throw new Error('You need to provide a P2P IP address.');
    }

    if (!p2pBroadcastPort) {
      config.p2pBroadcastPort = p2pPort;
    }

    const listenAddrUdp = multiaddr(convertToMultiaddr(listenAddress, p2pPort, 'udp'));

    const peerIdPrivateKey = await getPeerIdPrivateKey(config, this.store, this.logger);

    const { enr: ourEnr, peerId } = await createBootnodeENRandPeerId(
      peerIdPrivateKey.getValue(),
      p2pIp,
      config.p2pBroadcastPort!,
      config.l1ChainId,
    );
    this.peerId = peerId;

    this.logger.debug(`Starting bootstrap node ${peerId} listening on ${listenAddrUdp.toString()}`);

    const metricsRegistry = new OtelMetricsAdapter(this.telemetry, this.logger.getBindings());
    this.node = Discv5.create({
      enr: ourEnr,
      peerId,
      bindAddrs: { ip4: listenAddrUdp },
      config: {
        lookupTimeout: 2000,
        allowUnverifiedSessions: true,
      },
      metricsRegistry,
    });

    const versions = { l1ChainId: config.l1ChainId };
    const origOnEstablished = this.node.onEstablished.bind(this.node);
    this.node.onEstablished = (...args: unknown[]) => {
      if (validateAztecEnrVersion(args[1] as ENR, versions, this.logger)) {
        return origOnEstablished(...args);
      }
    };

    // discv5 updates known ENRs after emitting 'discovered', so filter before that update runs.
    const origDiscovered = this.node.discovered.bind(this.node);
    this.node.discovered = (srcId: string, enrs: ENR[], lookupId?: number) =>
      origDiscovered(
        srcId,
        enrs.filter(enr => validateAztecEnrVersion(enr, versions, this.logger)),
        lookupId,
      );

    this.node.on('multiaddrUpdated', (addr: Multiaddr) => {
      this.logger.info('Advertised socket address updated', { addr: addr.toString() });
    });
    this.node.on('discovered', async (enr: SignableENR) => {
      try {
        if (!validateAztecEnrVersion(enr, versions, this.logger)) {
          return;
        }
        const addr = await enr.getFullMultiaddr('udp');
        this.logger.verbose(`Discovered new peer`, { enr: enr.encodeTxt(), addr: addr?.toString() });
        // The bootnode runs no lookups: its only FINDNODE requests are distance-0 ENR refreshes for peers already in
        // the routing table, sent when a PING or PONG advertises a higher enrSeq. So this event only carries refreshed
        // records of known entries. addEnr() writes the record with insertOrUpdate, which on an existing entry also
        // marks it Disconnected. Nodes whose session was rejected for lacking a socket address never reach this
        // listener; they enter the routing table on a later handshake that carries their updated ENR.
        if (addr) {
          this.node.addEnr(enr);
        }
      } catch (err) {
        // A malformed ENR address field makes the parser throw. As an async listener this would crash
        // the bootnode on an unhandled rejection — catch, log, and drop the ENR instead.
        this.logger.warn(`Dropping discovered ENR with unparseable address`, { err });
      }
    });

    try {
      this.logger.info('Starting bootnode');
      await this.node.start();
      this.logger.info('Bootstrap node started', {
        peerId,
        enr: ourEnr.encodeTxt(),
        addr: listenAddrUdp.toString(),
      });
    } catch (e) {
      this.logger.error('Error starting Discv5', e);
    }

    // Add bootnode ENRs if provided, making sure we filter our own
    if (config.bootstrapNodes?.length) {
      const otherBootnodeENRs = config.bootstrapNodes
        .map(x => ENR.decodeTxt(x))
        .filter(b => b.nodeId !== ourEnr.nodeId);
      this.logger.info(`Adding bootstrap nodes ENRs: ${otherBootnodeENRs.map(x => x.encodeTxt()).join(', ')}`);
      try {
        otherBootnodeENRs.forEach(enr => {
          this.node.addEnr(enr);
        });
      } catch (e) {
        this.logger.error(`Error adding bootnode ENRs: ${e}`);
      }
    }
  }

  /**
   * Stops the bootstrap node.
   * @returns And empty promise.
   */
  public async stop() {
    // stop libp2p
    this.logger.debug('Stopping bootstrap node');
    await this.node?.stop();
    this.logger.info('Bootstrap node stopped');
  }

  private assertNodeStarted() {
    if (!this.node) {
      throw new Error('Node not started');
    }
  }

  private assertPeerId() {
    if (!this.peerId) {
      throw new Error('No peerId found');
    }
  }

  /**
   * Returns the peerId of this node.
   * @returns The node's peer Id
   */
  public getPeerId() {
    this.assertPeerId();
    return this.peerId!;
  }

  public getENR() {
    this.assertNodeStarted();
    return this.node?.enr.toENR();
  }

  public getEncodedEnr() {
    this.assertNodeStarted();
    return Promise.resolve(this.node!.enr.encodeTxt());
  }

  public getRoutingTable(): Promise<string[]> {
    this.assertNodeStarted();
    return Promise.resolve(this.node!.kadValues().map((enr: ENR) => enr.encodeTxt()));
  }
}
