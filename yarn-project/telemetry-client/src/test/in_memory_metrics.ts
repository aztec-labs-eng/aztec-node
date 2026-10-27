import type { Attributes } from '@opentelemetry/api';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';

import { NoopTelemetryClient } from '../noop.js';
import { WrappedMeter } from '../otel.js';
import type { Meter, TelemetryClient } from '../telemetry.js';

/** A data point of an exported metric. */
export type ExportedDataPoint = { value: unknown; attributes: Attributes };

/**
 * Telemetry client that exports metrics in memory through the OpenTelemetry SDK, so tests can check what a node would
 * actually export, including how observable instruments and batch callbacks are wired up. Traces are not recorded.
 */
export class InMemoryMetrics extends NoopTelemetryClient implements TelemetryClient {
  private readonly exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  private readonly reader = new PeriodicExportingMetricReader({
    exporter: this.exporter,
    exportIntervalMillis: 60 * 60 * 1000,
  });
  private readonly provider = new MeterProvider({ readers: [this.reader] });

  public override getMeter(name = 'InMemoryMetrics'): Meter {
    return new WrappedMeter(this.provider.getMeter(name));
  }

  /** Runs a collection and returns the data points of every exported metric, keyed by metric name. */
  public async collect(): Promise<Record<string, ExportedDataPoint[]>> {
    this.exporter.reset();
    await this.reader.forceFlush();
    const result: Record<string, ExportedDataPoint[]> = {};
    for (const { scopeMetrics } of this.exporter.getMetrics()) {
      for (const { metrics } of scopeMetrics) {
        for (const { descriptor, dataPoints } of metrics) {
          result[descriptor.name] = [
            ...(result[descriptor.name] ?? []),
            ...dataPoints.map(({ value, attributes }) => ({ value, attributes })),
          ];
        }
      }
    }
    return result;
  }

  public override isEnabled(): boolean {
    return true;
  }

  public override stop(): Promise<void> {
    return this.provider.shutdown();
  }
}
