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
  // Output format args
  const args: string[] = [
    "-r", "16000",   // 16kHz sample rate
    "-c", "1",       // mono
    "-b", "16",      // 16-bit
    "-e", "signed-integer",
    "-t", "wav",
    outputPath,
  ];

  // macOS CoreAudio: select input device via AUDIODEV env var
  const env = { ...process.env };
  if (inputDevice && inputDevice !== "Default") {
    env.AUDIODEV = inputDevice;
  }

  // Duration limit (for continuous mode)
  if (maxDuration > 0) {
    args.push("trim", "0", String(maxDuration));
  }

  const proc = spawn("rec", args, {
    stdio: ["ignore", "pipe", "pipe"],
    env,
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
 * List available INPUT audio devices on macOS.
 * Parses system_profiler SPAudioDataType to find devices with "Input Channels".
 */
export function listInputDevices(): string[] {
  try {
    const output = execSync("system_profiler SPAudioDataType 2>/dev/null", {
      encoding: "utf-8",
      timeout: 10000,
    });

    const devices: string[] = [];
    let currentDevice = "";

    for (const line of output.split("\n")) {
      // Device name is indented with 8 spaces and ends with ":"
      const deviceMatch = line.match(/^        (.+):$/);
      if (deviceMatch) {
        currentDevice = deviceMatch[1].trim();
        continue;
      }
      // If this device has input channels, it's a microphone
      if (currentDevice && line.includes("Input Channels")) {
        devices.push(currentDevice);
        currentDevice = "";
      }
    }

    return devices.length > 0 ? devices : ["Default"];
  } catch {
    return ["Default"];
  }
}
