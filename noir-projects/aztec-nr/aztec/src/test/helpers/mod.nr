use crate::macros::oracle_testing::generate_oracle_tests_excluding;

pub mod test_environment;
#[generate_oracle_tests_excluding(
    @[
        quote { deploy_oracle }, // TODO: implement once we support more complex types
        quote { set_messaging_secret_strategies }, // TODO: implement once we support more complex types
    ],
)]
pub mod txe_oracles;
pub mod authwit;
pub mod messaging_secret_strategy;
/// Deprecated: use [`messaging_secret_strategy`].
pub mod tagging_secret_strategy {
    pub use super::messaging_secret_strategy::compute_directional_app_secret;

    /// Deprecated: use [`MessagingSecretStrategy`](super::messaging_secret_strategy::MessagingSecretStrategy).
    pub type TaggingSecretStrategy = super::messaging_secret_strategy::MessagingSecretStrategy;
}
pub mod utils;
