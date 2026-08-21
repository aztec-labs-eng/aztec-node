import type { Fr } from '@aztec/foundation/curves/bn254';
import { ORACLE_REGISTRY, type OracleRegistryEntry, type TypeMapping, isStructMapping } from '@aztec/pxe/simulator';

import { SCALAR_MAPPINGS, UnsynthesizableTypeError, testValueFor } from './test-resolver/default_fixtures.js';
import { TXE_ORACLE_REGISTRY } from './txe_oracle_registry.js';

describe('oracle type-mapping labels', () => {
  it('mappings sharing a label are wire-equivalent', () => {
    // The manifest checks treat mappings with equal labels as the same wire type, so any two mappings sharing a label
    // anywhere in the registries (e.g. FIELD and TX_HASH, both a Noir `Field`) must serialize the same canonical value
    // for the same seed.
    const byLabel = new Map<string, TypeMapping<any>[]>();
    for (const mapping of reachableMappings()) {
      // A deserialize-only mapping has no wire form to compare.
      if (mapping.serialization === undefined) {
        continue;
      }
      byLabel.set(mapping.label, [...(byLabel.get(mapping.label) ?? []), mapping]);
    }

    for (const [label, mappings] of byLabel.entries()) {
      const serialized = mappings.map(mapping => canonicalRows(mapping)).filter(rows => rows !== undefined);
      for (const rows of serialized.slice(1)) {
        expect({ label, rows }).toEqual({ label, rows: serialized[0] });
      }
    }
  });
});

/**
 * Every distinct `TypeMapping` reachable from both registries' parameter and return declarations (recursing through
 * combinator inners and struct fields), plus the scalar table itself so currently-unreferenced scalars stay covered.
 */
function reachableMappings(): TypeMapping<any>[] {
  // Reference-identity dedup is deliberate: each mapping constant is one object, and aliases sharing a label are
  // exactly what the comparison must keep as distinct entries.
  const seen = new Set<TypeMapping<any>>();
  const visit = (mapping: TypeMapping<any>) => {
    if (seen.has(mapping)) {
      return;
    }
    seen.add(mapping);
    if (isStructMapping(mapping)) {
      for (const field of mapping.fields) {
        visit(field.type);
      }
    } else if (hasInner(mapping)) {
      visit(mapping.inner);
    }
  };

  const registries: Record<string, OracleRegistryEntry>[] = [ORACLE_REGISTRY, TXE_ORACLE_REGISTRY];
  for (const registry of registries) {
    for (const entry of Object.values(registry)) {
      for (const param of entry.params) {
        visit(param.type);
      }
      if (entry.returnType !== undefined) {
        visit(entry.returnType);
      }
    }
  }
  for (const mapping of SCALAR_MAPPINGS) {
    visit(mapping);
  }
  return [...seen];
}

function hasInner(mapping: TypeMapping<any>): mapping is TypeMapping<any> & { inner: TypeMapping<any> } {
  return 'inner' in mapping;
}

/**
 * Serialized canonical values at a few seeds, or `undefined` when the type has no synthesizable canonical value (its
 * wire equivalence is then covered by its inner mappings, which are visited separately).
 */
function canonicalRows(mapping: TypeMapping<any>): string[][] | undefined {
  try {
    return [10, 11, 12].map(seed =>
      mapping
        .serialization!.fn(testValueFor(mapping, seed))
        .flat()
        .map((f: Fr) => f.toString()),
    );
  } catch (err) {
    if (err instanceof UnsynthesizableTypeError) {
      return undefined;
    }
    throw err;
  }
}
