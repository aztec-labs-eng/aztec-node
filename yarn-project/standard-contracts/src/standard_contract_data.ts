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
  AuthRegistry: AztecAddress.fromStringUnsafe('0x1ec33912c9f14470513e0eb23db81ddb2aa1ae3395e6ab4d3cba383f68dec3c5'),
  MultiCallEntrypoint: AztecAddress.fromStringUnsafe(
    '0x2b48f1a970a1411924daef8cf51cd86ee7e79615b9240cdc40853bb5a90b83b6',
  ),
  PublicChecks: AztecAddress.fromStringUnsafe('0x0468c918e7d7e077f4fa75e275891db9bee8faaeafab83e870eeb39dbfaddbbe'),
  HandshakeRegistry: AztecAddress.fromStringUnsafe(
    '0x06196e77f13813a124c9049d41540b6d61c010a9dea5270fbd59d1f01225bff7',
  ),
};

export const StandardContractClassId: Record<StandardContractName, Fr> = {
  AuthRegistry: Fr.fromString('0x1eeae0dee2a555972083ba73eff19dc5e85e09723b814d27913efdca795f62f7'),
  MultiCallEntrypoint: Fr.fromString('0x1fe189791d144080d3127ee78ce115ac04bee1bebf16030a9a2ef78f806524f8'),
  PublicChecks: Fr.fromString('0x2d1b988184cea812710fbb2726e1dbead57de3c8d5408bef8df83e7173ce81ef'),
  HandshakeRegistry: Fr.fromString('0x17765d1c52082bca9af7e69fd48b63693764fa4d7266bc16c4e72e82a502a981'),
};

export const StandardContractClassIdPreimage: Record<
  StandardContractName,
  { artifactHash: Fr; privateFunctionsRoot: Fr; publicBytecodeCommitment: Fr }
> = {
  AuthRegistry: {
    artifactHash: Fr.fromString('0x1e83aa07b1de2241e53ee64576e9f38aa9c70583e005852d5434d8288fa400f5'),
    privateFunctionsRoot: Fr.fromString('0x28b6c90e1c15060b3110a384b1a44abbae0b1a6e3a924e0e902a614c2e3e6340'),
    publicBytecodeCommitment: Fr.fromString('0x27a30af260dec2e28b9bd38cd5d5096b6acdd6724cc481df0a62fa2a3b18b543'),
  },
  MultiCallEntrypoint: {
    artifactHash: Fr.fromString('0x1bc895ec5ebf6d2f91c10839036d915a2fd17256dfb3af0d1a06ca71dafeadc7'),
    privateFunctionsRoot: Fr.fromString('0x151b2265c67dec2eef5d34f2cff47a662f2d54e181a3bf174cec6eedd7fe69c5'),
    publicBytecodeCommitment: Fr.fromString('0x0ce4c618c3ed7f3a20410e618c06bb701e150af7fe28a3e92f68e7733809f33e'),
  },
  PublicChecks: {
    artifactHash: Fr.fromString('0x1ef0eb012faf7a86c342bce164ac56d50b254b2e16e29f7e101b8fbaa11ac58d'),
    privateFunctionsRoot: Fr.fromString('0x202860adb1b8975971eeaf571aaaa88a27f4035290d58532ae7d60b0dfaad54c'),
    publicBytecodeCommitment: Fr.fromString('0x24b3208d20769dfffffa03aa7c5a8d0def7cb568c70a36c6cdc41a09a5766dec'),
  },
  HandshakeRegistry: {
    artifactHash: Fr.fromString('0x29add3bc2df7a9b3b76da4bc17ee44753d302f68f5e38cd5d92309015cfc7521'),
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
      vkHash: Fr.fromString('0x01704e5003c702468ecbfbca6d990f41aefc9cf835d66594009c3eeaf20ff66d'),
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
