#!/usr/bin/env node
// Owns every file that must carry a literal copy of the toolchain's pinned release versions
// (BB_VERSION/NOIR_VERSION in bootstrap.sh next to this script). The copies exist because those
// files are read by tools with no include mechanism (yarn, nargo) or are consumed outside this
// repo as-is (published Nargo.toml manifests), so they cannot read the pin from here.
//
// Usage: node pins.mjs check                              fail if any copy drifted from the pin
//        node pins.mjs set <bb-version> [noir-version]    rewrite the pin and every copy
//        node pins.mjs use-local <foundation-root>        point each copy with a local form at
//                                                         the foundation checkout at that path
//
// use-local is for the foundation repo driving this repo as a submodule: it rewrites the
// worktree so the components build against the foundation tree's own packages instead of
// published releases, and records the root in .fnd-root so bootstrap.sh provisions the
// binaries from the same checkout. The result is never committed here; re-run it after a
// submodule update, and restore with git checkout of the touched files plus removing
// .fnd-root.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();
const BOOTSTRAP = "labs-aztec-toolchain/bootstrap.sh";

function tracked(...pathspecs) {
  return execFileSync("git", ["-C", repoRoot, "ls-files", "--", ...pathspecs], {
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
}

function read(file) {
  return readFileSync(join(repoRoot, file), "utf8");
}

// One pin per regex match: the span and current text of the version capture group (group 1, so
// the regex needs the d flag), plus the value it must hold.
function versionsIn(text, regex, expected, offset = 0) {
  return [...text.matchAll(regex)].map((m) => {
    const [start, end] = m.indices[1];
    return { start: start + offset, end: end + offset, found: m[1], expected };
  });
}

// Where each @aztec npm resolution lives inside a foundation checkout, as
// "<yarn protocol><foundation-relative path>"; use-local relativizes the path from the
// consuming manifest's directory. null marks packages whose installable content is staged
// only by the foundation release flow — their in-tree dirs hold no consumable package in an
// ordinary build — so they stay pinned to the published release even in use-local mode.
const LOCAL_PACKAGES = {
  "@aztec/bb-avm-sim": "portal:barretenberg/ts/bb-avm-sim",
  "@aztec/bb-avm-sim-darwin-arm64":
    "portal:barretenberg/ts/bb-avm-sim/packages/bb-avm-sim-darwin-arm64",
  "@aztec/bb-avm-sim-darwin-x64":
    "portal:barretenberg/ts/bb-avm-sim/packages/bb-avm-sim-darwin-x64",
  "@aztec/bb-avm-sim-linux-arm64":
    "portal:barretenberg/ts/bb-avm-sim/packages/bb-avm-sim-linux-arm64",
  "@aztec/bb-avm-sim-linux-x64":
    "portal:barretenberg/ts/bb-avm-sim/packages/bb-avm-sim-linux-x64",
  "@aztec/bb.js": "portal:barretenberg/ts/bb.js",
  "@aztec/cdb": "portal:barretenberg/ts/cdb",
  "@aztec/constants-codegen": "portal:protocol/constants-codegen",
  "@aztec/ipc-runtime": "portal:ipc-runtime/ts",
  "@aztec/l1-artifacts": "portal:l1-contracts/l1-artifacts",
  "@aztec/mock-protocol-circuits-artifacts": null,
  "@aztec/protocol-circuits-artifacts": null,
  "@aztec/protocol-contracts-artifacts": null,
  "@aztec/wsdb": "portal:wsdb/ts",
  "@aztec/wsdb-darwin-arm64": "portal:wsdb/ts/packages/wsdb-darwin-arm64",
  "@aztec/wsdb-darwin-x64": "portal:wsdb/ts/packages/wsdb-darwin-x64",
  "@aztec/wsdb-linux-arm64": "portal:wsdb/ts/packages/wsdb-linux-arm64",
  "@aztec/wsdb-linux-x64": "portal:wsdb/ts/packages/wsdb-linux-x64",
  "@aztec/noir-acvm_js": "portal:noir/packages/acvm_js",
  "@aztec/noir-types": "portal:noir/packages/types",
  "@aztec/noir-noirc_abi": "portal:noir/packages/noirc_abi",
  "@aztec/noir-noir_codegen": "portal:noir/packages/noir_codegen",
  "@aztec/noir-noir_js": "file:noir/packages/noir_js",
};

// Turns a LOCAL_PACKAGES value into the manifest entry ("portal:../relative/path") plus the
// foundation-relative path it points at.
function localize(protocolPath, { fndRoot, fileDir }) {
  const split = protocolPath.indexOf(":") + 1;
  const path = protocolPath.slice(split);
  return {
    value:
      protocolPath.slice(0, split) + relative(fileDir, join(fndRoot, path)),
    target: path,
  };
}

const SITES = [
  {
    name: "aztec-packages git dep tag",
    files: () => tracked("*Nargo.toml"),
    // aztec-nr is fetched from github by external contract projects, so its manifest must
    // always carry a resolvable release tag: losing the pin entirely (a committed use-local
    // rewrite, a switch to a path dep) must fail the check, not shrink its coverage.
    required: ["noir-projects/labs/aztec-nr/aztec/Nargo.toml"],
    // Only single-line inline dep tables are supported: a multi-line [dependencies.x] table
    // puts the url and tag on separate lines and is reported as a tagless dep rather than
    // matched. Dependency tables order their keys freely, so the url and the tag are only
    // tied together by sharing a (non-comment) line. A dep on the release repo must pin a
    // tag: a branch or rev ref would evade the version check, so a tagless line is reported
    // (found: null) rather than skipped. The url match is case-insensitive because github is.
    pins(content, { bb }) {
      const pins = [];
      let offset = 0;
      for (const line of content.split("\n")) {
        if (
          !/^\s*#/.test(line) &&
          /github\.com\/AztecProtocol\/aztec-packages/i.test(line)
        ) {
          const tags = versionsIn(
            line,
            /tag\s*=\s*"([^"]+)"/dg,
            `v${bb}`,
            offset,
          );
          pins.push(
            ...(tags.length
              ? tags
              : [
                  {
                    start: offset,
                    end: offset,
                    found: null,
                    expected: `v${bb}`,
                  },
                ]),
          );
        }
        offset += line.length + 1;
      }
      return pins;
    },
    // The git dep's directory key names the crate's path inside the foundation repo, so the
    // whole table collapses to a path dep pointing into the checkout.
    useLocal(content, ctx) {
      const targets = [];
      const updated = content.replace(
        /\{[^}\n]*github\.com\/AztecProtocol\/aztec-packages[^}\n]*\}/gi,
        (table) => {
          const dir = /directory\s*=\s*"([^"]+)"/.exec(table)?.[1];
          if (!dir) {
            throw new Error(
              `aztec-packages git dep has no directory key to map to a local path: ${table}`,
            );
          }
          targets.push(dir);
          return `{ path = "${relative(ctx.fileDir, join(ctx.fndRoot, dir))}" }`;
        },
      );
      return { content: updated, targets };
    },
  },
  {
    // Only bb.js and the noir packages track BB_VERSION: other @aztec-scoped pins (e.g. the viem
    // fork) version independently and must not be checked. A missing or empty version would
    // float to the registry's latest, so it is reported (found: null) rather than skipped.
    name: "published @aztec npm pin",
    files: () => tracked("docs/examples/ts/*/config.yaml"),
    required: ["docs/examples/ts/recursive_verification/config.yaml"],
    pins(content, { bb }) {
      const pins = [];
      let offset = 0;
      for (const line of content.split("\n")) {
        if (!/^\s*#/.test(line)) {
          for (const m of line.matchAll(
            /npm:@aztec\/(?:bb\.js|noir-[^@"'\s]*)(?:@([^"'\s]*))?/dg,
          )) {
            const pin = m[1]
              ? { start: m.indices[1][0], end: m.indices[1][1], found: m[1] }
              : { start: m.indices[0][0], end: m.indices[0][0], found: null };
            pins.push({
              ...pin,
              start: pin.start + offset,
              end: pin.end + offset,
              expected: bb,
            });
          }
        }
        offset += line.length + 1;
      }
      return pins;
    },
    // These have no local form: the examples runner links bare @aztec names from
    // yarn-project/, where bb.js and the noir packages do not exist, and its link: entries
    // install no transitive dependencies. Examples consume the published release even in
    // use-local mode.
    useLocal(content) {
      if (/npm:@aztec\/(?:bb\.js|noir-)/.test(content)) {
        console.log(
          "docs example npm pins: left pinned (no local form for packages outside yarn-project).",
        );
      }
      return { content, targets: [] };
    },
  },
  {
    // docs pins the l1-artifacts package, whose l1-contracts sources feed the docs L1 snippets
    // and the solidity examples' imports.
    name: "@aztec/l1-artifacts pin",
    files: () => ["docs/package.json"],
    required: ["docs/package.json"],
    pins: (content, { bb }) =>
      versionsIn(content, /"@aztec\/l1-artifacts":\s*"([^"]+)"/dg, bb),
    useLocal(content, ctx) {
      const { value, target } = localize(
        LOCAL_PACKAGES["@aztec/l1-artifacts"],
        ctx,
      );
      return {
        // A replacer function, not a replacement string: the localized value embeds a
        // filesystem path, which must not be interpreted for $-patterns.
        content: content.replace(
          /("@aztec\/l1-artifacts":\s*")[^"]+(")/,
          (_, pre, post) => pre + value + post,
        ),
        targets: [target],
      };
    },
  },
  {
    // yarn-project pins its first-party npm dependencies in one place, the resolutions block;
    // the workspace manifests carry a dummy version. Every @aztec-scoped entry there is a
    // release of this repo and so tracks BB_VERSION, unlike the third-party entries it sits
    // beside.
    name: "@aztec resolutions entry",
    files: () => ["yarn-project/package.json"],
    required: ["yarn-project/package.json"],
    pins(content, { bb }) {
      const block = /"resolutions"\s*:\s*\{[^}]*\}/.exec(content);
      if (!block)
        throw new Error("yarn-project/package.json has no resolutions block");
      return versionsIn(
        block[0],
        /"@aztec\/[^"]+":\s*"([^"]+)"/dg,
        bb,
        block.index,
      );
    },
    // The resolutions keys and LOCAL_PACKAGES must stay in lockstep: a new entry missing
    // its foundation mapping would otherwise surface only when the foundation repo runs
    // use-local, far from the change that caused it.
    verify(content) {
      const block = /"resolutions"\s*:\s*\{[^}]*\}/.exec(content);
      if (!block) return ["yarn-project/package.json has no resolutions block"];
      const keys = [...block[0].matchAll(/"(@aztec\/[^"]+)":/g)].map(
        (m) => m[1],
      );
      const errors = [];
      for (const key of keys) {
        if (!(key in LOCAL_PACKAGES))
          errors.push(
            `${key}: in yarn-project resolutions but not LOCAL_PACKAGES; add its foundation path (or null) to pins.mjs.`,
          );
      }
      for (const key of Object.keys(LOCAL_PACKAGES)) {
        if (!keys.includes(key))
          errors.push(
            `${key}: in LOCAL_PACKAGES but not yarn-project resolutions; remove it from pins.mjs.`,
          );
      }
      return errors;
    },
    useLocal(content, ctx) {
      const block = /"resolutions"\s*:\s*\{[^}]*\}/.exec(content);
      if (!block)
        throw new Error("yarn-project/package.json has no resolutions block");
      const targets = [];
      let retargeted = 0;
      const updated = block[0].replace(
        /"(@aztec\/[^"]+)":(\s*)"([^"]+)"/g,
        (entry, name, ws, current) => {
          const local = LOCAL_PACKAGES[name];
          if (local === undefined) {
            throw new Error(
              `no LOCAL_PACKAGES entry for ${name}; add its foundation path (or null) to pins.mjs`,
            );
          }
          if (local === null) {
            console.log(
              `${name}: left pinned (published-only, no package dir in the foundation tree).`,
            );
            return entry;
          }
          const { value, target } = localize(local, ctx);
          if (/^(portal|file):/.test(current) && current !== value)
            retargeted++;
          targets.push(target);
          return `"${name}":${ws}"${value}"`;
        },
      );
      return {
        content:
          content.slice(0, block.index) +
          updated +
          content.slice(block.index + block[0].length),
        targets,
        retargeted: retargeted > 0,
      };
    },
  },
];

function readPinnedVersions() {
  const content = read(BOOTSTRAP);
  const bb = /^BB_VERSION=(\S+)$/m.exec(content)?.[1];
  const noir = /^NOIR_VERSION=(\S+)$/m.exec(content)?.[1];
  if (!bb || !noir)
    throw new Error(`could not read BB_VERSION/NOIR_VERSION from ${BOOTSTRAP}`);
  return { bb, noir };
}

function lineAt(content, index) {
  return content.slice(0, index).split("\n").length;
}

// Everything check asserts and set must pre-validate, gathered without writing: per-file
// pins, required files that yielded none (a required file losing its last pin — deleted,
// or rewritten into a form the site no longer matches — must fail rather than silently
// shrink coverage), and each site's structural errors.
function audit(versions) {
  const results = [];
  const requiredMisses = [];
  const verifyErrors = [];
  for (const site of SITES) {
    const pinCounts = new Map();
    for (const file of site.files()) {
      // ls-files reports the index, so a file deleted from the worktree but not staged
      // still lands here; skip it so a required one is reported as missing, not as ENOENT.
      if (!existsSync(join(repoRoot, file))) continue;
      const content = read(file);
      const pins = site.pins(content, versions);
      pinCounts.set(file, pins.length);
      results.push({ site, file, content, pins });
      verifyErrors.push(...(site.verify?.(content) ?? []));
    }
    for (const file of site.required ?? []) {
      if (!pinCounts.get(file)) requiredMisses.push({ site, file });
    }
  }
  return { results, requiredMisses, verifyErrors };
}

function check() {
  const versions = readPinnedVersions();
  const { results, requiredMisses, verifyErrors } = audit(versions);
  let drifted = false;
  for (const { site, file, content, pins } of results) {
    for (const pin of pins) {
      if (pin.found === pin.expected) continue;
      drifted = true;
      const found = pin.found === null ? "no version" : `"${pin.found}"`;
      console.error(
        `${file}:${lineAt(content, pin.start)}: ${site.name} pins ${found}, expected "${pin.expected}" ` +
          `(from BB_VERSION in ${BOOTSTRAP}).`,
      );
    }
  }
  for (const { site, file } of requiredMisses) {
    console.error(`${file}: expected at least one ${site.name}, found none.`);
  }
  for (const error of verifyErrors) console.error(error);
  if (drifted) {
    console.error(
      `Pinned release versions drifted. Run ${BOOTSTRAP} set-pins ${versions.bb} to realign them.`,
    );
  }
  if (requiredMisses.length) {
    console.error(
      "A required pin is missing entirely; set-pins cannot recreate it — restore the file (git checkout) or re-add the dep.",
    );
  }
  if (drifted || requiredMisses.length || verifyErrors.length) process.exit(1);
}

function normalize(version) {
  const v = version.replace(/^v(?=\d)/i, "");
  if (!/^[0-9A-Za-z][0-9A-Za-z.-]*$/.test(v)) {
    console.error(`Invalid version "${version}".`);
    process.exit(1);
  }
  return v;
}

function set(bbArg, noirArg) {
  const bb = normalize(bbArg);
  // An explicit empty noir argument must be rejected by normalize, not treated as omitted:
  // a caller whose version lookup came up empty would otherwise bump bb and silently keep
  // the old noir pin.
  const noir =
    noirArg !== undefined ? normalize(noirArg) : readPinnedVersions().noir;
  const versions = { bb, noir };

  // Validate everything and compute every rewrite before writing anything: an abort
  // halfway must not leave the tree half-bumped, and a tree missing required pins (e.g.
  // one in use-local mode, whose path deps set-pins cannot restore) must not have its
  // npm sites silently re-pinned out from under it.
  const { results, requiredMisses, verifyErrors } = audit(versions);
  let fatal = false;
  for (const { site, file, content, pins } of results) {
    const broken = pins.find((pin) => pin.found === null);
    if (broken) {
      console.error(
        `${file}:${lineAt(content, broken.start)}: ${site.name} has no version to rewrite; fix it by hand.`,
      );
      fatal = true;
    }
  }
  for (const { site, file } of requiredMisses) {
    console.error(
      `${file}: expected at least one ${site.name}, found none — restore it (git checkout, or re-run use-local after) before setting pins.`,
    );
    fatal = true;
  }
  for (const error of verifyErrors) {
    console.error(error);
    fatal = true;
  }
  if (fatal) process.exit(1);

  const writes = [];
  for (const { file, content, pins } of results) {
    const stale = pins.filter((pin) => pin.found !== pin.expected);
    if (!stale.length) continue;
    let updated = content;
    for (const pin of stale.sort((a, b) => b.start - a.start)) {
      updated =
        updated.slice(0, pin.start) + pin.expected + updated.slice(pin.end);
    }
    writes.push({ file, content: updated, count: stale.length });
  }

  const bootstrap = read(BOOTSTRAP)
    .replace(/^BB_VERSION=\S+$/m, `BB_VERSION=${bb}`)
    .replace(/^NOIR_VERSION=\S+$/m, `NOIR_VERSION=${noir}`);
  writeFileSync(join(repoRoot, BOOTSTRAP), bootstrap);
  console.log(`${BOOTSTRAP}: pinned bb ${bb}, noir ${noir}.`);
  for (const { file, content, count } of writes) {
    writeFileSync(join(repoRoot, file), content);
    console.log(`${file}: updated ${count} pin${count === 1 ? "" : "s"}.`);
  }
  check();
}

function useLocal(fndRootArg) {
  const fndRoot = resolve(fndRootArg);
  // The same landmarks build_fnd checks: enough to tell a foundation checkout from a random
  // directory without requiring it to be built yet.
  for (const landmark of [
    "barretenberg/cpp/bootstrap.sh",
    "noir/bootstrap.sh",
  ]) {
    if (!existsSync(join(fndRoot, landmark))) {
      console.error(
        `${fndRootArg} does not look like a foundation checkout (missing ${landmark}).`,
      );
      process.exit(1);
    }
  }
  // Compute every rewrite before writing anything: a failure at any site must leave the
  // tree untouched, not half-localized with no .fnd-root to show for it.
  const writes = [];
  const missingTargets = [];
  const errors = [];
  let retargeted = false;
  for (const site of SITES) {
    for (const file of site.files()) {
      if (!existsSync(join(repoRoot, file))) continue;
      const original = read(file);
      let rewritten;
      try {
        rewritten = site.useLocal(original, {
          fndRoot,
          fileDir: dirname(join(repoRoot, file)),
        });
      } catch (err) {
        errors.push(`${file}: ${err.message}`);
        continue;
      }
      retargeted ||= rewritten.retargeted ?? false;
      for (const target of rewritten.targets) {
        if (!existsSync(join(fndRoot, target)))
          missingTargets.push({ file, target });
      }
      if (rewritten.content !== original)
        writes.push({ file, content: rewritten.content });
    }
  }
  for (const error of errors) console.error(error);
  // A tree already localized to a different root cannot be retargeted: the Nargo path
  // deps written by the earlier run no longer match any rewrite rule and would keep
  // pointing at the old root.
  if (retargeted) {
    console.error(
      "Tree is already localized to a different root; git checkout the touched files, then re-run use-local.",
    );
  }
  if (errors.length || retargeted) process.exit(1);

  // A missing target is only a warning: several are build outputs that appear once the
  // foundation tree is built.
  for (const { file, target } of missingTargets) {
    console.warn(
      `warning: ${file} now points at ${join(fndRootArg, target)}, which does not exist (not built yet?).`,
    );
  }
  for (const { file, content } of writes) {
    writeFileSync(join(repoRoot, file), content);
    console.log(`${file}: now consumes the foundation checkout.`);
  }
  // Recording the root makes the binaries follow: bootstrap.sh provisions bin/ from this
  // checkout whenever .fnd-root exists, so one command flips the whole tree consistently.
  writeFileSync(
    join(repoRoot, "labs-aztec-toolchain/.fnd-root"),
    `${fndRoot}\n`,
  );
  console.log(
    `Recorded ${fndRoot} in labs-aztec-toolchain/.fnd-root: bootstrap builds now provision bin/ from it. ` +
      "Remove the file (or export AZTEC_TOOLCHAIN_FND_ROOT=) to return to pinned mode.",
  );
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === "check" && args.length === 0) {
  check();
} else if (cmd === "set" && (args.length === 1 || args.length === 2)) {
  set(...args);
} else if (cmd === "use-local" && args.length === 1) {
  useLocal(args[0]);
} else {
  console.error(
    "Usage: pins.mjs check | set <bb-version> [noir-version] | use-local <foundation-root>",
  );
  process.exit(1);
}
