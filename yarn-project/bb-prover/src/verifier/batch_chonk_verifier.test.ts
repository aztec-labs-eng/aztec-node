import { promiseWithResolvers } from '@aztec-labs/foundation/promise';
import { jest } from '@jest/globals';
import { Packr } from 'msgpackr';
import * as fs from 'node:fs';

/* eslint-disable camelcase -- result fields use bb's wire names */
/**
 * Stands in for a bb process running the batch verifier service. Like bb, it opens the result FIFO only when it writes
 * its first result, and answers a proof with no fields at once with a FAILED result.
 */
class FifoFakeBb {
  public readonly firstProofQueued = promiseWithResolvers<void>();
  private fifoPath = '';
  private fd: number | undefined;
  private dead = false;

  public initSRSChonk() {
    return Promise.resolve();
  }

  public chonkBatchVerifierStart({ fifoPath }: { fifoPath: string }) {
    this.fifoPath = fifoPath;
    return Promise.resolve({});
  }

  public chonkBatchVerifierQueue({ requestId, proofFields }: { requestId: number; proofFields: Uint8Array[] }) {
    if (this.dead) {
      return Promise.reject(Object.assign(new Error('bb exited'), { retry: true }));
    }
    if (proofFields.length === 0) {
      this.writeResult({ request_id: requestId, status: 1, error_message: 'malformed proof fields: proof too short' });
    } else {
      this.firstProofQueued.resolve();
    }
    return Promise.resolve({});
  }

  public chonkBatchVerifierStop() {
    return Promise.resolve({});
  }

  public destroy() {
    this.die();
    return Promise.resolve();
  }

  /** The process exits: its end of the FIFO closes, if it ever opened it. */
  public die() {
    this.dead = true;
    if (this.fd !== undefined) {
      fs.closeSync(this.fd);
      this.fd = undefined;
    }
  }

  private writeResult(result: { request_id: number; status: number; error_message: string }) {
    this.fd ??= fs.openSync(this.fifoPath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
    const payload = new Packr({ useRecords: false }).pack({ ...result, time_in_queue_ms: 0, time_in_verify_ms: 0 });
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.length);
    fs.writeSync(this.fd, Buffer.concat([header, payload]));
  }
}

/* eslint-enable camelcase */

let fakeBb: FifoFakeBb;
const actualBbJs = await import('@aztec-foundation/bb.js');
jest.unstable_mockModule('@aztec-foundation/bb.js', () => ({
  ...actualBbJs,
  Barretenberg: { new: () => Promise.resolve(fakeBb) },
}));
const { BatchChonkVerifier, MAX_PROOFS_IN_FLIGHT } = await import('./batch_chonk_verifier.js');
type BatchChonkVerifier = Awaited<ReturnType<typeof BatchChonkVerifier.newForTesting>>;

/** The slice of bb.js's Barretenberg the verifier uses while proofs are queued. */
interface FakeBb {
  chonkBatchVerifierQueue: (req: unknown) => Promise<unknown>;
}

/** A BatchChonkVerifier over a fake bb, without a bb process or result stream. */
function verifierOver(bb: FakeBb): BatchChonkVerifier {
  const ctor = BatchChonkVerifier as unknown as new (...args: unknown[]) => BatchChonkVerifier;
  const verifier = new ctor({ bbChonkVerifyConcurrency: 1 }, [new Uint8Array()], 8, 'unit');
  (verifier as unknown as { bb: FakeBb }).bb = bb;
  return verifier;
}

function rejectAllInFlight(verifier: BatchChonkVerifier) {
  (verifier as unknown as { rejectPendingRequests: (e: Error) => void }).rejectPendingRequests(new Error('teardown'));
}

/** bb reports a verdict on the proof queued as `requestId`. */
function deliverVerdict(verifier: BatchChonkVerifier, requestId: number) {
  (verifier as unknown as { handleResult: (r: object) => void }).handleResult({
    request_id: requestId, // eslint-disable-line camelcase
    status: 0,
    error_message: '', // eslint-disable-line camelcase
    time_in_verify_ms: 0, // eslint-disable-line camelcase
  });
}

function failVerifier(verifier: BatchChonkVerifier) {
  (verifier as unknown as { failVerifier: (e: Error) => void }).failVerifier(new Error('bb died'));
}

/** Lets queued sends and woken waiters run. */
const settle = () => new Promise(resolve => setTimeout(resolve, 10));

const proofFields = [new Uint8Array(32)];

describe('BatchChonkVerifier', () => {
  it.each([
    ['finds bb gone', Object.assign(new Error('bb exited'), { retry: true })],
    ['is refused by bb', new Error('bb refused')],
  ])('fails, so it is replaced, when a send %s', async (_name, sendError) => {
    const verifier = verifierOver({ chonkBatchVerifierQueue: () => Promise.reject(sendError) });

    await expect(verifier.enqueueProof(0, proofFields)).rejects.toThrow(sendError.message);
    expect(verifier.isFailed()).toBe(true);
    await expect(verifier.enqueueProof(0, proofFields)).rejects.toThrow(sendError.message);
  });

  it('holds a proof past the in-flight cap until bb has a verdict on another, then sends it', async () => {
    let sent = 0;
    const verifier = verifierOver({ chonkBatchVerifierQueue: () => (sent++, Promise.resolve({})) });
    const inFlight = Array.from({ length: MAX_PROOFS_IN_FLIGHT }, () =>
      verifier.enqueueProof(0, proofFields).catch(() => {}),
    );
    const waiting = verifier.enqueueProof(0, proofFields);
    await settle();
    expect(sent).toBe(MAX_PROOFS_IN_FLIGHT);

    deliverVerdict(verifier, 0);
    await settle();
    expect(sent).toBe(MAX_PROOFS_IN_FLIGHT + 1);

    deliverVerdict(verifier, MAX_PROOFS_IN_FLIGHT);
    await expect(waiting).resolves.toMatchObject({ valid: true });
    rejectAllInFlight(verifier);
    await Promise.all(inFlight);
  });

  it('rejects a proof waiting for room when the verifier fails', async () => {
    const verifier = verifierOver({ chonkBatchVerifierQueue: () => Promise.resolve({}) });
    const inFlight = Array.from({ length: MAX_PROOFS_IN_FLIGHT }, () =>
      verifier.enqueueProof(0, proofFields).catch(() => {}),
    );
    const waiting = verifier.enqueueProof(0, proofFields);
    await settle();

    failVerifier(verifier);

    await expect(waiting).rejects.toThrow();
    await Promise.all(inFlight);
  });

  it('rejects a queued proof when bb dies before writing any result for it', async () => {
    // bb opens the result stream only on its first write; start() has it write one, so the death ends the stream.
    fakeBb = new FifoFakeBb();
    const verifier = await BatchChonkVerifier.newForTesting({ bbChonkVerifyConcurrency: 1 }, [new Uint8Array()], 8);
    const verification = verifier.enqueueProof(0, proofFields);
    await fakeBb.firstProofQueued.promise;

    fakeBb.die();

    await expect(verification).rejects.toThrow();
    expect(verifier.isFailed()).toBe(true);
    await verifier.stop();
  });
});
