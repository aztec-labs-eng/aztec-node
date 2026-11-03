use crate::{messages::delivery::OnchainDeliveryMode, protocol::traits::{Deserialize, Serialize}};

/// A messaging secret the app supplies explicitly to `get_pending_tagged_logs`.
///
/// These are searched alongside the secrets PXE derives or stores internally, and exist for secrets PXE cannot
/// enumerate on its own (e.g. handshake-derived ones).
#[derive(Serialize, Deserialize)]
pub(crate) struct ProvidedSecret {
    pub secret: Field,
    pub mode: OnchainDeliveryMode,
}
