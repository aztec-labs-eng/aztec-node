import { type LogData, addLogDataHandler } from '@aztec-labs/foundation/log';
import { AsyncLocalStorage } from 'node:async_hooks';

const logContext = new AsyncLocalStorage<LogData>();

addLogDataHandler(data => {
  const context = logContext.getStore();
  return context ? { ...data, ...context } : data;
});

export function withLogContext<T>(data: LogData, callback: () => T): T {
  return logContext.run({ ...logContext.getStore(), ...data }, callback);
}
