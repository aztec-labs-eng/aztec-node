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
  /**
   * Whether the bb process behind this instance is running and connected. An instance that is not alive never recovers,
   * and every later call on it fails.
   */
  isAlive(): boolean;
  destroy(): Promise<void>;
}

/**
 * Thin wrapper around a single Barretenberg instance.
 * Each instance spawns its own bb process via the NativeUnixSocket backend.
 */
export class BBJsInstance implements BBJsApi {
  private constructor(private api: Barretenberg) {}

  /** Creates a new Barretenberg instance connected to a fresh bb process. */
  static async create(bbPath: string, logger?: LogFn, threads?: number): Promise<BBJsInstance> {
    const options: BackendOptions = {
      bbPath,
      backend: BackendType.NativeUnixSocket,
      logger,
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

  isAlive(): boolean {
    return this.api.isAlive();
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
  logger?: Logger;
  threads?: number;
  debugDir?: string;
}

/**
 * Manages bb.js instance lifecycle. By default every `getInstance()` call spawns a fresh
 * bb process that is destroyed when the borrow is disposed. Pass `poolSize` to keep a fixed
 * set of long-lived bb processes that are reused across calls — useful when the per-call
 * bb startup cost dominates the workload (e.g. high-rate IVC verification).
 *
 * A pooled instance whose bb process died is never handed out again: it is destroyed when it is returned or found idle.
 * A replacement is spawned when a dead instance is returned, and when a borrower finds no idle instance while the pool
 * is below `poolSize`.
 *
 * Idiomatic usage:
 * ```
 * await using inst = await factory.getInstance();
 * await inst.someMethod(...);
 * // disposed automatically when `inst` goes out of scope
 * ```
 */
export class BBJsFactory {
  private readonly poolSize?: number;
  private readonly logger?: Logger;
  private readonly threads?: number;
  private readonly debugDir?: string;

  /** Available pooled instances when poolSize is set; otherwise undefined. */
  private pool?: FifoMemoryQueue<BBJsApi>;
  /** Lazily-resolved on first `getInstance()` call to prevent racing pool initialization. */
  private initPromise?: Promise<void>;
  /** Pooled instances that exist, idle or borrowed, plus spawns in flight. Below `poolSize` after an eviction. */
  private pooledCount = 0;
  private destroyed = false;

  constructor(
    private bbPath: string,
    options: BBJsFactoryOptions = {},
  ) {
    this.poolSize = options.poolSize;
    this.logger = options.logger;
    this.threads = options.threads;
    this.debugDir = options.debugDir;
    if (this.poolSize !== undefined && this.poolSize < 1) {
      throw new Error(`BBJsFactory poolSize must be >= 1, got ${this.poolSize}`);
    }
  }

  /**
   * Acquire a bb instance. The returned object implements `BBJsApi` and `AsyncDisposable`.
   * With no pool: spawns a fresh bb that is destroyed on dispose. With a pool: borrows a live instance from
   * the pool and returns it on dispose, spawning a replacement first if the pool has no idle instance and is below
   * `poolSize`. If that spawn fails, waits for a borrowed instance, or throws when there is none; the next call tries
   * the spawn again.
   */
  async getInstance(): Promise<BBJsApi & AsyncDisposable> {
    if (this.destroyed) {
      throw new Error('BBJsFactory has been destroyed');
    }
    if (this.poolSize === undefined) {
      // No pool: fresh-per-call, dispose destroys.
      const instance = await this.createInstance();
      return this.makeOwned(instance);
    }
    await this.ensurePoolInitialized();
    // Every idle instance can turn out dead, and each one found dead makes room for a replacement, so poolSize + 1
    // attempts always reach a live instance unless replacements keep dying too.
    for (let attempt = 0; attempt <= this.poolSize; attempt++) {
      const pool = this.pool;
      if (!pool) {
        throw new Error('BBJsFactory has been destroyed');
      }
      if (pool.length() === 0) {
        try {
          await this.replenish(pool);
        } catch (err) {
          if (this.pooledCount === 0) {
            throw err;
          }
          this.logger?.warn('Failed to spawn a bb instance; waiting for a borrowed one', {
            pooledCount: this.pooledCount,
            err,
          });
        }
      }
      const instance = await pool.get();
      if (!instance) {
        throw new Error('BBJsFactory was destroyed while waiting for an instance');
      }
      if (instance.isAlive()) {
        return this.makeBorrowed(instance);
      }
      await this.evict(instance);
    }
    throw new Error(`BBJsFactory found no live bb instance after ${this.poolSize + 1} attempts`);
  }

  /**
   * Tear down all pooled instances. Idempotent. No-op when no pool is configured (fresh-per-call
   * instances are destroyed by their own dispose callbacks). Instances currently held by an
   * in-flight pooled borrow are destroyed by their dispose callback when released.
   */
  async destroy(): Promise<void> {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    const pool = this.pool;
    this.pool = undefined;
    if (!pool) {
      return;
    }
    const idle: BBJsApi[] = [];
    while (pool.length() > 0) {
      const item = pool.getImmediate();
      if (item) {
        idle.push(item);
      }
    }
    pool.cancel();
    // Aggregate teardown failures so a single bb child that fails to shut down doesn't mask others.
    const results = await Promise.allSettled(idle.map(item => item.destroy()));
    const errors = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map(r => r.reason);
    if (errors.length > 0) {
      throw new AggregateError(errors, `BBJsFactory.destroy: ${errors.length} bb instance(s) failed to shut down`);
    }
  }

  protected async createInstance(): Promise<BBJsApi> {
    const logFn = this.logger ? (msg: string) => this.logger!.verbose(`bb.js - ${msg}`) : undefined;
    const raw = await BBJsInstance.create(this.bbPath, logFn, this.threads);
    return this.maybeWrapDebug(raw);
  }

  /** Initializes the pool once; a failed initialization is retried by the next call. */
  private async ensurePoolInitialized(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.initPool();
    }
    const initPromise = this.initPromise;
    try {
      await initPromise;
    } catch (err) {
      if (this.initPromise === initPromise) {
        this.initPromise = undefined;
      }
      throw err;
    }
  }

  private async initPool(): Promise<void> {
    // Use allSettled so that the bb child processes whose creation succeeded are kept when others fail, and are
    // destroyed rather than leaked when destroy() raced ahead.
    const results = await Promise.allSettled(Array.from({ length: this.poolSize! }, () => this.createInstance()));
    const items: BBJsApi[] = [];
    const errors: unknown[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        items.push(result.value);
      } else {
        errors.push(result.reason);
      }
    }
    if (this.destroyed) {
      await Promise.all(items.map(item => item.destroy()));
      return;
    }
    if (items.length === 0) {
      throw errors[0];
    }
    if (errors.length > 0) {
      // The missing instances are spawned on demand, like replacements for dead ones.
      this.logger?.warn('Some pooled bb instances failed to start', {
        poolSize: this.poolSize,
        started: items.length,
        err: errors[0],
      });
    }
    const pool = new FifoMemoryQueue<BBJsApi>();
    for (const item of items) {
      pool.put(item);
    }
    this.pooledCount = items.length;
    this.pool = pool;
  }

  /** Spawns one pooled instance into `pool` if the pool is below `poolSize`. */
  private async replenish(pool: FifoMemoryQueue<BBJsApi>): Promise<void> {
    if (this.pooledCount >= this.poolSize!) {
      return;
    }
    // Counted before the spawn so that concurrent borrowers do not spawn past poolSize.
    this.pooledCount++;
    let instance: BBJsApi;
    try {
      instance = await this.createInstance();
    } catch (err) {
      this.pooledCount--;
      throw err;
    }
    if (this.destroyed) {
      await instance.destroy();
      return;
    }
    pool.put(instance);
  }

  /** Destroys a pooled instance whose bb process died, making room in the pool for a replacement. */
  private async evict(instance: BBJsApi): Promise<void> {
    this.pooledCount--;
    this.logger?.warn('Evicting a pooled bb instance whose process died', {
      poolSize: this.poolSize,
      pooledCount: this.pooledCount,
    });
    // bb is already gone, so a teardown error is not actionable and must not fail the borrow that found it.
    await instance.destroy().catch(err => this.logger?.warn('Failed to destroy a dead bb instance', { err }));
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

  /**
   * Wrap a pooled instance with an `AsyncDisposable` that returns it to the pool, evicts it if its bb process died, or
   * destroys it if the factory was destroyed in the meantime. Destroy errors of a live instance are propagated.
   */
  private makeBorrowed(instance: BBJsApi): BBJsApi & AsyncDisposable {
    return this.makeDisposable(instance, async () => {
      const pool = this.pool;
      if (!pool || this.destroyed) {
        await instance.destroy();
      } else if (instance.isAlive()) {
        pool.put(instance);
      } else {
        await this.evict(instance);
        // A borrower may be waiting for this instance to come back, so replace it now rather than on the next borrow.
        await this.replenish(pool).catch(err =>
          this.logger?.warn('Failed to spawn a replacement for a dead bb instance', { err }),
        );
      }
    });
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
