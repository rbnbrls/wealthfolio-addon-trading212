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
 * the terminal, `coverage/coverage-summary.json`, and the CI job summary. The
 * thresholds are pinned just below the totals measured on `main`
 * (lines 70.5 / statements 45.6 / functions 35.1 / branches 36.2) so a coverage
 * regression fails the build without claiming headroom the code does not have;
 * raise them as tests are added.
 */
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
      thresholds: { lines: 70, statements: 45, functions: 35, branches: 36 },
    },
  },
});
