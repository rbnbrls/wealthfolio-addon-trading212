import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const readJson = <T>(relative: string): T =>
  JSON.parse(readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')) as T;

const packageJson = readJson<{ packageManager?: string }>('../package.json');
const lockfile = readFileSync(fileURLToPath(new URL('../pnpm-lock.yaml', import.meta.url)), 'utf8');

/**
 * Coolify builds this app with the `nixpacks` build pack, whose Node provider writes a fixed
 * install phase (`npm install -g corepack@0.24.1 && corepack enable`) and then runs
 * `pnpm i --frozen-lockfile`. The pnpm that actually executes is chosen by that corepack shim
 * from `packageManager` in package.json, so the pin is a build input, not a developer preference.
 *
 * corepack@0.24.1 loads a manager's entrypoint through `Module._compile`, which cannot service the
 * dynamic `import()` used by pnpm 11+ (`ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`). Verified
 * 2026-09-21 against corepack@0.24.1: pnpm 8.15.9/9.15.9/10.34.5 run; 11.24.0 and 12.5.1 abort.
 */
const corepack0241MaxMajor = 10;

/** For a `lockfileVersion: '9.0'` lockfile nixpacks' Node provider provisions the `pnpm-9_x` package. */
const nixpacksPnpmMajor = Number((lockfile.match(/^lockfileVersion:\s*'?(\d+)/m) ?? [])[1]);

describe('nixpacks/Coolify deploy configuration', () => {
  it('pins a packageManager version the nixpacks corepack shim can execute', () => {
    const pin = packageJson.packageManager;
    expect(pin).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
    const major = Number(pin!.slice('pnpm@'.length).split('.')[0]);
    expect(major).toBeLessThanOrEqual(corepack0241MaxMajor);
  });

  it('pins the pnpm major that nixpacks provisions for this lockfile', () => {
    const pin = packageJson.packageManager!;
    const major = Number(pin.slice('pnpm@'.length).split('.')[0]);
    expect(major).toBe(nixpacksPnpmMajor);
  });
});
