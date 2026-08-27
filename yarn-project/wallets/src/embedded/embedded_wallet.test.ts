import { NO_FROM } from '@aztec-labs/aztec.js/account';
import type { Aliased } from '@aztec-labs/aztec.js/wallet';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import type { PXE } from '@aztec-labs/pxe/server';
import { FunctionCall, FunctionSelector, FunctionType } from '@aztec-labs/stdlib/abi';
import { AztecAddress } from '@aztec-labs/stdlib/aztec-address';
import { Gas, GasFees } from '@aztec-labs/stdlib/gas';
import type { AztecNode } from '@aztec-labs/stdlib/interfaces/client';
import type { PrivateKernelTailCircuitPublicInputs } from '@aztec-labs/stdlib/kernel';
import {
  ExecutionPayload,
  PrivateCallExecutionResult,
  PrivateExecutionResult,
  TxSimulationResult,
} from '@aztec-labs/stdlib/tx';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { AccountContractsProvider } from './account-contract-providers/types.js';
import { EmbeddedWallet } from './embedded_wallet.js';
import type { WalletDB } from './wallet_db.js';

describe('EmbeddedWallet', () => {
  let pxe: PXE;
  let node: AztecNode;
  let wallet: TestWallet;
  let simulateTx: jest.MockedFunction<PXE['simulateTx']>;
  let proveTx: jest.MockedFunction<PXE['proveTx']>;
  let sync: jest.MockedFunction<PXE['sync']>;
  let getPredictedMinFees: jest.MockedFunction<AztecNode['getPredictedMinFees']>;
  let getNodeInfo: jest.MockedFunction<AztecNode['getNodeInfo']>;

  beforeEach(() => {
    simulateTx = jest.fn();
    proveTx = jest.fn();
    sync = jest.fn<PXE['sync']>().mockResolvedValue(undefined);
    getPredictedMinFees = jest.fn();
    getNodeInfo = jest.fn();
    pxe = { simulateTx, proveTx, sync } as unknown as PXE;
    node = { getPredictedMinFees, getNodeInfo } as unknown as AztecNode;
    wallet = new TestWallet(pxe, node, {} as WalletDB, {} as AccountContractsProvider);
  });

  describe('sendTx', () => {
    it('passes sendMessagesAs as senderForTags and includes it in scopes for PXE simulation', async () => {
      getPredictedMinFees.mockResolvedValue([new GasFees(2, 2)]);
      getNodeInfo.mockResolvedValue({
        l1ChainId: 1,
        rollupVersion: 1,
        txsLimits: { gas: { daGas: 117_668, l2Gas: 6_540_000 } },
      } as any);
      simulateTx.mockResolvedValue(makeMinimalSimResult());
      proveTx.mockRejectedValue(new Error('stop-at-prove'));

      const sendMessagesAs = await AztecAddress.random();
      const call = FunctionCall.from({
        name: 'test',
        to: await AztecAddress.random(),
        selector: FunctionSelector.random(),
        type: FunctionType.PRIVATE,
        hideMsgSender: false,
        isStatic: false,
        args: [],
      });
      const payload = new ExecutionPayload([call], [], []);

      await expect(wallet.sendTx(payload, { from: NO_FROM, sendMessagesAs })).rejects.toThrow('stop-at-prove');

      expect(simulateTx).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          senderForTags: sendMessagesAs,
          scopes: expect.arrayContaining([sendMessagesAs]),
        }),
      );
    });

    it('rejects caller-provided gas limits above the network admission limit', async () => {
      getPredictedMinFees.mockResolvedValue([new GasFees(2, 2)]);
      getNodeInfo.mockResolvedValue({
        l1ChainId: 1,
        rollupVersion: 1,
        txsLimits: { gas: { daGas: 1000, l2Gas: 2000 } },
      } as any);
      simulateTx.mockResolvedValue(makeMinimalSimResult());
      proveTx.mockRejectedValue(new Error('stop-at-prove'));

      const call = FunctionCall.from({
        name: 'test',
        to: await AztecAddress.random(),
        selector: FunctionSelector.random(),
        type: FunctionType.PRIVATE,
        hideMsgSender: false,
        isStatic: false,
        args: [],
      });
      const payload = new ExecutionPayload([call], [], []);

      await expect(
        wallet.sendTx(payload, {
          from: NO_FROM,
          fee: { gasSettings: { gasLimits: Gas.from({ daGas: 5000, l2Gas: 2000 }) } },
        }),
      ).rejects.toThrow('Declared DA gas limit (5000) exceeds the maximum this network allows per tx (1000)');
    });
  });
});

class TestWallet extends EmbeddedWallet {
  override getAccounts(): Promise<Aliased<AztecAddress>[]> {
    return Promise.resolve([]);
  }
}

function makeMinimalSimResult(): TxSimulationResult {
  const entrypoint = { offchainEffects: [], nestedExecutionResults: [] } as unknown as PrivateCallExecutionResult;
  const privateResult = new PrivateExecutionResult(entrypoint, Fr.zero(), []);
  const publicInputs = { gasUsed: Gas.empty() } as unknown as PrivateKernelTailCircuitPublicInputs;
  return new TxSimulationResult(privateResult, publicInputs);
}
