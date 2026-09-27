import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const readJson = <T>(relative: string): T =>
  JSON.parse(readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')) as T;

const packageJson = readJson<{ packageManager?: string; engines?: Record<string, string> }>('../package.json');
const lockfile = readFileSync(fileURLToPath(new URL('../pnpm-lock.yaml', import.meta.url)), 'utf8');

const minimumNode = { major: 22, minor: 12 };
const corepack0241MaxMajor = 10;
const nixpacksPnpmMajor = Number((lockfile.match(/^lockfileVersion:\s*'?(\d+)/m) ?? [])[1]);

describe('nixpacks/Coolify deploy configuration', () => {
  it('pins a package manager version the nixpacks corepack shim can execute', () => {
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

  it('declares a Node requirement that satisfies Vite native bindings', () => {
    const range = packageJson.engines?.node;
    expect(range, 'package.json must declare engines.node').toBeTruthy();
    const match = range!.match(/(\d+)\.(\d+)/);
    expect(match, `cannot read a minimum version out of engines.node: ${range}`).toBeTruthy();
    const [major, minor] = [Number(match![1]), Number(match![2])];
    const sufficient = major > minimumNode.major || (major === minimumNode.major && minor >= minimumNode.minor);
    expect(sufficient, `engines.node ${range} is below ${minimumNode.major}.${minimumNode.minor}`).toBe(true);
  });
});