/**
 * Guards the coverage gate, which is deliberately spread over two files:
 *
 *   `.github/workflows/ci.yml` — the job `env:` block that CI enforces
 *   `vitest.config.ts`         — the recorded levels a local run enforces
 *
 * A threshold held in only one of them is not a gate: declared in the workflow
 * alone it would be a number vitest never reads, held in the config alone it would
 * be invisible to anything reading the pipeline. So the two are asserted against
 * each other, and a drift in either direction fails here.
 *
 * The summary step's contract is checked by running it: an unreadable report must
 * come out as `unavailable` with a reason and a non-zero exit, never as a zero.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import config, {
  COVERAGE_THRESHOLD_ENV,
  RECORDED_COVERAGE_THRESHOLDS,
  recordedThreshold,
  type CoverageMetric,
} from '../vitest.config';

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const workflow = read('../.github/workflows/ci.yml');
const metrics = Object.keys(RECORDED_COVERAGE_THRESHOLDS) as CoverageMetric[];

/** The thresholds this config actually hands to vitest. */
const configuredThresholds = (): Record<string, number> =>
  (config.test as { coverage?: { thresholds?: Record<string, number> } } | undefined)?.coverage
    ?.thresholds ?? {};

/** Reads `KEY: 12` out of the workflow, or null when it is not declared. */
const declaredInWorkflow = (key: string): number | null => {
  const match = workflow.match(new RegExp(`^\\s*${key}\\s*:\\s*(\\d{1,3})\\s*$`, 'm'));
  return match ? Number(match[1]) : null;
};

describe('coverage gate', () => {
  it('runs the coverage suite in CI, so a threshold can actually block a merge', () => {
    expect(workflow).toMatch(/run: pnpm run test:coverage/);
    expect(workflow).toMatch(/name: Unit tests with coverage/);
  });

  it('records the same threshold in the CI workflow, the config and vitest', () => {
    for (const metric of metrics) {
      const name = COVERAGE_THRESHOLD_ENV[metric];
      const declared = declaredInWorkflow(name);
      expect(declared, `${name} must be declared in .github/workflows/ci.yml`).not.toBeNull();
      expect(declared, `${name} must equal the recorded ${metric} threshold`).toBe(
        RECORDED_COVERAGE_THRESHOLDS[metric],
      );
      // The level vitest enforces: the CI-declared one when CI set it, else the
      // recorded one. A config that hard-codes its own number fails here.
      expect(configuredThresholds()[metric], `vitest is not enforcing the declared ${metric}`).toBe(
        recordedThreshold(metric),
      );
    }
  });

  it('enforces a usable CI-declared value and falls back to the recorded one otherwise', () => {
    for (const metric of metrics) {
      expect(recordedThreshold(metric, '84')).toBe(84);
      expect(recordedThreshold(metric, '0')).toBe(0);
      // An unusable declaration must not silently weaken the gate.
      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => warnings.push(args.join(' '));
      try {
        expect(recordedThreshold(metric, 'not-a-number')).toBe(RECORDED_COVERAGE_THRESHOLDS[metric]);
        expect(recordedThreshold(metric, '101')).toBe(RECORDED_COVERAGE_THRESHOLDS[metric]);
        expect(warnings.length).toBe(2);
        expect(warnings.join('\n')).toContain(COVERAGE_THRESHOLD_ENV[metric]);
      } finally {
        console.warn = originalWarn;
      }
    }
  });

  it('reports an unreadable coverage report as unavailable, never as zero', () => {
    const directory = mkdtempSync(`${tmpdir()}/coverage-gate-`);
    try {
      const result = spawnSync(
        'node',
        ['scripts/coverage-summary.mjs', `${directory}/absent-summary.json`],
        { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('unavailable (reason: coverage_summary_missing');
      expect(result.stdout).not.toMatch(/\b0\b\s*%/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
