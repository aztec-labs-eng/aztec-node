import type { L1TxUtils } from '@aztec-labs/ethereum/l1-tx-utils';
import type { PublisherManager } from '@aztec-labs/ethereum/publisher-manager';
import type { PublicProcessorFactory } from '@aztec-labs/simulator/server';
import type { ProposerTimetable } from '@aztec-labs/stdlib/timetable';
import type { FullNodeCheckpointsBuilder, ValidatorClient } from '@aztec-labs/validator-client';

import { SequencerClient } from '../client/sequencer-client.js';
import type { SequencerPublisherFactory } from '../publisher/sequencer-publisher-factory.js';
import { Sequencer } from '../sequencer/sequencer.js';

class TestSequencer_ extends Sequencer {
  declare public publicProcessorFactory: PublicProcessorFactory;
  declare public timetable: ProposerTimetable;
  declare public publisherFactory: SequencerPublisherFactory;
  declare public validatorClient: ValidatorClient;
  declare public checkpointsBuilder: FullNodeCheckpointsBuilder;
}

export type TestSequencer = TestSequencer_;

class TestSequencerClient_ extends SequencerClient {
  declare public sequencer: TestSequencer;
  declare public publisherManager: PublisherManager<L1TxUtils>;
}

export type TestSequencerClient = TestSequencerClient_;
