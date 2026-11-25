import { OnchainDeliveryMode } from '@aztec-labs/stdlib/logs';

import { buildMessageDeliveryTest } from './onchain_delivery_harness.js';

// Pins handshake reuse: a handshake bootstrapped under one delivery mode must be reused when the other mode sends next,
// and by the later sends of the tx that bootstraps it.
describe('handshake_reuse', () => {
  const forwardHookCalls: OnchainDeliveryMode[] = [];
  buildMessageDeliveryTest({
    strategy: 'non-interactive handshake',
    mode: { events: 'constrained', notes: 'unconstrained' },
    senderHook: ({ deliveryMode }) => {
      forwardHookCalls.push(deliveryMode);
      return Promise.resolve({ type: 'non-interactive-handshake' });
    },
    additionalTests: () => {
      it('the strategy hook fires exactly once, to bootstrap the handshake on the first constrained send', () => {
        expect(forwardHookCalls).toHaveLength(1);
        expect(forwardHookCalls[0]).toBe(OnchainDeliveryMode.CONSTRAINED);
      });
    },
  });

  // Reverse direction also pins the constrained sequence to a fresh index 0 after an unconstrained bootstrap; a leaked
  // unconstrained counter would make the first constrained send require a predecessor nullifier that does not exist.
  const reverseHookCalls: OnchainDeliveryMode[] = [];
  buildMessageDeliveryTest({
    strategy: 'non-interactive handshake',
    mode: { events: 'unconstrained', notes: 'constrained' },
    senderHook: ({ deliveryMode }) => {
      reverseHookCalls.push(deliveryMode);
      return Promise.resolve({ type: 'non-interactive-handshake' });
    },
    additionalTests: () => {
      it('the strategy hook fires exactly once, to bootstrap the handshake on the first unconstrained send', () => {
        expect(reverseHookCalls).toHaveLength(1);
        expect(reverseHookCalls[0]).toBe(OnchainDeliveryMode.UNCONSTRAINED);
      });
    },
  });

  // Within one tx, the sends after the first reuse the handshake it bootstraps while that handshake is still pending. The
  // first constrained send proves the pending handshake against the registry, and the next constrained send proves its
  // pending predecessor's sequence nullifier.
  const sameTxReverseHookCalls: OnchainDeliveryMode[] = [];
  buildMessageDeliveryTest({
    strategy: 'non-interactive handshake',
    mode: { events: 'unconstrained', notes: 'constrained' },
    txs: 'one for all sends',
    senderHook: ({ deliveryMode }) => {
      sameTxReverseHookCalls.push(deliveryMode);
      return Promise.resolve({ type: 'non-interactive-handshake' });
    },
    additionalTests: () => {
      it('the strategy hook fires exactly once, to bootstrap the handshake on the first unconstrained send', () => {
        expect(sameTxReverseHookCalls).toHaveLength(1);
        expect(sameTxReverseHookCalls[0]).toBe(OnchainDeliveryMode.UNCONSTRAINED);
      });
    },
  });
});
