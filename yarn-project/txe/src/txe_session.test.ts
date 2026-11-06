import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { Point } from '@aztec-labs/foundation/curves/grumpkin';
import type { MessagingSecretStrategy } from '@aztec-labs/pxe/server';
import { Option } from '@aztec-labs/pxe/simulator';

import { TXE_ORACLE_REGISTRY } from './oracle/txe_oracle_registry.js';
import type { TXEOracleFunctionName } from './txe_session.js';
import { TXESession } from './txe_session.js';

describe('TXESession.processFunction', () => {
  let session: TXESession;

  const makeSession = (oracleHandler: object) =>
    new TXESession({
      logger: {} as any,
      sessionStore: {} as any,
      stateMachine: {} as any,
      oracleHandler: oracleHandler as any,
      contractStore: {} as any,
      noteStore: {} as any,
      keyStore: {} as any,
      addressStore: {} as any,
      accountStore: {} as any,
      senderTaggingStore: {} as any,
      recipientTaggingStore: {} as any,
      messagingSecretSourcesStore: {} as any,
      capsuleStore: {} as any,
      factStore: {} as any,
      privateEventStore: {} as any,
      stagedWriteCoordinator: {} as any,
      operationContributors: [],
      currentChangeSetId: {} as any,
      chainId: new Fr(1),
      version: new Fr(1),
      nextBlockTimestamp: 0n,
      artifactResolver: {} as any,
      rootPath: '',
      packageName: '',
    });

  beforeAll(() => {
    session = makeSession({});
  });

  it('rejects calling a function that does not exist on RPCTranslator with the expected error message', () => {
    const invalidName = 'notARealFunction' as unknown as TXEOracleFunctionName;

    expect(() => session.processFunction(invalidName, [])).toThrow(`Unknown oracle 'notARealFunction'.`);
  });

  it('rejects calling internal translator helpers (handlerAs*) with the expected error message', () => {
    const illegalNames = ['handlerAsMisc', 'handlerAsUtility', 'handlerAsPrivate', 'handlerAsAvm', 'handlerAsTxe'];

    for (const name of illegalNames) {
      expect(() => session.processFunction(name as any, [])).toThrow(`Unknown oracle '${name}'.`);
    }
  });

  it("rejects calling the translator's constructor with the expected error message", () => {
    const invalidName = 'constructor' as unknown as TXEOracleFunctionName;

    expect(() => session.processFunction(invalidName, [])).toThrow(`Unknown oracle 'constructor'.`);
  });

  it('serves the retired aztec_txe_setTaggingSecretStrategies name with the messaging secret strategies handler', async () => {
    const received: Option<MessagingSecretStrategy>[][] = [];
    const txeSession = makeSession({
      isTxe: true,
      setMessagingSecretStrategies: (...strategies: Option<MessagingSecretStrategy>[]) => {
        received.push(strategies);
      },
    });
    const unconstrainedStrategy = Option.some<MessagingSecretStrategy>({
      type: 'arbitrary-secret',
      secret: await Point.random(),
    });
    const constrainedStrategy = Option.none<MessagingSecretStrategy>();
    const [unconstrainedParam, constrainedParam] = TXE_ORACLE_REGISTRY.aztec_txe_setTaggingSecretStrategies.params;
    const inputs = [
      ...unconstrainedParam.type.serialization!.fn(unconstrainedStrategy),
      ...constrainedParam.type.serialization!.fn(constrainedStrategy),
    ].map(field => field.toString());

    await txeSession.processFunction('aztec_txe_setTaggingSecretStrategies', inputs);

    expect(received).toEqual([[unconstrainedStrategy, constrainedStrategy]]);
  });
});
