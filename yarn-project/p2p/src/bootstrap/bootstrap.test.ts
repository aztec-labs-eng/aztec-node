import { openTmpStore } from '@aztec-labs/kv-store/lmdb-v2';
import { emptyChainConfig } from '@aztec-labs/stdlib/config';
import { getTelemetryClient } from '@aztec-labs/telemetry-client';
import { jest } from '@jest/globals';
import { Discv5 } from '@nethermindeth/discv5';

import { type BootnodeConfig, DEFAULT_PUBLIC_IP_SERVICES } from '../config.js';
import { BootstrapNode } from './bootstrap.js';

describe('BootstrapNode', () => {
  jest.setTimeout(30_000);

  it('binds discovery to the listen port while advertising the broadcast port', async () => {
    const store = await openTmpStore('bootstrap-bind-port-test');
    const bootNode = new BootstrapNode(store, getTelemetryClient());
    const createSpy = jest.spyOn(Discv5, 'create');

    const p2pPort = 41400;
    const p2pBroadcastPort = 41500;
    const config: BootnodeConfig = {
      p2pIp: '127.0.0.1',
      p2pPort,
      p2pBroadcastPort,
      listenAddress: '127.0.0.1',
      dataDirectory: undefined,
      dataStoreMapSizeKb: 0,
      bootstrapNodes: [],
      queryForIp: false,
      publicIpServices: DEFAULT_PUBLIC_IP_SERVICES,
      ...emptyChainConfig,
    };

    try {
      await bootNode.start(config);

      // A mapped deployment sets listen != broadcast. The discovery socket must bind the local
      // listen port so routed packets arrive, while the advertised record keeps the broadcast port.
      const createArgs = createSpy.mock.calls[0][0] as Parameters<typeof Discv5.create>[0];
      const boundIp4 = createArgs.bindAddrs.ip4;
      expect(boundIp4).toBeDefined();
      expect(boundIp4!.nodeAddress().port).toBe(p2pPort);
      expect(bootNode.getENR()?.udp).toBe(p2pBroadcastPort);
    } finally {
      createSpy.mockRestore();
      await bootNode.stop();
      await store.close();
    }
  });
});
