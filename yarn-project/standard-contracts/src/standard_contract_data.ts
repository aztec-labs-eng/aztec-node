// GENERATED FILE - DO NOT EDIT. RUN `yarn generate` or `yarn generate:data`
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { FunctionSelector } from '@aztec-labs/stdlib/abi';
import { AztecAddress } from '@aztec-labs/stdlib/aztec-address';

export const standardContractNames = [
  'AuthRegistry',
  'MultiCallEntrypoint',
  'PublicChecks',
  'HandshakeRegistry',
] as const;

export type StandardContractName = (typeof standardContractNames)[number];

export const StandardContractSalt: Record<StandardContractName, Fr> = {
  AuthRegistry: new Fr(1),
  MultiCallEntrypoint: new Fr(1),
  PublicChecks: new Fr(1),
  HandshakeRegistry: new Fr(1),
};

export const StandardContractAddress: Record<StandardContractName, AztecAddress> = {
  AuthRegistry: AztecAddress.fromStringUnsafe('0x2e05e8fbfb2ce9a31e4b4ae5097c01b79d9b3529b1e861016c9c9a5d62fdf7c9'),
  MultiCallEntrypoint: AztecAddress.fromStringUnsafe(
    '0x15ef6dafc2ff68c67578fb3d178c02c1504607f8ce57964c99d57cc5c7374a02',
  ),
  PublicChecks: AztecAddress.fromStringUnsafe('0x0468c918e7d7e077f4fa75e275891db9bee8faaeafab83e870eeb39dbfaddbbe'),
  HandshakeRegistry: AztecAddress.fromStringUnsafe(
    '0x1e944d9800cd5f0790e00fd9f0f96458f79a668e24fca035fbc11fef5e70be4e',
  ),
};

export const StandardContractClassId: Record<StandardContractName, Fr> = {
  AuthRegistry: Fr.fromString('0x16642823e2b239fb721c3a031dc77df96b4487a68fed26488f90f5f53904e6ca'),
  MultiCallEntrypoint: Fr.fromString('0x2bb08118caa81e0889c7032516c0456703a53ad3266293a50172b626eb6d532a'),
  PublicChecks: Fr.fromString('0x2d1b988184cea812710fbb2726e1dbead57de3c8d5408bef8df83e7173ce81ef'),
  HandshakeRegistry: Fr.fromString('0x2ade07aa78933cb7a7ffb9eba74a3655b160ede159594141af22612efa98ff16'),
};

export const StandardContractClassIdPreimage: Record<
  StandardContractName,
  { artifactHash: Fr; privateFunctionsRoot: Fr; publicBytecodeCommitment: Fr }
> = {
  AuthRegistry: {
    artifactHash: Fr.fromString('0x067c81251320c4f11ad1ef1012b25008c12687ea074feb8eaa891f9047699480'),
    privateFunctionsRoot: Fr.fromString('0x28b6c90e1c15060b3110a384b1a44abbae0b1a6e3a924e0e902a614c2e3e6340'),
    publicBytecodeCommitment: Fr.fromString('0x27a30af260dec2e28b9bd38cd5d5096b6acdd6724cc481df0a62fa2a3b18b543'),
  },
  MultiCallEntrypoint: {
    artifactHash: Fr.fromString('0x1331d0a194e9fb7cf819cd4535975c5acf38d736d07778630d3762cdab844f10'),
    privateFunctionsRoot: Fr.fromString('0x241bdfca6b4a61f1bb835faea6be98736c3d95a4bc97e624324737baf3f1f150'),
    publicBytecodeCommitment: Fr.fromString('0x0ce4c618c3ed7f3a20410e618c06bb701e150af7fe28a3e92f68e7733809f33e'),
  },
  PublicChecks: {
    artifactHash: Fr.fromString('0x1ef0eb012faf7a86c342bce164ac56d50b254b2e16e29f7e101b8fbaa11ac58d'),
    privateFunctionsRoot: Fr.fromString('0x202860adb1b8975971eeaf571aaaa88a27f4035290d58532ae7d60b0dfaad54c'),
    publicBytecodeCommitment: Fr.fromString('0x24b3208d20769dfffffa03aa7c5a8d0def7cb568c70a36c6cdc41a09a5766dec'),
  },
  HandshakeRegistry: {
    artifactHash: Fr.fromString('0x2636ee5eede85cfb603ddd7847e5421bccae58ceeb7b0ed9af606b2069026171'),
    privateFunctionsRoot: Fr.fromString('0x13f84114d068de845da34722a59365859300e9a510efa20c7bc2d75f18fb9b3d'),
    publicBytecodeCommitment: Fr.fromString('0x0ce4c618c3ed7f3a20410e618c06bb701e150af7fe28a3e92f68e7733809f33e'),
  },
};

export const StandardContractInitializationHash: Record<StandardContractName, Fr> = {
  AuthRegistry: Fr.fromString('0x0000000000000000000000000000000000000000000000000000000000000000'),
  MultiCallEntrypoint: Fr.fromString('0x0000000000000000000000000000000000000000000000000000000000000000'),
  PublicChecks: Fr.fromString('0x0000000000000000000000000000000000000000000000000000000000000000'),
  HandshakeRegistry: Fr.fromString('0x0000000000000000000000000000000000000000000000000000000000000000'),
};

export const StandardContractPrivateFunctions: Record<
  StandardContractName,
  { selector: FunctionSelector; vkHash: Fr }[]
> = {
  AuthRegistry: [
    {
      selector: FunctionSelector.fromField(
        Fr.fromString('0x0000000000000000000000000000000000000000000000000000000079a3d418'),
      ),
      vkHash: Fr.fromString('0x2c5bff760477ed0d201deed7f27c858a91e9213b7a59a6fd0b85958bbfed2a8a'),
    },
  ],
  MultiCallEntrypoint: [
    {
      selector: FunctionSelector.fromField(
        Fr.fromString('0x00000000000000000000000000000000000000000000000000000000f04908a9'),
      ),
      vkHash: Fr.fromString('0x0c04c4044098bea91ee0c96e9be57bdf70c2aa534b103442b1b387a64d50d51f'),
    },
  ],
  PublicChecks: [],
  HandshakeRegistry: [
    {
      selector: FunctionSelector.fromField(
        Fr.fromString('0x0000000000000000000000000000000000000000000000000000000019f8b409'),
      ),
      vkHash: Fr.fromString('0x2d9decd50dbd1f1b210c1a0d3969862cec5d40d9d7f68de07a05b2b899df5e59'),
    },
    {
      selector: FunctionSelector.fromField(
        Fr.fromString('0x00000000000000000000000000000000000000000000000000000000db548fcf'),
      ),
      vkHash: Fr.fromString('0x2ac775c9ef5aaef2c633990edb69a855d4f89913d151ccc6e9f8503ad0f1e94a'),
    },
    {
      selector: FunctionSelector.fromField(
        Fr.fromString('0x00000000000000000000000000000000000000000000000000000000f1ff839b'),
      ),
      vkHash: Fr.fromString('0x2fb8bd951d28d2cf059c13f71ef513cc32d0a1546614f894f875e266983ef30b'),
    },
  ],
};
