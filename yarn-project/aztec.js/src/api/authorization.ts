export { AuthWitness } from '@aztec-labs/stdlib/auth-witness';
export {
  SetPublicAuthwitContractInteraction,
  type ContractFunctionInteractionCallIntent,
  isContractFunctionInteractionCallIntent,
  getMessageHashFromIntent,
  computeAuthWitMessageHash,
  computeInnerAuthWitHashFromAction,
  lookupValidity,
  type CallIntent,
  type IntentInnerHash,
} from '../utils/authwit.js';
export { computeInnerAuthWitHash } from '@aztec-labs/stdlib/auth-witness';

export { CallAuthorizationRequest } from '../authorization/call_authorization_request.js';
