import { Fr } from '@aztec-labs/foundation/curves/bn254';
import type { NoirCompiledCircuit } from '@aztec-labs/stdlib/noir';
import { VerificationKeyAsFields, VerificationKeyData } from '@aztec-labs/stdlib/vks';

export function abiToVKData(json: NoirCompiledCircuit): VerificationKeyData {
  const { verificationKey } = json;
  return new VerificationKeyData(
    new VerificationKeyAsFields(
      verificationKey.fields.map((str: string) => Fr.fromHexString(str)),
      Fr.fromHexString(verificationKey.hash),
    ),
    Buffer.from(verificationKey.bytes, 'hex'),
  );
}
