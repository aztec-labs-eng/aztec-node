import { defineConfig, loadEnv, searchForWorkspaceRoot, Plugin, ResolvedConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import fs from 'fs';
import { builtinModules } from 'module';
import path from 'path';

// Only required for alternative bb wasm file, left as reference
//import { viteStaticCopy } from 'vite-plugin-static-copy';

/**
 * Lightweight chunk size validator plugin
 * Checks chunk sizes after build completes and fails if limits are exceeded
 */
interface ChunkSizeLimit {
  /** Pattern to match chunk file names (e.g., /assets\/index-.*\.js$/) */
  pattern: RegExp;
  /** Maximum size in kilobytes */
  maxSizeKB: number;
  /** Optional description for logging */
  description?: string;
}

const chunkSizeValidator = (limits: ChunkSizeLimit[]): Plugin => {
  let config: ResolvedConfig;

  return {
    name: 'chunk-size-validator',
    enforce: 'post',
    apply: 'build',
    configResolved(resolvedConfig) {
      config = resolvedConfig;
    },
    // `writeBundle` is documented to fire AFTER the output bundle has been
    // written to disk, whereas `closeBundle` (which we used previously) is the
    // last hook to run and can fire before any chunks have been flushed in
    // current vite/rollup versions — manifesting as ENOENT on `scandir 'dist'`
    // for a build that otherwise transformed all modules cleanly.
    writeBundle() {
      const outDir = this.meta?.watchMode ? null : 'dist';
      if (!outDir) return; // Skip in watch mode

      const logger = config.logger;
      const violations: string[] = [];
      const checkDir = (dir: string, baseDir: string = '') => {
        const files = fs.readdirSync(dir);

        for (const file of files) {
          const filePath = path.join(dir, file);
          const relativePath = path.join(baseDir, file);
          const stat = fs.statSync(filePath);

          if (stat.isDirectory()) {
            checkDir(filePath, relativePath);
          } else if (stat.isFile()) {
            const sizeKB = stat.size / 1024;

            for (const limit of limits) {
              if (limit.pattern.test(relativePath)) {
                const desc = limit.description ? ` (${limit.description})` : '';
                logger.info(`  ${relativePath}: ${sizeKB.toFixed(2)} KB / ${limit.maxSizeKB} KB${desc}`);

                if (sizeKB > limit.maxSizeKB) {
                  violations.push(
                    `  ❌ ${relativePath}: ${sizeKB.toFixed(2)} KB exceeds limit of ${limit.maxSizeKB} KB${desc}`,
                  );
                }
              }
            }
          }
        }
      };

      logger.info('\n📦 Validating chunk sizes...');
      checkDir(path.resolve(process.cwd(), outDir));

      if (violations.length > 0) {
        logger.error('\n❌ Chunk size validation failed:\n');
        violations.forEach(v => logger.error(v));
        logger.error('\n');
        throw new Error('Build failed: chunk size limits exceeded');
      } else {
        logger.info('✅ All chunks within size limits\n');
      }
    },
  };
};

/**
 * Imports of Node.js builtin modules that are harmless in a browser, where such a module resolves to an empty one.
 * Each entry names the importing file by the end of its path, and the builtin it imports.
 */
const TOLERATED_NODE_BUILTIN_IMPORTS: { importer: string; builtin: string }[] = [
  // Checks that `tty.isatty` exists before calling it.
  { importer: '/node_modules/colorette/index.js', builtin: 'tty' },
  // Opens a socket to an SSH agent only when asked to sign with one, which a browser cannot do.
  { importer: '/accounts/dest/utils/ssh_agent.js', builtin: 'net' },
  // Opens a server only when asked for a free port, which tests on Node.js do.
  { importer: '/foundation/dest/testing/port_allocator.js', builtin: 'net' },
];

/**
 * Fails the build on an undeclared Node.js builtin import.
 *
 * Such an import only resolves here because this workspace happens to install a package named like the builtin, so
 * it breaks the build of an app that installs the importing package on its own. An entry of
 * `TOLERATED_NODE_BUILTIN_IMPORTS` that no import matches fails the build too, so the list cannot go stale.
 */
const nodeBuiltinImportValidator = (): Plugin => {
  const importersByViolation = new Map<string, Set<string>>();
  const matchedTolerations = new Set<(typeof TOLERATED_NODE_BUILTIN_IMPORTS)[number]>();

  const packageOf = (file: string): { name: string; dependencies: Record<string, string> } => {
    for (let dir = path.dirname(file); dir !== path.dirname(dir); dir = path.dirname(dir)) {
      const manifestPath = path.join(dir, 'package.json');
      if (fs.existsSync(manifestPath)) {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        // Build output can hold manifests that only set the module type; the package is the one with a name.
        if (manifest.name) {
          return {
            name: manifest.name,
            dependencies: { ...manifest.dependencies, ...manifest.peerDependencies, ...manifest.optionalDependencies },
          };
        }
      }
    }
    return { name: file, dependencies: {} };
  };

  return {
    name: 'node-builtin-import-validator',
    enforce: 'pre',
    apply: 'build',
    resolveId(source, importer) {
      const builtin = source.replace(/^node:/, '').split('/')[0];
      if (!importer || !builtinModules.includes(builtin)) {
        return null;
      }
      const importerFile = importer.split('?')[0];
      const toleration = TOLERATED_NODE_BUILTIN_IMPORTS.find(
        tolerated => tolerated.builtin === builtin && importerFile.endsWith(tolerated.importer),
      );
      if (toleration) {
        matchedTolerations.add(toleration);
        return null;
      }
      const { name, dependencies } = packageOf(importerFile);
      if (source.startsWith('node:') || !(builtin in dependencies)) {
        const violation = `${name} imports '${source}'`;
        importersByViolation.set(violation, (importersByViolation.get(violation) ?? new Set()).add(importerFile));
      }
      return null;
    },
    buildEnd() {
      if (importersByViolation.size > 0) {
        const violations = [...importersByViolation].map(
          ([violation, importers]) => `  ${violation} in:\n${[...importers].map(file => `    ${file}`).join('\n')}`,
        );
        throw new Error(`Node.js builtin modules imported without a declared dependency:\n${violations.join('\n')}`);
      }
      const unmatched = TOLERATED_NODE_BUILTIN_IMPORTS.filter(tolerated => !matchedTolerations.has(tolerated));
      if (unmatched.length > 0) {
        const entries = unmatched.map(({ importer, builtin }) => `  '${builtin}' in ${importer}`);
        throw new Error(`Tolerated imports of Node.js builtin modules that no longer exist:\n${entries.join('\n')}`);
      }
    },
  };
};

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    base: './',
    logLevel: process.env.CI ? 'error' : undefined,
    server: {
      // Headers needed for bb WASM to work in multithreaded mode
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      },
      // Allow vite to serve files from these directories, since they are symlinked
      // These are the protocol circuit artifacts and bb WASMs.
      fs: {
        allow: [searchForWorkspaceRoot(process.cwd()), '../yarn-project/noir-protocol-circuits-types/artifacts'],
      },
    },
    plugins: [
      react({ jsxImportSource: '@emotion/react' }),
      nodeBuiltinImportValidator(),
      // This is unnecessary unless BB_WASM_PATH is defined (default would be /assets/barretenberg.wasm.gz)
      // Left as an example of how to use a different bb wasm file than the default lazily loaded one
      // viteStaticCopy({
      //   targets: [
      //     {
      //       src: '../barretenberg/cpp/build-wasm-threads/bin/*.wasm',
      //       dest: 'assets/',
      //     },
      //   ],
      // }),
      chunkSizeValidator([
        // Bump log:
        // - AD: bumped from 1600 => 1680 as we now have a 20kb msgpack lib in bb.js and other logic got us 50kb higher, adding some wiggle room.
        // - MW: bumped from 1700 => 1750 after adding the noble curves pkg to foundation required for blob batching calculations.
        // - 2026-05-08: bumped from 1750 => 1800 after merge of next into merge-train/fairies brought in barretenberg changes (optimized Poseidon2, n1 apps) that nudged bb.js over the prior limit (1750.02 KB).
        // - JB: bumped from 1750 => 1800 after adding the `aztec_utl_getTxEffect` oracle handler, which pulls TxEffect / FlatPublicLogs / PrivateLog / PublicDataWrite into the eager PXE import path (#22979).
        // - 2026-05-12: bumped from 1800 => 1850 after merge-train/barretenberg brought in further bb-side changes (multi-app kernel circuits #23076 etc.) that pushed the main entrypoint to 1801.31 KB, just over the limit raised four days earlier.
        // - 2026-06-08: bumped from 1850 => 1925 after aztec RPC namespace / client surface changes pushed the main entrypoint to 1872.57 KB on CI (playground cold build).
        // - 2026-07-17: bumped from 1925 => 1960 after the fast-inbox per-block L1-to-L2 message bundle changes to the rollup circuit artifacts pushed the main entrypoint to 1936.60 KB on CI.
        {
          pattern: /assets\/index-.*\.js$/,
          maxSizeKB: 1960,
          description: 'Main entrypoint, hard limit',
        },
        // Bump log:
        // - Dec 2025: bumped from 4000 => 4500 as SimpleToken artifact grew to ~4485 KB causing CI build failures. This
        // raise in artifact size was caused by the BalanceSet state variable being moved to a separate crate in this
        // PR: https://github.com/AztecProtocol/aztec-packages/pull/18782.
        // Not sure why this triggered raise in artifact size, but will not deal with this now as Grego's feedback is
        // greatly needed here.
        // - Dec 2025: bumped from 4500 --> 4600 as SimpleToken grew a bit again.
        // PR: https://github.com/AztecProtocol/aztec-packages/pull/18815
        // - 2026-06-18: bumped from 4600 => 4700 after rebuilding the bb.js browser package at its new
        //   barretenberg/ts/bb.js path produced assets/barretenberg-*.js at 4641.65 KB.
        // - 2026-07-02: bumped to 5000 after merging from public to private repo resulted in 4800+k for some reason.
        // - 2026-07-04: bumped from 5000 => 5300 after bb changes on merge-train/barretenberg grew
        //   assets/barretenberg-*.js to 5079.12 KB and assets/barretenberg-threads-*.js to 5116.65 KB.
        {
          pattern: /.*/,
          maxSizeKB: 5350,
          description: 'Detect if json artifacts or bb.js wasm get out of control',
        },
      ]),
    ],
    define: {
      'process.env': JSON.stringify({
        LOG_LEVEL: env.LOG_LEVEL,
        // The path to a custom WASM file for bb.js.
        // Only the single-threaded file name is needed, the multithreaded file name will be inferred
        // by adding the -threads suffix: e.g: /assets/barretenberg.wasm.gz -> /assets/barretenberg-threads.wasm.gz
        // Files can be compressed or uncompressed, but must be gzipped if compressed.
        BB_WASM_PATH: env.BB_WASM_PATH,
      }),
    },
  };
});
