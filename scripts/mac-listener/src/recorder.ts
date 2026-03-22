import { spawn, execSync, type ChildProcess } from "child_process";
import type { RecordingHandle } from "./types";

/**
 * Start recording from microphone using sox `rec` command.
 * @param outputPath - path to output WAV file
 * @param maxDuration - max duration in seconds (0 = unlimited, for toggle mode)
 * @param inputDevice - sox input device (empty = system default)
 */
export function startRecording(
  outputPath: string,
  maxDuration: number = 0,
  inputDevice: string = ""
): RecordingHandle {
  const args: string[] = [];

  // Input device override (macOS coreaudio)
  if (inputDevice) {
    args.push("-d", inputDevice);
  }

  // Output format
  args.push(
    "-r", "16000",   // 16kHz sample rate
    "-c", "1",       // mono
    "-b", "16",      // 16-bit
    "-e", "signed-integer",
    "-t", "wav",
    outputPath
  );

  // Duration limit (for continuous mode)
  if (maxDuration > 0) {
    args.push("trim", "0", String(maxDuration));
  }

  const proc = spawn("rec", args, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  const promise = new Promise<boolean>((resolve) => {
    proc.on("close", (code) => {
      // rec exits 0 normally, or non-zero on SIGINT (which is fine for toggle)
      resolve(code === 0 || code === null);
    });
    proc.on("error", (err) => {
      console.error("rec error:", err.message);
      resolve(false);
    });
  });

  return {
    process: proc,
    outputPath,
    startedAt: Date.now(),
    promise,
  };
}

/**
 * Stop a running recording gracefully.
 */
export async function stopRecording(handle: RecordingHandle): Promise<boolean> {
  if (handle.process.exitCode !== null) {
    return handle.promise;
  }
  handle.process.kill("SIGINT");
  // Wait up to 5s for process to exit
  const timeout = new Promise<boolean>((resolve) => {
    setTimeout(() => {
      if (handle.process.exitCode === null) {
        handle.process.kill("SIGKILL");
      }
      resolve(false);
    }, 5000);
  });
  return Promise.race([handle.promise, timeout]);
}

/**
 * List available input devices from sox.
 * Returns array of device names.
 */
export function listInputDevices(): string[] {
  try {
    // On macOS, sox uses coreaudio; list devices via system_profiler or sox
    const output = execSync("rec --list-devices 2>&1 || true", {
      encoding: "utf-8",
      timeout: 5000,
    });

    // Parse sox output — look for device names
    const devices: string[] = [];
    for (const line of output.split("\n")) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("rec") && !trimmed.startsWith("--")) {
        devices.push(trimmed);
      }
    }

    // Fallback: use macOS system_profiler
    if (devices.length === 0) {
      try {
        const spOutput = execSync(
          'system_profiler SPAudioDataType 2>/dev/null | grep "Input Source"',
          { encoding: "utf-8", timeout: 5000 }
        );
        for (const line of spOutput.split("\n")) {
          const match = line.match(/Input Source:\s*(.+)/);
          if (match) devices.push(match[1].trim());
        }
      } catch {}
    }

    return devices.length > 0 ? devices : ["Default"];
  } catch {
    return ["Default"];
  }
}
