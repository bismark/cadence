import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isCliEntrypoint } from '../src/index.js';

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'cadence-cli-entrypoint-'));

  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('CLI entrypoint detection', () => {
  it('matches direct script execution', async () => {
    await withTempDir(async (dir) => {
      const realEntrypoint = join(dir, 'dist', 'index.js');
      await mkdir(join(dir, 'dist'), { recursive: true });
      await writeFile(realEntrypoint, '// test entrypoint', 'utf-8');

      const isEntrypoint = isCliEntrypoint(
        ['node', realEntrypoint],
        pathToFileURL(realEntrypoint).href,
      );

      expect(isEntrypoint).toBe(true);
    });
  });

  it('matches symlinked wrapper execution (npm bin style)', async () => {
    await withTempDir(async (dir) => {
      const realEntrypoint = join(dir, 'dist', 'index.js');
      await mkdir(join(dir, 'dist'), { recursive: true });
      await writeFile(realEntrypoint, '// test entrypoint', 'utf-8');

      const symlinkPath = join(dir, 'node_modules', '.bin', 'cadence-compile');
      await mkdir(join(dir, 'node_modules', '.bin'), { recursive: true });
      await symlink(realEntrypoint, symlinkPath);

      const isEntrypoint = isCliEntrypoint(
        ['node', symlinkPath],
        pathToFileURL(realEntrypoint).href,
      );

      expect(isEntrypoint).toBe(true);
    });
  });

  it('does not match when imported by another script', async () => {
    await withTempDir(async (dir) => {
      const realEntrypoint = join(dir, 'dist', 'index.js');
      const otherScript = join(dir, 'test-runner.js');
      await mkdir(join(dir, 'dist'), { recursive: true });
      await writeFile(realEntrypoint, '// test entrypoint', 'utf-8');
      await writeFile(otherScript, '// test runner', 'utf-8');

      const isEntrypoint = isCliEntrypoint(
        ['node', otherScript],
        pathToFileURL(realEntrypoint).href,
      );

      expect(isEntrypoint).toBe(false);
    });
  });

  it('returns false when argv has no entrypoint', () => {
    const isEntrypoint = isCliEntrypoint(['node'], 'file:///tmp/index.js');

    expect(isEntrypoint).toBe(false);
  });
});
