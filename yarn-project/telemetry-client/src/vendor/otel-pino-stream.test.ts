import { describe, expect, it, jest } from '@jest/globals';
import { spawn } from 'node:child_process';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

jest.setTimeout(30_000);

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

/** Starts an OTLP logs endpoint that records the decoded body of every export request it receives. */
async function startOtlpCollector(): Promise<{ server: Server; url: string; bodies: string[] }> {
  const bodies: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      bodies.push((req.headers['content-encoding'] === 'gzip' ? gunzipSync(body) : body).toString());
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}/v1/logs`, bodies };
}

describe('OTelPinoStream', () => {
  it('exports a record logged right before process.exit', async () => {
    const collector = await startOtlpCollector();
    try {
      // The logger only routes through the OTLP transport outside jest, so this runs in a plain node process against
      // the built packages.
      // @dependency ../../../foundation/src/log/pino-logger.ts, ./otel-pino-stream.ts
      const script = `
        import { createLogger } from '@aztec-labs/foundation/log';
        createLogger('otlp-exit-test').fatal('Exiting right after this line', undefined, { marker: 'otlp-exit-marker' });
        process.exit(1);
      `;
      const { JEST_WORKER_ID: _, ...env } = process.env;
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
        cwd: PACKAGE_ROOT,
        env: { ...env, LOG_LEVEL: 'info', LOG_JSON: '1', OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: collector.url },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', chunk => (stderr += chunk));
      const exitCode = await new Promise(resolve => child.on('close', resolve));

      expect(exitCode).toBe(1);
      expect(stderr).toContain('otlp-exit-marker');
      expect(collector.bodies.some(body => body.includes('otlp-exit-marker'))).toBe(true);
    } finally {
      collector.server.close();
    }
  });
});
