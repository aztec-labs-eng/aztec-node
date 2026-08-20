use crate::macros::{oracle_declaration::{add_manual_execution_oracle, prv_oracle}, oracle_testing::skip_oracle_test};
use crate::messages::delivery::OnchainDeliveryMode;
use crate::note::{HintedNote, note_interface::NoteType};

use crate::protocol::{address::AztecAddress, traits::Packable};

/// Notifies the simulator that a note has been created, so that it can be returned in future read requests in the same
/// transaction. This note should only be added to the non-volatile database if found in an actual block.
pub fn notify_created_note<let N: u32>(
    owner: AztecAddress,
    storage_slot: Field,
    randomness: Field,
    note_type_id: Field,
    packed_note: [Field; N],
    note_hash: Field,
    counter: u32,
) {
    // Safety: This oracle call returns nothing: we only call it for its side effects. It is therefore always safe to
    // call.
    unsafe {
        notify_created_note_oracle_wrapper(
            owner,
            storage_slot,
            randomness,
            note_type_id,
            packed_note,
            note_hash,
            counter,
        )
    };
}

/// Notifies the simulator that a note has been nullified, so that it is no longer returned in future read requests in
/// the same transaction. This note should only be removed to the non-volatile database if its nullifier is found in an
/// actual block.
pub fn notify_nullified_note(nullifier: Field, note_hash: Field, counter: u32) {
    // Safety: This oracle call returns nothing: we only call it for its side effects. It is therefore always safe to
    // call.
    unsafe { notify_nullified_note_oracle_wrapper(nullifier, note_hash, counter) };
}

// Compiles to a brillig entry point (it is called from constrained code), and entry points embed their function
// name in artifact bytecode: renaming this function would change every artifact hash and class ID.
unconstrained fn notify_created_note_oracle_wrapper<let N: u32>(
    owner: AztecAddress,
    storage_slot: Field,
    randomness: Field,
    note_type_id: Field,
    packed_note: [Field; N],
    note_hash: Field,
    counter: u32,
) {
    notify_created_note_internal(
        owner,
        storage_slot,
        randomness,
        note_type_id,
        packed_note,
        note_hash,
        counter,
    );
}

#[prv_oracle]
unconstrained fn notify_created_note_internal<let N: u32>(
    owner: AztecAddress,
    storage_slot: Field,
    randomness: Field,
    note_type_id: Field,
    packed_note: [Field; N],
    note_hash: Field,
    counter: u32,
) {
    notify_created_note_internal_oracle(
        owner,
        storage_slot,
        randomness,
        note_type_id,
        packed_note,
        note_hash,
        counter,
    );
}

// Compiles to a brillig entry point (it is called from constrained code), and entry points embed their function
// name in artifact bytecode: renaming this function would change every artifact hash and class ID.
unconstrained fn notify_nullified_note_oracle_wrapper(nullifier: Field, note_hash: Field, counter: u32) {
    notify_nullified_note_internal(nullifier, note_hash, counter);
}

#[prv_oracle]
unconstrained fn notify_nullified_note_internal(nullifier: Field, note_hash: Field, counter: u32) {
    notify_nullified_note_internal_oracle(nullifier, note_hash, counter);
}

/// Registers `get_notes`'s manifest entry. The stub below stays hand-written because the oracle is generic over the
/// note type itself, so no derived label can describe its rows: the `note` token in the return is the TS registry's
/// variable-width note leaf, honestly leaving the row layout unpinned while the wire name and parameter positions
/// stay checked. The `u32` parameter labels transcribe the TS-side interpretation of the `u8` values sent here.
comptime fn declare_get_notes_manifest_entry(_f: FunctionDefinition) {
    add_manual_execution_oracle(
        "aztec_utl_getNotes",
        "option(aztec-address),field,u32,array(u32),array(u32),array(u32),array(field),array(u32),array(u32),array(u32),array(u32),array(u32),u32,u32,u32,u32,u32->bounded-vec(note)",
    );
}

// TODO: cover with an oracle test once the test resolver can synthesize note rows.
#[skip_oracle_test]
#[declare_get_notes_manifest_entry]
#[oracle(aztec_utl_getNotes)]
unconstrained fn get_notes_oracle<Note, let M: u32, let MaxNotes: u32>(
    _owner: Option<AztecAddress>,
    _storage_slot: Field,
    _num_selects: u8,
    _select_by_indexes: [u8; M],
    _select_by_offsets: [u8; M],
    _select_by_lengths: [u8; M],
    _select_values: [Field; M],
    _select_comparators: [u8; M],
    _sort_by_indexes: [u8; M],
    _sort_by_offsets: [u8; M],
    _sort_by_lengths: [u8; M],
    _sort_order: [u8; M],
    _limit: u32,
    _offset: u32,
    _status: u8,
    // This is always set to MAX_NOTES. We need to pass it to TS in order to correctly construct the BoundedVec
    _max_notes: u32,
    // This is always set to <HintedNote<Note> as Packable>::N. We need to pass it to TS in order to be able to
    // correctly construct the BoundedVec there.
    _packed_hinted_note_length: u32,
) -> BoundedVec<[Field; <HintedNote<Note> as Packable>::N], MaxNotes>
where
    // TODO(https://github.com/noir-lang/noir/issues/9399): `Note: Packable` should work here.
    HintedNote<Note>: Packable,
{}

pub unconstrained fn get_notes<Note, let M: u32, let MaxNotes: u32>(
    owner: Option<AztecAddress>,
    storage_slot: Field,
    num_selects: u8,
    select_by_indexes: [u8; M],
    select_by_offsets: [u8; M],
    select_by_lengths: [u8; M],
    select_values: [Field; M],
    select_comparators: [u8; M],
    sort_by_indexes: [u8; M],
    sort_by_offsets: [u8; M],
    sort_by_lengths: [u8; M],
    sort_order: [u8; M],
    limit: u32,
    offset: u32,
    status: u8,
) -> [Option<HintedNote<Note>>; MaxNotes]
where
    Note: NoteType + Packable,
{
    let packed_hinted_notes: BoundedVec<[Field; <HintedNote<Note> as Packable>::N], MaxNotes> = get_notes_oracle::<Note, M, MaxNotes>(
        owner,
        storage_slot,
        num_selects,
        select_by_indexes,
        select_by_offsets,
        select_by_lengths,
        select_values,
        select_comparators,
        sort_by_indexes,
        sort_by_offsets,
        sort_by_lengths,
        sort_order,
        limit,
        offset,
        status,
        MaxNotes,
        <HintedNote<Note> as Packable>::N,
    );

    let mut notes = BoundedVec::<_, MaxNotes>::new();
    for i in 0..packed_hinted_notes.len() {
        let hinted_note = HintedNote::unpack(packed_hinted_notes.get(i));
        notes.push(hinted_note);
    }

    // At last we convert the bounded vector to an array of options. We do this because that is what the filter
    // function needs to have on the output and we've decided to have the same type on the input and output of the
    // filter and preprocessor functions.
    //
    // We have decided to have the same type on the input and output of the filter and preprocessor functions because
    // it allows us to chain multiple filters and preprocessors together.
    //
    // So why do we want the array of options on the output of the filter function?
    //
    // Filter returns an array of options rather than a BoundedVec for performance reasons. Using an array of options
    // allows setting values at known indices in the output array which is much more efficient than pushing to a
    // BoundedVec where the write position depends on previous iterations. The array can then be efficiently converted
    // to a BoundedVec using utils/array/collapse.nr::collapse function from Aztec.nr. This avoids expensive dynamic
    // memory access patterns that would be required when building up a BoundedVec incrementally. For preprocessor
    // functions we could use BoundedVec return value as there the optimization does not matter since it is applied in
    // an unconstrained context. We, however, use the same return value type to be able to use the same function as
    // both a preprocessor and a filter.
    let mut notes_array = [Option::none(); MaxNotes];
    for i in 0..notes.len() {
        notes_array[i] = Option::some(notes.get_unchecked(i));
    }

    notes_array
}

// TODO: Oracles below are generic private log oracles and are not specific to notes. Move them somewhere else.

/// Returns the sender-side app tagging secret for a `(sender, recipient)` pair.
///
/// The secret is resolved by the simulator rather than computed by the contract.
///
/// Returns `None` for an invalid recipient address.
#[prv_oracle]
pub unconstrained fn get_app_tagging_secret(sender: AztecAddress, recipient: AztecAddress) -> Option<Field> {
    get_app_tagging_secret_oracle(sender, recipient)
}

/// Returns the next sender-side tagging index for a given secret and delivery mode.
///
/// The caller already holds the tagging `secret`, whether obtained from [`get_app_tagging_secret`] or computed by the
/// contract, and only needs the simulator to hand out a fresh per-secret, per-mode index; the caller computes the tag
/// itself. `mode` is converted into the [`OnchainDeliveryMode`] selecting the per-mode index counter, so callers can
/// pass either a concrete on-chain delivery builder or an explicit mode. Offchain messages are not tagged, so only the
/// onchain delivery variants can be used by this oracle.
///
/// The simulator persists the index increment only if the tagged log is found in an actual block; a reverting
/// transaction can otherwise cause the sender to skip indices and later produce notes that are not found by the
/// recipient.
pub unconstrained fn get_next_tagging_index<M>(secret: Field, mode: M) -> u32
where
    M: Into<OnchainDeliveryMode>,
{
    get_next_tagging_index_internal(secret, mode.into())
}

#[prv_oracle]
unconstrained fn get_next_tagging_index_internal(secret: Field, mode: OnchainDeliveryMode) -> u32 {
    get_next_tagging_index_internal_oracle(secret, mode)
}

/// Gets the sender for tags.
///
/// This unconstrained value is used as the sender when computing an unconstrained shared secret for a tag in order to
/// emit a log. Constrained tagging should not use this as there is no guarantee that the recipient knows about the
/// sender, and hence about the shared secret.
///
/// Returns the wallet-supplied default sender for tags, or `None` if no default was provided.
#[prv_oracle]
pub(crate) unconstrained fn get_sender_for_tags() -> Option<AztecAddress> {
    get_sender_for_tags_oracle()
}
