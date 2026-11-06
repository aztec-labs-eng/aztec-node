import type { AuthorizeUtilityCall } from './authorize_utility_call.js';
import type { ResolveCustomRequest } from './resolve_custom_request.js';
import type { ResolveExpirationAndPadding } from './resolve_expiration_and_padding.js';
import type { ResolveMessagingSecretStrategy } from './resolve_messaging_secret_strategy.js';
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- only referenced by a {@link} doc tag
import type { defaultMessagingSecretStrategy } from './resolve_messaging_secret_strategy.js';

/**
 * Hooks that PXE invokes while simulating and proving transactions to gate or steer operations that the protocol
 * does not restrict on its own. They give the wallet a chance to apply custom policies (e.g.
 * prompting the user, consulting a dynamic allowlist, or inspecting call arguments) before the
 * execution proceeds. All hooks are optional, and when a hook is absent PXE applies a safe default.
 *
 * For example, {@link authorizeUtilityCall} is called whenever a utility function makes a cross-contract call. A call
 * made by a malicious contract could leak private information, so the hook lets the wallet decide, per-call, whether
 * to allow it. A static allowlist would not work here because neither the app nor the wallet can predict ahead of
 * time which contracts will be invoked during execution. Calls to the handshake registry's read functions bypass this
 * hook and are always authorized. When the hook is absent, cross-contract utility calls are denied.
 *
 * Note: hooks are unrelated to authentication witnesses (authwits). Authwits are an on-chain
 * mechanism where a contract verifies that a caller was authorized by a specific account; hooks
 * are a client-side PXE concern that gates execution before it proceeds.
 *
 * @example
 * ```ts
 * const pxe = await PXE.create({
 *   // ...
 *   hooks: {
 *     authorizeUtilityCall: async (req) => {
 *       // Allow calls to a known helper contract, deny everything else.
 *       return req.target.equals(trustedHelper)
 *         ? { authorized: true }
 *         : { authorized: false, reason: 'Unknown target' };
 *     },
 *     // Use address-derived secrets for unconstrained messages to known contacts, who have registered this account as
 *     // a sender, and PXE's default for everything else.
 *     resolveMessagingSecretStrategy: async request =>
 *       request.deliveryMode === OnchainDeliveryMode.UNCONSTRAINED && knownContacts.has(request.recipient.toString())
 *         ? { type: 'address-derived' }
 *         : defaultMessagingSecretStrategy(request),
 *   },
 * });
 * ```
 */
export interface ExecutionHooks {
  /** Called when a contract attempts a cross-contract utility call. Calls are denied when absent. */
  authorizeUtilityCall?: AuthorizeUtilityCall;
  /**
   * Chooses the messaging secret strategy for outgoing messages, letting the wallet apply per-recipient policy; see
   * {@link ResolveMessagingSecretStrategy} for when PXE calls it. PXE applies {@link defaultMessagingSecretStrategy}
   * when absent.
   */
  resolveMessagingSecretStrategy?: ResolveMessagingSecretStrategy;
  /**
   * Resolves a custom, caller-defined request a circuit cannot serve from local state. Any contract can issue one, so
   * an implementor should verify both the request `kind` and the issuing contract (its address and class ID) before
   * fulfilling it. Rejected when absent; see {@link ResolveCustomRequest}.
   */
  resolveCustomRequest?: ResolveCustomRequest;
  /**
   * Chooses the tx's expiration timestamp and adds padding to private side-effects, changing its public effects and
   * therefore its privacy set. PXE applies a default when absent.
   * See {@link ResolveExpirationAndPadding} for details and defaults.
   */
  resolveExpirationAndPadding?: ResolveExpirationAndPadding;
}

/**
 * Builds an {@link ExecutionHooks} from individually-constructed hook callbacks. Returns `undefined`
 * when every field is absent, so callers can unconditionally pass the result as `hooks`.
 */
export function composeHooks(hooks: ExecutionHooks): ExecutionHooks | undefined {
  if (Object.values(hooks).every(v => v === undefined)) {
    return undefined;
  }
  return hooks;
}
