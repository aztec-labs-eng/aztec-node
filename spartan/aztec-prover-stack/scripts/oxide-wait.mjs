import { mkdir, access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout } from 'node:timers/promises';

process.env.L1_PRIVATE_KEY = (await readFile("/oxide-identity/key", "utf8")).trim();

const directory = dirname(process.env.OXIDE_RELAYER_STATE_PATH);
await mkdir(directory, { recursive: true });
await access(directory, constants.W_OK);
const deadline = Date.now() + Number(process.env.OXIDE_STARTUP_TIMEOUT_SECONDS) * 1000;
const endpoints = [
  [process.env.AZTEC_NODE_URL, 'node_getNodeInfo', {}],
  [process.env.OXIDE_RELAYER_PROVER_NODE_URL, 'prover_getJobs',
    process.env.OXIDE_RELAYER_PROVER_NODE_API_KEY
      ? { 'x-api-key': process.env.OXIDE_RELAYER_PROVER_NODE_API_KEY } : {}],
];
let ready = false;
while (Date.now() < deadline) {
  try {
    for (const [url, method, headers] of endpoints) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }),
        signal: AbortSignal.timeout(Math.max(1, Math.min(5000, deadline - Date.now()))),
      });
      const body = await response.json();
      if (!response.ok || body.error || !Object.hasOwn(body, 'result')) {
        throw new Error('RPC unavailable');
      }
    }
    ready = true;
    break;
  } catch {
    await setTimeout(Math.max(0, Math.min(1000, deadline - Date.now())));
  }
}
if (!ready) {
  throw new Error('Oxide startup timed out waiting for public and authenticated prover RPC');
}
console.log('Oxide public and prover RPC ready');
