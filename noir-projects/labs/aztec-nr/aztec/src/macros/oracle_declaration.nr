//! # Oracle declaration attributes and manifests
//!
//! Every oracle wrapper carries one of the per-scope attributes below (`#[utl_oracle]`, `#[prv_oracle]`, ...).
//! The attribute:
//!   1. derives the oracle's wire method name from the wrapper's own name (snake_case → camelCase) and composes
//!      the full wire name `aztec_<scope>_<camelName>`,
//!   2. renders the oracle's wire signature from the wrapper's parameter and return types into the
//!      wire-structural label grammar shared with the TypeScript oracle registries (see [`label_of`]),
//!   3. records `wire_name:param,param->return` into the scope's manifest (a comptime global), and
//!   4. generates the raw `#[oracle]` stub as a sibling function named `<wrapper>_oracle`, so wrapper bodies
//!      keep calling the stub exactly as they called the previous hand-written one.
//!
//! Two manifests exist, routed by scope. The execution manifest (`misc`/`utl`/`prv`) describes the oracles PXE
//! serves during contract execution and is embedded into contract artifacts. The TXE manifest (`txe`/`avm`)
//! describes test-only oracles: it is sent to the TXE at `TestEnvironment` creation and never embedded in
//! artifacts (Noir has no `#[cfg(test)]`, so these wrappers elaborate in every build — routing keeps them out
//! of contract ABIs). AVM oracles need no manifest in production, where the avm-transpiler pattern-matches
//! their wire names into opcodes at build time; the TXE however executes public functions as ordinary Noir,
//! where they remain real foreign calls.
//!
//! ## Wire name derivation
//!
//! `f.name()`, snake_case → camelCase (`get_auth_witness` → `getAuthWitness`; digit segments capitalize
//! mechanically, so `get_l1_to_l2_membership_witness_v2` → `getL1ToL2MembershipWitnessV2`), with exactly two
//! extra conventions:
//!   - a trailing `_internal` is stripped: a transforming wrapper's forwarder is named for its wire
//!     (`get_block_header_internal` → `getBlockHeader`);
//!   - a single trailing `_` is stripped, the standard keyword-collision convention (`return_` → `return`).
//!
//! New oracles choose derivable wire names by construction. A genuinely underivable shape keeps a hand-written
//! stub and a manual manifest entry (see [`add_manual_execution_oracle`]).
//!
//! ## The label grammar
//!
//! Labels mirror the TypeScript `TypeMapping.label` grammar in
//! `yarn-project/pxe/src/contract_function_simulator/oracle/oracle_type_mappings.ts`, the shared canonical
//! form both sides compare: scalars are bare kinds (`field`, `u32`, `bool`); leaf-registered types carry their
//! registered kind (`aztec-address`); combinators compose (`option(...)`, `array(elem)` for a generic length,
//! `array(elem,N)` for a concrete one, `bounded-vec(elem)` / `bounded-vec(elem,Cap)`, `vector(elem)` for
//! slices, `ephemeral-array(elem)`); structs and tuples are nameless brace lists (`{field,u32}`) with nested
//! struct labels spliced flat into the parent, since nesting affects neither the wire nor the interface. Two
//! types share a label exactly when they are wire-identical.

use crate::event::EventSelector;
use crate::facts::OriginBlockState;
use crate::messages::delivery::{OnchainDeliveryMode, ResolvedTaggingStrategy};
use crate::messages::processing::event_validation_request::EventValidationRequest;
use crate::messages::processing::NoteValidationRequest;
use crate::protocol::abis::function_selector::FunctionSelector;
use crate::protocol::address::{AztecAddress, EthAddress};
use crate::test::helpers::tagging_secret_strategy::TaggingSecretStrategy;
use std::append::Append;
use std::collections::bounded_vec::BoundedVec;
use std::meta::{ctstring::AsCtString, type_of, unquote};

/// Maximum number of oracles each manifest can hold.
comptime global MAX_ORACLES_PER_MANIFEST: u32 = 256;

/// One `(wire name, manifest line)` entry per declared execution oracle (`misc`/`utl`/`prv` scopes).
pub comptime mut global EXECUTION_ORACLE_MANIFEST: BoundedVec<(CtString, CtString), MAX_ORACLES_PER_MANIFEST> =
    BoundedVec::new();

/// One `(wire name, manifest line)` entry per declared TXE oracle (`txe`/`avm` scopes).
pub comptime mut global TXE_ORACLE_MANIFEST: BoundedVec<(CtString, CtString), MAX_ORACLES_PER_MANIFEST> =
    BoundedVec::new();

/// Declares a misc-scope oracle (`aztec_misc_*`), served by every execution environment.
#[allow(dead_code)]
pub(crate) comptime fn misc_oracle(f: FunctionDefinition) -> Quoted {
    declare_oracle(f, quote { misc })
}

/// Declares a utility-scope oracle (`aztec_utl_*`), callable from utility and private contexts.
#[allow(dead_code)]
pub(crate) comptime fn utl_oracle(f: FunctionDefinition) -> Quoted {
    declare_oracle(f, quote { utl })
}

/// Declares a private-execution-scope oracle (`aztec_prv_*`).
#[allow(dead_code)]
pub(crate) comptime fn prv_oracle(f: FunctionDefinition) -> Quoted {
    declare_oracle(f, quote { prv })
}

/// Declares a TXE-only test oracle (`aztec_txe_*`). Never embedded in contract artifacts.
#[allow(dead_code)]
pub(crate) comptime fn txe_oracle(f: FunctionDefinition) -> Quoted {
    declare_oracle(f, quote { txe })
}

/// Declares an AVM opcode oracle (`aztec_avm_*`). Pattern-matched by the avm-transpiler in production;
/// served as a real foreign call only by the TXE, so it routes to the TXE manifest.
#[allow(dead_code)]
pub(crate) comptime fn avm_oracle(f: FunctionDefinition) -> Quoted {
    declare_oracle(f, quote { avm })
}

/// Registers a manifest entry for an execution oracle whose stub is hand-written because its wire cannot be
/// described by [`label_of`] (e.g. `get_notes`, generic over the note type itself), or whose declaration
/// lives outside this crate (e.g. the `protocol_types` logging oracle). The caller supplies the full wire
/// name and the signature part after the `:` separator, in the label grammar.
#[allow(dead_code)]
pub(crate) comptime fn add_manual_execution_oracle<let N: u32, let M: u32>(wire_name: str<N>, signature: str<M>) {
    let name = wire_name.as_ctstring();
    let line = name.append_str(":").append_str(signature);
    append_manifest_entry(false, name, line);
}

/// Registers manifest entries for the execution oracles declared in `protocol_types` (foundation), which this
/// crate's attribute machinery cannot annotate. The signatures transcribe the TS registry labels (as with
/// `get_notes`, the `u32` level label covers the `u8` the declaration sends); native annotation replaces this
/// once the machinery is upstreamed.
pub(crate) comptime fn declare_foundation_oracles(_m: Module) {
    add_manual_execution_oracle("aztec_misc_log", "u32,str,u32,array(field)->()");
}

comptime fn declare_oracle(f: FunctionDefinition, scope: Quoted) -> Quoted {
    let name = f.name();
    assert(f.is_unconstrained(), f"oracle wrapper {name} must be an unconstrained function");

    let wire_name = compose_wire_name(scope, name);
    let line = manifest_line(wire_name, f.parameters(), f.return_type());

    let routes_to_txe = (scope == quote { txe }) | (scope == quote { avm });
    append_manifest_entry(routes_to_txe, wire_name, line);

    generate_oracle_stub(f, wire_name)
}

comptime fn compose_wire_name(scope: Quoted, name: Quoted) -> CtString {
    "aztec_".as_ctstring().append_fmtstr(f"{scope}_").append(derive_wire_method_name(name))
}

comptime fn append_manifest_entry(routes_to_txe: bool, wire_name: CtString, line: CtString) {
    let name = wire_name.as_quoted_str();
    if routes_to_txe {
        assert(!is_declared(TXE_ORACLE_MANIFEST, wire_name), f"oracle wire name {name} is declared more than once");
        TXE_ORACLE_MANIFEST.push((wire_name, line));
    } else {
        assert(
            !is_declared(EXECUTION_ORACLE_MANIFEST, wire_name),
            f"oracle wire name {name} is declared more than once",
        );
        EXECUTION_ORACLE_MANIFEST.push((wire_name, line));
    }
}

comptime fn is_declared(
    manifest: BoundedVec<(CtString, CtString), MAX_ORACLES_PER_MANIFEST>,
    wire_name: CtString,
) -> bool {
    let mut declared = false;
    for i in 0..manifest.len() {
        let (existing, _) = manifest.get(i);
        if existing == wire_name {
            declared = true;
        }
    }
    declared
}

/// Quotes the execution manifest's `#[abi(oracles)]` global, injected into every contract module by the
/// `#[aztec]` macro. The global's value lands in the artifact JSON under `outputs.globals.oracles`, embedding
/// the oracle surface of the aztec-nr the contract compiled against. The global's name carries the contract
/// name because compiling a contract that imports other contract crates pools every `#[abi]` global into the
/// artifact (as with `STORAGE_LAYOUT_<name>`) — readers select their contract's entry by name.
pub(crate) comptime fn generate_execution_manifest_global(m: Module) -> Quoted {
    let module_name = m.name();
    let global_name = f"AZTEC_ORACLE_MANIFEST_{module_name}".quoted_contents();
    let (manifest_literal, len) = render_manifest(EXECUTION_ORACLE_MANIFEST);
    let len_quoted = f"{len}".quoted_contents();
    quote {
        #[abi(oracles)]
        pub global $global_name: str<$len_quoted> = $manifest_literal;
    }
}

/// Quotes the TXE manifest's canonical rendering as a string literal, spliced into the `TestEnvironment`
/// creation path that transports it to the TXE. Not embedded in artifacts.
pub(crate) comptime fn txe_manifest_str() -> Quoted {
    let (manifest_literal, _len) = render_manifest(TXE_ORACLE_MANIFEST);
    manifest_literal
}

/// Renders a manifest in its canonical form — one line per oracle, sorted by byte order, `\n`-joined — as a
/// quoted string literal plus its byte length. Sorting keeps the rendering (and with it every artifact hash)
/// independent of declaration order, so moving an oracle between modules cannot move contract class ids.
comptime fn render_manifest(manifest: BoundedVec<(CtString, CtString), MAX_ORACLES_PER_MANIFEST>) -> (Quoted, u32) {
    // Join in entry order first: one unquote of the joined literal yields every line's bytes (for sorting)
    // and the total byte length (for the rendered `str<N>` type).
    let mut joined = CtString::new();
    for i in 0..manifest.len() {
        if i != 0 {
            joined = joined.append_str("\n");
        }
        joined = joined.append(manifest.get(i).1);
    }
    let joined_literal = joined.as_quoted_str();
    let bytes: [u8] = unquote!(
        quote { $joined_literal.as_bytes().fold(@[], |acc: [u8], byte: u8| acc.push_back(byte)) },
    );

    let order = sorted_line_order(bytes, manifest.len());

    let mut sorted = CtString::new();
    for k in 0..order.len() {
        if k != 0 {
            sorted = sorted.append_str("\n");
        }
        sorted = sorted.append(manifest.get(order[k]).1);
    }
    (sorted.as_quoted_str(), bytes.len())
}

/// The entry indices of a `\n`-joined rendering, sorted by byte-lexicographic line order.
comptime fn sorted_line_order(bytes: [u8], count: u32) -> [u32] {
    let mut starts: [u32] = @[];
    let mut lens: [u32] = @[];
    let mut start: u32 = 0;
    for i in 0..bytes.len() {
        if bytes[i] == 10 {
            starts = starts.push_back(start);
            lens = lens.push_back(i - start);
            start = i + 1;
        }
    }
    if count > 0 {
        starts = starts.push_back(start);
        lens = lens.push_back(bytes.len() - start);
    }
    assert(starts.len() == count, "manifest lines must not contain newlines");

    let mut order: [u32] = @[];
    for i in 0..count {
        let mut inserted = false;
        let mut next: [u32] = @[];
        for k in 0..order.len() {
            let existing = order[k];
            if !inserted & line_less_than(bytes, starts[i], lens[i], starts[existing], lens[existing]) {
                next = next.push_back(i);
                inserted = true;
            }
            next = next.push_back(existing);
        }
        if !inserted {
            next = next.push_back(i);
        }
        order = next;
    }
    order
}

comptime fn line_less_than(bytes: [u8], a_start: u32, a_len: u32, b_start: u32, b_len: u32) -> bool {
    let min_len = if a_len < b_len { a_len } else { b_len };
    let mut decided = false;
    let mut less = false;
    for i in 0..min_len {
        let a = bytes[a_start + i];
        let b = bytes[b_start + i];
        if !decided & (a != b) {
            decided = true;
            less = a < b;
        }
    }
    if decided {
        less
    } else {
        a_len < b_len
    }
}

/// Renders a full manifest line: `wire_name:param,param->return`, with `()` as the return of a valueless
/// oracle and an empty parameter list for a parameterless one (`name:->field`).
pub(crate) comptime fn manifest_line(wire_name: CtString, params: [(Quoted, Type)], return_type: Type) -> CtString {
    let param_labels = params.map(|(_name, typ): (Quoted, Type)| label_of(typ)).join(",".as_ctstring());
    let return_label = if return_type.is_unit() {
        "()".as_ctstring()
    } else {
        label_of(return_type)
    };
    wire_name.append_str(":").append(param_labels).append_str("->").append(return_label)
}

/// Derives the wire method name from a wrapper function name. See the module docs for the conventions.
pub(crate) comptime fn derive_wire_method_name(name: Quoted) -> CtString {
    // The name's length is only known per invocation, so go through a quote to obtain a concretely-typed
    // byte slice of it.
    let name_literal = f"{name}".as_quoted_str();
    let bytes: [u8] = unquote!(
        quote { $name_literal.as_bytes().fold(@[], |acc: [u8], byte: u8| acc.push_back(byte)) },
    );
    let total = bytes.len();

    let suffix = "_internal".as_bytes();
    let mut len = total;
    if total > suffix.len() {
        let mut has_suffix = true;
        for i in 0..suffix.len() {
            if bytes[total - suffix.len() + i] != suffix[i] {
                has_suffix = false;
            }
        }
        if has_suffix {
            len = total - suffix.len();
        }
    }
    // '_' is 95. Only a name that did not end in `_internal` can use the trailing-underscore convention.
    if (len == total) & (total > 1) & (bytes[total - 1] == 95) {
        len = total - 1;
    }

    let mut out = CtString::new();
    let mut capitalize = false;
    for i in 0..len {
        let byte = bytes[i];
        if byte == 95 {
            capitalize = true;
        } else {
            if capitalize {
                out = out.append_str(uppercase_char(byte, name));
            } else {
                out = out.append_str(lowercase_char(byte, name));
            }
            capitalize = false;
        }
    }
    out
}

comptime fn lowercase_char(byte: u8, name: Quoted) -> str<1> {
    let lower = [
        "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p", "q", "r", "s", "t", "u", "v",
        "w", "x", "y", "z",
    ];
    if (byte >= 97) & (byte <= 122) {
        lower[(byte - 97) as u32]
    } else {
        digit_char(byte, name)
    }
}

comptime fn uppercase_char(byte: u8, name: Quoted) -> str<1> {
    let upper = [
        "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T", "U", "V",
        "W", "X", "Y", "Z",
    ];
    if (byte >= 97) & (byte <= 122) {
        upper[(byte - 97) as u32]
    } else {
        // A digit right after an underscore stays a digit (`decrypt_aes_128` → `decryptAes128`).
        digit_char(byte, name)
    }
}

comptime fn digit_char(byte: u8, name: Quoted) -> str<1> {
    let digits = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
    if (byte >= 48) & (byte <= 57) {
        digits[(byte - 48) as u32]
    } else {
        panic(
            f"cannot derive a wire name from {name}: only lowercase snake_case names over [a-z0-9_] are derivable",
        )
    }
}

/// Renders the wire-structural label of a type. See the module docs for the grammar; this must agree with the
/// TypeScript `TypeMapping.label` values, which the manifest comparisons verify end to end.
pub(crate) comptime fn label_of(typ: Type) -> CtString {
    let leaf = leaf_label(typ);
    if leaf.is_some() {
        leaf.unwrap()
    } else if typ.is_field() {
        "field".as_ctstring()
    } else if typ.is_bool() {
        "bool".as_ctstring()
    } else if typ.as_integer().is_some() {
        let (is_signed, bit_size) = typ.as_integer().unwrap();
        assert(!is_signed, f"cannot render an oracle wire label for {typ}: signed integers have no wire mapping");
        f"u{bit_size}".as_ctstring()
    } else if typ.as_str().is_some() {
        "str".as_ctstring()
    } else if is_data_type_named(typ, quote { Option }) {
        "option(".as_ctstring().append(label_of(generic_of(typ, 0))).append_str(")")
    } else if is_data_type_named(typ, quote { BoundedVec }) {
        let element = label_of(generic_of(typ, 0));
        let capacity = generic_of(typ, 1).as_constant();
        if capacity.is_some() {
            let cap = capacity.unwrap();
            "bounded-vec(".as_ctstring().append(element).append_fmtstr(f",{cap})")
        } else {
            "bounded-vec(".as_ctstring().append(element).append_str(")")
        }
    } else if is_data_type_named(typ, quote { UnconstrainedArray }) {
        // `EphemeralArray<T>` is an alias of `UnconstrainedArray<T, EphemeralOracles>`; only the ephemeral
        // backing crosses oracle wires.
        let backing_is_ephemeral = is_data_type_named(generic_of(typ, 1), quote { EphemeralOracles });
        assert(
            backing_is_ephemeral,
            f"cannot render an oracle wire label for {typ}: only EphemeralArray-backed UnconstrainedArrays have a wire mapping",
        );
        "ephemeral-array(".as_ctstring().append(label_of(generic_of(typ, 0))).append_str(")")
    } else if typ.as_array().is_some() {
        let (element_type, length_type) = typ.as_array().unwrap();
        let element = label_of(element_type);
        let length = length_type.as_constant();
        if length.is_some() {
            let len = length.unwrap();
            "array(".as_ctstring().append(element).append_fmtstr(f",{len})")
        } else {
            "array(".as_ctstring().append(element).append_str(")")
        }
    } else if typ.as_vector().is_some() {
        "vector(".as_ctstring().append(label_of(typ.as_vector().unwrap())).append_str(")")
    } else if typ.as_tuple().is_some() | typ.as_data_type().is_some() {
        "{".as_ctstring().append(composite_field_labels(typ)).append_str("}")
    } else {
        panic(
            f"cannot render an oracle wire label for {typ}: register the type in leaf_labels or extend label_of",
        )
    }
}

/// The comma-joined member labels of a struct or tuple, with nested struct/tuple labels spliced flat into the
/// parent, mirroring `structFieldLabels` on the TypeScript side.
comptime fn composite_field_labels(typ: Type) -> CtString {
    let member_types = if typ.as_tuple().is_some() {
        typ.as_tuple().unwrap()
    } else {
        let (definition, generics) = typ.as_data_type().unwrap();
        definition.fields(generics).map(|(_name, field_type, _visibility): (Quoted, Type, Quoted)| field_type)
    };
    member_types
        .map(|member: Type| {
            if is_spliced_composite(member) {
                composite_field_labels(member)
            } else {
                label_of(member)
            }
        })
        .join(",".as_ctstring())
}

/// Whether a type labels through the `{...}` fallback (and therefore splices into a parent struct label):
/// structs and tuples that are neither leaf-registered nor named combinators.
comptime fn is_spliced_composite(typ: Type) -> bool {
    let named_combinator = is_data_type_named(typ, quote { Option })
        | is_data_type_named(typ, quote { BoundedVec })
        | is_data_type_named(typ, quote { UnconstrainedArray });
    (typ.as_tuple().is_some() | typ.as_data_type().is_some()) & !named_combinator & leaf_label(typ).is_none()
}

/// Leaf label registrations: Noir types whose wire label is not derived structurally, mirroring the
/// TypeScript SCALAR/LEAF/ALIAS label decisions in `oracle_type_mappings.ts`. Extended as oracle migrations
/// surface more types. A non-struct type with no entry fails compilation in [`label_of`]; a struct with a
/// missing (or wrong) entry renders structurally as `{...}` instead, which the Noir↔TS manifest comparisons
/// then catch — the TS side of the pair labels it as its registered leaf kind.
comptime fn leaf_labels() -> [(Type, CtString)] {
    @[
        (type_of(std::mem::zeroed::<AztecAddress>()), "aztec-address".as_ctstring()),
        (type_of(std::mem::zeroed::<EthAddress>()), "eth-address".as_ctstring()),
        (type_of(std::mem::zeroed::<FunctionSelector>()), "function-selector".as_ctstring()),
        (type_of(std::mem::zeroed::<EventSelector>()), "event-selector".as_ctstring()),
        (type_of(std::mem::zeroed::<OnchainDeliveryMode>()), "onchain-delivery-mode".as_ctstring()),
        (type_of(std::mem::zeroed::<ResolvedTaggingStrategy>()), "resolved-tagging-strategy".as_ctstring()),
        (type_of(std::mem::zeroed::<OriginBlockState>()), "origin-block-state".as_ctstring()),
        (type_of(std::mem::zeroed::<NoteValidationRequest>()), "note-validation-request".as_ctstring()),
        (type_of(std::mem::zeroed::<EventValidationRequest>()), "event-validation-request".as_ctstring()),
        (type_of(std::mem::zeroed::<TaggingSecretStrategy>()), "tagging-secret-strategy".as_ctstring()),
    ]
}

comptime fn leaf_label(typ: Type) -> Option<CtString> {
    let matching = leaf_labels().filter(|entry: (Type, CtString)| entry.0 == typ);
    if matching.len() == 0 {
        Option::none()
    } else {
        Option::some(matching[0].1)
    }
}

comptime fn generic_of(typ: Type, index: u32) -> Type {
    typ.as_data_type().unwrap().1[index]
}

comptime fn is_data_type_named(typ: Type, name: Quoted) -> bool {
    typ.as_data_type().map(|(definition, _generics): (TypeDefinition, [Type])| definition.name() == name).unwrap_or(
        false,
    )
}

/// Generates the raw `#[oracle]` stub as a sibling of the wrapper, named `<wrapper>_oracle`, carrying the
/// wrapper's parameter and return types plus whatever numeric generics those types mention. A
/// `#[skip_oracle_test]` marker on the wrapper is passed through to the stub, which is where
/// `#[generate_oracle_tests]` looks for it.
comptime fn generate_oracle_stub(f: FunctionDefinition, wire_name: CtString) -> Quoted {
    let name = f.name();
    let stub_name = f"{name}_oracle".quoted_contents();
    let wire_str = wire_name.as_quoted_str!();
    let wire_ident = f"{wire_str}".quoted_contents();

    let skip_test_marker = if f.has_named_attribute("skip_oracle_test") {
        quote { #[crate::macros::oracle_testing::skip_oracle_test] }
    } else {
        quote {}
    };

    let params = f
        .parameters()
        .map(|(param_name, param_type): (Quoted, Type)| {
            let unused_name = f"_{param_name}".quoted_contents();
            quote { $unused_name: $param_type }
        })
        .join(quote {,});

    let return_type = f.return_type();
    let return_clause = if return_type.is_unit() {
        quote {}
    } else {
        quote { -> $return_type }
    };

    let generics = stub_generics(f);

    quote {
        $skip_test_marker
        #[oracle($wire_ident)]
        unconstrained fn $stub_name $generics ($params) $return_clause {}
    }
}

/// Reconstructs the stub's numeric generic declarations (`<let N: u32, ...>`) by walking the wrapper's
/// parameter and return types for non-constant lengths — `FunctionDefinition` exposes no `.generics()`.
comptime fn stub_generics(f: FunctionDefinition) -> Quoted {
    let mut lengths: [Quoted] = @[];
    for param in f.parameters() {
        let (_name, typ) = param;
        lengths = collect_numeric_generics(typ, lengths);
    }
    lengths = collect_numeric_generics(f.return_type(), lengths);

    if lengths.len() == 0 {
        quote {}
    } else {
        let declarations = lengths.map(|length: Quoted| quote { let $length: u32 }).join(quote {,});
        quote { <$declarations> }
    }
}

comptime fn collect_numeric_generics(typ: Type, acc: [Quoted]) -> [Quoted] {
    let mut acc = acc;
    if typ.as_str().is_some() {
        acc = push_generic_length(typ.as_str().unwrap(), acc);
    } else if typ.as_array().is_some() {
        let (element_type, length_type) = typ.as_array().unwrap();
        acc = collect_numeric_generics(element_type, acc);
        acc = push_generic_length(length_type, acc);
    } else if typ.as_vector().is_some() {
        acc = collect_numeric_generics(typ.as_vector().unwrap(), acc);
    } else if typ.as_tuple().is_some() {
        for member in typ.as_tuple().unwrap() {
            acc = collect_numeric_generics(member, acc);
        }
    } else if typ.as_data_type().is_some() {
        // Walking the fields (with generics substituted) finds numeric generics wherever they manifest —
        // array lengths, BoundedVec capacities — without needing to tell numeric generic arguments apart
        // from type ones.
        let (definition, generics) = typ.as_data_type().unwrap();
        for field in definition.fields(generics) {
            let (_name, field_type, _visibility) = field;
            acc = collect_numeric_generics(field_type, acc);
        }
    }
    acc
}

comptime fn push_generic_length(length_type: Type, acc: [Quoted]) -> [Quoted] {
    if length_type.as_constant().is_some() {
        acc
    } else {
        let length = f"{length_type}".quoted_contents();
        if acc.any(|existing: Quoted| existing == length) {
            acc
        } else {
            acc.push_back(length)
        }
    }
}

mod test {
    use super::{
        compose_wire_name, derive_wire_method_name, generate_oracle_stub, label_of, manifest_line,
        MAX_ORACLES_PER_MANIFEST, render_manifest,
    };
    use std::collections::bounded_vec::BoundedVec;
    use std::meta::{ctstring::AsCtString, unquote};

    /// Compile-time probe of the full declaration pipeline over a real `FunctionDefinition` — everything
    /// [`super::declare_oracle`] does except the manifest append, so the probe never pollutes the manifests
    /// that later ship in artifacts. The generated stub is spliced back in, proving it compiles, that its
    /// numeric generics are reconstructed, and (via the wrapper body) that the sibling name resolves.
    comptime fn assert_declaration_pipeline(f: FunctionDefinition) -> Quoted {
        let wire_name = compose_wire_name(quote { utl }, f.name());
        assert(wire_name == "aztec_utl_probeDeclaration".as_ctstring());

        let line = manifest_line(wire_name, f.parameters(), f.return_type());
        assert(line == "aztec_utl_probeDeclaration:array(field),bool->option(array(field,3))".as_ctstring());

        generate_oracle_stub(f, wire_name)
    }

    #[assert_declaration_pipeline]
    #[allow(dead_code)]
    unconstrained fn probe_declaration<let N: u32>(values: [Field; N], flag: bool) -> Option<[Field; 3]> {
        probe_declaration_oracle(values, flag)
    }

    pub(crate) struct Pair {
        pub(crate) a: Field,
        pub(crate) b: u32,
    }

    pub(crate) struct Nested {
        pub(crate) pair: Pair,
        pub(crate) flag: bool,
    }

    #[test]
    fn derives_plain_names() {
        comptime {
            assert(derive_wire_method_name(quote { deploy }) == "deploy".as_ctstring());
            assert(derive_wire_method_name(quote { get_auth_witness }) == "getAuthWitness".as_ctstring());
            assert(derive_wire_method_name(quote { decrypt_aes128 }) == "decryptAes128".as_ctstring());
            assert(
                derive_wire_method_name(quote { get_l1_to_l2_membership_witness_v2 })
                    == "getL1ToL2MembershipWitnessV2".as_ctstring(),
            );
        }
    }

    #[test]
    fn derives_convention_stripped_names() {
        comptime {
            assert(derive_wire_method_name(quote { return_ }) == "return".as_ctstring());
            assert(derive_wire_method_name(quote { get_block_header_internal }) == "getBlockHeader".as_ctstring());
        }
    }

    #[test]
    fn labels_scalars_and_leaves() {
        comptime {
            assert(label_of(quote { Field }.as_type()) == "field".as_ctstring());
            assert(label_of(quote { bool }.as_type()) == "bool".as_ctstring());
            assert(label_of(quote { u8 }.as_type()) == "u8".as_ctstring());
            assert(label_of(quote { u32 }.as_type()) == "u32".as_ctstring());
            assert(label_of(quote { u128 }.as_type()) == "u128".as_ctstring());
            assert(label_of(quote { str<5> }.as_type()) == "str".as_ctstring());
            assert(
                label_of(quote { crate::protocol::address::AztecAddress }.as_type()) == "aztec-address".as_ctstring(),
            );
            assert(label_of(quote { crate::protocol::address::EthAddress }.as_type()) == "eth-address".as_ctstring());
        }
    }

    #[test]
    fn labels_combinators() {
        comptime {
            assert(label_of(quote { [Field; 3] }.as_type()) == "array(field,3)".as_ctstring());
            assert(label_of(quote { [Field] }.as_type()) == "vector(field)".as_ctstring());
            assert(label_of(quote { Option<Field> }.as_type()) == "option(field)".as_ctstring());
            assert(label_of(quote { BoundedVec<u8, 5> }.as_type()) == "bounded-vec(u8,5)".as_ctstring());
            assert(label_of(quote { Option<[Field; 3]> }.as_type()) == "option(array(field,3))".as_ctstring());
            assert(
                label_of(quote { crate::ephemeral::EphemeralArray<Field> }.as_type())
                    == "ephemeral-array(field)".as_ctstring(),
            );
        }
    }

    #[test]
    fn labels_composites_with_splicing() {
        comptime {
            assert(label_of(quote { Pair }.as_type()) == "{field,u32}".as_ctstring());
            assert(label_of(quote { Nested }.as_type()) == "{field,u32,bool}".as_ctstring());
            assert(label_of(quote { (Field, bool) }.as_type()) == "{field,bool}".as_ctstring());
            assert(label_of(quote { Option<Pair> }.as_type()) == "option({field,u32})".as_ctstring());
            assert(label_of(quote { [Pair; 2] }.as_type()) == "array({field,u32},2)".as_ctstring());
        }
    }

    #[test]
    fn routes_and_appends_manifest_entries() {
        comptime {
            // Probe entries are appended to the real globals and popped again below, so the manifests that
            // ship in artifacts are untouched by this test.
            let execution_len = super::EXECUTION_ORACLE_MANIFEST.len();
            let txe_len = super::TXE_ORACLE_MANIFEST.len();

            let name = "aztec_utl_manifestAppendProbe".as_ctstring();
            let line = "aztec_utl_manifestAppendProbe:->()".as_ctstring();
            assert(!super::is_declared(super::EXECUTION_ORACLE_MANIFEST, name));
            super::append_manifest_entry(false, name, line);
            assert(super::EXECUTION_ORACLE_MANIFEST.len() == execution_len + 1);
            assert(super::TXE_ORACLE_MANIFEST.len() == txe_len);
            assert(super::is_declared(super::EXECUTION_ORACLE_MANIFEST, name));
            let (stored_name, stored_line) = super::EXECUTION_ORACLE_MANIFEST.get(execution_len);
            assert(stored_name == name);
            assert(stored_line == line);

            let txe_name = "aztec_txe_manifestAppendProbe".as_ctstring();
            super::append_manifest_entry(true, txe_name, txe_name);
            assert(super::TXE_ORACLE_MANIFEST.len() == txe_len + 1);
            assert(super::EXECUTION_ORACLE_MANIFEST.len() == execution_len + 1);
            assert(super::is_declared(super::TXE_ORACLE_MANIFEST, txe_name));
            assert(!super::is_declared(super::EXECUTION_ORACLE_MANIFEST, txe_name));

            let _ = super::EXECUTION_ORACLE_MANIFEST.pop();
            let _ = super::TXE_ORACLE_MANIFEST.pop();
            assert(super::EXECUTION_ORACLE_MANIFEST.len() == execution_len);
            assert(super::TXE_ORACLE_MANIFEST.len() == txe_len);
        }
    }

    #[test]
    fn renders_manifests_sorted_by_byte_order() {
        comptime {
            let mut manifest: BoundedVec<(CtString, CtString), MAX_ORACLES_PER_MANIFEST> = BoundedVec::new();
            manifest.push(("b".as_ctstring(), "b:u32->()".as_ctstring()));
            manifest.push(("aa".as_ctstring(), "aa:->field".as_ctstring()));
            manifest.push(("a".as_ctstring(), "a:field->()".as_ctstring()));

            let (literal, len) = render_manifest(manifest);
            // Splicing the rendered literal back into comptime code recovers its contents for comparison.
            let rendered = unquote!(quote { $literal.as_ctstring() });
            // Byte order: ':' sorts before 'a', so "a:field->()" precedes "aa:->field".
            assert(rendered == "a:field->()\naa:->field\nb:u32->()".as_ctstring());
            assert(len == 32);
        }
    }

    #[test]
    fn renders_empty_manifest() {
        comptime {
            let empty: BoundedVec<(CtString, CtString), MAX_ORACLES_PER_MANIFEST> = BoundedVec::new();
            let (literal, len) = render_manifest(empty);
            let rendered = unquote!(quote { $literal.as_ctstring() });
            assert(rendered == "".as_ctstring());
            assert(len == 0);
        }
    }

    #[test]
    fn renders_manifest_lines() {
        comptime {
            let params = @[
                (quote { owner }, quote { crate::protocol::address::AztecAddress }.as_type()),
                (quote { slot }, quote { Field }.as_type()),
            ];
            let line = manifest_line(
                "aztec_utl_probe".as_ctstring(),
                params,
                quote { Option<Field> }.as_type(),
            );
            assert(line == "aztec_utl_probe:aztec-address,field->option(field)".as_ctstring());

            let empty: [(Quoted, Type)] = @[];
            let no_params = manifest_line(
                "aztec_misc_getRandomField".as_ctstring(),
                empty,
                quote { Field }.as_type(),
            );
            assert(no_params == "aztec_misc_getRandomField:->field".as_ctstring());

            let void_return = manifest_line(
                "aztec_utl_probe2".as_ctstring(),
                empty,
                quote { () }.as_type(),
            );
            assert(void_return == "aztec_utl_probe2:->()".as_ctstring());
        }
    }
}
