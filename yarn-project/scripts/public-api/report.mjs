#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { compare, extract } from './extract.mjs';
import { git, snapshot, stable } from './source.mjs';

const { values } = parseArgs({
  options: {
    base: { type: 'string', default: 'origin/main' },
    head: { type: 'string', default: 'HEAD' },
    root: { type: 'string', default: path.resolve(import.meta.dirname, '../../..') },
    output: { type: 'string' },
    config: { type: 'string', default: path.join(import.meta.dirname, 'surfaces.json') },
  },
});
function describeChanges(before, after, prefix = '') {
  if (stable(before) === stable(after)) return [];
  if (before && after && typeof before === 'object' && typeof after === 'object') {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .sort()
      .flatMap(key => describeChanges(before[key], after[key], prefix ? `${prefix}.${key}` : key));
  }
  const preview = value => (stable(value) ?? 'absent').replaceAll('`', '').slice(0, 120);
  return [`${prefix}: ${preview(before)} → ${preview(after)}`];
}

const report = { status: 'analysis-failed', base: values.base, head: values.head };
let markdown;
try {
  const config = JSON.parse(readFileSync(values.config, 'utf8'));
  const head = values.head === 'worktree' ? 'HEAD' : values.head;
  report.mergeBase = git(values.root, ['merge-base', values.base, head]).trim();
  report.before = extract(snapshot(values.root, report.mergeBase), config);
  report.after = extract(snapshot(values.root, values.head), config);
  report.changes = compare(report.before, report.after);
  const counts = Object.fromEntries(Object.entries(report.changes).map(([kind, changes]) => [kind, changes.length]));
  const incomplete = report.before.warnings.length + report.after.warnings.length > 0;
  const changed = Object.values(counts).some(Boolean);
  report.status = incomplete ? 'incomplete-analysis' : changed ? 'api-changed' : 'no-api-changes';
  process.exitCode = incomplete ? 2 : changed ? 1 : 0;
  markdown =
    `# Public API report (advisory)\n\nStatus: **${report.status}**. ` +
    `${counts.added} additions, ${counts.removed} removals, ${counts.modified} modifications.\n\n` +
    `Compared merge-base \`${report.mergeBase}\` with \`${values.head}\`.\n\n` +
    'This source inventory does not decide compatibility or require a changelog. See the JSON artifact for full signatures.\n';
  for (const [kind, changes] of Object.entries(report.changes)) {
    markdown += `\n## ${kind[0].toUpperCase() + kind.slice(1)}\n\n`;
    markdown += changes.length
      ? changes
          .map(c => {
            const details = kind === 'modified' ? describeChanges(c.before, c.after) : [];
            return (
              `- ${c.surface}: \`${c.name.replaceAll('`', '')}\`` +
              (details.length
                ? ` — ${details.slice(0, 3).join('; ')}${details.length > 3 ? '; … (see JSON)' : ''}`
                : '')
            );
          })
          .join('\n') + '\n'
      : 'None.\n';
  }
  for (const [revision, inventory] of [
    ['Base', report.before],
    ['Candidate', report.after],
  ]) {
    markdown +=
      `\n## ${revision} coverage\n\n` +
      Object.entries(inventory.surfaces)
        .map(([name, entries]) => `${Object.keys(entries).length} ${name} entries`)
        .join(', ') +
      `; ${inventory.parsedFiles} source files parsed.\n`;
    if (inventory.warnings.length)
      markdown +=
        '\nUnsupported or unresolved source expressions (analysis is incomplete):\n\n' +
        inventory.warnings.map(w => `- ${w.replaceAll('`', '')}`).join('\n') +
        '\n';
  }
} catch (error) {
  report.error = error.stack ?? String(error);
  process.exitCode = 2;
  markdown = `# Public API report (advisory)\n\n**Analysis failed. No clean API result is available.**\n\n\`\`\`\n${report.error}\n\`\`\`\n`;
}
console.log(markdown);
if (values.output) {
  mkdirSync(values.output, { recursive: true });
  writeFileSync(path.join(values.output, 'report.json'), JSON.stringify(report) + '\n');
  writeFileSync(path.join(values.output, 'report.md'), markdown);
}
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
