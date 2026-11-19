//! Hybrid shared secrets for post-quantum resistance.
//!
//! They combine elliptic curve Diffie-Hellman and ML-KEM shared secrets, such that they are resilient to failure of any
//! of the two. Elliptic curves are expected to be breakable by a quantum computer, unlike ML-KEM, but they are also
//! better understood and regarded classically. This combination is therefore a good mitigation against both current and
//! future threats, and essentially follows the approach as X-Wing.

use crate::{
    keys::{
        ecdh_shared_secret::derive_ecdh_shared_secret,
        ephemeral::generate_positive_ephemeral_key_pair,
        post_quantum::mlkem768::{KemCiphertext, KemSharedSecret, PostQuantumPublicKey},
    },
    oracle::mlkem_encapsulate::mlkem_encapsulate,
    protocol::{address::AztecAddress, hash::poseidon2_hash_with_separator, point::EmbeddedCurvePoint, traits::ToField},
};

/// Domain separator for the hybrid shared secret derived from a KEM shared secret and an ECDH shared secret.
pub(crate) global DOM_SEP__HYBRID_SHARED_SECRET: u32 = 2111733946;

/// Domain separator for the messaging secret a contract gets from a hybrid shared secret.
pub(crate) global DOM_SEP__HYBRID_MESSAGING_SECRET: u32 = 3760126800;

/// A hybrid shared secret a sender created with a recipient.
///
/// The sender gives `eph_pk` and `kem_ciphertext` to the recipient, who derives the secret from them (see
/// [`get_hybrid_messaging_secret`](crate::oracle::hybrid_messaging_secret::get_hybrid_messaging_secret)). Nothing is
/// revealed about the secret to anyone else.
pub(crate) struct CreatedHybridSharedSecret {
    /// The hybrid shared secret, which only the sender and the recipient know.
    pub(crate) secret: Field,
    /// The sender's ephemeral public key. Its y-coordinate is positive, so its x-coordinate is enough to reconstruct
    /// it.
    pub(crate) eph_pk: EmbeddedCurvePoint,
    /// The ciphertext of the sender's encapsulation to the recipient's post-quantum public key.
    pub(crate) kem_ciphertext: KemCiphertext,
}

/// Creates a hybrid shared secret with `recipient`.
///
/// The secret combines an ECDH shared secret with `recipient`'s address and a [`KemSharedSecret`] encapsulated to
/// `recipient_post_quantum_public_key` (see
/// [`get_post_quantum_public_key`](crate::keys::post_quantum::registry::get_post_quantum_public_key)). Every call
/// yields a different secret.
///
/// The secret is not a messaging secret: derive the one each contract uses from it with
/// [`compute_hybrid_messaging_secret`].
///
/// Returns `None` if `recipient` is not a valid address, or `recipient_post_quantum_public_key` is not a valid
/// ML-KEM-768 public key.
pub(crate) unconstrained fn create_hybrid_shared_secret(
    recipient: AztecAddress,
    recipient_post_quantum_public_key: PostQuantumPublicKey,
) -> Option<CreatedHybridSharedSecret> {
    recipient.to_address_point().and_then(|recipient_point| {
        mlkem_encapsulate(recipient_post_quantum_public_key).map(|(kem_shared_secret, kem_ciphertext)| {
            let (eph_sk, eph_pk) = generate_positive_ephemeral_key_pair();
            let ecdh_shared_secret = derive_ecdh_shared_secret(eph_sk, recipient_point.inner);

            CreatedHybridSharedSecret {
                secret: compute_hybrid_shared_secret(kem_shared_secret, ecdh_shared_secret),
                eph_pk,
                kem_ciphertext,
            }
        })
    })
}

/// Combines a KEM shared secret and an ECDH shared secret into a hybrid shared secret.
pub(crate) fn compute_hybrid_shared_secret(
    kem_shared_secret: KemSharedSecret,
    ecdh_shared_secret: EmbeddedCurvePoint,
) -> Field {
    // X-Wing, which this follows, also hashes the ephemeral public key and the recipient's public key, since an X25519
    // shared secret determines neither. Here the ECDH shared secret is a point of a prime order group, and so for a
    // given recipient it determines the ephemeral public key. That takes both of its coordinates: negating the
    // ephemeral public key negates the shared secret, which keeps its x-coordinate, so two ephemeral public keys share
    // each x-coordinate.
    poseidon2_hash_with_separator(
        kem_shared_secret.fields.concat([ecdh_shared_secret.x, ecdh_shared_secret.y]),
        DOM_SEP__HYBRID_SHARED_SECRET,
    )
}

/// Derives the messaging secret `contract_address` gets from a hybrid shared secret.
///
/// Each contract gets a different messaging secret, which reveals neither the hybrid shared secret nor the messaging
/// secret of any other contract.
///
/// `messaging_secret = h(DOM_SEP__HYBRID_MESSAGING_SECRET, hybrid_shared_secret, contract_address)`
pub(crate) fn compute_hybrid_messaging_secret(hybrid_shared_secret: Field, contract_address: AztecAddress) -> Field {
    poseidon2_hash_with_separator(
        [hybrid_shared_secret, contract_address.to_field()],
        DOM_SEP__HYBRID_MESSAGING_SECRET,
    )
}

mod test {
    use crate::keys::post_quantum::mlkem768::{
        KemSharedSecret, POST_QUANTUM_PUBLIC_KEY_SIZE_IN_FIELDS, PostQuantumPublicKey,
    };
    use crate::oracle::hybrid_messaging_secret::get_hybrid_messaging_secret;
    use crate::protocol::{address::AztecAddress, point::EmbeddedCurvePoint, traits::FromField};
    use crate::test::helpers::{test_environment::TestEnvironment, txe_oracles::derive_post_quantum_public_key};
    use crate::utils::point::get_sign_of_point;
    use super::{compute_hybrid_messaging_secret, compute_hybrid_shared_secret, create_hybrid_shared_secret};
    use std::ops::Neg;

    global KEM_SHARED_SECRET: KemSharedSecret = KemSharedSecret {
        fields: [
            0x0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f,
            0x20000000000000000000000000000000000000000000000000000000000000,
        ],
    };

    global ECDH_SHARED_SECRET: EmbeddedCurvePoint = EmbeddedCurvePoint {
        x: 0x2688431c705a5ff3e6c6f2573c9e3ba1c1026d2251d0dbbf2d810aa53fd1d186,
        y: 0x1e96887b117afca01c00468264f4f80b5bb16d94c1808a448595f115556e5c8e,
    };

    // PXE derives the recipient's side in TypeScript, whose tests pin the same value for the same inputs.
    #[test]
    fn hybrid_shared_secret_matches_the_typescript_derivation() {
        assert_eq(
            compute_hybrid_shared_secret(KEM_SHARED_SECRET, ECDH_SHARED_SECRET),
            0x005544c74008185bb962f33f0d622977d48e33c73f1227283fe7ac4ee736d76f,
        );
    }

    #[test]
    fn hybrid_shared_secret_depends_on_every_field_of_the_kem_shared_secret() {
        let hybrid_shared_secret = compute_hybrid_shared_secret(KEM_SHARED_SECRET, ECDH_SHARED_SECRET);

        for i in 0..KEM_SHARED_SECRET.fields.len() {
            let mut other_kem_shared_secret = KEM_SHARED_SECRET;
            other_kem_shared_secret.fields[i] += 1;

            assert(compute_hybrid_shared_secret(other_kem_shared_secret, ECDH_SHARED_SECRET) != hybrid_shared_secret);
        }
    }

    #[test]
    fn hybrid_shared_secret_depends_on_both_coordinates_of_the_ecdh_shared_secret() {
        let hybrid_shared_secret = compute_hybrid_shared_secret(KEM_SHARED_SECRET, ECDH_SHARED_SECRET);

        // The negated point has the same x-coordinate and a different y-coordinate.
        assert(compute_hybrid_shared_secret(KEM_SHARED_SECRET, ECDH_SHARED_SECRET.neg()) != hybrid_shared_secret);

        let other_x = EmbeddedCurvePoint { x: ECDH_SHARED_SECRET.x + 1, y: ECDH_SHARED_SECRET.y };
        assert(compute_hybrid_shared_secret(KEM_SHARED_SECRET, other_x) != hybrid_shared_secret);
    }

    // PXE derives the recipient's side in TypeScript, whose tests pin the same value for the same inputs.
    #[test]
    fn hybrid_messaging_secret_matches_the_typescript_derivation() {
        assert_eq(
            compute_hybrid_messaging_secret(7, AztecAddress::from_field(42)),
            0x2163cd6fceadd9f938bdb1fa6237cecf0fb8cf5ee2a2aaea150354f705754d29,
        );
    }

    #[test]
    fn hybrid_messaging_secret_differs_per_contract() {
        assert(
            compute_hybrid_messaging_secret(7, AztecAddress::from_field(42))
                != compute_hybrid_messaging_secret(7, AztecAddress::from_field(43)),
        );
    }

    #[test]
    fn hybrid_messaging_secret_differs_per_hybrid_shared_secret() {
        assert(
            compute_hybrid_messaging_secret(7, AztecAddress::from_field(42))
                != compute_hybrid_messaging_secret(8, AztecAddress::from_field(42)),
        );
    }

    #[test]
    unconstrained fn recipient_derives_the_messaging_secret_of_a_created_hybrid_shared_secret() {
        let mut env = TestEnvironment::new();
        let recipient = env.create_light_account();
        let recipient_post_quantum_public_key = derive_post_quantum_public_key(recipient);

        env.utility_context(|context| {
            let contract_address = context.this_address();
            let created = create_hybrid_shared_secret(recipient, recipient_post_quantum_public_key).unwrap();

            assert_eq(
                get_hybrid_messaging_secret(
                    recipient,
                    created.eph_pk,
                    created.kem_ciphertext,
                    contract_address,
                )
                    .unwrap(),
                compute_hybrid_messaging_secret(created.secret, contract_address),
            );
        });
    }

    #[test]
    unconstrained fn every_created_hybrid_shared_secret_is_different() {
        let mut env = TestEnvironment::new();
        let recipient = env.create_light_account();
        let recipient_post_quantum_public_key = derive_post_quantum_public_key(recipient);

        env.utility_context(|_| {
            let created = create_hybrid_shared_secret(recipient, recipient_post_quantum_public_key).unwrap();
            let other_created = create_hybrid_shared_secret(recipient, recipient_post_quantum_public_key).unwrap();

            assert(other_created.secret != created.secret);
            assert(other_created.eph_pk != created.eph_pk);
            assert(other_created.kem_ciphertext != created.kem_ciphertext);
        });
    }

    #[test]
    unconstrained fn created_ephemeral_public_key_has_a_positive_y_coordinate() {
        let mut env = TestEnvironment::new();
        let recipient = env.create_light_account();
        let recipient_post_quantum_public_key = derive_post_quantum_public_key(recipient);

        env.utility_context(|_| {
            // About half of all points are negative, so a few creations give high confidence that none is.
            for _ in 0..10 {
                assert(get_sign_of_point(
                    create_hybrid_shared_secret(recipient, recipient_post_quantum_public_key).unwrap().eph_pk,
                ));
            }
        });
    }

    #[test]
    unconstrained fn creating_a_hybrid_shared_secret_with_an_invalid_recipient_returns_none() {
        let mut env = TestEnvironment::new();
        let recipient_post_quantum_public_key = derive_post_quantum_public_key(env.create_light_account());

        // x = 3 is a non-residue for this curve, resulting in an invalid address
        let invalid_recipient = AztecAddress { inner: 3 };

        env.utility_context(|_| {
            assert(create_hybrid_shared_secret(invalid_recipient, recipient_post_quantum_public_key).is_none());
        });
    }

    #[test]
    unconstrained fn creating_a_hybrid_shared_secret_with_an_invalid_public_key_returns_none() {
        let mut env = TestEnvironment::new();
        let recipient = env.create_light_account();

        // The first coefficients of this key are 4095, and ML-KEM-768 allows none above 3328.
        let mut fields = [0; POST_QUANTUM_PUBLIC_KEY_SIZE_IN_FIELDS];
        fields[0] = 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff;
        let invalid_public_key = PostQuantumPublicKey { fields };

        env.utility_context(|_| { assert(create_hybrid_shared_secret(recipient, invalid_public_key).is_none()); });
    }
}
