import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * Vitest + V8 coverage for the addon.
 *
 * Two suites live side by side and CI runs both:
 *   pnpm test / test:coverage -> vitest for the `src` and `tests` unit suites
 *   pnpm test:worker          -> `node --test` for the dependency-free worker
 *
 * The coverage runner is V8 (`@vitest/coverage-v8`) and reports a line total in
 * the terminal, `coverage/coverage-summary.json`, and the CI job summary.
 */

/**
 * Recorded coverage gate: the levels measured on `main` at e4cdf5b
 * (lines 70.5%, statements 45.57%, functions 35.08%, branches 36.15%), floored to
 * whole percent. A run below the recorded level fails, so coverage can ratchet up
 * but not down; raise these as tests are added.
 *
 * `.github/workflows/ci.yml` declares the same numbers in its job `env:` block and
 * this config reads them back from there, so CI and a local
 * `pnpm run test:coverage` enforce an identical gate.
 * `tests/coverage-gate.test.ts` fails on any drift between the two files.
 */
export const RECORDED_COVERAGE_THRESHOLDS = {
  lines: 70,
  statements: 45,
  functions: 35,
  branches: 36,
} as const;

export type CoverageMetric = keyof typeof RECORDED_COVERAGE_THRESHOLDS;

/** Environment variable each metric's threshold is read from in CI. */
export const COVERAGE_THRESHOLD_ENV: Record<CoverageMetric, string> = {
  lines: 'COVERAGE_LINES_THRESHOLD',
  statements: 'COVERAGE_STATEMENTS_THRESHOLD',
  functions: 'COVERAGE_FUNCTIONS_THRESHOLD',
  branches: 'COVERAGE_BRANCHES_THRESHOLD',
};

/** The process environment, typed without requiring `@types/node` (this repo type-checks `src`). */
const environment: Record<string, string | undefined> =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

/**
 * The threshold a metric is enforced at: the CI-declared value when it is a usable
 * percentage, otherwise the recorded level. An unusable override is reported
 * instead of silently weakening the gate — a threshold that cannot be read must
 * never turn into "no threshold".
 */
export function recordedThreshold(metric: CoverageMetric, override?: string): number {
  const name = COVERAGE_THRESHOLD_ENV[metric];
  const raw = override === undefined ? environment[name] : override;
  const value = Number.parseInt(raw ?? '', 10);
  if (raw !== undefined && Number.isInteger(value) && value >= 0 && value <= 100) {
    return value;
  }
  if (raw !== undefined) {
    console.warn(
      `coverage: ignoring ${name}=${JSON.stringify(raw)} (not an integer 0-100); ` +
        `using the recorded ${metric} threshold ${RECORDED_COVERAGE_THRESHOLDS[metric]}`,
    );
  }
  return RECORDED_COVERAGE_THRESHOLDS[metric];
}

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}'],
      thresholds: {
        lines: recordedThreshold('lines'),
        statements: recordedThreshold('statements'),
        functions: recordedThreshold('functions'),
        branches: recordedThreshold('branches'),
      },
    },
  },
});
