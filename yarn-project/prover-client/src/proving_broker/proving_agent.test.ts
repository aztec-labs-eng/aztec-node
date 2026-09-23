import { RECURSIVE_PROOF_LENGTH } from '@aztec-labs/constants';
import { EpochNumber } from '@aztec-labs/foundation/branded-types';
import { randomBytes } from '@aztec-labs/foundation/crypto/random';
import { AbortError } from '@aztec-labs/foundation/error';
import { promiseWithResolvers } from '@aztec-labs/foundation/promise';
import { ProvingError } from '@aztec-labs/stdlib/errors';
import {
  type GetProvingJobResponse,
  type ProofUri,
  type ProvingJob,
  type ProvingJobConsumer,
  type ProvingJobId,
  type ProvingJobInputs,
  type PublicInputsAndRecursiveProof,
  makePublicInputsAndRecursiveProof,
} from '@aztec-labs/stdlib/interfaces/server';
import type { ParityPublicInputs } from '@aztec-labs/stdlib/parity';
import { ProvingRequestType, makeRecursiveProof } from '@aztec-labs/stdlib/proofs';
import { makeInboxParityPrivateInputs, makeParityPublicInputs } from '@aztec-labs/stdlib/testing';
import { VerificationKeyData } from '@aztec-labs/stdlib/vks';
import { jest } from '@jest/globals';

import { MockProver } from '../test/mock_prover.js';
import type { ProofStore } from './proof_store/index.js';
import { ProvingAgent } from './proving_agent.js';

describe('ProvingAgent', () => {
  let prover: MockProver;
  let jobSource: jest.Mocked<ProvingJobConsumer>;
  let agent: ProvingAgent;
  let proofDB: jest.Mocked<ProofStore>;
  const agentPollIntervalMs = 1000;
  let allowList: ProvingRequestType[];

  beforeEach(() => {
    jest.useFakeTimers();

    prover = new MockProver();
    jobSource = {
      getProvingJob: jest.fn(),
      reportProvingJobProgress: jest.fn(),
      reportProvingJobError: jest.fn(),
      reportProvingJobSuccess: jest.fn(),
    };
    proofDB = {
      getProofInput: jest.fn(),
      getProofOutput: jest.fn(),
      saveProofInput: jest.fn(() => Promise.resolve('' as ProofUri)),
      saveProofOutput: jest.fn(() => Promise.resolve('' as ProofUri)),
    };

    allowList = [ProvingRequestType.INBOX_PARITY];
    agent = new ProvingAgent(jobSource, proofDB, prover, allowList, agentPollIntervalMs);
  });

  afterEach(async () => {
    await agent.stop();
  });

  it('polls for jobs passing the permitted list of proofs', () => {
    agent.start();
    expect(jobSource.getProvingJob).toHaveBeenCalledWith({ allowList: [ProvingRequestType.INBOX_PARITY] });
  });

  it('only takes a single job from the source at a time', async () => {
    expect(jobSource.getProvingJob).not.toHaveBeenCalled();

    // simulate the proof taking a long time
    const { promise, resolve } =
      promiseWithResolvers<PublicInputsAndRecursiveProof<ParityPublicInputs, typeof RECURSIVE_PROOF_LENGTH>>();
    jest.spyOn(prover, 'getInboxParityProof').mockReturnValueOnce(promise);

    const { job, time, inputs } = makeBaseParityJob();
    jobSource.getProvingJob.mockResolvedValueOnce({ job, time });
    proofDB.getProofInput.mockResolvedValueOnce(inputs);
    agent.start();

    await jest.advanceTimersByTimeAsync(agentPollIntervalMs);
    expect(jobSource.getProvingJob).toHaveBeenCalledTimes(1);
    expect(jobSource.reportProvingJobProgress).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(agentPollIntervalMs);
    expect(jobSource.getProvingJob).toHaveBeenCalledTimes(1);
    expect(jobSource.reportProvingJobProgress).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(agentPollIntervalMs);
    expect(jobSource.getProvingJob).toHaveBeenCalledTimes(1);
    expect(jobSource.reportProvingJobProgress).toHaveBeenCalledTimes(3);

    // let's resolve the proof
    const result = makePublicInputsAndRecursiveProof(
      makeParityPublicInputs(),
      makeRecursiveProof(RECURSIVE_PROOF_LENGTH),
      VerificationKeyData.makeFakeHonk(),
    );
    resolve(result);

    await jest.advanceTimersByTimeAsync(agentPollIntervalMs);
    expect(jobSource.getProvingJob).toHaveBeenCalledTimes(2);
  });

  it('reports success to the job source', async () => {
    const { job, time, inputs } = makeBaseParityJob();
    const result = makeBaseParityResult();

    jest.spyOn(prover, 'getInboxParityProof').mockResolvedValueOnce(result);

    jobSource.getProvingJob.mockResolvedValueOnce({ job, time });
    proofDB.getProofInput.mockResolvedValueOnce(inputs);
    proofDB.saveProofOutput.mockResolvedValueOnce('output-uri' as ProofUri);

    agent.start();

    await jest.advanceTimersByTimeAsync(agentPollIntervalMs);
    expect(proofDB.saveProofOutput).toHaveBeenCalledWith(job.id, job.type, result);
    expect(jobSource.reportProvingJobSuccess).toHaveBeenCalledWith(job.id, 'output-uri', { allowList });
  });

  it('reports errors to the job source', async () => {
    const { job, time, inputs } = makeBaseParityJob();
    jest.spyOn(prover, 'getInboxParityProof').mockRejectedValueOnce(new Error('test error'));

    jobSource.getProvingJob.mockResolvedValueOnce({ job, time });
    proofDB.getProofInput.mockResolvedValueOnce(inputs);
    agent.start();

    await jest.advanceTimersByTimeAsync(agentPollIntervalMs);
    expect(jobSource.reportProvingJobError).toHaveBeenCalledWith(job.id, expect.stringContaining('test error'), false, {
      allowList,
    });
  });

  it('sets the retry flag on when reporting an error', async () => {
    const { job, time, inputs } = makeBaseParityJob();
    const err = new ProvingError('test error', undefined, true);
    jest.spyOn(prover, 'getInboxParityProof').mockRejectedValueOnce(err);

    jobSource.getProvingJob.mockResolvedValueOnce({ job, time });
    proofDB.getProofInput.mockResolvedValueOnce(inputs);
    agent.start();

    await jest.advanceTimersByTimeAsync(agentPollIntervalMs);
    expect(jobSource.reportProvingJobError).toHaveBeenCalledWith(job.id, expect.stringContaining(err.message), true, {
      allowList,
    });
  });

  it('reports jobs in progress to the job source', async () => {
    const { job, time, inputs } = makeBaseParityJob();
    const { promise, resolve } =
      promiseWithResolvers<PublicInputsAndRecursiveProof<ParityPublicInputs, typeof RECURSIVE_PROOF_LENGTH>>();
    jest.spyOn(prover, 'getInboxParityProof').mockReturnValueOnce(promise);

    jobSource.getProvingJob.mockResolvedValueOnce({ job, time });
    proofDB.getProofInput.mockResolvedValueOnce(inputs);
    agent.start();

    await jest.advanceTimersByTimeAsync(agentPollIntervalMs);
    expect(jobSource.reportProvingJobProgress).toHaveBeenCalledWith(job.id, time, {
      allowList: [ProvingRequestType.INBOX_PARITY],
    });

    await jest.advanceTimersByTimeAsync(agentPollIntervalMs);
    expect(jobSource.reportProvingJobProgress).toHaveBeenCalledWith(job.id, time, {
      allowList: [ProvingRequestType.INBOX_PARITY],
    });

    resolve(makeBaseParityResult());
  });

  it('abandons jobs if told so by the source', async () => {
    const firstJob = makeBaseParityJob();
    let firstProofAborted = false;
    const firstProof =
      promiseWithResolvers<PublicInputsAndRecursiveProof<ParityPublicInputs, typeof RECURSIVE_PROOF_LENGTH>>();

    // simulate a long running proving job that can be aborted
    jest.spyOn(prover, 'getInboxParityProof').mockImplementationOnce((_, signal) => {
      signal?.addEventListener('abort', () => {
        firstProof.reject(new AbortError('test abort'));
        firstProofAborted = true;
      });
      return firstProof.promise;
    });

    jobSource.getProvingJob.mockResolvedValueOnce({ job: firstJob.job, time: firstJob.time });
    proofDB.getProofInput.mockResolvedValueOnce(firstJob.inputs);
    agent.start();

    // now the agent should be happily proving and reporting progress
    await jest.advanceTimersByTimeAsync(agentPollIntervalMs);
    expect(jobSource.reportProvingJobProgress).toHaveBeenCalledTimes(1);
    expect(jobSource.reportProvingJobProgress).toHaveBeenCalledWith(firstJob.job.id, firstJob.time, {
      allowList: [ProvingRequestType.INBOX_PARITY],
    });

    await jest.advanceTimersByTimeAsync(agentPollIntervalMs);
    expect(jobSource.reportProvingJobProgress).toHaveBeenCalledTimes(2);

    // now let's simulate the job source cancelling the job and giving the agent something else to do
    // this should cause the agent to abort the current job and start the new one
    const secondJobResponse = makeBaseParityJob();

    proofDB.getProofInput.mockResolvedValueOnce(secondJobResponse.inputs);

    const secondProof =
      promiseWithResolvers<PublicInputsAndRecursiveProof<ParityPublicInputs, typeof RECURSIVE_PROOF_LENGTH>>();
    jest.spyOn(prover, 'getInboxParityProof').mockReturnValueOnce(secondProof.promise);

    jobSource.reportProvingJobProgress.mockResolvedValueOnce(secondJobResponse);

    await jest.advanceTimersByTimeAsync(agentPollIntervalMs);
    expect(jobSource.reportProvingJobProgress).toHaveBeenCalledTimes(4);
    expect(jobSource.reportProvingJobProgress).toHaveBeenNthCalledWith(3, firstJob.job.id, firstJob.time, {
      allowList: [ProvingRequestType.INBOX_PARITY],
    });
    expect(jobSource.reportProvingJobProgress).toHaveBeenNthCalledWith(
      4,
      secondJobResponse.job.id,
      secondJobResponse.time,
      {
        allowList: [ProvingRequestType.INBOX_PARITY],
      },
    );
    expect(firstProofAborted).toBe(true);

    // agent should have switched now
    await jest.advanceTimersByTimeAsync(agentPollIntervalMs);
    expect(jobSource.reportProvingJobProgress).toHaveBeenCalledTimes(5);
    expect(jobSource.reportProvingJobProgress).toHaveBeenLastCalledWith(
      secondJobResponse.job.id,
      secondJobResponse.time,
      {
        allowList: [ProvingRequestType.INBOX_PARITY],
      },
    );
  });

  it('immediately starts working on the next job', async () => {
    const job1 = makeBaseParityJob();
    const job2 = makeBaseParityJob();

    jest
      .spyOn(prover, 'getInboxParityProof')
      .mockResolvedValueOnce(makeBaseParityResult())
      .mockResolvedValueOnce(makeBaseParityResult());

    proofDB.getProofInput.mockResolvedValueOnce(job1.inputs).mockResolvedValueOnce(job2.inputs);
    proofDB.saveProofOutput.mockResolvedValue('' as ProofUri);

    jobSource.getProvingJob.mockResolvedValueOnce(job1);
    jobSource.reportProvingJobSuccess.mockResolvedValueOnce(job2);

    agent.start();

    await jest.advanceTimersByTimeAsync(agentPollIntervalMs);
    await jest.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    expect(jobSource.reportProvingJobSuccess).toHaveBeenCalledWith(job1.job.id, expect.any(String), { allowList });
    expect(jobSource.reportProvingJobSuccess).toHaveBeenCalledWith(job2.job.id, expect.any(String), { allowList });
  });

  it('immediately starts working after reporting an error', async () => {
    const job1 = makeBaseParityJob();
    const job2 = makeBaseParityJob();

    jest
      .spyOn(prover, 'getInboxParityProof')
      .mockRejectedValueOnce(new Error('test error'))
      .mockResolvedValueOnce(makeBaseParityResult());

    proofDB.getProofInput.mockResolvedValueOnce(job1.inputs).mockResolvedValueOnce(job2.inputs);
    proofDB.saveProofOutput.mockResolvedValue('' as ProofUri);

    jobSource.getProvingJob.mockResolvedValueOnce(job1);
    jobSource.reportProvingJobError.mockResolvedValueOnce(job2);

    agent.start();

    await jest.advanceTimersByTimeAsync(agentPollIntervalMs);
    expect(jobSource.reportProvingJobError).toHaveBeenCalledWith(job1.job.id, expect.any(String), false, { allowList });
    expect(jobSource.reportProvingJobSuccess).toHaveBeenCalledWith(job2.job.id, expect.any(String), { allowList });
  });

  it('reports an error if inputs cannot be loaded', async () => {
    const { job, time } = makeBaseParityJob();
    jobSource.getProvingJob.mockResolvedValueOnce({ job, time });
    proofDB.getProofInput.mockRejectedValueOnce(new Error('Failed to load proof inputs'));

    agent.start();

    await jest.advanceTimersByTimeAsync(agentPollIntervalMs);
    expect(jobSource.reportProvingJobError).toHaveBeenCalledWith(job.id, 'Failed to load proof inputs', true, {
      allowList,
    });
  });

  it('drains an idle agent without claiming another job', async () => {
    agent.start();
    await jest.advanceTimersByTimeAsync(0);
    jobSource.getProvingJob.mockResolvedValueOnce(makeBaseParityJob());

    await agent.drain();

    expect(agent.getStatus()).toEqual({ status: 'stopped' });
    expect(agent.isRunning()).toBe(false);
  });

  it.each(['success', 'error'] as const)('drains an active proof through %s reporting', async outcome => {
    const response = makeBaseParityJob();
    const proof = promiseWithResolvers<ReturnType<typeof makeBaseParityResult>>();
    const reported = promiseWithResolvers<GetProvingJobResponse | undefined>();
    let signal: AbortSignal | undefined;
    const heartbeats: number[] = [];
    let reportAllowsNewJobs: boolean | undefined;
    jest.spyOn(prover, 'getInboxParityProof').mockImplementationOnce((_, abortSignal) => {
      signal = abortSignal;
      return proof.promise;
    });
    jobSource.getProvingJob.mockResolvedValueOnce(response);
    proofDB.getProofInput.mockResolvedValueOnce(response.inputs);
    jobSource.reportProvingJobProgress.mockImplementation((_id, _time, filter) => {
      if (filter?.allowNewJobs === false) {
        heartbeats.push(jest.now());
      }
      return Promise.resolve(undefined);
    });
    jobSource.reportProvingJobSuccess.mockImplementation((_id, _uri, filter) => {
      reportAllowsNewJobs = filter?.allowNewJobs;
      return reported.promise;
    });
    jobSource.reportProvingJobError.mockImplementation((_id, _err, _retry, filter) => {
      reportAllowsNewJobs = filter?.allowNewJobs;
      return reported.promise;
    });
    agent.start();
    await jest.advanceTimersByTimeAsync(0);

    let drained = false;
    const draining = agent.drain().then(() => {
      drained = true;
    });
    const alsoDraining = agent.drain();
    await jest.advanceTimersByTimeAsync(3 * agentPollIntervalMs);
    expect(signal?.aborted).toBe(false);
    expect(drained).toBe(false);
    expect(heartbeats.length).toBeGreaterThanOrEqual(3);

    if (outcome === 'success') {
      proof.resolve(makeBaseParityResult());
    } else {
      proof.reject(new Error('proof failed'));
    }
    await jest.advanceTimersByTimeAsync(0);
    expect(reportAllowsNewJobs).toBe(false);
    expect(drained).toBe(false);

    reported.resolve(undefined);
    await jest.advanceTimersByTimeAsync(0);
    await Promise.all([draining, alsoDraining]);
    expect(agent.getStatus()).toEqual({ status: 'stopped' });
    expect(signal?.aborted).toBe(false);
  });

  it('finishes a job returned by a claim already in flight when draining starts', async () => {
    const response = makeBaseParityJob();
    const claim = promiseWithResolvers<GetProvingJobResponse | undefined>();
    const completed: string[] = [];
    jobSource.getProvingJob.mockReturnValueOnce(claim.promise);
    proofDB.getProofInput.mockResolvedValueOnce(response.inputs);
    jest.spyOn(prover, 'getInboxParityProof').mockResolvedValueOnce(makeBaseParityResult());
    jobSource.reportProvingJobSuccess.mockImplementation((id, _uri, filter) => {
      expect(filter?.allowNewJobs).toBe(false);
      completed.push(id);
      return Promise.resolve(undefined);
    });
    agent.start();

    const draining = agent.drain();
    claim.resolve(response);
    await jest.advanceTimersByTimeAsync(0);
    await draining;

    expect(completed).toEqual([response.job.id]);
    expect(agent.getStatus()).toEqual({ status: 'stopped' });
  });

  it('finishes replacement work returned by a result report already in flight', async () => {
    const first = makeBaseParityJob();
    const next = makeBaseParityJob();
    const report = promiseWithResolvers<GetProvingJobResponse | undefined>();
    const completed: string[] = [];
    jobSource.getProvingJob.mockResolvedValueOnce(first);
    proofDB.getProofInput.mockResolvedValueOnce(first.inputs).mockResolvedValueOnce(next.inputs);
    jest.spyOn(prover, 'getInboxParityProof').mockResolvedValue(makeBaseParityResult());
    jobSource.reportProvingJobSuccess.mockReturnValueOnce(report.promise).mockImplementation((id, _uri, filter) => {
      expect(filter?.allowNewJobs).toBe(false);
      completed.push(id);
      return Promise.resolve(undefined);
    });
    agent.start();
    await jest.advanceTimersByTimeAsync(0);

    const draining = agent.drain();
    report.resolve(next);
    await jest.advanceTimersByTimeAsync(0);
    await draining;

    expect(completed).toEqual([next.job.id]);
    expect(agent.getStatus()).toEqual({ status: 'stopped' });
  });

  it('reports input loading failure while draining without claiming replacement work', async () => {
    const response = makeBaseParityJob();
    const inputs = promiseWithResolvers<ProvingJobInputs>();
    const failures: string[] = [];
    jobSource.getProvingJob.mockResolvedValueOnce(response);
    proofDB.getProofInput.mockReturnValueOnce(inputs.promise);
    jobSource.reportProvingJobError.mockImplementation((id, _err, retry, filter) => {
      expect(retry).toBe(true);
      expect(filter?.allowNewJobs).toBe(false);
      failures.push(id);
      return Promise.resolve(undefined);
    });
    agent.start();
    await jest.advanceTimersByTimeAsync(0);

    const draining = agent.drain();
    inputs.reject(new Error('input unavailable'));
    await jest.advanceTimersByTimeAsync(0);
    await draining;

    expect(failures).toEqual([response.job.id]);
    expect(agent.getStatus()).toEqual({ status: 'stopped' });
  });

  function makeBaseParityJob(): { job: ProvingJob; time: number; inputs: ProvingJobInputs } {
    const time = jest.now();
    const inputs: ProvingJobInputs = { type: ProvingRequestType.INBOX_PARITY, inputs: makeInboxParityPrivateInputs() };
    const job: ProvingJob = {
      id: randomBytes(8).toString('hex') as ProvingJobId,
      epochNumber: EpochNumber(1),
      type: ProvingRequestType.INBOX_PARITY,
      inputsUri: randomBytes(8).toString('hex') as ProofUri,
    };

    return { job, time, inputs };
  }

  function makeBaseParityResult() {
    return makePublicInputsAndRecursiveProof(
      makeParityPublicInputs(),
      makeRecursiveProof(RECURSIVE_PROOF_LENGTH),
      VerificationKeyData.makeFakeHonk(),
    );
  }
});
