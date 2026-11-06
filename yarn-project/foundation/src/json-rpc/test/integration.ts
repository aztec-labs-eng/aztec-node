import type http from 'http';

import type { ApiSchema, ApiSchemaFor } from '../../schemas/api.js';
import { findUnboundedContainersInApi } from '../../testing/unbounded_containers.js';
import { makeFetch } from '../client/fetch.js';
import { type SafeJsonRpcClientOptions, createSafeJsonRpcClient } from '../client/safe_json_rpc_client.js';
import {
  type SafeJsonRpcServer,
  type SafeJsonRpcServerOptions,
  createSafeJsonRpcServer,
  startHttpRpcServer,
} from '../server/safe_json_rpc_server.js';

export type JsonRpcTestContext<T extends object> = {
  server: SafeJsonRpcServer;
  client: T;
  httpServer: http.Server & { port: number };
  url: string;
};

const checkedSchemas = new WeakSet<object>();

/**
 * Starts a JSON-RPC server for `handler` and a client for it. Throws if any method parameter in `schema` has a
 * container whose size is not checked before its entries are parsed, so every API tested through here is also checked
 * for unbounded parameters.
 */
export async function createJsonRpcTestSetup<T extends object>(
  handler: T,
  schema: ApiSchemaFor<T>,
  serverOptions: SafeJsonRpcServerOptions = {},
  clientOptions: SafeJsonRpcClientOptions = {},
): Promise<JsonRpcTestContext<T>> {
  assertParametersBounded(schema);
  const server = createSafeJsonRpcServer<T>(handler, schema, serverOptions);
  const httpServer = await startHttpRpcServer(server, { host: '127.0.0.1' });
  const noRetryFetch = makeFetch([], true);
  const url = `http://127.0.0.1:${httpServer.port}`;
  const client = createSafeJsonRpcClient<T>(url, schema, {
    fetch: noRetryFetch,
    ...clientOptions,
  });
  return { server, client, httpServer, url };
}

function assertParametersBounded(schema: ApiSchema) {
  if (checkedSchemas.has(schema)) {
    return;
  }
  const unbounded = findUnboundedContainersInApi(schema);
  if (unbounded.length > 0) {
    throw new Error(`API parameters with no size bound checked before parsing: ${unbounded.join(', ')}`);
  }
  checkedSchemas.add(schema);
}
