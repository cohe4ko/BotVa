import {
  app,
  Tray,
  Menu,
  nativeImage,
  MenuItem,
  dialog,
  nativeTheme,
} from "electron";
import { join, basename } from "path";
import { existsSync, unlinkSync, statSync } from "fs";
import { loadConfig, saveConfig } from "./config";
import { startRecording, stopRecording, listInputDevices, type AudioDevice } from "./recorder";
import { detectSpeechPercentage } from "./vad";
import {
  uploadAudio,
  queueForRetry,
  processRetryQueue,
  getQueueSize,
} from "./uploader";
import type { AppConfig, AppState, RecordingHandle, RecordingMode } from "./types";

// ── State ────────────────────────────────────────────────────────────

let tray: Tray | null = null;
let config: AppConfig;
let state: AppState = "idle";
let recordingHandle: RecordingHandle | null = null;
let recordingTimer: ReturnType<typeof setInterval> | null = null;
let recordingSeconds = 0;
let lastTranscript = "";
let continuousRunning = false;

// ── Tray Icons ───────────────────────────────────────────────────────

const ASSETS_DIR = join(__dirname, "..", "assets");

function createTrayIcon(color: "idle" | "recording" | "uploading"): Electron.NativeImage {
  const iconFiles: Record<string, string> = {
    idle: "trayTemplate.png",
    recording: "tray-recording.png",
    uploading: "tray-uploading.png",
  };
  const file = join(ASSETS_DIR, iconFiles[color]);
  const img = nativeImage.createFromPath(file);
  // Mark idle icon as template so macOS adapts to dark/light mode
  if (color === "idle") {
    img.setTemplateImage(true);
  }
  return img;
}

// ── Timer ────────────────────────────────────────────────────────────

function startTimer() {
  recordingSeconds = 0;
  recordingTimer = setInterval(() => {
    recordingSeconds++;
    rebuildMenu();
  }, 1000);
}

function stopTimer() {
  if (recordingTimer) {
    clearInterval(recordingTimer);
    recordingTimer = null;
  }
  recordingSeconds = 0;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

// ── Recording Logic ──────────────────────────────────────────────────

function generateWavPath(): string {
  const ts = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "T")
    .replace("Z", "");
  return join(config.audioDir, `${ts}.wav`);
}

async function doStartRecording() {
  if (state !== "idle") return;

  const wavPath = generateWavPath();
  const maxDuration = config.mode === "continuous" ? config.chunkDuration : 0;

  state = "recording";
  tray?.setImage(createTrayIcon("recording"));
  startTimer();
  rebuildMenu();

  recordingHandle = startRecording(wavPath, maxDuration, config.inputDevice);

  if (config.mode === "continuous") {
    continuousRunning = true;
    runContinuousLoop();
  }
}

async function doStopRecording() {
  if (state !== "recording" || !recordingHandle) return;

  continuousRunning = false;
  await stopRecording(recordingHandle);
  stopTimer();

  const wavPath = recordingHandle.outputPath;
  recordingHandle = null;

  await processChunk(wavPath);
}

async function doForceUpload() {
  if (state !== "recording" || !recordingHandle) return;

  continuousRunning = false;
  await stopRecording(recordingHandle);
  stopTimer();

  const wavPath = recordingHandle.outputPath;
  recordingHandle = null;

  // Skip VAD — force upload
  await processChunk(wavPath, true);
}

async function processChunk(wavPath: string, skipVad: boolean = false) {
  if (!existsSync(wavPath) || statSync(wavPath).size < 1000) {
    state = "idle";
    tray?.setImage(createTrayIcon("idle"));
    rebuildMenu();
    return;
  }

  const sizeKb = (statSync(wavPath).size / 1024).toFixed(1);

  if (!skipVad) {
    // VAD
    const speechPct = detectSpeechPercentage(wavPath, config.silenceThreshold);
    console.log(`Speech: ${speechPct.toFixed(1)}% (${sizeKb} KB)`);

    if (speechPct < config.minSpeechPct) {
      console.log(`Silence (${speechPct.toFixed(1)}% < ${config.minSpeechPct}%), skipping`);
      unlinkSync(wavPath);
      state = "idle";
      tray?.setImage(createTrayIcon("idle"));
      rebuildMenu();
      return;
    }
  } else {
    console.log(`Force upload (${sizeKb} KB), skipping VAD`);
  }

  // Upload
  state = "uploading";
  tray?.setImage(createTrayIcon("uploading"));
  rebuildMenu();

  const result = await uploadAudio(wavPath, config);

  if (result.ok) {
    console.log(`Uploaded: ${basename(wavPath)}`);
    if (result.transcript) {
      lastTranscript = result.transcript;
    }
    unlinkSync(wavPath);
  } else {
    console.error(`Upload failed: ${result.error}`);
    queueForRetry(wavPath, config);
    if (existsSync(wavPath)) unlinkSync(wavPath);
  }

  state = "idle";
  tray?.setImage(createTrayIcon("idle"));
  rebuildMenu();
}

async function runContinuousLoop() {
  while (continuousRunning) {
    // Wait for current chunk to finish
    if (recordingHandle) {
      await recordingHandle.promise;
    }

    if (!continuousRunning) break;

    const wavPath = recordingHandle?.outputPath;
    recordingHandle = null;
    stopTimer();

    // Process the completed chunk
    if (wavPath) {
      await processChunk(wavPath);
    }

    if (!continuousRunning) break;

    // Start next chunk
    const nextPath = generateWavPath();
    state = "recording";
    tray?.setImage(createTrayIcon("recording"));
    startTimer();
    rebuildMenu();

    recordingHandle = startRecording(nextPath, config.chunkDuration, config.inputDevice);
  }
}

// ── Server Status Check ──────────────────────────────────────────────

async function checkServerStatus(): Promise<boolean> {
  if (!config.uploadUrl) return false;
  try {
    const url = new URL(config.uploadUrl);
    const healthUrl = `${url.protocol}//${url.host}/health`;
    const { request } = url.protocol === "https:" ? await import("https") : await import("http");

    return new Promise((resolve) => {
      const req = request(healthUrl, { method: "GET", timeout: 5000 }, (res) => {
        resolve(res.statusCode === 200);
      });
      req.on("error", () => resolve(false));
      req.on("timeout", () => { req.destroy(); resolve(false); });
      req.end();
    });
  } catch {
    return false;
  }
}

// ── Tray Menu ────────────────────────────────────────────────────────

function rebuildMenu() {
  if (!tray) return;

  const statusLabel =
    state === "recording"
      ? `● Recording (${formatTime(recordingSeconds)})`
      : state === "uploading"
        ? "↑ Uploading..."
        : "○ Idle";

  const queueSize = getQueueSize(config);

  const template: (Electron.MenuItemConstructorOptions | Electron.MenuItem)[] = [
    { label: statusLabel, enabled: false },
    { type: "separator" },
  ];

  // Start/Stop button + Force Upload
  if (state === "recording") {
    template.push({
      label: "■ Stop Recording",
      click: () => doStopRecording(),
    });
    template.push({
      label: "⚡ Force Upload Now",
      click: () => doForceUpload(),
    });
  } else if (state === "idle") {
    template.push({
      label: "▶ Start Recording",
      click: () => doStartRecording(),
      enabled: !!config.uploadUrl,
    });
  } else {
    template.push({ label: "Uploading...", enabled: false });
  }

  template.push({ type: "separator" });

  // Mode submenu
  template.push({
    label: `Mode: ${config.mode === "toggle" ? "Toggle" : "Continuous"}`,
    submenu: [
      {
        label: "Toggle",
        type: "radio",
        checked: config.mode === "toggle",
        click: () => {
          config.mode = "toggle";
          saveConfig({ mode: "toggle" });
          rebuildMenu();
        },
      },
      {
        label: "Continuous",
        type: "radio",
        checked: config.mode === "continuous",
        click: () => {
          config.mode = "continuous";
          saveConfig({ mode: "continuous" });
          rebuildMenu();
        },
      },
    ],
  });

  // Microphone submenu (ffmpeg avfoundation devices)
  const audioDevices = listInputDevices();
  const currentDeviceName = audioDevices.find(d => d.index === config.inputDevice)?.name || "Default";
  const micSubmenu: Electron.MenuItemConstructorOptions[] = audioDevices.map((dev) => ({
    label: `[${dev.index}] ${dev.name}`,
    type: "radio" as const,
    checked: config.inputDevice === dev.index || (!config.inputDevice && dev.index === "0"),
    click: () => {
      config.inputDevice = dev.index;
      saveConfig({ inputDevice: dev.index });
      rebuildMenu();
    },
  }));
  template.push({
    label: `Microphone: ${currentDeviceName}`,
    submenu: micSubmenu,
  });

  // Chunk duration submenu (for continuous mode)
  if (config.mode === "continuous") {
    template.push({
      label: `Chunk: ${config.chunkDuration / 60} min`,
      submenu: [1, 2, 5, 10].map((min) => ({
        label: `${min} min`,
        type: "radio" as const,
        checked: config.chunkDuration === min * 60,
        click: () => {
          config.chunkDuration = min * 60;
          saveConfig({ chunkDuration: min * 60 });
          rebuildMenu();
        },
      })),
    });
  }

  template.push({ type: "separator" });

  // Last transcript
  if (lastTranscript) {
    const truncated =
      lastTranscript.length > 50
        ? lastTranscript.slice(0, 50) + "..."
        : lastTranscript;
    template.push({ label: `Last: "${truncated}"`, enabled: false });
  }

  // Server & queue status
  const serverLabel = config.uploadUrl
    ? `Server: ${config.uploadUrl.replace(/^https?:\/\//, "").split("/")[0]}`
    : "Server: not configured";
  template.push({ label: serverLabel, enabled: false });

  if (queueSize > 0) {
    template.push({
      label: `Queue: ${queueSize} pending`,
      click: async () => {
        const uploaded = await processRetryQueue(config);
        console.log(`Retry queue: uploaded ${uploaded}`);
        rebuildMenu();
      },
    });
  }

  template.push({ type: "separator" });

  // Config
  template.push({
    label: "Set Server URL...",
    click: async () => {
      // Use a simple prompt via dialog
      const result = await dialog.showMessageBox({
        type: "question",
        title: "Server URL",
        message: "Enter the upload URL (e.g. http://host:3847/audio):",
        detail: `Current: ${config.uploadUrl || "(not set)"}`,
        buttons: ["Cancel", "OK"],
      });
      // Electron doesn't have a native input dialog — use env var or settings file
      if (result.response === 1) {
        console.log("Edit UPLOAD_URL in env or settings.json in", app.getPath("userData"));
      }
    },
  });

  template.push({ type: "separator" });
  template.push({ label: "Quit", click: () => app.quit() });

  const menu = Menu.buildFromTemplate(template);
  tray.setContextMenu(menu);
}

// ── App Lifecycle ────────────────────────────────────────────────────

// Prevent app from quitting when no windows are open
app.on("window-all-closed", () => {});

app.whenReady().then(() => {
  // Hide dock icon (tray-only app)
  if (process.platform === "darwin") {
    app.dock?.hide();
    // @ts-ignore — setActivationPolicy exists on macOS
    app.setActivationPolicy?.("accessory");
  }

  config = loadConfig();

  if (!config.uploadUrl) {
    console.log("⚠ UPLOAD_URL not set. Set it via env var or settings.json in", app.getPath("userData"));
  }

  console.log(`🎙 Mac Listener starting (device: ${config.deviceId}, mode: ${config.mode})`);
  console.log(`   Server: ${config.uploadUrl || "(not configured)"}`);
  console.log(`   Audio dir: ${config.audioDir}`);

  tray = new Tray(createTrayIcon("idle"));
  tray.setToolTip("Mac Listener");
  rebuildMenu();

  // Process retry queue on startup
  processRetryQueue(config).then((n) => {
    if (n > 0) console.log(`Startup: uploaded ${n} queued files`);
  });
});

app.on("before-quit", async () => {
  if (recordingHandle) {
    continuousRunning = false;
    await stopRecording(recordingHandle);
  }
});
