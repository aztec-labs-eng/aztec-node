import { Fr } from '@aztec-labs/foundation/curves/bn254';

import type { TXEOracleFunctionName } from './txe_session.js';
import { TXESession } from './txe_session.js';

describe('TXESession.processFunction', () => {
  let session: TXESession;

  beforeAll(() => {
    session = new TXESession({
      logger: {} as any,
      sessionStore: {} as any,
      stateMachine: {} as any,
      oracleHandler: {} as any,
      contractStore: {} as any,
      noteStore: {} as any,
      keyStore: {} as any,
      addressStore: {} as any,
      accountStore: {} as any,
      senderTaggingStore: {} as any,
      recipientTaggingStore: {} as any,
      taggingSecretSourcesStore: {} as any,
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
});
