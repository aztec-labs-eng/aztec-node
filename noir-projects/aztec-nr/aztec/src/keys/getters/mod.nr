use crate::{
    keys::constants::{INCOMING_INDEX, NULLIFIER_INDEX, OUTGOING_INDEX, TAGGING_INDEX},
    oracle::{
        key_validation_request::try_get_key_validation_request,
        keys::{get_public_keys_and_partial_address, try_get_public_keys_and_partial_address},
    },
};
use crate::protocol::{address::AztecAddress, public_keys::PublicKeys};

/// The type of an app-siloed secret key requested with [`try_get_sk_app`].
pub struct KeyType {
    // Noir has no enums, so this wraps the key type's index.
    index: Field,
}

impl KeyType {
    /// The nullifier hiding key, whose master public key hash is `npk_m_hash` in [`PublicKeys`].
    pub fn nullifier_hiding() -> Self {
        Self { index: NULLIFIER_INDEX }
    }

    /// The incoming viewing secret key, whose master public key hash is `ivpk_m.hash()` in [`PublicKeys`].
    pub fn incoming_viewing() -> Self {
        Self { index: INCOMING_INDEX }
    }

    /// The outgoing viewing secret key, whose master public key hash is `ovpk_m_hash` in [`PublicKeys`].
    pub fn outgoing_viewing() -> Self {
        Self { index: OUTGOING_INDEX }
    }

    /// The tagging secret key, whose master public key hash is `tpk_m_hash` in [`PublicKeys`].
    pub fn tagging() -> Self {
        Self { index: TAGGING_INDEX }
    }
}

/// Returns the app-siloed secret key of type `key_type` for `pk_m_hash`.
///
/// `pk_m_hash` is the hash of an account's master public key of that type. Returns `None` if no account in scope has
/// that key.
pub unconstrained fn try_get_sk_app(pk_m_hash: Field, key_type: KeyType) -> Option<Field> {
    try_get_key_validation_request(pk_m_hash, key_type.index).map(|request| request.sk_app)
}

#[deprecated("use try_get_sk_app with KeyType::nullifier_hiding()")]
pub unconstrained fn get_nhk_app(npk_m_hash: Field) -> Field {
    try_get_sk_app(npk_m_hash, KeyType::nullifier_hiding()).expect(
        f"Key validation request denied: no scoped account has a key with hash {npk_m_hash}",
    )
}

// A helper function that gets app-siloed outgoing viewing key for a given `ovpk_m_hash`. This function is used in
// unconstrained contexts only - when computing unconstrained note logs. The safe alternative is `request_ovsk_app`
// function defined on `PrivateContext`.
#[deprecated("use try_get_sk_app with KeyType::outgoing_viewing()")]
pub unconstrained fn get_ovsk_app(ovpk_m_hash: Field) -> Field {
    try_get_sk_app(ovpk_m_hash, KeyType::outgoing_viewing()).expect(
        f"Key validation request denied: no scoped account has a key with hash {ovpk_m_hash}",
    )
}

// Returns all public keys for a given account, applying proper constraints to the context. We read all keys at once
// since the constraints for reading them all are actually fewer than if we read them one at a time - any read keys
// that are not required by the caller can simply be discarded.
// Fails if the public keys are not registered
pub fn get_public_keys(account: AztecAddress) -> PublicKeys {
    // Safety: Public keys are constrained by showing their inclusion in the address's preimage.
    let (public_keys, partial_address) = unsafe { get_public_keys_and_partial_address(account) };
    assert_eq(account, AztecAddress::compute(public_keys, partial_address), "Invalid public keys hint for address");

    public_keys
}

/// Returns all public keys for a given account, or `None` if the public keys are not registered in the PXE.
pub unconstrained fn try_get_public_keys(account: AztecAddress) -> Option<PublicKeys> {
    try_get_public_keys_and_partial_address(account).map(|(public_keys, _)| public_keys)
}

mod test {
    use super::{get_public_keys, KeyType, try_get_sk_app};

    use crate::protocol::{
        address::PartialAddress,
        point::EmbeddedCurvePoint,
        public_keys::{IvpkM, PublicKeys},
        traits::Hash,
    };
    use crate::test::helpers::test_environment::TestEnvironment;
    use std::test::OracleMock;

    #[test]
    unconstrained fn try_get_sk_app_finds_each_key_type_by_its_public_key_hash() {
        let mut env = TestEnvironment::new();
        let account = env.create_light_account();

        env.utility_context(|_| {
            let public_keys = get_public_keys(account);
            assert(try_get_sk_app(public_keys.npk_m_hash, KeyType::nullifier_hiding()).is_some());
            assert(try_get_sk_app(public_keys.ivpk_m.hash(), KeyType::incoming_viewing()).is_some());
            assert(try_get_sk_app(public_keys.ovpk_m_hash, KeyType::outgoing_viewing()).is_some());
            assert(try_get_sk_app(public_keys.tpk_m_hash, KeyType::tagging()).is_some());
        });
    }

    #[test]
    unconstrained fn try_get_sk_app_returns_none_for_unknown_key() {
        let env = TestEnvironment::new();

        env.utility_context(|_| { assert(try_get_sk_app(42, KeyType::nullifier_hiding()).is_none()); });
    }

    #[test(should_fail_with = "Invalid public keys hint for address")]
    unconstrained fn get_public_keys_fails_with_bad_hint() {
        let mut env = TestEnvironment::new();
        let account = env.create_light_account();

        // Instead of querying for some unknown account, which would result in the oracle erroring out, we mock a bad
        // oracle response to check that the circuit properly checks the address derivation. The values below are
        // arbitrary; `ivpk_m` does not have to be on-curve to make this test fail.
        let public_keys = PublicKeys {
            npk_m_hash: 0x292364b852c6c6f01472951e76a39cbcf074591fd0e063a81965e7b51ad868a5,
            ivpk_m: IvpkM {
                inner: EmbeddedCurvePoint {
                    x: 0x173c5229a00c5425255680dd6edc27e278c48883991f348fe6985de43b4ec25f,
                    y: 0x1698608e23b5f6c2f43c49a559108bb64e2247b8fc2da842296a416817f40b7f,
                },
            },
            ovpk_m_hash: 0x1bad2f7d1ad960a1bd0fe4d2c8d17f5ab4a86ef8b103e0a9e7f67ec0d3b4795e,
            tpk_m_hash: 0x05e3bd9cfe6b47daa139613619cf7d7fd8bb0112b6f2908caa6d9b536ed948ed,
            mspk_m_hash: 0x1a4f87ed20a8ce7e8d2b2c731f9b3d39f37e2d4ab2c6db66f7c8e3e9f1b6b39d,
            fbpk_m_hash: 0x0fbb9c2bf6cb4d4a1d4ee2f8b3a2c5e3d4b9c1a8e5f2d6b7c8e3f4a5b6c7d8e9,
        };
        let partial_address = PartialAddress::from_field(
            0x236703e2cb00a182e024e98e9f759231b556d25ff19f98896cebb69e9e678cc9,
        );

        let _ = OracleMock::mock("aztec_utl_getPublicKeysAndPartialAddress").returns(Option::some((
            public_keys, partial_address,
        )));
        let _ = get_public_keys(account);
    }
}
