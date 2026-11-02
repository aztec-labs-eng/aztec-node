/** The tagging mode an onchain message is delivered under. */
export const OnchainDeliveryMode = {
  UNCONSTRAINED: 'unconstrained',
  CONSTRAINED: 'constrained',
} as const;

export type OnchainDeliveryMode = (typeof OnchainDeliveryMode)[keyof typeof OnchainDeliveryMode];

// Keep in sync with aztec::messages::delivery::OnchainDeliveryMode.
const ONCHAIN_UNCONSTRAINED_DELIVERY_MODE = 2;
const ONCHAIN_CONSTRAINED_DELIVERY_MODE = 3;

export function onchainDeliveryModeFromNumber(deliveryMode: number): OnchainDeliveryMode {
  switch (deliveryMode) {
    case ONCHAIN_UNCONSTRAINED_DELIVERY_MODE:
      return OnchainDeliveryMode.UNCONSTRAINED;
    case ONCHAIN_CONSTRAINED_DELIVERY_MODE:
      return OnchainDeliveryMode.CONSTRAINED;
    default:
      throw new Error(`Unrecognized delivery mode for tagging: ${deliveryMode}`);
  }
}
