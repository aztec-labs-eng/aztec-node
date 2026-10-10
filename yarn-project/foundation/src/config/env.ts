/**
 * Returns the environment variables of the current runtime, or an empty record where it has none.
 *
 * In a browser this reads whatever a bundler substitutes for the whole `process.env`, so an app must define that
 * entire object; a definition of an individual `process.env.X` is not seen here and is silently absent.
 */
export function getEnv(): Record<string, string | undefined> {
  // `process.env` is written out literally because bundlers substitute that exact text with the variables an app
  // defines, which a `typeof process` guard would discard in a runtime that has no `process`.
  try {
    // eslint-disable-next-line no-restricted-properties
    return process.env ?? {};
  } catch {
    return {};
  }
}
