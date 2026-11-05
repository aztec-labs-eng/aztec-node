import { readFileSync } from 'node:fs';

/** Loads the review-test config from disk. */
export function loadConfig(path: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return {};
  }
}
