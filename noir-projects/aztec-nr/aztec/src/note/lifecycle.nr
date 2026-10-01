use crate::{
    context::PrivateContext,
    note::{
        ConfirmedNote,
        note_interface::{NoteHash, NoteType},
        NoteMessage,
        utils::compute_confirmed_note_hash_for_nullification,
    },
    oracle::{notes::notify_created_note, random::random},
};
use crate::protocol::{address::AztecAddress, hash::poseidon2_hash_with_separator, traits::Packable};

/// Domain separator for the randomness of a note.
pub(crate) global DOM_SEP__NOTE_RANDOMNESS: u32 = 2943528854;

/// A note that was created in the current contract call.
///
/// This struct holds a freshly created note along with the side-effect counter that the kernel uses to order note
/// creations within a transaction. It is produced by [`create_note`] and is typically wrapped in a
/// [`NoteMessage`](crate::note::NoteMessage), which is responsible for delivering the note's information to its
/// recipient so that it is not lost.
///
/// Unlike [`ConfirmedNote`](crate::note::ConfirmedNote), which represents a note whose existence has been proven
/// (either by reading it from PXE or by checking historical state), a `NewNote` represents a note whose creation is
/// still pending in the current transaction's side-effect stream. Its note hash has been pushed into the
/// [`PrivateContext`] but has not yet been siloed nor inserted into the note hash tree.
pub struct NewNote<Note> {
    pub note: Note,
    pub owner: AztecAddress,
    pub storage_slot: Field,
    pub randomness: Field,
    pub note_hash_counter: u32,
}

impl<Note> NewNote<Note> {
    fn new(note: Note, owner: AztecAddress, storage_slot: Field, randomness: Field, note_hash_counter: u32) -> Self {
        // A counter of value zero indicates a settled note, which a NewNote by definition cannot be.
        assert(note_hash_counter != 0, "A NewNote cannot have a zero note hash counter");
        Self { note, owner, storage_slot, randomness, note_hash_counter }
    }
}

pub fn create_note<Note>(
    context: &mut PrivateContext,
    owner: AztecAddress,
    storage_slot: Field,
    note: Note,
) -> NoteMessage<Note>
where
    Note: NoteType + NoteHash + Packable,
{
    let note_hash_counter = context.get_side_effect_counter();

    // Safety: We use the randomness to preserve the privacy of the note recipient by preventing brute-forcing, so a
    // malicious sender could use non-random values to make the note less private. But they already know the full note
    // pre-image anyway, and so the recipient already trusts them to not disclose this information. We can therefore
    // assume that the sender will cooperate in the random value generation.
    let random_value = unsafe { random() };

    // Settled note hashes are globally unique, but during transaction execution pending notes are nullified (and made
    // transient) by their note hash, and two notes with the same note hash created in the same transaction cannot be
    // told apart for the purposes of nullification and squashing. A prover can therefore select which one to squash,
    // and in so doing select which of the two associated logs (if any) to squash, which may have unintended
    // side-effects if the logs are not identical.
    // To avoid such scenarios entirely, we include the note hash counter in the randomness derivation, which makes all
    // pending note hashes unique within their transaction, as note hash counter values are unique (assuming the note
    // hash includes a commitment to the randomness).
    // Note that squashed notes do not result in already used counters changing, instead they are simply dropped and
    // counter values are not reused.
    let randomness = poseidon2_hash_with_separator(
        [random_value, note_hash_counter as Field],
        DOM_SEP__NOTE_RANDOMNESS,
    );

    let note_hash = note.compute_note_hash(owner, storage_slot, randomness);

    notify_created_note(
        owner,
        storage_slot,
        randomness,
        Note::get_id(),
        note.pack(),
        note_hash,
        note_hash_counter,
    );

    context.push_note_hash(note_hash);

    NoteMessage::new(
        NewNote::new(note, owner, storage_slot, randomness, note_hash_counter),
        context,
    )
}

pub fn destroy_note<Note>(context: &mut PrivateContext, confirmed_note: ConfirmedNote<Note>)
where
    Note: NoteHash,
{
    let note_hash_for_nullification = compute_confirmed_note_hash_for_nullification(confirmed_note);
    let nullifier = confirmed_note.note.compute_nullifier(context, confirmed_note.owner, note_hash_for_nullification);

    let note_hash = if confirmed_note.metadata.is_settled() {
        // Counter is zero, so we're nullifying a settled note and we don't populate the note_hash with real value.
        0
    } else {
        // A non-zero note hash counter implies that we're nullifying a pending note (i.e. one that has not yet been
        // persisted in the trees and is instead in the pending new note hashes array). In such a case we populate its
        // hash with real value to inform the kernel which note we're nullifying so that it can either squash both the
        // note and the nullifier if it's an inner note hash, or check that the it matches a pending note if it's a
        // siloed note hash.
        note_hash_for_nullification
    };

    context.push_nullifier_for_note_hash(nullifier, note_hash)
}

mod test {
    use crate::test::{helpers::test_environment::TestEnvironment, mocks::mock_note::MockNote};
    use super::create_note;
    use std::test::OracleMock;

    global VALUE: Field = 7;
    global STORAGE_SLOT: Field = 13;
    global RANDOM_VALUE: Field = 42;

    #[test]
    unconstrained fn identical_notes_created_with_the_same_random_value_have_different_note_hashes() {
        let mut env = TestEnvironment::new();
        let owner = env.create_light_account();

        env.private_context(|context| {
            let _ = OracleMock::mock("aztec_misc_getRandomField").returns(RANDOM_VALUE);

            let note = MockNote::new(VALUE).build_note();
            let _ = create_note(context, owner, STORAGE_SLOT, note);
            let _ = create_note(context, owner, STORAGE_SLOT, note);

            assert(context.note_hashes.get(0).inner != context.note_hashes.get(1).inner);
        });
    }
}
