#!/usr/bin/env node
// Print the transitive TypeScript dependency closure of one or more test (or source) files.
//
// Usage: node scripts/test-deps.mjs [--all] [--diff-excluded] <path/to/foo.test.ts> [more files...]
//        node scripts/test-deps.mjs --check
//
// Files are grouped by their containing package's tsconfig and one ts.Program is built per
// group, so sweeping a whole package costs about the same as a single file (~2s). Each
// input's individual closure is then recovered with a BFS over the program's per-file
// resolved-import tables. Module resolution matches the compiler's: in-package imports
// resolve to src/*.ts, cross-package imports resolve through package.json exports to the
// dependency's dest/*.d.ts; those dest paths are mapped back to the src/*.ts they were
// compiled from when it exists.
//
// Dependencies the compiler cannot see (non-literal dynamic imports, worker entry points,
// forked scripts) are declared at the loading site with a structured comment:
//
//   // @dependency <path-or-glob>[, <path-or-glob>...]
//
// Semantics: file-scoped (the containing file additionally depends on the matched files),
// paths relative to the containing file, globs supported. TypeScript targets are walked
// transitively (they join the program as extra roots); other targets (JSON, binaries,
// bundles) are included as closure leaves. `--check` scans all yarn-project sources and
// fails if a non-literal dynamic import, `new Worker(...)`, or child_process `fork(...)`
// site has no @dependency annotation in its file, or if an annotation matches nothing.
// createRequire/require.resolve of npm packages are deliberately not flagged: those resolve
// into version-pinned packages already covered by yarn.lock.
//
// node_modules files are never parsed: the compiler host hands the program an empty stub
// SourceFile for any /node_modules/ path. This is safe because module *resolution* does not go
// through the parser (the resolver reads package.json and probes file existence via the host),
// and because node_modules files cannot pull repo files into a closure — workspace packages are
// reached at their realpaths (yarn symlinks are resolved by the compiler), never via
// /node_modules/. Repo closures are therefore identical to a full parse, while the bulk of a
// program's text (dependency .d.ts trees such as viem's) is skipped. The one visible effect:
// node_modules dependencies appear only as direct-import leaves — their transitive imports are
// not enumerated (for cache purposes they are covered by yarn.lock), so the "node_modules
// files" counts are of direct imports only.
//
// By default only repo files are printed; node_modules files are summarized on stderr
// (--all lists them too). With --diff-excluded, every package touched by a closure is shown
// exhaustively as a diff: "+ file" for included, "- file" for that package's source files the
// closure does NOT reach (other packages' *.test.ts files are left out of the "-" side — tests
// never depend on each other's test files). Ambient types injected program-wide by tsconfig
// types/typeRoots are excluded from closures — they are a per-package constant, not per-test
// signal. Runtime reads (fs, spawned binaries, non-literal paths without annotations) remain
// invisible.
//
// Uses two internal-but-stable compiler APIs (SourceFile.imports and
// Program.getResolvedModule, present in TS 5.x); the script fails loudly if either is gone.
import { existsSync, readFileSync, readdirSync } from 'fs';
import path from 'path';
import ts from 'typescript';

const args = process.argv.slice(2);
const all = args.includes('--all');
const diffExcluded = args.includes('--diff-excluded');
const checkMode = args.includes('--check');
const files = args.filter(a => !a.startsWith('--'));

if (files.length === 0 && !checkMode) {
  console.error('Usage: node scripts/test-deps.mjs [--all] [--diff-excluded] <file.ts> [more files...]');
  console.error('       node scripts/test-deps.mjs --check');
  console.error('  --all            also list node_modules dependencies');
  console.error('  --diff-excluded  show touched packages exhaustively: "+ included" / "- not included"');
  console.error('  --check          verify dynamic-load sites carry a // @dependency annotation');
  process.exit(1);
}

const repoRoot = path.resolve(import.meta.dirname, '../..');

const destToSrcCache = new Map();
function destToSrc(file) {
  if (!destToSrcCache.has(file)) {
    const m = /^(.*)\/dest\/(.*)\.d\.ts$/.exec(file);
    const src = m && `${m[1]}/src/${m[2]}.ts`;
    destToSrcCache.set(file, src && existsSync(src) ? src : file);
  }
  return destToSrcCache.get(file);
}

// ---------------------------------------------------------------------------
// @dependency annotations
// ---------------------------------------------------------------------------

const ANNOTATION_RE = /^\s*\/\/\s*@dependency\s+(.+)$/gm;

// Expand one annotation spec relative to `dir`. Returns absolute paths; empty = dangling.
function expandDependencySpec(dir, spec) {
  if (/[*?{]/.test(spec)) {
    return ts.sys.readDirectory(dir, undefined, [], [spec]).map(f => path.resolve(f));
  }
  const p = path.resolve(dir, spec);
  return existsSync(p) ? [p] : [];
}

// Absolute targets declared by @dependency comments in `file` (cached). Dangling specs
// warn on stderr in the normal flow; --check turns them into failures.
const annotationCache = new Map();
function annotationTargets(file) {
  if (!annotationCache.has(file)) {
    const out = [];
    if (existsSync(file)) {
      const dir = path.dirname(file);
      for (const m of readFileSync(file, 'utf8').matchAll(ANNOTATION_RE)) {
        for (const spec of m[1]
          .split(',')
          .map(s => s.trim())
          .filter(Boolean)) {
          const matches = expandDependencySpec(dir, spec);
          if (matches.length === 0) {
            console.error(`WARNING: @dependency matches nothing: '${spec}' (in ${path.relative(repoRoot, file)})`);
          }
          out.push(...matches);
        }
      }
    }
    annotationCache.set(file, out);
  }
  return annotationCache.get(file);
}

// ---------------------------------------------------------------------------
// --check: dynamic-load sites must be annotated; annotations must resolve
// ---------------------------------------------------------------------------

// A file can only produce a --check violation if its text contains one of these triggers
// (dynamic import, worker construction, fork, or an annotation to validate). This is a
// conservative superset of what the AST scan detects, and lets ~95% of files skip parsing.
const CHECK_TRIGGER_RE = /import\s*\(|new\s+Worker|\bfork\b|@dependency/;

function runCheck() {
  const srcFiles = ts.sys.readDirectory(
    path.join(repoRoot, 'yarn-project'),
    ['.ts'],
    ['**/node_modules/**', '**/dest/**'],
    ['*/src/**/*.ts'],
  );
  const violations = [];
  for (const f of srcFiles) {
    const text = readFileSync(f, 'utf8');
    if (!CHECK_TRIGGER_RE.test(text)) continue;
    const rel = path.relative(repoRoot, f);
    const hasAnnotation = new RegExp(ANNOTATION_RE.source, 'm').test(text);

    // Dangling annotations rot silently — fail them here.
    if (hasAnnotation) {
      for (const m of text.matchAll(ANNOTATION_RE)) {
        for (const spec of m[1]
          .split(',')
          .map(s => s.trim())
          .filter(Boolean)) {
          if (expandDependencySpec(path.dirname(f), spec).length === 0) {
            violations.push(`${rel}: @dependency matches nothing: '${spec}'`);
          }
        }
      }
    }

    // AST-based detection (immune to mentions inside comments/strings).
    const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, false);
    const sites = [];
    const visit = node => {
      if (ts.isCallExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          const a = node.arguments[0];
          if (!a || !(ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a))) {
            sites.push([node, 'non-literal dynamic import']);
          }
        } else if (
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'fork' &&
          text.includes('child_process')
        ) {
          sites.push([node, 'child_process fork()']);
        }
      } else if (
        ts.isNewExpression(node) &&
        node.expression &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'Worker'
      ) {
        sites.push([node, 'new Worker(...)']);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);

    if (!hasAnnotation) {
      for (const [node, kind] of sites) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        violations.push(`${rel}:${line + 1}: ${kind} without a // @dependency annotation in the file`);
      }
    }
  }

  if (violations.length) {
    for (const v of violations.sort()) console.error(v);
    console.error(`\n${violations.length} violation(s) in ${srcFiles.length} scanned files.`);
    process.exit(1);
  }
  console.error(`OK: ${srcFiles.length} files scanned, all dynamic-load sites annotated.`);
  process.exit(0);
}

if (checkMode) runCheck();

// ---------------------------------------------------------------------------
// --diff-excluded support: enumerate a package's source files (src/**/*.ts, tests excluded)
// once and cache it. Only invoked under the flag, so the normal flow pays nothing.
// ---------------------------------------------------------------------------

const pkgFilesCache = new Map();
function packageSourceFiles(pkgRel) {
  if (!pkgFilesCache.has(pkgRel)) {
    const out = [];
    const walk = dir => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(path.relative(repoRoot, p));
      }
    };
    const srcDir = path.join(repoRoot, pkgRel, 'src');
    if (existsSync(srcDir)) walk(srcDir);
    pkgFilesCache.set(pkgRel, out);
  }
  return pkgFilesCache.get(pkgRel);
}

// The yarn-project package a repo-relative file belongs to, or null.
function packageOf(rel) {
  const m = /^(yarn-project\/[^/]+)\/src\//.exec(rel);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Closure computation
// ---------------------------------------------------------------------------

// Group inputs by their governing tsconfig so each package gets one program.
const groups = new Map();
for (const file of files) {
  const entry = path.resolve(file);
  if (!existsSync(entry)) {
    console.error(`ERROR: no such file: ${entry}`);
    process.exitCode = 1;
    continue;
  }
  const cfgPath = ts.findConfigFile(path.dirname(entry), ts.sys.fileExists);
  if (!cfgPath) {
    console.error(`ERROR: no tsconfig.json found above ${entry}`);
    process.exitCode = 1;
    continue;
  }
  if (!groups.has(cfgPath)) groups.set(cfgPath, []);
  groups.get(cfgPath).push(entry);
}

for (const [cfgPath, entries] of groups) {
  const cfg = ts.parseJsonConfigFileContent(
    ts.readConfigFile(cfgPath, ts.sys.readFile).config,
    ts.sys,
    path.dirname(cfgPath),
  );

  // BFS over the program's per-file resolution tables, yielding one root's closure.
  // @dependency targets that are TS files but not in the program are reported through
  // `missingRoots` so the caller can rebuild the program with them as extra roots.
  function closure(program, rootPath, missingRoots) {
    const seen = new Set();
    const queue = [program.getSourceFile(rootPath)];
    while (queue.length) {
      const sf = queue.pop();
      if (!sf || seen.has(sf.fileName)) continue;
      seen.add(sf.fileName);
      // sf.imports is the compiler's collected specifier list: import/export-from clauses
      // and literal dynamic imports.
      for (const spec of sf.imports ?? []) {
        const mode = ts.getModeForUsageLocation(sf, spec, cfg.options);
        const resolved = program.getResolvedModule(sf, spec.text, mode)?.resolvedModule;
        if (resolved) queue.push(program.getSourceFile(resolved.resolvedFileName));
      }
      // /// <reference path="..."> is relative to the referencing file.
      for (const ref of sf.referencedFiles ?? []) {
        queue.push(program.getSourceFile(path.resolve(path.dirname(sf.fileName), ref.fileName)));
      }
      // /// <reference types="..."> — rare in repo files; resolve via the public API.
      for (const ref of sf.typeReferenceDirectives ?? []) {
        const resolved = ts.resolveTypeReferenceDirective(
          ref.fileName,
          sf.fileName,
          cfg.options,
          ts.sys,
        )?.resolvedTypeReferenceDirective;
        if (resolved?.resolvedFileName) queue.push(program.getSourceFile(resolved.resolvedFileName));
      }
      // @dependency annotations live in the source file (dest d.ts are mapped back to it).
      // node_modules files never carry them — skip the disk lookups entirely.
      if (sf.fileName.includes('/node_modules/')) continue;
      for (const target of annotationTargets(destToSrc(path.resolve(sf.fileName)))) {
        if (/\.[cm]?tsx?$/.test(target)) {
          const tsf = program.getSourceFile(target);
          if (tsf) queue.push(tsf);
          else missingRoots.add(target);
        } else {
          seen.add(target); // non-TS leaf (JSON config, binary, bundle)
        }
      }
    }
    return seen;
  }

  // Stub host (see header): every /node_modules/ file parses as empty. Stubs are cached so
  // fixpoint rebuilds can reuse program structure.
  const host = ts.createCompilerHost(cfg.options);
  const realGetSourceFile = host.getSourceFile.bind(host);
  const stubs = new Map();
  host.getSourceFile = (fileName, languageVersion, ...rest) => {
    if (!fileName.includes('/node_modules/')) return realGetSourceFile(fileName, languageVersion, ...rest);
    if (!stubs.has(fileName)) stubs.set(fileName, ts.createSourceFile(fileName, '', languageVersion, false));
    return stubs.get(fileName);
  };

  // Fixpoint: annotation-discovered TS targets join the program as extra roots. Rebuilds
  // reuse the previous program, and in practice converge in zero or one extra iteration.
  let roots = [...entries];
  let program;
  let closures;
  for (;;) {
    program = ts.createProgram(roots, cfg.options, host, program);
    if (typeof program.getResolvedModule !== 'function') {
      console.error('ERROR: Program.getResolvedModule is gone — this TS version needs a script update.');
      process.exit(1);
    }
    const missingRoots = new Set();
    closures = new Map();
    for (const entry of entries) {
      closures.set(entry, program.getSourceFile(entry) ? closure(program, entry, missingRoots) : null);
    }
    const newRoots = [...missingRoots].filter(r => !roots.includes(r));
    if (newRoots.length === 0) break;
    roots = roots.concat(newRoots);
  }

  for (const entry of entries) {
    const entryClosure = closures.get(entry);
    if (!entryClosure) {
      console.error(`ERROR: ${entry} is not part of the program built from ${cfgPath}`);
      process.exitCode = 1;
      continue;
    }
    const repoFiles = new Set();
    let external = 0;
    for (const fileName of entryClosure) {
      const f = path.resolve(fileName);
      if (f.includes('/node_modules/')) {
        external++;
        if (all) repoFiles.add(path.relative(repoRoot, f));
        continue;
      }
      repoFiles.add(path.relative(repoRoot, destToSrc(f)));
    }

    console.log(`# ${path.relative(repoRoot, entry)}`);
    if (diffExcluded) {
      const excluded = new Set();
      for (const pkg of new Set([...repoFiles].map(packageOf).filter(Boolean))) {
        for (const f of packageSourceFiles(pkg)) if (!repoFiles.has(f)) excluded.add(f);
      }
      for (const f of [...repoFiles, ...excluded].sort()) {
        console.log(`${repoFiles.has(f) ? '+' : '-'} ${f}`);
      }
      console.error(
        `# ${path.relative(repoRoot, entry)}: ${repoFiles.size} included, ${excluded.size} excluded` +
          (all ? '' : `, ${external} node_modules files omitted (--all to include)`),
      );
    } else {
      for (const f of [...repoFiles].sort()) console.log(f);
      console.error(
        `# ${path.relative(repoRoot, entry)}: ${repoFiles.size} files listed` +
          (all ? '' : `, ${external} node_modules files omitted (--all to include)`),
      );
    }
  }
}
