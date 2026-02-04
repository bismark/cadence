import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Type } from '@sinclair/typebox';

const DEVICE_PATH = '/sdcard/Download/cadence-bundle';
const APP_ID = 'com.cadence.player';
const APP_ACTIVITY = 'com.cadence.player/.MainActivity';

function resolveBundlePath(cwd: string, fixturesDir: string, input: string): string | null {
  const candidate = input.endsWith('.bundle') ? input : `${input}.bundle`;

  if (candidate.startsWith('/')) {
    return existsSync(candidate) ? candidate : null;
  }

  const fixturesCandidate = join(fixturesDir, candidate);
  if (existsSync(fixturesCandidate)) {
    return fixturesCandidate;
  }

  const cwdCandidate = join(cwd, candidate);
  return existsSync(cwdCandidate) ? cwdCandidate : null;
}

function resolveEpubPath(cwd: string, fixturesDir: string, input?: string): string | null {
  if (input) {
    if (!input.endsWith('.epub')) {
      const fixturesCandidate = join(fixturesDir, `${input}.epub`);
      if (existsSync(fixturesCandidate)) {
        return fixturesCandidate;
      }
    }

    const candidate = input.startsWith('/') ? input : join(cwd, input);
    return existsSync(candidate) ? candidate : null;
  }

  if (existsSync(fixturesDir)) {
    const epubs = readdirSync(fixturesDir).filter((f) => f.endsWith('.epub'));
    if (epubs.length > 0) {
      return join(fixturesDir, epubs[0]);
    }
  }

  return null;
}

async function ensureEmulator(pi: ExtensionAPI): Promise<void> {
  const devicesResult = await pi.exec('adb', ['devices'], { timeout: 5000 });
  if (!devicesResult.stdout.includes('emulator') && !devicesResult.stdout.includes('device')) {
    throw new Error('No Android emulator/device found. Start one first.');
  }
}

async function restartApp(pi: ExtensionAPI): Promise<void> {
  await pi.exec('adb', ['shell', 'am', 'force-stop', APP_ID], { timeout: 5000 });
  await pi.exec('adb', ['shell', 'am', 'start', '-n', APP_ACTIVITY], { timeout: 5000 });
}

async function pushBundleToDevice(pi: ExtensionAPI, bundleDir: string): Promise<void> {
  await pi.exec('adb', ['shell', 'rm', '-rf', DEVICE_PATH], { timeout: 10000 });
  const pushResult = await pi.exec('adb', ['push', bundleDir, DEVICE_PATH], { timeout: 60000 });
  if (pushResult.code !== 0) {
    throw new Error(`Push failed: ${pushResult.stderr}`);
  }
}

async function buildCompiler(pi: ExtensionAPI, compilerDir: string): Promise<void> {
  const buildResult = await pi.exec('npm', ['run', 'build'], {
    cwd: compilerDir,
    timeout: 60000,
  });

  if (buildResult.code !== 0) {
    throw new Error(`Compiler build failed: ${buildResult.stderr}`);
  }
}

async function compileEpub(
  pi: ExtensionAPI,
  compilerDir: string,
  epubPath: string,
): Promise<void> {
  const compileResult = await pi.exec(
    'node',
    ['dist/index.js', 'compile', '-i', epubPath, '--no-zip'],
    {
      cwd: compilerDir,
      timeout: 300000,
    },
  );

  if (compileResult.code !== 0) {
    throw new Error(`Compilation failed: ${compileResult.stderr}`);
  }
}

type PushBundleOptions = {
  cwd: string;
  bundleArg?: string;
  epubArg?: string;
  onStatus?: (status: string | undefined) => void;
  onNotify?: (message: string, level: 'info' | 'error' | 'success') => void;
};

async function runPushBundle(pi: ExtensionAPI, options: PushBundleOptions): Promise<string> {
  const { cwd, bundleArg, epubArg, onStatus, onNotify } = options;
  const compilerDir = join(cwd, 'compiler');
  const fixturesDir = join(compilerDir, 'test/fixtures');

  let bundleDir: string | null = null;
  let bundleName: string | null = null;

  if (bundleArg) {
    bundleDir = resolveBundlePath(cwd, fixturesDir, bundleArg);
    if (!bundleDir) {
      throw new Error(`Bundle not found: ${bundleArg}`);
    }
    bundleName = basename(bundleDir, '.bundle');
  } else {
    const epubPath = resolveEpubPath(cwd, fixturesDir, epubArg);
    if (!epubPath) {
      throw new Error('EPUB not found.');
    }

    bundleName = basename(epubPath, '.epub');
    bundleDir = epubPath.replace(/\.epub$/i, '.bundle');

    onNotify?.(`Compiling: ${basename(epubPath)}`, 'info');
    onStatus?.('Building compiler...');
    await buildCompiler(pi, compilerDir);

    onStatus?.('Compiling EPUB...');
    await compileEpub(pi, compilerDir, epubPath);
  }

  if (!bundleDir || !bundleName) {
    throw new Error('Bundle path could not be resolved.');
  }

  onStatus?.('Checking emulator...');
  await ensureEmulator(pi);

  onStatus?.('Pushing to emulator...');
  await pushBundleToDevice(pi, bundleDir);

  onStatus?.('Restarting app...');
  await restartApp(pi);

  onStatus?.(undefined);
  return bundleName;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand('push-bundle', {
    description:
      'Compile EPUB and push Cadence bundle to Android emulator (use --bundle <name> to push an existing bundle)',
    handler: async (args, ctx) => {
      const tokens = args?.trim().split(/\s+/).filter(Boolean) ?? [];
      const bundleIndex = tokens.indexOf('--bundle');
      const bundleArg = bundleIndex >= 0 ? tokens[bundleIndex + 1] : undefined;

      if (bundleIndex >= 0) {
        tokens.splice(bundleIndex, 2);
      }

      try {
        const bundleName = await runPushBundle(pi, {
          cwd: ctx.cwd,
          bundleArg,
          epubArg: tokens[0],
          onStatus: (status) => ctx.ui.setStatus('push-bundle', status),
          onNotify: (message, level) => ctx.ui.notify(message, level),
        });

        ctx.ui.notify(`✓ Pushed: ${bundleName}`, 'success');
      } catch (error) {
        ctx.ui.notify(
          error instanceof Error ? error.message : 'Failed to push bundle',
          'error',
        );
        ctx.ui.setStatus('push-bundle', undefined);
      }
    },
  });

  pi.registerTool({
    name: 'push_bundle',
    label: 'Push Cadence Bundle',
    description: 'Compile or push a Cadence bundle to the emulator and restart the app.',
    parameters: Type.Object({
      bundle: Type.Optional(Type.String({
        description: 'Bundle name or path (use instead of compiling an EPUB).',
      })),
      epub: Type.Optional(Type.String({
        description: 'EPUB name or path to compile (default: first fixture epub).',
      })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const bundleName = await runPushBundle(pi, {
          cwd: ctx.cwd,
          bundleArg: params.bundle,
          epubArg: params.epub,
        });

        return {
          content: [{ type: 'text', text: `✓ Pushed: ${bundleName}` }],
          details: { bundleName },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to push bundle';
        return {
          content: [{ type: 'text', text: message }],
          details: { error: message },
          isError: true,
        };
      }
    },
  });

  pi.registerCommand('rebuild-player', {
    description: 'Rebuild and reinstall Cadence player app, then launch it',
    handler: async (_args, ctx) => {
      const cwd = ctx.cwd;
      const playerDir = join(cwd, 'player');

      ctx.ui.setStatus('rebuild-player', 'Building player...');
      const buildResult = await pi.exec('./gradlew', ['installDebug'], {
        cwd: playerDir,
        timeout: 300000,
      });

      if (buildResult.code !== 0) {
        ctx.ui.notify(`Build failed: ${buildResult.stderr}`, 'error');
        ctx.ui.setStatus('rebuild-player', undefined);
        return;
      }

      ctx.ui.setStatus('rebuild-player', 'Restarting app...');
      await restartApp(pi);

      ctx.ui.setStatus('rebuild-player', undefined);
      ctx.ui.notify('✓ Player rebuilt and restarted', 'success');
    },
  });
}
