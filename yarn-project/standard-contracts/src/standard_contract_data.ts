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
  AuthRegistry: AztecAddress.fromStringUnsafe('0x120bf1fe8c548704113679844f28f54b787aafad438bd90f20654f8ffef65e83'),
  MultiCallEntrypoint: AztecAddress.fromStringUnsafe(
    '0x2d464e835406c6057bf147843d1541e0b338a13f8fedd5cba697629172dd8105',
  ),
  PublicChecks: AztecAddress.fromStringUnsafe('0x2097f8b30eed69e12abbb5107bcae325aa8b02ebf30a111d38f1ba89a15aa6a4'),
  HandshakeRegistry: AztecAddress.fromStringUnsafe(
    '0x20dfae8b5be70f13680b37dd346752517db43ebfc02bd5686fc11b3c5cba32b9',
  ),
};

export const StandardContractClassId: Record<StandardContractName, Fr> = {
  AuthRegistry: Fr.fromString('0x280746c6b1377b8ca1414d898b0c1e63b02fc20f42b89c2e84fed4a615084a71'),
  MultiCallEntrypoint: Fr.fromString('0x1f658f0f5874d1f073e85182e9fe96d3f6fcf5501ee05988eccb63b655213906'),
  PublicChecks: Fr.fromString('0x0bcfd8eb97de32bf835c2202ce8dbbb61db9820c267f4d43200341840590e8b9'),
  HandshakeRegistry: Fr.fromString('0x2169bdbbeb4bebbf99687e0683f6661028a16a1308bdf58ce0df0cb5c4bed15e'),
};

export const StandardContractClassIdPreimage: Record<
  StandardContractName,
  { artifactHash: Fr; privateFunctionsRoot: Fr; publicBytecodeCommitment: Fr }
> = {
  AuthRegistry: {
    artifactHash: Fr.fromString('0x1d5f899f6dad791d8f2591bed29f998f8ea07a6ec06f1781e4a8685f611c64ab'),
    privateFunctionsRoot: Fr.fromString('0x28b6c90e1c15060b3110a384b1a44abbae0b1a6e3a924e0e902a614c2e3e6340'),
    publicBytecodeCommitment: Fr.fromString('0x27a30af260dec2e28b9bd38cd5d5096b6acdd6724cc481df0a62fa2a3b18b543'),
  },
  MultiCallEntrypoint: {
    artifactHash: Fr.fromString('0x2249a3ee1d367666b1904c9bc5acdb30f8d516961f6550a173e05cb1c1952404'),
    privateFunctionsRoot: Fr.fromString('0x241bdfca6b4a61f1bb835faea6be98736c3d95a4bc97e624324737baf3f1f150'),
    publicBytecodeCommitment: Fr.fromString('0x0ce4c618c3ed7f3a20410e618c06bb701e150af7fe28a3e92f68e7733809f33e'),
  },
  PublicChecks: {
    artifactHash: Fr.fromString('0x0a1a6cb156224c1ff564f9f9c4a3d39ae2849b7243b794725d7957a24de5ee22'),
    privateFunctionsRoot: Fr.fromString('0x202860adb1b8975971eeaf571aaaa88a27f4035290d58532ae7d60b0dfaad54c'),
    publicBytecodeCommitment: Fr.fromString('0x24b3208d20769dfffffa03aa7c5a8d0def7cb568c70a36c6cdc41a09a5766dec'),
  },
  HandshakeRegistry: {
    artifactHash: Fr.fromString('0x1024edfc0eecacb9ce01f429067cf65448c7aa8524e127b1f82f30226ec6796e'),
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
