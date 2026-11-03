import { AztecAddress } from '@aztec-labs/stdlib/aztec-address';

/**
 * Returns whether `scope` is one of `allowedScopes`.
 */
export function isAllowedScope(scope: AztecAddress, allowedScopes: AztecAddress[]): boolean {
  return allowedScopes.some((allowed: AztecAddress) => allowed.equals(scope));
}

/**
 * Asserts that `scope` is one of `allowedScopes`, throwing otherwise.
 */
export function assertAllowedScope(scope: AztecAddress, allowedScopes: AztecAddress[]): void {
  if (!isAllowedScope(scope, allowedScopes)) {
    throw new Error(
      `Scope ${scope.toString()} is not in the allowed scopes list: [${allowedScopes
        .map((s: AztecAddress) => s.toString())
        .join(', ')}]. See https://docs.aztec.network/errors/10`,
    );
  }
}
