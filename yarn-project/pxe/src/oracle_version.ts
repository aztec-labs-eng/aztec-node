/// The oracle version constants are used to check that the oracle interface is in sync between PXE and Aztec.nr.
/// We version the oracle interface as `major.minor` where:
///   - `major` = backward-breaking changes (must match exactly between PXE and Aztec.nr)
///   - `minor` = oracle additions (non-breaking; PXE minor >= contract minor)
///
/// The Noir counterparts are in `noir-projects/labs/aztec-nr/aztec/src/oracle/version.nr`.
///
/// @dev Whenever a contract function or Noir test is run, the `aztec_misc_assertCompatibleOracleVersion` oracle is called.
/// If the major version is incompatible, an error is thrown immediately. The minor version is recorded by the PXE and
/// used to provide helpful error messages if a contract calls an oracle that doesn't exist. We don't throw immediately
/// if AZTEC_NR_MINOR > PXE_MINOR because if a contract is updated to use a newer Aztec.nr dependency without actually
/// using any of the new oracles then there is no reason to throw.
export const ORACLE_VERSION_MAJOR = 30;
export const ORACLE_VERSION_MINOR = 9;

/// This hash is computed from `ORACLE_REGISTRY` (each oracle's name, ordered parameter names and
/// types, and return type) and is used to detect when the oracle interface changes. When it does, you need to either:
/// - increment `ORACLE_VERSION_MAJOR` and reset `ORACLE_VERSION_MINOR` to zero if the change is breaking, or
/// - increment only `ORACLE_VERSION_MINOR` if the change is additive (a new oracle was added).
///
/// The major version must match `noir-projects/labs/aztec-nr/aztec/src/oracle/version.nr` exactly; the minor version
/// there may lag behind this one (the check requires PXE minor >= contract minor).
export const ORACLE_INTERFACE_HASH = '69ab7a79921aed7b72cf9719f682bc8c6af00b4abd963bcc210aa8c889c5c5a8';
