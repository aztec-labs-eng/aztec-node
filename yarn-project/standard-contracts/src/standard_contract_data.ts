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
  AuthRegistry: AztecAddress.fromStringUnsafe('0x0ebd5e08eaf291d2ecb3d2841f2929f86c72b5a1f8c66342c9d87b9678b2f3cb'),
  MultiCallEntrypoint: AztecAddress.fromStringUnsafe(
    '0x0f4a429483c26c1ea6e596fbfc73abade911a36ddbb503603a4cdae153a83db1',
  ),
  PublicChecks: AztecAddress.fromStringUnsafe('0x1d211cdd3a67cc5a619e60934297bceef128def789068542a66850796c27d52f'),
  HandshakeRegistry: AztecAddress.fromStringUnsafe(
    '0x25250671728e8151edde5ec6255e8c29ffa2a2503382a6aefc73db25377d9de0',
  ),
};

export const StandardContractClassId: Record<StandardContractName, Fr> = {
  AuthRegistry: Fr.fromString('0x0e99fa0f1254c8c36c29ea85cc8d8422552b6e9c661ca5db10a0a07c025557e2'),
  MultiCallEntrypoint: Fr.fromString('0x269d9301153ab9fce8f1d53fdbcd6aff5a93fcec14fb46ccd31e0d4a436c4710'),
  PublicChecks: Fr.fromString('0x20afe088f942a9f68de8909bbfd959de5bb05ff3f2fb5f83e16d8d406932d800'),
  HandshakeRegistry: Fr.fromString('0x0dc8bb5ba0da4d057dc5eac929a83c282ee0af9caf00f4d34d2be289ce715fcc'),
};

export const StandardContractClassIdPreimage: Record<
  StandardContractName,
  { artifactHash: Fr; privateFunctionsRoot: Fr; publicBytecodeCommitment: Fr }
> = {
  AuthRegistry: {
    artifactHash: Fr.fromString('0x2052506e6c46157ca50acbf4cdecd4e163c664011f3188424d90ba2b21ece464'),
    privateFunctionsRoot: Fr.fromString('0x28b6c90e1c15060b3110a384b1a44abbae0b1a6e3a924e0e902a614c2e3e6340'),
    publicBytecodeCommitment: Fr.fromString('0x27a30af260dec2e28b9bd38cd5d5096b6acdd6724cc481df0a62fa2a3b18b543'),
  },
  MultiCallEntrypoint: {
    artifactHash: Fr.fromString('0x1943a9b596e429f1134be5a25fbbeedd9bbe0ccce6f3659528acd5c711db67e0'),
    privateFunctionsRoot: Fr.fromString('0x241bdfca6b4a61f1bb835faea6be98736c3d95a4bc97e624324737baf3f1f150'),
    publicBytecodeCommitment: Fr.fromString('0x0ce4c618c3ed7f3a20410e618c06bb701e150af7fe28a3e92f68e7733809f33e'),
  },
  PublicChecks: {
    artifactHash: Fr.fromString('0x174e5dada564b2c909ce8e539bb1a73f5ef6573570c8175139d6a8df0934d532'),
    privateFunctionsRoot: Fr.fromString('0x202860adb1b8975971eeaf571aaaa88a27f4035290d58532ae7d60b0dfaad54c'),
    publicBytecodeCommitment: Fr.fromString('0x24b3208d20769dfffffa03aa7c5a8d0def7cb568c70a36c6cdc41a09a5766dec'),
  },
  HandshakeRegistry: {
    artifactHash: Fr.fromString('0x285eb6bcdad28e701c801ca916e275765a4158206a23df7d2a0c5754e0b9285f'),
    privateFunctionsRoot: Fr.fromString('0x1e5ca84c41bf7319aacef8ce9a3120cf06fef0d0f40ac567027cab83e68b3c37'),
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
      vkHash: Fr.fromString('0x1414ee8b91a8ed07b0301479d9c09c3ce5d84e2a5e5828c4b95474878faa97c9'),
    },
    {
      selector: FunctionSelector.fromField(
        Fr.fromString('0x00000000000000000000000000000000000000000000000000000000db548fcf'),
      ),
      vkHash: Fr.fromString('0x2d8fb2d03e9dee76060849344418493cb7dfd3db3c5bff9b3e5936a87e78514c'),
    },
    {
      selector: FunctionSelector.fromField(
        Fr.fromString('0x00000000000000000000000000000000000000000000000000000000f1ff839b'),
      ),
      vkHash: Fr.fromString('0x0412fa75dbe2068ce89cea1d36d192508e9435ed45c642d3cbc4ffa9dc16c611'),
    },
  ],
};
