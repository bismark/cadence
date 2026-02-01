/**
 * Android Emulator Screenshot Extension
 *
 * Captures debug screenshots from the currently running Android emulator.
 * The screenshot is returned as an image that can be viewed by the LLM.
 *
 * Usage: The LLM can call the `android_screenshot` tool to capture the current screen.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export default function androidScreenshotExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "android_screenshot",
    label: "Android Screenshot",
    description:
      "Capture a screenshot from the currently running Android emulator. Returns the screenshot as an image.",
    parameters: Type.Object({
      description: Type.Optional(
        Type.String({
          description: "Optional description of what you're looking for in the screenshot",
        })
      ),
    }),

    async execute(toolCallId, params, onUpdate, ctx, signal) {
      // Create temp file path for screenshot
      const tempDir = os.tmpdir();
      const timestamp = Date.now();
      const localPath = path.join(tempDir, `android-screenshot-${timestamp}.png`);
      const devicePath = `/sdcard/screenshot-${timestamp}.png`;

      try {
        // Check if adb is available
        const adbCheck = await pi.exec("which", ["adb"], { signal, timeout: 5000 });
        if (adbCheck.code !== 0) {
          return {
            content: [{ type: "text", text: "Error: adb not found in PATH" }],
            isError: true,
          };
        }

        // Check for connected devices
        const devicesResult = await pi.exec("adb", ["devices"], { signal, timeout: 5000 });
        if (devicesResult.code !== 0) {
          return {
            content: [{ type: "text", text: `Error checking devices: ${devicesResult.stderr}` }],
            isError: true,
          };
        }

        // Parse device list (skip header line)
        const lines = devicesResult.stdout.trim().split("\n").slice(1);
        const devices = lines.filter((line) => line.includes("device") || line.includes("emulator"));

        if (devices.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No Android emulator or device connected. Start an emulator first.",
              },
            ],
            isError: true,
          };
        }

        // Stream progress
        onUpdate?.({
          content: [{ type: "text", text: "Capturing screenshot from emulator..." }],
        });

        // Take screenshot on device
        const screencapResult = await pi.exec(
          "adb",
          ["shell", "screencap", "-p", devicePath],
          { signal, timeout: 10000 }
        );

        if (screencapResult.code !== 0) {
          return {
            content: [
              { type: "text", text: `Error capturing screenshot: ${screencapResult.stderr}` },
            ],
            isError: true,
          };
        }

        // Pull screenshot to local machine
        const pullResult = await pi.exec(
          "adb",
          ["pull", devicePath, localPath],
          { signal, timeout: 10000 }
        );

        if (pullResult.code !== 0) {
          return {
            content: [{ type: "text", text: `Error pulling screenshot: ${pullResult.stderr}` }],
            isError: true,
          };
        }

        // Clean up device file
        await pi.exec("adb", ["shell", "rm", devicePath], { signal, timeout: 5000 });

        // Read the screenshot file
        const imageData = fs.readFileSync(localPath);
        const base64Data = imageData.toString("base64");

        // Clean up local file
        fs.unlinkSync(localPath);

        // Return the image
        return {
          content: [
            {
              type: "image",
              data: base64Data,
              mimeType: "image/png",
            },
            {
              type: "text",
              text: params.description
                ? `Screenshot captured. Looking for: ${params.description}`
                : "Screenshot captured from Android emulator.",
            },
          ],
          details: {
            device: devices[0]?.trim(),
            timestamp: new Date().toISOString(),
          },
        };
      } catch (error) {
        // Clean up files on error
        try {
          if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
          await pi.exec("adb", ["shell", "rm", "-f", devicePath], { timeout: 5000 });
        } catch {
          // Ignore cleanup errors
        }

        return {
          content: [
            {
              type: "text",
              text: `Error capturing screenshot: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  });

  // Also register a command for manual use
  pi.registerCommand("screenshot", {
    description: "Capture a screenshot from Android emulator",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Capturing Android screenshot...", "info");

      const tempDir = os.tmpdir();
      const timestamp = Date.now();
      const localPath = path.join(tempDir, `android-screenshot-${timestamp}.png`);
      const devicePath = `/sdcard/screenshot-${timestamp}.png`;

      try {
        await pi.exec("adb", ["shell", "screencap", "-p", devicePath], { timeout: 10000 });
        await pi.exec("adb", ["pull", devicePath, localPath], { timeout: 10000 });
        await pi.exec("adb", ["shell", "rm", devicePath], { timeout: 5000 });

        ctx.ui.notify(`Screenshot saved to: ${localPath}`, "success");
      } catch (error) {
        ctx.ui.notify(
          `Failed: ${error instanceof Error ? error.message : String(error)}`,
          "error"
        );
      }
    },
  });
}
