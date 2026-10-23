import { Buffer } from 'buffer';
import { type Server, createServer } from 'node:http';

/** A JSON-RPC endpoint that records the method of every request it receives. */
export type RecordingRpcServer = {
  /** URL the server listens on. */
  url: string;
  /** Methods of the JSON-RPC requests received so far, in arrival order. */
  methods: string[];
  /** Stops the server. */
  close: () => Promise<void>;
};

/** A JSON-RPC error that an `answer` callback can throw to send that exact error code and message. */
export class RpcErrorAnswer extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'RpcErrorAnswer';
  }
}

/**
 * Starts a JSON-RPC server that records the method of every request it receives, so tests can assert on what a
 * client actually put on the wire. When `answer` is given, its return value (awaited) is sent as the `result` of each
 * request (`null` included), and an error it throws is sent as a JSON-RPC error: an {@link RpcErrorAnswer} as is, and
 * anything else with code -32000. Its `forward` argument sends the request on to `forwardTo` and returns that node's
 * result, or throws its error. With only `forwardTo`, every request is forwarded as is. Without either, the server
 * answers `eth_chainId` with the anvil chain id and rejects anything else.
 */
export async function startRecordingRpcServer(
  opts: { forwardTo?: string; answer?: (method: string, forward: () => Promise<unknown>) => unknown } = {},
): Promise<RecordingRpcServer> {
  const methods: string[] = [];

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      void (async () => {
        const body = Buffer.concat(chunks).toString();
        const parsed: unknown = body.length > 0 ? JSON.parse(body) : undefined;
        const requests = Array.isArray(parsed) ? parsed : [parsed];
        for (const request of requests) {
          const method = (request as { method?: string } | undefined)?.method;
          if (typeof method === 'string') {
            methods.push(method);
          }
        }

        const forwardTo = opts.forwardTo;
        if (forwardTo && !opts.answer) {
          const response = await fetch(forwardTo, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
          });
          res.writeHead(response.status, { 'content-type': 'application/json' });
          res.end(await response.text());
          return;
        }
        const forward = async () => {
          if (!forwardTo) {
            throw new Error('No node to forward the request to');
          }
          const response = await fetch(forwardTo, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(requests[0]),
          });
          const reply = (await response.json()) as { result?: unknown; error?: { code: number; message: string } };
          if (reply.error) {
            throw new RpcErrorAnswer(reply.error.code, reply.error.message);
          }
          return reply.result;
        };

        const id = (requests[0] as { id?: number } | undefined)?.id ?? 1;
        const method = (requests[0] as { method?: string } | undefined)?.method ?? '';
        let result: object;
        if (opts.answer) {
          try {
            result = { jsonrpc: '2.0', id, result: (await opts.answer(method, forward)) ?? null };
          } catch (err) {
            const error =
              err instanceof RpcErrorAnswer
                ? { code: err.code, message: err.message }
                : { code: -32000, message: String(err) };
            result = { jsonrpc: '2.0', id, error };
          }
        } else if (method === 'eth_chainId') {
          result = { jsonrpc: '2.0', id, result: '0x7a69' };
        } else {
          result = { jsonrpc: '2.0', id, error: { code: -32601, message: 'method not handled by test server' } };
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result));
      })();
    });
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected recording RPC server to listen on a TCP port');
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    methods,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}
