#!/usr/bin/env node
// Runs a forge deploy script against the foundry bundle shipped in
// @aztec-foundation/l1-artifacts. Requires yarn-project to be built.
//
// The artifact copy and Forge run share a process so cleanup happens only after
// Forge exits. Failed broadcasts retain their artifacts for recovery.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ethereumDest = join(repoRoot, "yarn-project", "ethereum", "dest");
const {
  prepareL1ContractsForDeployment,
  getForgeBroadcastArgs,
  getForgeBroadcastTimeout,
  runProcess,
} = await import(
  pathToFileURL(join(ethereumDest, "deploy_aztec_l1_contracts.js"))
);
const { resolveFoundryBinary } = await import(
  pathToFileURL(join(ethereumDest, "foundry_binary.js"))
);
const { getPublicClient } = await import(
  pathToFileURL(join(ethereumDest, "client.js"))
);

const args = process.argv.slice(2);
const rpcUrlIndex = args.indexOf("--rpc-url");
const rpcUrl = rpcUrlIndex >= 0 ? args[rpcUrlIndex + 1] : undefined;
if (!rpcUrl || rpcUrl.startsWith("--")) {
  throw new Error("--rpc-url is required");
}
// Only eth_chainId is queried; no chain-specific transaction formatting is used.
const client = getPublicClient({ l1RpcUrls: [rpcUrl], l1ChainId: 1 });
const chainId = await client.getChainId();
const timeout = getForgeBroadcastTimeout(chainId);
const projectDir = prepareL1ContractsForDeployment();
try {
  await runProcess(
    resolveFoundryBinary("forge"),
    ["script", ...args, ...getForgeBroadcastArgs(projectDir, chainId)],
    { FOUNDRY_PROFILE: chainId === 1 ? "production" : undefined },
    projectDir,
    timeout,
  );
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
