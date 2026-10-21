import { getSchnorrInitializerlessAccountContractAddress } from '@aztec-labs/accounts/schnorr';
import type { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { getContractInstanceFromInstantiationParams } from '@aztec-labs/aztec.js/contracts';
import { Fr } from '@aztec-labs/aztec.js/fields';
import { FeeJuiceContract } from '@aztec-labs/aztec.js/protocol';
import { describeWithAnvil } from '@aztec-labs/ethereum/test';
import { TokenContract } from '@aztec-labs/noir-contracts.js/Token';
import { deriveMasterMessageSigningSecretKey } from '@aztec-labs/stdlib/keys';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { setupLocalNetwork } from '../testing/local-network.js';
import {
  type ActionStep,
  type ContractStep,
  type Ctx,
  type DeployPlan,
  type DeployReporter,
  type FundStep,
  runDeployment,
} from './index.js';

describeWithAnvil('runDeployment', () => {
  it('publishes a contract, runs an action, and is idempotent on re-run', async () => {
    // Admin account: the runner derives its Schnorr initializerless address from (secret, salt),
    // signing with deriveMasterMessageSigningSecretKey(secret). Pre-derive that same address here
    // so we can pre-fund it at genesis (funded above threshold ⇒ pays from its own Fee Juice, so
    // no SponsoredFPC / no L1 bridge needed to exercise the core).
    const secret = Fr.fromString('0x00000000000000000000000000000000000000000000000000000000deadbeef');
    const salt = new Fr(0);
    const admin = await getSchnorrInitializerlessAccountContractAddress(
      deriveMasterMessageSigningSecretKey(secret),
      salt,
      secret,
    );

    const net = await setupLocalNetwork({ fundedAddresses: [admin] });
    const stateDir = await mkdtemp(join(tmpdir(), 'deploy-test-'));

    // Contract steps as a literal (validated by `satisfies`) so `ctx.instance(alias)` is typed
    // per-alias in the action closures below.
    const contracts = {
      token: {
        kind: 'contract',
        contract: TokenContract,
        deployer: r => r.account('admin'),
        mode: 'publish',
        initializerArgs: r => [r.account('admin'), 'TokenName', 'TKN', 18],
      },
    } satisfies Record<string, ContractStep>;
    type Contracts = typeof contracts;

    const mint = {
      kind: 'action',
      from: r => r.account('admin'),
      dependsOn: ['token'],
      call: ctx => ctx.instance('token').methods.mint_to_public(ctx.account('admin'), 1000n),
      // Idempotent once the admin holds a public balance. Read from public state so a fresh PXE
      // (each run builds a new ephemeral wallet) can evaluate it without private notes.
      done: async ctx => {
        const { result } = await ctx
          .instance('token')
          .methods.balance_of_public(ctx.account('admin'))
          .simulate({ from: ctx.account('admin') });
        return BigInt(result.toString()) > 0n;
      },
    } satisfies ActionStep<Contracts>;

    // Five more same-account actions: together with `mint` they exceed one batch, exercising
    // multi-batch action chunking. They mint to `operator` (declared below), never to admin —
    // defToken's deferred name reads the admin balance, and it must not depend on where these
    // land relative to its resolution.
    const extraMints = Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [
        `mintExtra${i}`,
        {
          kind: 'action',
          from: r => r.account('admin'),
          dependsOn: ['token'],
          call: ctx => ctx.instance('token').methods.mint_to_public(operator, 1n),
          done: async ctx => !(await ctx.ran('token')),
        } satisfies ActionStep<Contracts>,
      ]),
    );

    // Deferred: its name reads runtime state (the token supply `mint` creates), so the address can
    // only resolve once `mint` has run. On a re-run the state is already there, so the framework
    // resolves it at inventory time and discovers it published — nothing to send.
    const defToken = {
      kind: 'contract',
      contract: TokenContract,
      deployer: r => r.account('admin'),
      mode: 'publish',
      dependsOn: ['mint', 'token'],
      deferredInitializerArgs: async ctx => {
        const { result } = await TokenContract.at(ctx.contract('token'), ctx.wallet)
          .methods.balance_of_public(ctx.account('admin'))
          .simulate({ from: ctx.account('admin') });
        return [ctx.account('admin'), `Supply${result.toString()}`, 'DEF', 18];
      },
    } satisfies ContractStep;

    // Gated on `ran`: runs exactly when `defToken` publishes this run (the documented pattern for
    // "seed a fresh contract"), so it must see the deferred publish as work done this run.
    const mintDef = {
      kind: 'action',
      from: r => r.account('admin'),
      dependsOn: ['defToken'],
      call: ctx =>
        TokenContract.at(ctx.contract('defToken'), ctx.wallet).methods.mint_to_public(ctx.account('admin'), 7n),
      done: async ctx => !(await ctx.ran('defToken')),
    } satisfies ActionStep;

    // Provision an address that is NOT a sender in this run — the representative case (funding an
    // FPC, or an operator account so it can pay for its own txs later): L1 bridge via anvil's dev
    // key + faucet, warp until the message is available, then a claim tx sent from admin.
    const FUND_AMOUNT = 5n * 10n ** 18n;
    const operatorSecret = Fr.fromString('0x00000000000000000000000000000000000000000000000000000000cafe0001');
    const operator = await getSchnorrInitializerlessAccountContractAddress(
      deriveMasterMessageSigningSecretKey(operatorSecret),
      salt,
      operatorSecret,
    );
    const fundOperator = {
      kind: 'fund',
      recipient: () => operator,
      threshold: 1n,
      amount: FUND_AMOUNT,
      from: r => r.account('admin'),
      // The fixture's anvil binds a random port, so the local defaults don't apply.
      l1RpcUrl: net.l1RpcUrl,
      l1ChainId: net.l1ChainId,
    } satisfies FundStep;

    let tokenAddress: string | undefined;
    let mintedBalance: bigint | undefined;
    let defBalance: bigint | undefined;
    let operatorFeeJuice: bigint | undefined;
    // Uses only string-based accessors, so it stays valid whatever the inferred steps generic is.
    const capture = async (ctx: Ctx) => {
      const address = ctx.contract('token');
      tokenAddress = address.toString();
      const { result } = await TokenContract.at(address, ctx.wallet)
        .methods.balance_of_public(ctx.account('admin'))
        .simulate({ from: ctx.account('admin') });
      mintedBalance = BigInt(result.toString());
      const { result: defResult } = await TokenContract.at(ctx.contract('defToken'), ctx.wallet)
        .methods.balance_of_public(ctx.account('admin'))
        .simulate({ from: ctx.account('admin') });
      defBalance = BigInt(defResult.toString());
      const { result: feeJuiceResult } = await FeeJuiceContract.at(ctx.wallet)
        .methods.balance_of_public(operator)
        .simulate({ from: ctx.account('admin') });
      operatorFeeJuice = BigInt(feeJuiceResult.toString());
    };

    const base = {
      node: net.node,
      local: true,
      label: 'test',
      stateDir,
      accounts: { admin: { secret, salt } },
      // Admin is genesis-funded well above this threshold ⇒ "funded" ⇒ pays from balance (no bridge).
      fees: { kind: 'fee-juice', threshold: 1n, fundAmount: 0n } as const,
      steps: { ...contracts, mint, ...extraMints, defToken, mintDef, fundOperator },
      output: capture,
    };

    try {
      // First run: publishes the token, mints, publishes the deferred contract, seeds it, and
      // funds the operator address with bridged Fee Juice.
      await runDeployment({ ...base, reporter: {} });
      expect(tokenAddress).toBeDefined();
      expect(mintedBalance).toEqual(1000n);
      expect(defBalance).toEqual(7n);
      // The local faucet's mint amount wins over the requested amount, so assert the floor only.
      expect(operatorFeeJuice).toBeGreaterThanOrEqual(FUND_AMOUNT);

      // Second run against the same state + chain: everything is already on-chain — including the
      // deferred contract, whose args now resolve at inventory time, and the funded recipient,
      // whose balance clears the threshold — so nothing runs.
      let nothingToDo = false;
      const reporter: DeployReporter = { onNothingToDo: () => (nothingToDo = true) };
      await runDeployment({ ...base, reporter });
      expect(nothingToDo).toBe(true);
      expect(defBalance).toEqual(7n);

      // A gate reading a contract it doesn't declare is rejected even though the read succeeds here
      // (token is on-chain) and even though the gate swallows its own errors — nothing checked the
      // contract was in place before the read.
      const undeclared = {
        kind: 'action',
        from: r => r.account('admin'),
        dependsOn: [],
        call: ctx => TokenContract.at(ctx.contract('token'), ctx.wallet).methods.mint_to_public(operator, 1n),
        done: async ctx => {
          try {
            const { result } = await TokenContract.at(ctx.contract('token'), ctx.wallet)
              .methods.balance_of_public(ctx.account('admin'))
              .simulate({ from: ctx.account('admin') });
            return BigInt(result.toString()) > 0n;
          } catch {
            return false;
          }
        },
      } satisfies ActionStep;
      await expect(runDeployment({ ...base, reporter: {}, steps: { ...base.steps, undeclared } })).rejects.toThrow(
        /Idempotency gate for action "undeclared" reads "token" but does not declare it in dependsOn/,
      );

      // The same holds for the interaction an action builds: its target is undeclared, so nothing
      // ordered the action after it. Rejected before the tx is sent.
      const undeclaredCall = {
        kind: 'action',
        from: r => r.account('admin'),
        dependsOn: [],
        call: ctx => TokenContract.at(ctx.contract('token'), ctx.wallet).methods.mint_to_public(operator, 1n),
        done: () => Promise.resolve(false),
      } satisfies ActionStep;
      await expect(runDeployment({ ...base, reporter: {}, steps: { ...base.steps, undeclaredCall } })).rejects.toThrow(
        /Call for action "undeclaredCall" reads "token" but does not declare it in dependsOn/,
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
      await net.stop();
    }
  }, 300_000);

  it('evaluates inventory gates independently of step declaration order', async () => {
    const secret = Fr.fromString('0x00000000000000000000000000000000000000000000000000000000c0ffee01');
    const salt = new Fr(0);
    const admin = await getSchnorrInitializerlessAccountContractAddress(
      deriveMasterMessageSigningSecretKey(secret),
      salt,
      secret,
    );
    const operatorSecret = Fr.fromString('0x00000000000000000000000000000000000000000000000000000000c0ffee02');
    const operator = await getSchnorrInitializerlessAccountContractAddress(
      deriveMasterMessageSigningSecretKey(operatorSecret),
      salt,
      operatorSecret,
    );

    const net = await setupLocalNetwork({ fundedAddresses: [admin] });
    const stateDir = await mkdtemp(join(tmpdir(), 'deploy-test-'));

    const publicBalance = async (ctx: Ctx, alias: string, owner: AztecAddress) => {
      const { result } = await TokenContract.at(ctx.contract(alias), ctx.wallet)
        .methods.balance_of_public(owner)
        .simulate({ from: ctx.account('admin') });
      return BigInt(result.toString());
    };

    // Declared before the steps it depends on: inventory checks `later` while `seed`'s gate still waits
    // on `early`, a deferred contract that has not been looked at yet.
    const later = {
      kind: 'contract',
      contract: TokenContract,
      deployer: r => r.account('admin'),
      mode: 'publish',
      dependsOn: ['seed', 'early'],
      deferredInitializerArgs: async ctx => [
        ctx.account('admin'),
        `Later${await publicBalance(ctx, 'early', ctx.account('admin'))}`,
        'LTR',
        18,
      ],
    } satisfies ContractStep;
    const seed = {
      kind: 'action',
      from: r => r.account('admin'),
      dependsOn: ['early'],
      call: ctx => TokenContract.at(ctx.contract('early'), ctx.wallet).methods.mint_to_public(ctx.account('admin'), 5n),
      done: async ctx => (await publicBalance(ctx, 'early', ctx.account('admin'))) > 0n,
    } satisfies ActionStep;
    const early = {
      kind: 'contract',
      contract: TokenContract,
      deployer: r => r.account('admin'),
      mode: 'publish',
      dependsOn: [],
      deferredInitializerArgs: r => [r.account('admin'), 'Early', 'ERL', 18],
    } satisfies ContractStep;

    const units: string[] = [];
    const reporter: DeployReporter = { onUnitStart: unit => units.push(unit.label) };
    const base = {
      node: net.node,
      local: true,
      label: 'test',
      stateDir,
      accounts: { admin: { secret, salt } },
      fees: { kind: 'fee-juice', threshold: 1n, fundAmount: 0n } as const,
      reporter,
    };

    try {
      await runDeployment({ ...base, steps: { later, seed, early } });
      expect(units).toEqual(expect.arrayContaining(['publish early', 'action seed', 'publish later']));

      // Everything is in place, so a re-run sends nothing — `seed` included, though `later` reached
      // its gate before `early` had resolved.
      units.length = 0;
      await runDeployment({ ...base, steps: { later, seed, early } });
      expect(units).toEqual([]);

      // A gate asking whether a fund step runs this run must get the answer before fund inventory
      // would have reached it: `funded` checks `afterFund`'s gate while contracts are still being
      // inventoried, and `afterFund` runs because `fundOperator` does.
      const fundOperator = {
        kind: 'fund',
        recipient: () => operator,
        threshold: 1n,
        amount: 10n ** 18n,
        from: r => r.account('admin'),
        l1RpcUrl: net.l1RpcUrl,
        l1ChainId: net.l1ChainId,
      } satisfies FundStep;
      const afterFund = {
        kind: 'action',
        from: r => r.account('admin'),
        dependsOn: ['fundOperator', 'early'],
        call: ctx => TokenContract.at(ctx.contract('early'), ctx.wallet).methods.mint_to_public(operator, 1n),
        done: async ctx => !(await ctx.ran('fundOperator')),
      } satisfies ActionStep;
      const funded = {
        kind: 'contract',
        contract: TokenContract,
        deployer: r => r.account('admin'),
        mode: 'publish',
        dependsOn: ['afterFund'],
        deferredInitializerArgs: r => [r.account('admin'), 'Funded', 'FND', 18],
      } satisfies ContractStep;
      units.length = 0;
      await runDeployment({ ...base, steps: { early, seed, later, funded, fundOperator, afterFund } });
      expect(units).toEqual(expect.arrayContaining(['fund fundOperator', 'action afterFund', 'publish funded']));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
      await net.stop();
    }
  }, 300_000);

  it('auto-derives interdependencies, dedupes a shared class, registers privately, and deploys universally', async () => {
    const secret = Fr.fromString('0x00000000000000000000000000000000000000000000000000000000feedface');
    const salt = new Fr(0);
    const admin = await getSchnorrInitializerlessAccountContractAddress(
      deriveMasterMessageSigningSecretKey(secret),
      salt,
      secret,
    );

    const net = await setupLocalNetwork({ fundedAddresses: [admin] });
    const stateDir = await mkdtemp(join(tmpdir(), 'deploy-test-'));

    const contracts = {
      token: {
        kind: 'contract',
        contract: TokenContract,
        deployer: r => r.account('admin'),
        mode: 'publish',
        initializerArgs: r => [r.account('admin'), 'GoCoin', 'GO', 18],
      },
      // Same class as `token` (so the class is published exactly once, the rest skip it). Its
      // "admin" arg is `token`'s address, so the framework auto-derives a dependency on `token`
      // and resolves that address upfront.
      token2: {
        kind: 'contract',
        contract: TokenContract,
        deployer: r => r.account('admin'),
        mode: 'publish',
        initializerArgs: r => [r.contract('token'), 'GoCoinPremium', 'GOP', 18],
      },
      // Register-only: derive the deterministic address + register in the PXE, no tx.
      regToken: {
        kind: 'contract',
        contract: TokenContract,
        deployer: r => r.account('admin'),
        mode: 'register',
        initializerArgs: r => [r.account('admin'), 'Reg', 'REG', 18],
      },
      // Universal: `from` sends and pays, but the address preimage omits it.
      uniToken: {
        kind: 'contract',
        contract: TokenContract,
        from: r => r.account('admin'),
        mode: 'publish',
        universal: true,
        initializerArgs: r => [r.account('admin'), 'Universal', 'UNI', 18],
      },
    } satisfies Record<string, ContractStep>;

    const addresses: Record<string, string> = {};
    const capture = (ctx: Ctx) => {
      for (const alias of ['token', 'token2', 'regToken', 'uniToken']) {
        addresses[alias] = ctx.contract(alias).toString();
      }
    };

    const base = {
      node: net.node,
      local: true,
      label: 'test',
      stateDir,
      accounts: { admin: { secret, salt } },
      fees: { kind: 'fee-juice', threshold: 1n, fundAmount: 0n } as const,
      steps: contracts,
      output: capture,
    };

    try {
      let plan: DeployPlan | undefined;
      await runDeployment({ ...base, reporter: { onPlan: p => (plan = p) } });

      // Interdependency: token2's args reference token, so its dependency is auto-derived.
      expect(plan?.steps.find(s => s.id === 'token2')?.dependsOn).toContain('token');
      // All four resolved to distinct deterministic addresses.
      expect(new Set(Object.values(addresses)).size).toBe(4);
      // The register step must honor its declared deployer in the derivation — the registered
      // address has to match what publishing the same spec (deployer included) would produce.
      const expectedRegToken = await getContractInstanceFromInstantiationParams(TokenContract.artifact, {
        salt: new Fr(0),
        constructorArgs: [admin, 'Reg', 'REG', 18],
        deployer: admin,
      });
      expect(addresses.regToken).toEqual(expectedRegToken.address.toString());
      // The universal step's address must omit the deployer from the preimage.
      const expectedUniToken = await getContractInstanceFromInstantiationParams(TokenContract.artifact, {
        salt: new Fr(0),
        constructorArgs: [admin, 'Universal', 'UNI', 18],
      });
      expect(addresses.uniToken).toEqual(expectedUniToken.address.toString());

      // Idempotent re-run: both publishes are on-chain and the register step sends no tx, so the
      // whole graph is a no-op. (A broken shared-class dedup would have thrown on the first run.)
      let nothingToDo = false;
      await runDeployment({ ...base, reporter: { onNothingToDo: () => (nothingToDo = true) } });
      expect(nothingToDo).toBe(true);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
      await net.stop();
    }
  }, 300_000);
});
