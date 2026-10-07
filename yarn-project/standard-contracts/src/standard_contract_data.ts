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
  AuthRegistry: AztecAddress.fromStringUnsafe('0x2ba8714679fbee823f108f366f878ce3249861637de705b0ac7cfbd0f81b3a9c'),
  MultiCallEntrypoint: AztecAddress.fromStringUnsafe(
    '0x265552a432ba2f9420ce5283bec14d7385e7a4accaff6c82648efe312d42fcc2',
  ),
  PublicChecks: AztecAddress.fromStringUnsafe('0x2cfebe9733e41d10357b4362dc434a24a7c53f12e952f5727a38c6da7ec6d21a'),
  HandshakeRegistry: AztecAddress.fromStringUnsafe(
    '0x198aa5f21f7a13761f4729c544fb6edcae73a484d57b248b6390eb0dc5c06040',
  ),
};

export const StandardContractClassId: Record<StandardContractName, Fr> = {
  AuthRegistry: Fr.fromString('0x2929c576147bd0873d6ce14ffcd118615edecef58fc1bf3e28a582acf8580b7e'),
  MultiCallEntrypoint: Fr.fromString('0x1d0e399af1bea651df969ede47fb57013b9a68e3341c3e445ea42ecf5a7f4913'),
  PublicChecks: Fr.fromString('0x2d1b988184cea812710fbb2726e1dbead57de3c8d5408bef8df83e7173ce81ef'),
  HandshakeRegistry: Fr.fromString('0x2267cbde16fa4e3f8401068b2507f01fdaaeaec0a46bc0b92ee57b22687518c9'),
};

export const StandardContractClassIdPreimage: Record<
  StandardContractName,
  { artifactHash: Fr; privateFunctionsRoot: Fr; publicBytecodeCommitment: Fr }
> = {
  AuthRegistry: {
    artifactHash: Fr.fromString('0x22a141e78bb71c7f12d2249b0e6823c7740443a6f4bb27291a6ed1580e7aadcc'),
    privateFunctionsRoot: Fr.fromString('0x28b6c90e1c15060b3110a384b1a44abbae0b1a6e3a924e0e902a614c2e3e6340'),
    publicBytecodeCommitment: Fr.fromString('0x27a30af260dec2e28b9bd38cd5d5096b6acdd6724cc481df0a62fa2a3b18b543'),
  },
  MultiCallEntrypoint: {
    artifactHash: Fr.fromString('0x18a8ab6d95d31c079016109808e45209bdecd45194db20f3364849def81937e0'),
    privateFunctionsRoot: Fr.fromString('0x241bdfca6b4a61f1bb835faea6be98736c3d95a4bc97e624324737baf3f1f150'),
    publicBytecodeCommitment: Fr.fromString('0x0ce4c618c3ed7f3a20410e618c06bb701e150af7fe28a3e92f68e7733809f33e'),
  },
  PublicChecks: {
    artifactHash: Fr.fromString('0x1ef0eb012faf7a86c342bce164ac56d50b254b2e16e29f7e101b8fbaa11ac58d'),
    privateFunctionsRoot: Fr.fromString('0x202860adb1b8975971eeaf571aaaa88a27f4035290d58532ae7d60b0dfaad54c'),
    publicBytecodeCommitment: Fr.fromString('0x24b3208d20769dfffffa03aa7c5a8d0def7cb568c70a36c6cdc41a09a5766dec'),
  },
  HandshakeRegistry: {
    artifactHash: Fr.fromString('0x16668047090be654dd099d25a55b4eb6a4c99ea6df627971d25eb89730045e26'),
    privateFunctionsRoot: Fr.fromString('0x0b411cc64d47cc476c8526b3e31a10a6e83cb506d4a5150aeb538cb2d9cb9aa9'),
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
      vkHash: Fr.fromString('0x2cf2d4aaa0274fd15bfa3e811760dd7ca85c12e1ab2074d6af59ddfd02bfc8a9'),
    },
    {
      selector: FunctionSelector.fromField(
        Fr.fromString('0x00000000000000000000000000000000000000000000000000000000db548fcf'),
      ),
      vkHash: Fr.fromString('0x24f22b54b6581bd92ece9073908b6fd0b33e799af095a24692ff4a1a0c3df3a3'),
    },
    {
      selector: FunctionSelector.fromField(
        Fr.fromString('0x00000000000000000000000000000000000000000000000000000000f1ff839b'),
      ),
      vkHash: Fr.fromString('0x178a8d87cb1d7a7319f8237377a82a8abbe568e139cf66dc7216976623ceb158'),
    },
  ],
};
