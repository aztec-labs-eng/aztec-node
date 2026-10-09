//! Note for an ECDSA public key.

use aztec::{macros::notes::note, protocol::traits::{Deserialize, Packable, Serialize}};

/// Stores an ECDSA public key composed of two 32-byte elements.
#[note]
#[derive(Deserialize, Eq, Serialize)]
pub struct EcdsaPublicKeyNote {
    pub x: [u8; 32],
    pub y: [u8; 32],
}

impl Packable for EcdsaPublicKeyNote {
    let N: u32 = 4;

    // Cannot use the automatic packing since each u8 would be packed into a full field, making the representation 64
    // fields long. Pack the note as 4 fields where:
    // [0] = x[0..31] (upper bound excluded)
    // [1] = x[31]
    // [2] = y[0..31]
    // [3] = y[31]
    fn pack(self) -> [Field; Self::N] {
        let mut x: Field = 0;
        let mut y: Field = 0;
        let mut mul: Field = 1;

        for i in 1..32 {
            let byte_x: Field = self.x[31 - i] as Field;
            x = x + (byte_x * mul);
            let byte_y: Field = self.y[31 - i] as Field;
            y = y + (byte_y * mul);
            mul *= 256;
        }

        let last_x = self.x[31] as Field;
        let last_y = self.y[31] as Field;

        [x, last_x, y, last_y]
    }

    // Cannot use the automatic unpacking for the aforementioned reasons
    fn unpack(packed_note: [Field; Self::N]) -> Self {
        let mut x: [u8; 32] = [0; 32];
        let mut y: [u8; 32] = [0; 32];

        let part_x: [u8; 32] = packed_note[0].to_be_bytes();
        for i in 0..31 {
            x[i] = part_x[i + 1];
        }
        x[31] = packed_note[1].to_be_bytes::<32>()[31];

        let part_y: [u8; 32] = packed_note[2].to_be_bytes();
        for i in 0..31 {
            y[i] = part_y[i + 1];
        }
        y[31] = packed_note[3].to_be_bytes::<32>()[31];

        EcdsaPublicKeyNote { x, y }
    }
}

mod test {
    use crate::EcdsaPublicKeyNote;
    use aztec::protocol::traits::Packable;

    #[test]
    unconstrained fn pack_unpack_round_trips(x: [u8; 32], y: [u8; 32]) {
        let note = EcdsaPublicKeyNote { x, y };

        assert_eq(EcdsaPublicKeyNote::unpack(note.pack()), note);
    }

    #[test]
    unconstrained fn pack_unpack_round_trips_smallest_coordinates() {
        let note = EcdsaPublicKeyNote { x: [0; 32], y: [0; 32] };

        assert_eq(note.pack(), [0, 0, 0, 0]);
        assert_eq(EcdsaPublicKeyNote::unpack(note.pack()), note);
    }

    #[test]
    unconstrained fn pack_unpack_round_trips_largest_coordinates() {
        let note = EcdsaPublicKeyNote { x: [255; 32], y: [255; 32] };

        let largest_31_byte_value: Field = 2.pow_32(8 * 31) - 1;

        assert_eq(note.pack(), [largest_31_byte_value, 255, largest_31_byte_value, 255]);
        assert_eq(EcdsaPublicKeyNote::unpack(note.pack()), note);
    }

    #[test]
    unconstrained fn pack_splits_each_coordinate_into_its_first_31_bytes_and_its_last_byte() {
        let mut x = [0; 32];
        x[0] = 1;
        x[30] = 2;
        x[31] = 3;

        let mut y = [0; 32];
        y[0] = 4;
        y[30] = 5;
        y[31] = 6;

        // The first of the 31 bytes packed into a field is the most significant, 30 bytes above the last.
        let first_byte_mul: Field = 2.pow_32(8 * 30);

        assert_eq(EcdsaPublicKeyNote { x, y }.pack(), [first_byte_mul + 2, 3, 4 * first_byte_mul + 5, 6]);
    }

    #[test]
    unconstrained fn unpack_does_not_fail_on_fields_that_pack_cannot_produce() {
        let _ = EcdsaPublicKeyNote::unpack([-1, -1, -1, -1]);
    }
}
