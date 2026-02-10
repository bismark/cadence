import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { Type } from '@sinclair/typebox';

const DEVICE_PATH = '/sdcard/Download/cadence-bundle';
const APP_ID = 'com.cadence.player';
const APP_ACTIVITY = 'com.cadence.player/.MainActivity';
const DEFAULT_AVD_NAME = process.env.CADENCE_AVD ?? 'Supernote_Manta_A5_X2';
const EMULATOR_BOOT_TIMEOUT_MS = 180000;

function parseArgs(input?: string): string[] {
  if (!input) return [];
  const tokens: string[] = [];
  const regex = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null = null;

  while ((match = regex.exec(input)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? '');
  }

  return tokens;
}

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

type NotifyLevel = 'info' | 'error' | 'success';

type AdbDevice = {
  serial: string;
  state: string;
};

function parseAdbDevicesOutput(stdout: string): AdbDevice[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('List of devices attached'))
    .map((line) => line.split(/\s+/))
    .filter((parts) => parts.length >= 2)
    .map((parts) => ({
      serial: parts[0],
      state: parts[1],
    }));
}

async function listAdbDevices(pi: ExtensionAPI): Promise<AdbDevice[]> {
  const devicesResult = await pi.exec('adb', ['devices'], { timeout: 5000 });
  if (devicesResult.code !== 0) {
    throw new Error(`Failed to run adb devices: ${devicesResult.stderr || devicesResult.stdout}`);
  }
  return parseAdbDevicesOutput(devicesResult.stdout);
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function getEmulatorCandidates(): string[] {
  const candidates = [
    process.env.ANDROID_EMULATOR,
    process.env.ANDROID_SDK_ROOT ? join(process.env.ANDROID_SDK_ROOT, 'emulator', 'emulator') : '',
    process.env.ANDROID_HOME ? join(process.env.ANDROID_HOME, 'emulator', 'emulator') : '',
    join(homedir(), 'Library', 'Android', 'sdk', 'emulator', 'emulator'),
    'emulator',
  ].filter(Boolean) as string[];

  return Array.from(new Set(candidates));
}

async function listAvdNames(pi: ExtensionAPI, emulatorBinary: string): Promise<string[]> {
  try {
    const avdResult = await pi.exec(emulatorBinary, ['-list-avds'], { timeout: 8000 });
    if (avdResult.code !== 0) {
      return [];
    }

    return avdResult.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function chooseAvdName(avdNames: string[], requestedAvdName?: string): string {
  if (requestedAvdName) {
    if (!avdNames.includes(requestedAvdName)) {
      throw new Error(
        `AVD "${requestedAvdName}" not found. Available AVDs: ${avdNames.join(', ')}`,
      );
    }

    return requestedAvdName;
  }

  if (avdNames.includes(DEFAULT_AVD_NAME)) {
    return DEFAULT_AVD_NAME;
  }

  return avdNames[0];
}

async function resolveEmulatorLaunchTarget(
  pi: ExtensionAPI,
  requestedAvdName?: string,
): Promise<{ emulatorBinary: string; avdName: string }> {
  const candidates = getEmulatorCandidates();

  for (const candidate of candidates) {
    if (candidate !== 'emulator' && !existsSync(candidate)) {
      continue;
    }

    const avdNames = await listAvdNames(pi, candidate);
    if (avdNames.length === 0) {
      continue;
    }

    const avdName = chooseAvdName(avdNames, requestedAvdName);
    return { emulatorBinary: candidate, avdName };
  }

  throw new Error(
    'Could not find Android emulator binary/AVD. Ensure Android SDK emulator is installed and an AVD exists.',
  );
}

async function getBootedDeviceSerial(pi: ExtensionAPI): Promise<string | null> {
  const devices = await listAdbDevices(pi);
  const readyDevices = devices.filter((device) => device.state === 'device');

  for (const device of readyDevices) {
    const bootResult = await pi.exec(
      'adb',
      ['-s', device.serial, 'shell', 'getprop', 'sys.boot_completed'],
      { timeout: 5000 },
    );

    const bootCompleted = bootResult.stdout.trim();
    if (bootResult.code === 0 && bootCompleted === '1') {
      return device.serial;
    }
  }

  return null;
}

async function waitForBootedDevice(
  pi: ExtensionAPI,
  timeoutMs: number,
): Promise<string> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const serial = await getBootedDeviceSerial(pi);
    if (serial) {
      return serial;
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  throw new Error(`Timed out waiting for Android device boot (${Math.round(timeoutMs / 1000)}s)`);
}

async function startEmulatorProcess(
  pi: ExtensionAPI,
  emulatorBinary: string,
  avdName: string,
): Promise<void> {
  await pi.exec('adb', ['start-server'], { timeout: 5000 });

  const launchCommand =
    `nohup ${shellEscape(emulatorBinary)} -avd ${shellEscape(avdName)} ` +
    '-netdelay none -netspeed full >/tmp/cadence-emulator.log 2>&1 &';

  const launchResult = await pi.exec('bash', ['-lc', launchCommand], { timeout: 5000 });
  if (launchResult.code !== 0) {
    throw new Error(`Failed to launch emulator: ${launchResult.stderr || launchResult.stdout}`);
  }
}

async function ensureEmulator(
  pi: ExtensionAPI,
  options?: {
    avdName?: string;
    onStatus?: (status: string | undefined) => void;
    onNotify?: (message: string, level: NotifyLevel) => void;
  },
): Promise<void> {
  const { avdName, onNotify, onStatus } = options ?? {};

  const initialBootedDevice = await getBootedDeviceSerial(pi);
  if (initialBootedDevice) {
    return;
  }

  const attachedDevices = await listAdbDevices(pi);
  if (attachedDevices.length > 0) {
    onStatus?.('Waiting for connected Android device to finish booting...');
    await waitForBootedDevice(pi, EMULATOR_BOOT_TIMEOUT_MS);
    return;
  }

  const launchTarget = await resolveEmulatorLaunchTarget(pi, avdName);

  onNotify?.(`Starting emulator: ${launchTarget.avdName}`, 'info');
  onStatus?.(`Starting emulator (${launchTarget.avdName})...`);
  await startEmulatorProcess(pi, launchTarget.emulatorBinary, launchTarget.avdName);

  onStatus?.(`Waiting for emulator (${launchTarget.avdName}) to boot...`);
  await waitForBootedDevice(pi, EMULATOR_BOOT_TIMEOUT_MS);
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
  avdArg?: string;
  onStatus?: (status: string | undefined) => void;
  onNotify?: (message: string, level: NotifyLevel) => void;
};

async function runPushBundle(pi: ExtensionAPI, options: PushBundleOptions): Promise<string> {
  const { cwd, bundleArg, epubArg, avdArg, onStatus, onNotify } = options;
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
  await ensureEmulator(pi, {
    avdName: avdArg,
    onStatus,
    onNotify,
  });

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
      'Compile EPUB and push Cadence bundle to Android emulator (auto-starts emulator if needed; use --bundle <name> to push an existing bundle)',
    handler: async (args, ctx) => {
      const tokens = parseArgs(args);
      const bundleIndex = tokens.indexOf('--bundle');
      const bundleArg = bundleIndex >= 0 ? tokens[bundleIndex + 1] : undefined;

      if (bundleIndex >= 0) {
        tokens.splice(bundleIndex, 2);
      }

      const avdIndex = tokens.indexOf('--avd');
      const avdArg = avdIndex >= 0 ? tokens[avdIndex + 1] : undefined;

      if (avdIndex >= 0) {
        tokens.splice(avdIndex, 2);
      }

      try {
        const bundleName = await runPushBundle(pi, {
          cwd: ctx.cwd,
          bundleArg,
          epubArg: tokens[0],
          avdArg,
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
    description:
      'Compile or push a Cadence bundle to the emulator and restart the app (auto-starts emulator if needed).',
    parameters: Type.Object({
      bundle: Type.Optional(Type.String({
        description: 'Bundle name or path (use instead of compiling an EPUB).',
      })),
      epub: Type.Optional(Type.String({
        description: 'EPUB name or path to compile (default: first fixture epub).',
      })),
      avd: Type.Optional(Type.String({
        description:
          'Optional AVD name to launch when no device is connected (default: CADENCE_AVD env or Supernote_Manta_A5_X2).',
      })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const bundleName = await runPushBundle(pi, {
          cwd: ctx.cwd,
          bundleArg: params.bundle,
          epubArg: params.epub,
          avdArg: params.avd,
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
