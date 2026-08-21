import { type ContractArtifact, getContractOracleManifest } from '@aztec/stdlib/abi';

import { LEGACY_ORACLE_REGISTRY } from './legacy_oracle_registry.js';
import { ORACLE_REGISTRY } from './oracle_registry.js';
import type { TypeMapping } from './oracle_type_mappings.js';

/**
 * The canonical wire-structural signature of one oracle: `wire_name:param,param->return`, with `()` as the
 * return of a valueless oracle and an empty parameter list for a parameterless one (`name:->field`).
 *
 * This is the exact grammar the aztec-nr attribute machinery renders into oracle manifests (see
 * `noir-projects/labs/aztec-nr/aztec/src/macros/oracle_declaration.nr`), so both sides compare byte for byte.
 * Parameter names are not part of the wire and never register as a change.
 */
export function getManifestSignature(
  name: string,
  entry: { params: readonly { name: string; type: TypeMapping }[]; returnType?: TypeMapping },
): string {
  const params = entry.params.map(p => p.type.label).join(',');
  const returnLabel = entry.returnType ? entry.returnType.label : '()';
  return `${name}:${params}->${returnLabel}`;
}

let servedExecutionSignatures: Map<string, string> | undefined;

/**
 * The signature of every oracle this environment serves during contract execution, keyed by wire name: the
 * live `ORACLE_REGISTRY` plus the `LEGACY_ORACLE_REGISTRY` adapters with their effective wires (the legacy
 * override where present, the modern oracle's wire otherwise).
 */
export function getServedExecutionOracleSignatures(): ReadonlyMap<string, string> {
  if (!servedExecutionSignatures) {
    servedExecutionSignatures = new Map(
      Object.entries(ORACLE_REGISTRY).map(([name, entry]) => [name, getManifestSignature(name, entry)]),
    );
    for (const [name, legacy] of Object.entries(LEGACY_ORACLE_REGISTRY)) {
      const modern = ORACLE_REGISTRY[legacy.modernOracle];
      servedExecutionSignatures.set(
        name,
        getManifestSignature(name, {
          params: legacy.params?.legacyType ?? modern.params,
          returnType: legacy.returnType?.legacyType ?? modern.returnType,
        }),
      );
    }
  }
  return servedExecutionSignatures;
}

/**
 * Compares a contract's embedded oracle manifest against the signatures an environment serves. Returns one
 * human-readable issue per incompatible oracle; an empty result means every oracle the contract compiled
 * against is served compatibly. Oracles served but not in the manifest are fine (additions are non-breaking).
 */
export function checkOracleManifest(manifestLines: readonly string[], served: ReadonlyMap<string, string>): string[] {
  const issues: string[] = [];
  for (const line of manifestLines) {
    const separator = line.indexOf(':');
    const name = separator === -1 ? line : line.slice(0, separator);
    const servedSignature = served.get(name);
    if (servedSignature === undefined) {
      issues.push(`oracle '${name}' is not served by this environment (the contract expects '${line}')`);
    } else if (servedSignature !== line) {
      issues.push(
        `oracle '${name}' signature mismatch: the contract expects '${line}', this environment serves '${servedSignature}'`,
      );
    }
  }
  return issues;
}

/**
 * Validates a contract artifact's embedded oracle manifest against everything this environment serves during
 * contract execution. A missing manifest (artifact compiled by an aztec-nr predating manifest emission) and a
 * malformed one (the reader's validation errors) are themselves reported as issues — this never throws, so
 * warn-mode callers stay warn-only. Issue strings carry no contract identification — callers add their own
 * context.
 */
export function checkArtifactOracleManifest(artifact: ContractArtifact): string[] {
  let manifest: string[] | undefined;
  try {
    manifest = getContractOracleManifest(artifact);
  } catch (err) {
    return [
      `carries a malformed oracle manifest (${err instanceof Error ? err.message : err}); oracle compatibility cannot be verified`,
    ];
  }
  if (manifest === undefined) {
    return [
      'compiled without an oracle manifest (an aztec-nr predating manifest emission); oracle compatibility cannot be verified',
    ];
  }
  return checkOracleManifest(manifest, getServedExecutionOracleSignatures());
}

/**
 * Per-process cache of manifest check results, keyed by contract class id. The manifest is class-invariant
 * and the served registries are process-constant, so each class is validated once, not once per executed
 * function or per session. The in-flight promise is cached, so concurrent first checks of one class share a
 * single validation (and its single round of warnings).
 */
const checkedClasses = new Map<string, Promise<string[]>>();

/**
 * Runs {@link checkArtifactOracleManifest} for an executing contract's class, caching per class id.
 * `alreadyChecked` tells the caller whether this class's validation was already underway, so warnings are
 * logged once. A missing artifact (or a failing load) is reported but not cached, since the artifact may
 * simply not be registered yet. Never rejects.
 */
export function checkExecutingContractManifest(
  classId: string,
  loadArtifact: () => Promise<ContractArtifact | undefined>,
): Promise<{ issues: string[]; alreadyChecked: boolean }> {
  const cached = checkedClasses.get(classId);
  if (cached !== undefined) {
    return cached.then(issues => ({ issues, alreadyChecked: true }));
  }
  const pending = (async () => {
    let artifact: ContractArtifact | undefined;
    try {
      artifact = await loadArtifact();
    } catch (err) {
      checkedClasses.delete(classId);
      return [
        `failed to load the artifact for contract class ${classId} (${err instanceof Error ? err.message : err}); oracle compatibility cannot be verified`,
      ];
    }
    if (!artifact) {
      checkedClasses.delete(classId);
      return [`no artifact available for contract class ${classId}; oracle compatibility cannot be verified`];
    }
    return checkArtifactOracleManifest(artifact);
  })();
  checkedClasses.set(classId, pending);
  return pending.then(issues => ({ issues, alreadyChecked: false }));
}
