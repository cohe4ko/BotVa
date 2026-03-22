import { spawn, execSync } from "child_process";
import type { RecordingHandle } from "./types";

/**
 * Start recording from microphone using ffmpeg (avfoundation on macOS).
 * Much lighter on CPU than sox/rec which does unnecessary resampling.
 *
 * @param outputPath - path to output WAV file
 * @param maxDuration - max duration in seconds (0 = unlimited, for toggle mode)
 * @param inputDevice - avfoundation audio device index or name (empty = default ":0")
 */
export function startRecording(
  outputPath: string,
  maxDuration: number = 0,
  inputDevice: string = ""
): RecordingHandle {
  // avfoundation input: "none:<audio_device>" — no video, only audio
  const audioInput = inputDevice && inputDevice !== "Default"
    ? `:${inputDevice}`
    : ":0";

  const args: string[] = [
    "-f", "avfoundation",
    "-i", audioInput,
    "-ar", "16000",   // 16kHz sample rate
    "-ac", "1",       // mono
    "-sample_fmt", "s16",
    "-y",             // overwrite
  ];

  // Duration limit (for continuous mode)
  if (maxDuration > 0) {
    args.push("-t", String(maxDuration));
  }

  args.push(outputPath);

  console.log(`[rec] ffmpeg ${args.join(" ")}`);

  const proc = spawn("ffmpeg", args, {
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Log stderr for debugging
  let stderr = "";
  proc.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const promise = new Promise<boolean>((resolve) => {
    proc.on("close", (code) => {
      if (code !== 0 && code !== 255) {
        // 255 = killed by signal, which is expected for toggle mode
        const lastLines = stderr.split("\n").slice(-3).join("\n");
        console.error(`[rec] ffmpeg exited ${code}: ${lastLines}`);
      }
      resolve(true); // WAV should be written even on SIGINT
    });
    proc.on("error", (err) => {
      console.error("[rec] ffmpeg spawn error:", err.message);
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
 * Sends 'q' to ffmpeg stdin for clean shutdown (writes proper WAV header).
 */
export async function stopRecording(handle: RecordingHandle): Promise<boolean> {
  if (handle.process.exitCode !== null) {
    return handle.promise;
  }

  // Send 'q' to ffmpeg for graceful stop (writes WAV header properly)
  try {
    handle.process.stdin?.write("q");
  } catch {
    // stdin may be closed
    handle.process.kill("SIGINT");
  }

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
 * List available audio INPUT devices via ffmpeg avfoundation.
 * Returns array of { index, name } for audio devices.
 */
export interface AudioDevice {
  index: string;
  name: string;
}

export function listInputDevices(): AudioDevice[] {
  try {
    const output = execSync(
      'ffmpeg -f avfoundation -list_devices true -i "" 2>&1 || true',
      { encoding: "utf-8", timeout: 5000 }
    );

    const devices: AudioDevice[] = [];
    let inAudio = false;

    for (const line of output.split("\n")) {
      if (line.includes("AVFoundation audio devices:")) {
        inAudio = true;
        continue;
      }
      if (line.includes("AVFoundation video devices:")) {
        inAudio = false;
        continue;
      }
      if (inAudio) {
        const match = line.match(/\[(\d+)\]\s+(.+)/);
        if (match) {
          devices.push({ index: match[1], name: match[2].trim() });
        }
      }
    }

    return devices.length > 0 ? devices : [{ index: "0", name: "Default" }];
  } catch {
    return [{ index: "0", name: "Default" }];
  }
}
