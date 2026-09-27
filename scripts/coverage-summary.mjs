#!/usr/bin/env node
// Prints the coverage line total produced by `pnpm test:coverage`.
//
// A missing or unreadable summary is reported as `unavailable` with a reason and
// fails the run: an unmeasurable metric must never be reported as zero.
import { appendFileSync, readFileSync } from 'node:fs';

const summaryPath = process.argv[2] ?? 'coverage/coverage-summary.json';

let summary;
try {
  summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
} catch (error) {
  console.error(`coverage: unavailable (reason: coverage_summary_missing, path: ${summaryPath})`);
  console.error(String(error && error.message ? error.message : error));
  process.exit(1);
}

const total = summary.total ?? {};
const lines = total.lines;

if (!lines || typeof lines.pct !== 'number') {
  console.error('coverage: unavailable (reason: coverage_line_total_absent)');
  process.exit(1);
}

const lineTotal = `coverage line total: ${lines.pct}% (${lines.covered}/${lines.total} lines)`;
const detail = [
  `statements ${total.statements.pct}%`,
  `branches ${total.branches.pct}%`,
  `functions ${total.functions.pct}%`,
].join(', ');

console.log(lineTotal);
console.log(detail);

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Coverage\n\n- ${lineTotal}\n- ${detail}\n`);
}
