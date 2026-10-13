import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { spawn } from 'node:child_process';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

jest.setTimeout(30_000);

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const CHILD_DEADLINE_MS = 20_000;

type OtlpAttribute = { key: string; value: { stringValue?: string } };
type OtlpRecord = { severityText?: string; attributes?: OtlpAttribute[] };
type OtlpLogsRequest = { resourceLogs?: { scopeLogs?: { logRecords?: OtlpRecord[] }[] }[] };

/** An OTLP/HTTP logs endpoint that records every exported log record, or never answers if `respond` is false. */
class OtlpCollector {
  public readonly records: OtlpRecord[] = [];
  private readonly server: Server;

  constructor(private readonly respond: boolean) {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const decoded = req.headers['content-encoding'] === 'gzip' ? gunzipSync(body) : body;
        const request = JSON.parse(decoded.toString()) as OtlpLogsRequest;
        this.records.push(
          ...(request.resourceLogs ?? []).flatMap(r => (r.scopeLogs ?? []).flatMap(s => s.logRecords ?? [])),
        );
        if (this.respond) {
          res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
        }
      });
    });
  }

  async start(): Promise<string> {
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1/logs`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise(resolve => this.server.close(resolve));
  }

  hasRecordWithMarker(marker: string): boolean {
    return this.records.some(
      record =>
        record.severityText === 'fatal' &&
        record.attributes?.some(a => a.key === 'marker' && a.value.stringValue === marker),
    );
  }
}

/**
 * Runs a node process that logs a fatal line after `delayMs` and immediately calls process.exit(1). The logger only
 * routes through the OTLP transport outside jest, so this runs in a plain node process against the built packages.
 */
async function logFatalAndExit(otlpUrl: string, marker: string, delayMs: number) {
  // @dependency ../../../foundation/src/log/pino-logger.ts, ./otel-pino-stream.ts
  const script = `
    import { createLogger } from '@aztec-labs/foundation/log';
    setTimeout(() => {
      createLogger('otlp-exit-test').fatal('Exiting right after this line', undefined, { marker: '${marker}' });
      process.stderr.write('exiting at ' + Date.now() + '\\n');
      process.exit(1);
    }, ${delayMs});
  `;
  const { JEST_WORKER_ID: _, ...env } = process.env;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: PACKAGE_ROOT,
    env: {
      ...env,
      LOG_LEVEL: 'info',
      LOG_JSON: '1',
      USE_GCLOUD_LOGGING: 'false',
      USE_AWS_LOGGING: 'false',
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: otlpUrl,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => (stderr += chunk));
  const deadline = setTimeout(() => child.kill('SIGKILL'), CHILD_DEADLINE_MS);
  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    const exitRequestedAt = Number(/exiting at (\d+)/.exec(stderr)?.[1]);
    return { exitCode, stderr, exitDurationMs: Date.now() - exitRequestedAt };
  } finally {
    clearTimeout(deadline);
  }
}

describe('OTelPinoStream', () => {
  let collector: OtlpCollector | undefined;

  beforeEach(() => {
    collector = undefined;
  });

  afterEach(async () => {
    await collector?.stop();
  });

  it.each([
    ['while the transport is still starting', 0],
    ['once the transport is running', 1000],
  ])('exports a record logged right before process.exit %s', async (_, delayMs) => {
    collector = new OtlpCollector(true);
    const url = await collector.start();

    const { exitCode, stderr } = await logFatalAndExit(url, 'otlp-exit-marker', delayMs);

    expect(exitCode).toBe(1);
    expect(stderr).toContain('otlp-exit-marker');
    expect(collector.hasRecordWithMarker('otlp-exit-marker')).toBe(true);
  });

  it('does not hold up the exit on an unresponsive collector', async () => {
    collector = new OtlpCollector(false);
    const url = await collector.start();

    const { exitCode, exitDurationMs } = await logFatalAndExit(url, 'otlp-exit-marker', 1000);

    expect(exitCode).toBe(1);
    expect(exitDurationMs).toBeLessThan(6_000);
  });
});
