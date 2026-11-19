use crate::ephemeral::EphemeralArray;
use crate::protocol::{address::AztecAddress, point::EmbeddedCurvePoint};

#[oracle(aztec_utl_getEcdhMessagingSecrets)]
unconstrained fn get_ecdh_messaging_secrets_oracle(
    address: AztecAddress,
    eph_pks: EphemeralArray<EmbeddedCurvePoint>,
    contract_address: AztecAddress,
) -> EphemeralArray<Field> {}

/// Variant of [`get_ecdh_messaging_secrets`] for a single ephemeral public key.
///
/// Returns `Option::none()` where [`get_ecdh_messaging_secrets`] returns an empty array.
pub unconstrained fn get_ecdh_messaging_secret(
    address: AztecAddress,
    eph_pk: EmbeddedCurvePoint,
    contract_address: AztecAddress,
) -> Option<Field> {
    let eph_pks: EphemeralArray<EmbeddedCurvePoint> = EphemeralArray::empty();
    eph_pks.push(eph_pk);
    let secrets = get_ecdh_messaging_secrets(address, eph_pks, contract_address);
    if secrets.len() == 1 {
        Option::some(secrets.get(0))
    } else {
        Option::none()
    }
}

/// Returns `address`'s ECDH messaging secret for each ephemeral public key.
///
/// Each secret is shared with whoever knows the secret key behind that ephemeral public key.
///
/// Each returned Field is computed as:
///
/// ```text
/// S      = address_secret * ephPk          (raw ECDH point)
/// secret = h(DOM_SEP, S.x, S.y, contract)  (messaging secret)
/// ```
///
/// where `contract` is `contract_address`, which must be the address of the calling contract.
///
/// Without app-siloing, a malicious contract could call this oracle with public information (address, ephPk) and
/// obtain the same raw secret as the legitimate contract, letting it find the legitimate contract's tagged logs and
/// decrypt its messages. By including the contract address in the hash, each contract receives its own messaging
/// secret, preventing this attack. For the same reason, requesting messaging secrets for another contract is not
/// currently supported: it would need a mechanism for a contract to explicitly allow trusted contracts to do so.
///
/// Returns an empty array when the PXE does not hold `address`'s ivsk in scope, and therefore cannot derive any
/// secrets.
pub unconstrained fn get_ecdh_messaging_secrets(
    address: AztecAddress,
    eph_pks: EphemeralArray<EmbeddedCurvePoint>,
    contract_address: AztecAddress,
) -> EphemeralArray<Field> {
    let response = get_ecdh_messaging_secrets_oracle(address, eph_pks, contract_address);
    assert(
        (response.len() == eph_pks.len()) | (response.len() == 0),
        "get_ecdh_messaging_secrets: response length does not match request length",
    );
    response
}

mod test {
    use crate::ephemeral::EphemeralArray;
    use crate::oracle::ecdh_messaging_secret::{get_ecdh_messaging_secret, get_ecdh_messaging_secrets};
    use crate::protocol::{address::AztecAddress, traits::FromField};
    use crate::test::helpers::test_environment::TestEnvironment;
    use crate::utils::point::point_from_x_coord;
    use std::test::OracleMock;

    #[test]
    unconstrained fn preserves_ephemeral_key_ordering() {
        let env = TestEnvironment::new();
        env.utility_context(|_| {
            let _ = mock_get_ecdh_messaging_secrets([100, 200, 300]);

            let pk_a = point_from_x_coord(1).unwrap();
            let pk_b = point_from_x_coord(2).unwrap();
            let pk_c = point_from_x_coord(8).unwrap();

            let eph_pks: EphemeralArray<_> = EphemeralArray::empty_at(200);
            eph_pks.push(pk_a);
            eph_pks.push(pk_b);
            eph_pks.push(pk_c);

            let _: EphemeralArray<Field> = get_ecdh_messaging_secrets(
                AztecAddress::from_field(1),
                eph_pks,
                AztecAddress::from_field(2),
            );

            assert_eq(eph_pks.get(0), pk_a);
            assert_eq(eph_pks.get(1), pk_b);
            assert_eq(eph_pks.get(2), pk_c);
        });
    }

    #[test]
    unconstrained fn returns_secrets_in_order() {
        let env = TestEnvironment::new();
        env.utility_context(|_| {
            let _ = mock_get_ecdh_messaging_secrets([111, 222, 333]);

            let pk = point_from_x_coord(1).unwrap();
            let eph_pks: EphemeralArray<_> = EphemeralArray::empty_at(200);
            eph_pks.push(pk);
            eph_pks.push(pk);
            eph_pks.push(pk);

            let results: EphemeralArray<Field> = get_ecdh_messaging_secrets(
                AztecAddress::from_field(1),
                eph_pks,
                AztecAddress::from_field(2),
            );

            assert_eq(results.get(0), 111);
            assert_eq(results.get(1), 222);
            assert_eq(results.get(2), 333);
        });
    }

    #[test]
    unconstrained fn returns_empty_when_pxe_does_not_hold_keys() {
        let env = TestEnvironment::new();
        env.utility_context(|_| {
            let empty: [Field; 0] = [];
            let _ = mock_get_ecdh_messaging_secrets(empty);

            let pk = point_from_x_coord(1).unwrap();
            let eph_pks: EphemeralArray<_> = EphemeralArray::empty_at(200);
            eph_pks.push(pk);

            let results: EphemeralArray<Field> = get_ecdh_messaging_secrets(
                AztecAddress::from_field(1),
                eph_pks,
                AztecAddress::from_field(2),
            );

            assert_eq(results.len(), 0);
        });
    }

    #[test]
    unconstrained fn single_secret_returns_the_secret() {
        let env = TestEnvironment::new();
        env.utility_context(|_| {
            let _ = mock_get_ecdh_messaging_secrets([111]);

            let pk = point_from_x_coord(1).unwrap();
            let secret = get_ecdh_messaging_secret(AztecAddress::from_field(1), pk, AztecAddress::from_field(2));

            assert_eq(secret.unwrap(), 111);
        });
    }

    #[test]
    unconstrained fn single_secret_returns_none_when_pxe_does_not_hold_keys() {
        let env = TestEnvironment::new();
        env.utility_context(|_| {
            let empty: [Field; 0] = [];
            let _ = mock_get_ecdh_messaging_secrets(empty);

            let pk = point_from_x_coord(1).unwrap();
            let secret = get_ecdh_messaging_secret(AztecAddress::from_field(1), pk, AztecAddress::from_field(2));

            assert(secret.is_none());
        });
    }

    #[test(should_fail_with = "response length does not match request length")]
    unconstrained fn cannot_return_mismatched_length() {
        let env = TestEnvironment::new();
        env.utility_context(|_| {
            let _ = mock_get_ecdh_messaging_secrets([111, 222]);

            let pk = point_from_x_coord(1).unwrap();
            let eph_pks: EphemeralArray<_> = EphemeralArray::empty_at(200);
            eph_pks.push(pk);

            let _: EphemeralArray<Field> = get_ecdh_messaging_secrets(
                AztecAddress::from_field(1),
                eph_pks,
                AztecAddress::from_field(2),
            );
        });
    }

    unconstrained fn mock_get_ecdh_messaging_secrets<let N: u32>(response_values: [Field; N]) -> Field {
        let response_slot: Field = 99;
        let response_array: EphemeralArray<Field> = EphemeralArray::at(response_slot);
        for value in response_values {
            response_array.push(value);
        }
        let _ = OracleMock::mock("aztec_utl_getEcdhMessagingSecrets").returns(response_slot);
        response_slot
    }
}
