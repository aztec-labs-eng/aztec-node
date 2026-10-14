import { deriveBlsPrivateKey } from '@aztec-labs/foundation/crypto/bls';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import {
  type Hex,
  concat,
  decodeAbiParameters,
  encodeFunctionData,
  getContractAddress,
  numberToHex,
  pad,
  parseAbi,
} from 'viem';
import { foundry } from 'viem/chains';

import { getPublicClient } from '../client.js';
import { DefaultL1ContractsConfig } from '../config.js';
import { GSEContract } from '../contracts/gse.js';
import { deployAztecL1Contracts } from '../deploy_aztec_l1_contracts.js';
import { type Anvil, startAnvil } from '../test/start_anvil.js';
import type { ViemClient } from '../types.js';
import gasVectors from './fixtures/bn254_pop_gas_vectors.json' with { type: 'json' };
import { computeBn254RegistrationDigest } from './hash_to_point.js';
import { AMSTERDAM_PROOF_OF_POSSESSION_GAS_MODEL, estimateProofOfPossessionGas } from './proof_of_possession_gas.js';

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const WRAPPER_ABI = parseAbi([
  'function proofOfPossession((uint256 x, uint256 y) pk1, (uint256 x0, uint256 x1, uint256 y0, uint256 y1) pk2, (uint256 x, uint256 y) pop) view returns (bool)',
  'function g1ToDigestPoint((uint256 x, uint256 y) pk1) view returns ((uint256 x, uint256 y))',
]);

/**
 * Runtime code of a forwarder that calls `target` with exactly `gas`, the way GSE calls the wrapper with
 * `{gas: proofOfPossessionGasLimit}`. Calldata: `gas (32 bytes) || target (32 bytes) || payload`. Returns
 * `(first word of the callee's return data, call success)`.
 */
const FORWARDER_CODE: Hex = `0x${[
  '36', // CALLDATASIZE
  '6040', // PUSH1 0x40
  '90', // SWAP1
  '03', // SUB                    payload size = calldatasize - 64
  '80', // DUP1
  '6040', // PUSH1 0x40           calldata offset of the payload
  '6000', // PUSH1 0x00           memory offset
  '37', // CALLDATACOPY
  '6020', // PUSH1 0x20           retSize
  '6000', // PUSH1 0x00           retOffset
  '82', // DUP3                   argsSize
  '6000', // PUSH1 0x00           argsOffset
  '6000', // PUSH1 0x00           value
  '602035', // CALLDATALOAD(0x20) target
  '600035', // CALLDATALOAD(0x00) gas
  'f1', // CALL
  '602052', // MSTORE(0x20, success)
  '60406000f3', // RETURN(0x00, 0x40)
].join('')}`;
const FORWARDER_ADDRESS: Hex = '0x00000000000000000000000000000000000f0f0f';

type RegistrationTuple = {
  pk1: { x: bigint; y: bigint };
  pk2: { x0: bigint; x1: bigint; y0: bigint; y1: bigint };
  pop: { x: bigint; y: bigint };
};

/**
 * Checks the amsterdam gas model against the deployed verifier on anvil: for each key, the smallest forwarded gas for
 * which the wrapper's `proofOfPossession` returns true must be at most the local estimate. Runs on osaka, which prices
 * this path exactly like amsterdam (see the calibration vectors).
 */
describe('BN254 proof-of-possession gas model against the L1 verifier', () => {
  let anvil: Anvil;
  let client: ViemClient;
  let gse: GSEContract;
  let wrapper: Hex;

  beforeAll(async () => {
    let rpcUrl: string;
    ({ anvil, rpcUrl } = await startAnvil({ port: 0, hardfork: 'osaka' }));
    client = getPublicClient({ l1RpcUrls: [rpcUrl], l1ChainId: foundry.id });
    const nodeInfo = await client.request<{
      Method: 'anvil_nodeInfo';
      Parameters: [];
      ReturnType: { hardFork: string };
    }>({ method: 'anvil_nodeInfo', params: [] });
    expect(nodeInfo.hardFork.toLowerCase()).toBe('osaka');
    const { l1ContractAddresses } = await deployAztecL1Contracts(
      rpcUrl,
      '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
      foundry.id,
      {
        ...DefaultL1ContractsConfig,
        vkTreeRoot: Fr.random(),
        protocolContractsHash: Fr.random(),
        genesisArchiveRoot: Fr.random(),
        realVerifier: false,
      },
    );
    gse = new GSEContract(client, l1ContractAddresses.gseAddress!);
    // GSE creates the wrapper in a field initializer, so the wrapper is GSE's first CREATE (nonce 1).
    wrapper = getContractAddress({ from: gse.address.toString(), nonce: 1n });
    expect(await client.getCode({ address: wrapper })).toBeTruthy();
  });

  afterAll(async () => {
    await anvil?.stop().catch(() => {});
  });

  async function accepts(payload: Hex, gas: number) {
    const { data } = await client.call({
      to: FORWARDER_ADDRESS,
      data: concat([numberToHex(gas, { size: 32 }), pad(wrapper, { size: 32 }), payload]),
      gas: 10_000_000n,
      stateOverride: [{ address: FORWARDER_ADDRESS, code: FORWARDER_CODE }],
    });
    const [result, success] = decodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], data!);
    return success === 1n && result === 1n;
  }

  /** Smallest forwarded gas for which the proof of possession is accepted. */
  async function measureMinStipend(tuple: RegistrationTuple) {
    const payload = encodeFunctionData({
      abi: WRAPPER_ABI,
      functionName: 'proofOfPossession',
      args: [tuple.pk1, tuple.pk2, tuple.pop],
    });
    let low = 100_000;
    let high = 500_000;
    expect(await accepts(payload, low)).toBe(false);
    expect(await accepts(payload, high)).toBe(true);
    while (high - low > 1) {
      const mid = Math.floor((low + high) / 2);
      if (await accepts(payload, mid)) {
        high = mid;
      } else {
        low = mid;
      }
    }
    return high;
  }

  // Calibration vectors, whose min stipend Forge measured on the same verifier code.
  const vectorKeys = gasVectors.vectors.map(v => ({
    label: v.label,
    sk: BigInt(v.sk),
    forgeMinStipend: v.gas.osaka.minStipend as number | undefined,
  }));

  // Freshly derived keys, including a mnemonic key with 98 attempts and 19 square roots.
  const derivedKeys = [
    'm/12381/3600/0/0/0',
    'm/12381/3600/0/0/712',
    'm/12381/3600/0/0/1769',
    'm/12381/3600/0/0/384795',
  ].map(path => ({
    label: `mnemonic ${path}`,
    sk: BigInt(deriveBlsPrivateKey(TEST_MNEMONIC, undefined, path)),
    forgeMinStipend: undefined,
  }));

  async function registrationTupleOf(sk: bigint): Promise<RegistrationTuple> {
    const { publicKeyInG1, publicKeyInG2, proofOfPossession } = await gse.makeRegistrationTuple(sk);
    return { pk1: publicKeyInG1, pk2: publicKeyInG2, pop: proofOfPossession };
  }

  it.each([...derivedKeys, ...vectorKeys].map(k => [k.label, k] as const))(
    'bounds the gas the verifier needs for %s',
    async (_label, { sk, forgeMinStipend }) => {
      const tuple = await registrationTupleOf(sk);
      const digest = computeBn254RegistrationDigest(tuple.pk1);
      const onChainDigest = await client.readContract({
        address: wrapper,
        abi: WRAPPER_ABI,
        functionName: 'g1ToDigestPoint',
        args: [tuple.pk1],
      });
      expect(digest.point).toEqual(onChainDigest);

      const measured = await measureMinStipend(tuple);
      if (forgeMinStipend !== undefined) {
        expect(measured).toBe(forgeMinStipend);
      }
      const estimated = estimateProofOfPossessionGas(
        AMSTERDAM_PROOF_OF_POSSESSION_GAS_MODEL,
        digest.attempts,
        digest.sqrtCalls,
      );
      expect(estimated).toBeGreaterThanOrEqual(measured);
      expect(estimated - measured).toBeLessThanOrEqual(200);
    },
  );
});
