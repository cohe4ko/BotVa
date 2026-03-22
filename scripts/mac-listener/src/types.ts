import type { ChildProcess } from "child_process";

export type AppState = "idle" | "recording" | "uploading";
export type RecordingMode = "toggle" | "continuous";

export interface AppConfig {
  uploadUrl: string;
  uploadToken: string;
  deviceId: string;
  chunkDuration: number;
  silenceThreshold: number;
  minSpeechPct: number;
  audioDir: string;
  mode: RecordingMode;
  inputDevice: string; // sox input device name, empty = default
}

export interface RecordingHandle {
  process: ChildProcess;
  outputPath: string;
  startedAt: number;
  promise: Promise<boolean>;
}

export interface UploadResult {
  ok: boolean;
  status?: number;
  transcript?: string;
  error?: string;
}
