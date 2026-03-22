import { app } from "electron";
import { join } from "path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import type { AppConfig, RecordingMode } from "./types";

const SETTINGS_FILE = "settings.json";

function getSettingsPath(): string {
  const dir = app.getPath("userData");
  return join(dir, SETTINGS_FILE);
}

function getAudioDir(): string {
  const dir = join(app.getPath("temp"), "mac-listener-audio");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function loadConfig(): AppConfig {
  const saved = loadSavedSettings();
  return {
    uploadUrl: process.env.UPLOAD_URL || saved.uploadUrl || "",
    uploadToken: process.env.UPLOAD_TOKEN || saved.uploadToken || "",
    deviceId: process.env.DEVICE_ID || saved.deviceId || "mac-1",
    chunkDuration: parseInt(process.env.CHUNK_DURATION || "") || saved.chunkDuration || 300,
    silenceThreshold: parseInt(process.env.SILENCE_THRESHOLD || "") || saved.silenceThreshold || 3,
    minSpeechPct: parseInt(process.env.MIN_SPEECH_PCT || "") || saved.minSpeechPct || 15,
    audioDir: getAudioDir(),
    mode: (saved.mode as RecordingMode) || "toggle",
    inputDevice: saved.inputDevice || "",
  };
}

export function saveConfig(config: Partial<AppConfig>): void {
  const current = loadSavedSettings();
  const merged = { ...current, ...config };
  const path = getSettingsPath();
  writeFileSync(path, JSON.stringify(merged, null, 2));
}

function loadSavedSettings(): Partial<AppConfig> {
  try {
    const path = getSettingsPath();
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, "utf-8"));
    }
  } catch {}
  return {};
}
