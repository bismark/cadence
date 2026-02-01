import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { join, basename } from "node:path";
import { existsSync, readdirSync } from "node:fs";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("push-bundle", {
    description: "Compile EPUB and push Cadence bundle to Android emulator",
    handler: async (args, ctx) => {
      const cwd = ctx.cwd;
      const compilerDir = join(cwd, "compiler");
      const fixturesDir = join(compilerDir, "test/fixtures");

      // Find EPUB to compile
      let epubPath: string | undefined;
      
      if (args && args.trim()) {
        // User specified an EPUB path
        epubPath = args.trim();
        if (!epubPath.startsWith("/")) {
          epubPath = join(cwd, epubPath);
        }
      } else {
        // Find first EPUB in fixtures directory
        if (existsSync(fixturesDir)) {
          const epubs = readdirSync(fixturesDir).filter(f => f.endsWith(".epub"));
          if (epubs.length > 0) {
            epubPath = join(fixturesDir, epubs[0]);
          }
        }
      }

      if (!epubPath || !existsSync(epubPath)) {
        ctx.ui.notify(`EPUB not found: ${epubPath || "none specified"}`, "error");
        return;
      }

      const epubName = basename(epubPath, ".epub");
      const bundleDir = epubPath.replace(/\.epub$/i, ".bundle");

      ctx.ui.notify(`Compiling: ${basename(epubPath)}`, "info");

      // Step 1: Build compiler (if needed)
      ctx.ui.setStatus("push-bundle", "Building compiler...");
      const buildResult = await pi.exec("npm", ["run", "build"], {
        cwd: compilerDir,
        timeout: 60000,
      });

      if (buildResult.code !== 0) {
        ctx.ui.notify(`Compiler build failed: ${buildResult.stderr}`, "error");
        ctx.ui.setStatus("push-bundle", undefined);
        return;
      }

      // Step 2: Compile EPUB
      ctx.ui.setStatus("push-bundle", "Compiling EPUB...");
      const compileResult = await pi.exec(
        "node",
        ["dist/index.js", "compile", "-i", epubPath, "--no-zip"],
        {
          cwd: compilerDir,
          timeout: 300000, // 5 minutes for large books
        }
      );

      if (compileResult.code !== 0) {
        ctx.ui.notify(`Compilation failed: ${compileResult.stderr}`, "error");
        ctx.ui.setStatus("push-bundle", undefined);
        return;
      }

      // Step 3: Check if emulator is running
      ctx.ui.setStatus("push-bundle", "Checking emulator...");
      const devicesResult = await pi.exec("adb", ["devices"], { timeout: 5000 });
      
      if (!devicesResult.stdout.includes("emulator") && !devicesResult.stdout.includes("device")) {
        ctx.ui.notify("No Android emulator/device found. Start one first.", "error");
        ctx.ui.setStatus("push-bundle", undefined);
        return;
      }

      // Step 4: Remove old bundle from device
      ctx.ui.setStatus("push-bundle", "Removing old bundle...");
      await pi.exec("adb", ["shell", "rm", "-rf", "/sdcard/Download/cadence-bundle"], {
        timeout: 10000,
      });

      // Step 5: Push new bundle
      ctx.ui.setStatus("push-bundle", "Pushing to emulator...");
      const pushResult = await pi.exec(
        "adb",
        ["push", bundleDir, "/sdcard/Download/cadence-bundle"],
        { timeout: 60000 }
      );

      if (pushResult.code !== 0) {
        ctx.ui.notify(`Push failed: ${pushResult.stderr}`, "error");
        ctx.ui.setStatus("push-bundle", undefined);
        return;
      }

      // Step 6: Launch the app
      ctx.ui.setStatus("push-bundle", "Launching app...");
      await pi.exec("adb", ["shell", "am", "start", "-n", "com.cadence.player/.MainActivity"], {
        timeout: 5000,
      });

      ctx.ui.setStatus("push-bundle", undefined);
      ctx.ui.notify(`✓ Pushed: ${epubName}`, "success");
    },
  });

  pi.registerCommand("rebuild-player", {
    description: "Rebuild and reinstall Cadence player app, then launch it",
    handler: async (_args, ctx) => {
      const cwd = ctx.cwd;
      const playerDir = join(cwd, "player");

      ctx.ui.setStatus("rebuild-player", "Building player...");
      const buildResult = await pi.exec("./gradlew", ["installDebug"], {
        cwd: playerDir,
        timeout: 300000,
      });

      if (buildResult.code !== 0) {
        ctx.ui.notify(`Build failed: ${buildResult.stderr}`, "error");
        ctx.ui.setStatus("rebuild-player", undefined);
        return;
      }

      ctx.ui.setStatus("rebuild-player", "Launching app...");
      await pi.exec("adb", ["shell", "am", "start", "-n", "com.cadence.player/.MainActivity"], {
        timeout: 5000,
      });

      ctx.ui.setStatus("rebuild-player", undefined);
      ctx.ui.notify("✓ Player rebuilt and launched", "success");
    },
  });
}
