import { performance } from 'node:perf_hooks';
import { parentPort } from 'node:worker_threads';

const pings = [];
let pending = 0;
let stopped = false;

const interval = setInterval(() => {
  pending++;
  parentPort.postMessage({ type: 'ping', sent: performance.now() });
}, 5);

parentPort.on('message', message => {
  if (message.type === 'ping') {
    pending--;
    pings.push({ sent: message.sent, latencyMs: performance.now() - message.sent });
  } else if (message.type === 'stop') {
    clearInterval(interval);
    stopped = true;
  }
  if (stopped && pending === 0) {
    parentPort.postMessage({ type: 'done', pings });
    parentPort.close();
  }
});

parentPort.postMessage({ type: 'ready' });
