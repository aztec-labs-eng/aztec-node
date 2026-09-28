import { EpochNumber } from '@aztec-labs/foundation/branded-types';
import { createNamespacedSafeJsonRpcServer, startHttpRpcServer } from '@aztec-labs/foundation/json-rpc/server';
import { Agent, makeUndiciFetch } from '@aztec-labs/foundation/json-rpc/undici';
import { promiseWithResolvers } from '@aztec-labs/foundation/promise';
import { sleep } from '@aztec-labs/foundation/sleep';
import type { ProvingJob, ProvingJobBroker } from '@aztec-labs/stdlib/interfaces/server';
import { ProvingRequestType } from '@aztec-labs/stdlib/proofs';
import { makeInboxParityPrivateInputs } from '@aztec-labs/stdlib/testing';
import { jest } from '@jest/globals';

import { MockProver } from '../test/mock_prover.js';
import { makeOutputsUri, makeRandomProvingJobId } from './fixtures.js';
import { InlineProofStore } from './proof_store/inline_proof_store.js';
import { ProvingAgent } from './proving_agent.js';
import { ProvingBroker } from './proving_broker.js';
import { InMemoryBrokerDatabase } from './proving_broker_database/memory.js';
import { ProvingJobBrokerSchema, createProvingJobBrokerClient } from './rpc.js';

describe('Proving agent drain over RPC', () => {
  let broker: ProvingBroker;
  let client: ProvingJobBroker;
  let httpServer: Awaited<ReturnType<typeof startHttpRpcServer>>;
  let transport: Agent;
  let agent: ProvingAgent;
  let prover: MockProver;
  let store: InlineProofStore;
  const jobTimeoutMs = 1000;
  const pollIntervalMs = 50;
  const noNewJobs = { allowList: [], allowNewJobs: false };

  beforeEach(async () => {
    broker = new ProvingBroker(new InMemoryBrokerDatabase(), {
      proverBrokerJobTimeoutMs: jobTimeoutMs,
      proverBrokerPollIntervalMs: pollIntervalMs,
      proverBrokerJobMaxRetries: 1,
      proverBrokerMaxEpochsToKeepResultsFor: 1,
      proverBrokerDebugReplayEnabled: false,
    });
    await broker.start();
    httpServer = await startHttpRpcServer(
      createNamespacedSafeJsonRpcServer({ proverBroker: [broker, ProvingJobBrokerSchema] }),
      { host: '127.0.0.1' },
    );
    transport = new Agent();
    client = createProvingJobBrokerClient(`http://127.0.0.1:${httpServer.port}`, {}, makeUndiciFetch(transport));
    store = new InlineProofStore();
    prover = new MockProver();
    agent = new ProvingAgent(client, store, prover, [], pollIntervalMs);
  });

  afterEach(async () => {
    await agent.stop();
    await broker.stop();
    await transport.close();
    httpServer.close();
  });

  async function enqueueJob() {
    const id = makeRandomProvingJobId();
    const type = ProvingRequestType.INBOX_PARITY;
    const job: ProvingJob = {
      id,
      type,
      epochNumber: EpochNumber(1),
      inputsUri: await store.saveProofInput(id, type, makeInboxParityPrivateInputs()),
    };
    await client.enqueueProvingJob(job);
    return job;
  }

  it.each(['success', 'error', 'progress'] as const)('%s reports can decline replacement work', async report => {
    const current = await enqueueJob();
    const claimed = await client.getProvingJob();
    const next = await enqueueJob();

    if (report === 'success') {
      const outputUri = makeOutputsUri();
      expect(await client.reportProvingJobSuccess(current.id, outputUri, noNewJobs)).toBeUndefined();
      expect(await client.getProvingJobStatus(current.id)).toEqual({ status: 'fulfilled', value: outputUri });
    } else if (report === 'error') {
      expect(await client.reportProvingJobError(current.id, 'proof failed', false, noNewJobs)).toBeUndefined();
      expect(await client.getProvingJobStatus(current.id)).toEqual({ status: 'rejected', reason: 'proof failed' });
    } else {
      await client.cancelProvingJob(current.id);
      expect(await client.reportProvingJobProgress(current.id, claimed!.time, noNewJobs)).toBeUndefined();
      expect(await client.getProvingJobStatus(current.id)).toEqual({ status: 'aborted' });
    }

    expect(await client.getProvingJobStatus(next.id)).toEqual({ status: 'in-queue' });
    expect((await client.getProvingJob())?.job.id).toBe(next.id);
  });

  it('keeps heartbeating while draining, reports the proof, and leaves the next job available', async () => {
    const result = await prover.getInboxParityProof(makeInboxParityPrivateInputs());
    const proof = promiseWithResolvers<typeof result>();
    const started = promiseWithResolvers<void>();
    let signal: AbortSignal | undefined;
    jest.spyOn(prover, 'getInboxParityProof').mockImplementationOnce((_, abortSignal) => {
      signal = abortSignal;
      started.resolve();
      return proof.promise;
    });
    const current = await enqueueJob();
    const next = await enqueueJob();
    agent.start();
    await started.promise;

    let drained = false;
    const draining = agent.drain().then(() => {
      drained = true;
    });
    await sleep(2 * jobTimeoutMs);
    expect(drained).toBe(false);
    expect(signal?.aborted).toBe(false);
    expect(await client.getProvingJobStatus(current.id)).toEqual({ status: 'in-progress' });
    expect(await client.getProvingJobStatus(next.id)).toEqual({ status: 'in-queue' });

    proof.resolve(result);
    await draining;

    const status = await client.getProvingJobStatus(current.id);
    expect(status.status).toBe('fulfilled');
    if (status.status !== 'fulfilled') {
      throw new Error('Proof was not reported');
    }
    expect(await store.getProofOutput(status.value)).toEqual({ type: current.type, result });
    expect(signal?.aborted).toBe(false);
    expect(agent.getStatus()).toEqual({ status: 'stopped' });
    expect((await client.getProvingJob())?.job.id).toBe(next.id);
  });
});
