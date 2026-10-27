import { type AvmStat, type BackendOptions, BackendType, Barretenberg } from '@aztec-foundation/bb.js';

import type { LogFn, Logger } from '@aztec-labs/foundation/log';
import { FifoMemoryQueue } from '@aztec-labs/foundation/queue';
import { Timer } from '@aztec-labs/foundation/timer';
import { ProvingError } from '@aztec-labs/stdlib/errors';

import type { UltraHonkFlavor } from '../honk.js';

/**
 * Maps UltraHonkFlavor to the bb.js ProofSystemSettings.
 * All server-side proofs use disableZk: true.
 */
function getProofSettings(flavor: UltraHonkFlavor) {
  const base = { disableZk: true, optimizedSolidityVerifier: false };
  switch (flavor) {
    case 'ultra_honk':
      return { ...base, oracleHashType: 'poseidon2' as const, ipaAccumulation: false };
    case 'ultra_keccak_honk':
      return { ...base, oracleHashType: 'keccak' as const, ipaAccumulation: false };
    case 'ultra_starknet_honk':
      return { ...base, oracleHashType: 'starknet' as const, ipaAccumulation: false };
    case 'ultra_rollup_honk':
      return { ...base, oracleHashType: 'poseidon2' as const, ipaAccumulation: true };
  }
}

/** Result of a successful proof generation via bb.js. */
export type BBJsProofResult = {
  /** Proof fields as 32-byte Uint8Arrays. */
  proofFields: Uint8Array[];
  /** Public input fields as 32-byte Uint8Arrays. */
  publicInputFields: Uint8Array[];
  /** Duration of the proving operation in ms. */
  durationMs: number;
};

/** Public API surface of a bb.js instance, used by the factory and debug wrapper. */
export interface BBJsApi {
  generateProof(
    circuitName: string,
    bytecode: Uint8Array,
    verificationKey: Uint8Array,
    witness: Uint8Array,
    flavor: UltraHonkFlavor,
  ): Promise<BBJsProofResult>;
  verifyProof(
    proofFields: Uint8Array[],
    verificationKey: Uint8Array,
    publicInputFields: Uint8Array[],
    flavor: UltraHonkFlavor,
  ): Promise<{ verified: boolean; durationMs: number }>;
  verifyChonkProof(
    fieldsWithPublicInputs: Uint8Array[],
    verificationKey: Uint8Array,
  ): Promise<{ verified: boolean; durationMs: number }>;
  computeGateCount(
    circuitName: string,
    bytecode: Uint8Array,
    flavor: UltraHonkFlavor | 'mega_honk',
  ): Promise<{ circuitSize: number; durationMs: number }>;
  generateContract(verificationKey: Uint8Array): Promise<{ solidityCode: string; durationMs: number }>;
  /** Generate an AVM proof from serialized inputs. Callers should call verifyAvmProof separately. */
  generateAvmProof(inputs: Uint8Array): Promise<{ proof: Uint8Array[]; stats: AvmStat[]; durationMs: number }>;
  /** Verify an AVM proof against serialized public inputs. */
  verifyAvmProof(proof: Uint8Array[], publicInputs: Uint8Array): Promise<{ verified: boolean; durationMs: number }>;
  /** Check the AVM circuit from serialized inputs. Returns pass/fail and per-stage timings. */
  checkAvmCircuit(inputs: Uint8Array): Promise<{ passed: boolean; stats: AvmStat[]; durationMs: number }>;
  destroy(): Promise<void>;
}

/**
 * Thin wrapper around a single Barretenberg instance.
 * Each instance spawns its own bb process via the NativeUnixSocket backend.
 */
export class BBJsInstance implements BBJsApi {
  private constructor(private api: Barretenberg) {}

  /**
   * Creates a new Barretenberg instance connected to a fresh bb process.
   *
   * `respawn` lets the instance replace its bb process when it dies, so a long-lived instance stays
   * usable instead of failing every later call. Only safe where the instance holds no state between
   * calls, since a replacement has no Chonk accumulation and no batch-verifier session.
   */
  static async create(bbPath: string, logger?: LogFn, threads?: number, respawn?: boolean): Promise<BBJsInstance> {
    const options: BackendOptions = {
      bbPath,
      backend: BackendType.NativeUnixSocket,
      logger,
      respawn,
    };
    if (threads !== undefined) {
      options.threads = threads;
    }
    try {
      return new BBJsInstance(await Barretenberg.new(options));
    } catch (err) {
      // bb startup failures are environmental (machine load, a wedged or dead bb process), never a
      // property of the proof inputs, so the job is always safe to retry.
      throw new ProvingError(`Failed to start bb process: ${err}`, err, /*retry*/ true);
    }
  }

  /**
   * Generate an UltraHonk proof for a circuit.
   * @param circuitName - Identifier for the circuit (used by bb internally).
   * @param bytecode - Uncompressed ACIR bytecode.
   * @param verificationKey - The circuit's verification key bytes.
   * @param witness - Uncompressed witness bytes.
   * @param flavor - The UltraHonk flavor to use.
   */
  async generateProof(
    circuitName: string,
    bytecode: Uint8Array,
    verificationKey: Uint8Array,
    witness: Uint8Array,
    flavor: UltraHonkFlavor,
  ): Promise<BBJsProofResult> {
    const timer = new Timer();
    const result = await this.api.circuitProve({
      circuit: {
        name: circuitName,
        bytecode,
        verificationKey,
      },
      witness,
      settings: getProofSettings(flavor),
    });
    return {
      proofFields: result.proof,
      publicInputFields: result.publicInputs,
      durationMs: timer.ms(),
    };
  }

  /**
   * Verify an UltraHonk proof.
   * @param proofFields - Proof fields as 32-byte Uint8Arrays.
   * @param verificationKey - The VK bytes.
   * @param publicInputFields - Public input fields as 32-byte Uint8Arrays.
   * @param flavor - The UltraHonk flavor.
   * @returns Whether the proof is valid.
   */
  async verifyProof(
    proofFields: Uint8Array[],
    verificationKey: Uint8Array,
    publicInputFields: Uint8Array[],
    flavor: UltraHonkFlavor,
  ): Promise<{ verified: boolean; durationMs: number }> {
    const timer = new Timer();
    const result = await this.api.circuitVerify({
      verificationKey,
      publicInputs: publicInputFields,
      proof: proofFields,
      settings: getProofSettings(flavor),
    });
    return { verified: result.verified, durationMs: timer.ms() };
  }

  /**
   * Compute circuit gate count / circuit size.
   * @param circuitName - Identifier for the circuit.
   * @param bytecode - Uncompressed ACIR bytecode.
   * @param flavor - 'mega_honk' for chonk circuits, or an UltraHonk flavor.
   * @returns The dyadic circuit size (next power of 2 of gate count).
   */
  async computeGateCount(
    circuitName: string,
    bytecode: Uint8Array,
    flavor: UltraHonkFlavor | 'mega_honk',
  ): Promise<{ circuitSize: number; durationMs: number }> {
    const timer = new Timer();
    if (flavor === 'mega_honk') {
      const result = await this.api.chonkStats({
        circuit: { name: circuitName, bytecode },
        includeGatesPerOpcode: false,
      });
      return { circuitSize: result.circuitSize, durationMs: timer.ms() };
    }
    const result = await this.api.circuitStats({
      circuit: { name: circuitName, bytecode, verificationKey: new Uint8Array(0) },
      includeGatesPerOpcode: false,
      settings: getProofSettings(flavor),
    });
    return { circuitSize: result.numGatesDyadic, durationMs: timer.ms() };
  }

  /**
   * Generate a Solidity verifier contract from a verification key.
   * @param verificationKey - The VK bytes.
   * @returns The Solidity source code.
   */
  async generateContract(verificationKey: Uint8Array): Promise<{ solidityCode: string; durationMs: number }> {
    const timer = new Timer();
    const result = await this.api.circuitWriteSolidityVerifier({
      verificationKey,
      settings: {
        ipaAccumulation: false,
        oracleHashType: 'poseidon2',
        disableZk: true,
        optimizedSolidityVerifier: false,
      },
    });
    return { solidityCode: result.solidityCode, durationMs: timer.ms() };
  }

  /**
   * Verify a Chonk (IVC) proof passed as flat field elements (with public inputs prepended).
   * The split into structured sub-proofs happens server-side in `ChonkProof::from_field_elements`,
   * so this layer doesn't need to know per-component sub-proof sizes.
   * @param fieldsWithPublicInputs - Flat proof fields as 32-byte Uint8Arrays (public inputs prepended).
   * @param verificationKey - The VK bytes.
   */
  async verifyChonkProof(
    fieldsWithPublicInputs: Uint8Array[],
    verificationKey: Uint8Array,
  ): Promise<{ verified: boolean; durationMs: number }> {
    const timer = new Timer();
    const result = await this.api.chonkVerifyFromFields({ proof: fieldsWithPublicInputs, vk: verificationKey });
    return { verified: result.valid, durationMs: timer.ms() };
  }

  /** Generate an AVM proof from serialized inputs. */
  async generateAvmProof(inputs: Uint8Array): Promise<{ proof: Uint8Array[]; stats: AvmStat[]; durationMs: number }> {
    const timer = new Timer();
    const result = await this.api.avmProve({ inputs });
    return { proof: result.proof, stats: result.stats, durationMs: timer.ms() };
  }

  /** Verify an AVM proof against serialized public inputs. */
  async verifyAvmProof(
    proof: Uint8Array[],
    publicInputs: Uint8Array,
  ): Promise<{ verified: boolean; durationMs: number }> {
    const timer = new Timer();
    const result = await this.api.avmVerify({ proof, publicInputs });
    return { verified: result.verified, durationMs: timer.ms() };
  }

  /** Check the AVM circuit from serialized inputs. */
  async checkAvmCircuit(inputs: Uint8Array): Promise<{ passed: boolean; stats: AvmStat[]; durationMs: number }> {
    const timer = new Timer();
    const result = await this.api.avmCheckCircuit({ inputs });
    return { passed: result.passed, stats: result.stats, durationMs: timer.ms() };
  }

  /** Destroy this instance and kill the underlying bb process. */
  async destroy(): Promise<void> {
    await this.api.destroy();
  }
}

/** Options for {@link BBJsFactory}. */
export interface BBJsFactoryOptions {
  /**
   * Number of long-lived bb processes to keep in the pool.
   * If omitted, every `getInstance()` call spawns a fresh bb that is destroyed on dispose.
   */
  poolSize?: number;
  /**
   * Let each instance replace its bb process when it dies. Only for callers whose calls stand alone:
   * a replacement process remembers nothing, so state held across calls (a Chonk accumulation, a
   * batch-verifier session) would be silently lost.
   */
  respawn?: boolean;
  logger?: Logger;
  threads?: number;
  debugDir?: string;
}

/** A place in a {@link BBJsFactory} pool: empty until a borrower first starts a bb in it. */
type PoolSlot = { instance?: BBJsApi };

/**
 * Manages bb.js instance lifecycle. By default every `getInstance()` call spawns a fresh
 * bb process that is destroyed when the borrow is disposed. Pass `poolSize` to keep a fixed
 * set of long-lived bb processes that are reused across calls — useful when the per-call
 * bb startup cost dominates the workload (e.g. high-rate IVC verification).
 *
 * The pool is a queue of `poolSize` slots, each starting its bb on the first borrow that needs it.
 * A borrower waits in exactly two places: for a slot, which destroy() releases by cancelling the
 * queue, and for its slot's bb to start, which bb.js bounds with its own startup deadline. A bb that
 * fails to start costs only that slot, which goes back empty for the next borrower to try again.
 *
 * Idiomatic usage:
 * ```
 * await using inst = await factory.getInstance();
 * await inst.someMethod(...);
 * // disposed automatically when `inst` goes out of scope
 * ```
 */
export class BBJsFactory {
  private readonly logger?: Logger;
  private readonly threads?: number;
  private readonly debugDir?: string;
  private readonly respawn: boolean;

  /** Slots not currently borrowed, when poolSize is set; otherwise undefined. */
  private readonly slots?: FifoMemoryQueue<PoolSlot>;
  private destroyed = false;

  constructor(
    private bbPath: string,
    options: BBJsFactoryOptions = {},
  ) {
    this.respawn = options.respawn ?? false;
    this.logger = options.logger;
    this.threads = options.threads;
    this.debugDir = options.debugDir;
    if (options.poolSize !== undefined) {
      if (options.poolSize < 1) {
        throw new Error(`BBJsFactory poolSize must be >= 1, got ${options.poolSize}`);
      }
      this.slots = new FifoMemoryQueue<PoolSlot>();
      for (let i = 0; i < options.poolSize; i++) {
        this.slots.put({});
      }
    }
  }

  /**
   * Acquire a bb instance. The returned object implements `BBJsApi` and `AsyncDisposable`.
   * With no pool: spawns a fresh bb that is destroyed on dispose. With a pool: borrows a slot,
   * starting its bb if it has none, and returns the slot to the pool on dispose.
   */
  async getInstance(): Promise<BBJsApi & AsyncDisposable> {
    if (this.destroyed) {
      throw new Error('BBJsFactory has been destroyed');
    }
    if (!this.slots) {
      // No pool: fresh-per-call, dispose destroys.
      const instance = await this.createInstance();
      return this.makeOwned(instance);
    }
    const slot = await this.slots.get();
    if (!slot) {
      throw new Error('BBJsFactory was destroyed while waiting for an instance');
    }
    let instance: BBJsApi;
    try {
      instance = slot.instance ??= await this.createInstance();
    } catch (err) {
      await this.release(slot);
      throw err;
    }
    if (this.destroyed) {
      await this.release(slot);
      throw new Error('BBJsFactory has been destroyed');
    }
    return this.makeDisposable(instance, () => this.release(slot));
  }

  /**
   * Tear down all pooled instances. Idempotent. No-op when no pool is configured (fresh-per-call
   * instances are destroyed by their own dispose callbacks). Instances in borrowed slots are
   * destroyed when their borrow is released.
   */
  async destroy(): Promise<void> {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    if (!this.slots) {
      return;
    }
    const idle: BBJsApi[] = [];
    for (let slot = this.slots.getImmediate(); slot; slot = this.slots.getImmediate()) {
      if (slot.instance) {
        idle.push(slot.instance);
      }
    }
    this.slots.cancel();
    // Aggregate teardown failures so a single bb child that fails to shut down doesn't mask others.
    const results = await Promise.allSettled(idle.map(item => item.destroy()));
    const errors = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map(r => r.reason);
    if (errors.length > 0) {
      throw new AggregateError(errors, `BBJsFactory.destroy: ${errors.length} bb instance(s) failed to shut down`);
    }
  }

  /** Return a borrowed slot to the pool, or destroy its bb if the factory was destroyed meanwhile. */
  private async release(slot: PoolSlot): Promise<void> {
    if (!this.destroyed) {
      this.slots!.put(slot);
    } else {
      await slot.instance?.destroy();
    }
  }

  protected async createInstance(): Promise<BBJsApi> {
    const logFn = this.logger ? (msg: string) => this.logger!.verbose(`bb.js - ${msg}`) : undefined;
    const raw = await BBJsInstance.create(this.bbPath, logFn, this.threads, this.respawn);
    return this.maybeWrapDebug(raw);
  }

  /** Wrap the instance in a debug wrapper if debugDir is configured. */
  private async maybeWrapDebug(instance: BBJsInstance): Promise<BBJsApi> {
    if (this.debugDir && this.logger) {
      const { DebugBBJsInstance } = await import('./bb_js_debug.js');
      return new DebugBBJsInstance(instance, this.debugDir, this.bbPath, this.logger);
    }
    return instance;
  }

  /**
   * Wrap a fresh instance with an `AsyncDisposable` that destroys it on dispose. Used when no
   * pool is configured. Destroy errors are propagated so that a teardown failure (e.g. a bb child
   * that didn't shut down cleanly) surfaces instead of being silently swallowed.
   */
  private makeOwned(instance: BBJsApi): BBJsApi & AsyncDisposable {
    return this.makeDisposable(instance, () => instance.destroy());
  }

  private makeDisposable(instance: BBJsApi, onDispose: () => void | Promise<void>): BBJsApi & AsyncDisposable {
    let disposed = false;
    const dispose = async (): Promise<void> => {
      if (disposed) {
        return;
      }
      disposed = true;
      await onDispose();
    };
    return new Proxy(instance as BBJsApi & AsyncDisposable, {
      get(target, prop, receiver) {
        if (prop === Symbol.asyncDispose) {
          return dispose;
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  }
}
