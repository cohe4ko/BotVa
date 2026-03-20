/**
 * BotVa Audio Receiver — server-side processing for Orange Pi Listener.
 *
 * Receives WAV files from Orange Pi devices, then:
 * 1. Saves audio locally
 * 2. Transcribes via Groq Whisper (or xAI when available)
 * 3. Analyzes transcript with Claude (facts, decisions, tasks)
 * 4. Stores structured results + daily summaries
 *
 * Usage: npx tsx scripts/orange-pi-listener/receive-transcript.ts
 *
 * Env vars:
 *   LISTENER_PORT       (default: 3847)
 *   LISTENER_AUTH_TOKEN  (optional, for auth)
 *   LISTENER_DATA_DIR   (default: workspace/listener)
 *   GROQ_API_KEY        (single key, fallback if GROQ_API_KEYS not set)
 *   GROQ_API_KEYS       (comma-separated keys for rotation)
 *   ANTHROPIC_API_KEY   (optional, for LLM analysis)
 *   STT_PROVIDER        (default: "groq", or "xai")
 *   XAI_API_KEY         (for xAI STT when available)
 */

import { createServer, IncomingMessage, ServerResponse } from "http";
import {
  writeFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
  readdirSync,
  unlinkSync,
} from "fs";
import { join, extname } from "path";
import { tmpdir } from "os";
import { execFileSync } from "child_process";

// ── Config ──────────────────────────────────────────────────────────

const PORT = parseInt(process.env.LISTENER_PORT || "3847");
const AUTH_TOKEN = process.env.LISTENER_AUTH_TOKEN || "";
const DATA_DIR =
  process.env.LISTENER_DATA_DIR || join(process.cwd(), "workspace/listener");
const GROQ_API_KEYS: string[] = (() => {
  const multi = process.env.GROQ_API_KEYS;
  if (multi) return multi.split(",").map((k) => k.trim()).filter(Boolean);
  const single = process.env.GROQ_API_KEY;
  if (single) return [single];
  return [];
})();
let groqKeyIndex = 0;

function nextGroqKey(): string | null {
  if (GROQ_API_KEYS.length === 0) return null;
  const key = GROQ_API_KEYS[groqKeyIndex % GROQ_API_KEYS.length];
  groqKeyIndex++;
  return key;
}

const XAI_API_KEY = process.env.XAI_API_KEY || "";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const STT_PROVIDER = process.env.STT_PROVIDER || "groq";

// Runtime-configurable STT language (empty = auto-detect)
let sttLanguage = process.env.STT_LANGUAGE || "";

// ── Device Status ───────────────────────────────────────────────────

interface DeviceStatus {
  device_id: string;
  uptime_seconds: number;
  cpu_temp: number;
  load_avg: number[];
  ram_used_mb: number;
  ram_total_mb: number;
  chunks_recorded: number;
  chunks_uploaded: number;
  queue_size: number;
  recording: boolean;
  lastSeen: number;
}

const deviceStatuses = new Map<string, DeviceStatus>();

// ── Helpers ─────────────────────────────────────────────────────────

function ensureDir(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function timestamp(): string {
  return new Date().toISOString();
}

// ── Multipart Parser (minimal, for file upload) ────────────────────

interface ParsedUpload {
  file?: { data: Buffer; filename: string };
  fields: Record<string, string>;
}

async function parseMultipart(req: IncomingMessage): Promise<ParsedUpload> {
  const contentType = req.headers["content-type"] || "";
  const boundaryMatch = contentType.match(/boundary=(.+?)(?:;|$)/);
  if (!boundaryMatch) throw new Error("No boundary in content-type");

  const boundary = boundaryMatch[1];
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks);

  const result: ParsedUpload = { fields: {} };
  const boundaryBuf = Buffer.from(`--${boundary}`);

  // Split by boundary
  let start = 0;
  const parts: Buffer[] = [];
  while (true) {
    const idx = body.indexOf(boundaryBuf, start);
    if (idx === -1) break;
    if (start > 0) {
      parts.push(body.subarray(start, idx - 2)); // -2 for \r\n before boundary
    }
    start = idx + boundaryBuf.length + 2; // +2 for \r\n after boundary
  }

  for (const part of parts) {
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;

    const header = part.subarray(0, headerEnd).toString();
    const data = part.subarray(headerEnd + 4);

    const nameMatch = header.match(/name="([^"]+)"/);
    const filenameMatch = header.match(/filename="([^"]+)"/);

    if (!nameMatch) continue;

    if (filenameMatch) {
      result.file = { data, filename: filenameMatch[1] };
    } else {
      result.fields[nameMatch[1]] = data.toString().trim();
    }
  }

  return result;
}

// ── Transcription ──────────────────────────────────────────────────

async function transcribeGroq(wavPath: string, langOverride?: string): Promise<string | null> {
  if (GROQ_API_KEYS.length === 0) {
    console.error("No GROQ API keys configured");
    return null;
  }

  const fileData = readFileSync(wavPath);
  const totalKeys = GROQ_API_KEYS.length;
  let keysExhausted = false;

  for (let attempt = 0; attempt <= totalKeys; attempt++) {
    // If we've tried all keys and got 429 on each, wait 60s and retry once
    if (attempt === totalKeys) {
      if (!keysExhausted) break;
      console.log(`[${timestamp()}] All ${totalKeys} keys rate-limited, waiting 60s...`);
      await new Promise((r) => setTimeout(r, 60_000));
      keysExhausted = false;
    }

    const apiKey = nextGroqKey()!;
    const keyHint = apiKey.slice(-4);
    console.log(`[${timestamp()}] Groq transcription [key ...${keyHint}]`);

    const blob = new Blob([fileData], { type: "audio/wav" });
    const form = new FormData();
    form.append("file", blob, "audio.wav");
    form.append("model", "whisper-large-v3");
    form.append("response_format", "verbose_json");
    const lang = langOverride || sttLanguage;
    if (lang) {
      form.append("language", lang);
    }

    try {
      const response = await fetch(
        "https://api.groq.com/openai/v1/audio/transcriptions",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}` },
          body: form,
        }
      );

      if (response.status === 429) {
        const text = await response.text();
        console.error(`Groq 429 [key ...${keyHint}]: ${text.slice(0, 200)}`);
        keysExhausted = true;
        continue;
      }

      if (!response.ok) {
        const text = await response.text();
        console.error(`Groq error ${response.status} [key ...${keyHint}]: ${text.slice(0, 200)}`);
        return null;
      }

      const result = (await response.json()) as any;
      return result.text?.trim() || null;
    } catch (e) {
      console.error(`Groq transcription error [key ...${keyHint}]:`, e);
      return null;
    }
  }

  console.error("All Groq keys exhausted after retry");
  return null;
}

async function transcribeXai(wavPath: string): Promise<string | null> {
  if (!XAI_API_KEY) {
    console.error("XAI_API_KEY not set");
    return null;
  }

  // Placeholder for xAI standalone STT endpoint (coming soon)
  const fileData = readFileSync(wavPath);
  const blob = new Blob([fileData], { type: "audio/wav" });

  const form = new FormData();
  form.append("file", blob, "audio.wav");
  form.append("model", "grok-2-audio");
  form.append("response_format", "verbose_json");

  try {
    const response = await fetch(
      "https://api.x.ai/v1/audio/transcriptions",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${XAI_API_KEY}` },
        body: form,
      }
    );

    if (!response.ok) {
      const text = await response.text();
      console.error(`xAI error ${response.status}: ${text.slice(0, 200)}`);
      return null;
    }

    const result = (await response.json()) as any;
    return result.text?.trim() || null;
  } catch (e) {
    console.error("xAI transcription error:", e);
    return null;
  }
}

async function transcribe(wavPath: string, langOverride?: string): Promise<string | null> {
  if (STT_PROVIDER === "xai") return transcribeXai(wavPath);
  return transcribeGroq(wavPath, langOverride);
}

// ── LLM Analysis ───────────────────────────────────────────────────

interface AnalysisResult {
  facts: string[];
  decisions: string[];
  tasks: string[];
  topics: string[];
  summary: string;
  language: string;
}

async function analyzeTranscript(text: string): Promise<AnalysisResult> {
  const empty: AnalysisResult = {
    facts: [],
    decisions: [],
    tasks: [],
    topics: [],
    summary: text.slice(0, 200),
    language: "unknown",
  };

  if (!ANTHROPIC_API_KEY) return empty;

  const prompt = `Analyze this room conversation transcript. Extract structured information.

TRANSCRIPT:
${text}

Respond in JSON format:
{
  "facts": ["factual statements mentioned (names, numbers, dates, addresses)"],
  "decisions": ["decisions made during conversation"],
  "tasks": ["action items, things to do, promises made"],
  "topics": ["main topics discussed"],
  "summary": "2-3 sentence summary of what happened",
  "language": "primary language code (uk, en, ru, etc.)"
}

Rules:
- Extract ONLY what was explicitly said, don't infer
- Facts: concrete data points (names, numbers, dates, contacts, addresses, prices)
- Decisions: clear choices made ("we decided to...", "let's do...")
- Tasks: actionable items with person responsible if mentioned
- Keep each item to 1 sentence
- If transcript is mostly noise/garbage, return empty arrays and summary "unintelligible"
- Respond with ONLY valid JSON, no markdown`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2000,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      console.error(`Anthropic API error: ${response.status}`);
      return empty;
    }

    const data = (await response.json()) as any;
    const content = data.content?.[0]?.text || "{}";
    return JSON.parse(content);
  } catch (e) {
    console.error("Analysis error:", e);
    return empty;
  }
}

// ── Daily Summary ──────────────────────────────────────────────────

function appendDailySummary(
  dateStr: string,
  ts: string,
  transcript: string,
  analysis: AnalysisResult
) {
  const summaryDir = join(DATA_DIR, "summaries");
  ensureDir(summaryDir);

  const summaryPath = join(summaryDir, `${dateStr}.md`);
  const time = ts.slice(11, 16).replace("-", ":");

  let entry = `\n## ${time}\n`;
  entry += `${analysis.summary}\n`;

  if (analysis.facts.length > 0) {
    entry += `\n**Facts:**\n`;
    analysis.facts.forEach((f) => (entry += `- ${f}\n`));
  }
  if (analysis.decisions.length > 0) {
    entry += `\n**Decisions:**\n`;
    analysis.decisions.forEach((d) => (entry += `- ${d}\n`));
  }
  if (analysis.tasks.length > 0) {
    entry += `\n**Tasks:**\n`;
    analysis.tasks.forEach((t) => (entry += `- [ ] ${t}\n`));
  }
  entry += `\n---\n`;

  if (existsSync(summaryPath)) {
    const existing = readFileSync(summaryPath, "utf-8");
    writeFileSync(summaryPath, existing + entry);
  } else {
    const header = `# Room Listener -- ${dateStr}\n`;
    writeFileSync(summaryPath, header + entry);
  }
}

// ── WAV → OGG Conversion ──────────────────────────────────────────

function convertWavToOgg(wavPath: string): string | null {
  const oggPath = wavPath.replace(/\.wav$/, ".ogg");
  try {
    execFileSync("ffmpeg", [
      "-y", "-i", wavPath,
      "-c:a", "libopus", "-b:a", "48k", "-ar", "48000", "-ac", "1",
      oggPath,
    ], { timeout: 120_000, stdio: "pipe" });

    unlinkSync(wavPath);
    const { statSync } = require("fs");
    const oggSize = (statSync(oggPath).size / 1024).toFixed(0);
    console.log(`[${timestamp()}] Converted WAV → OGG (${oggSize} KB), deleted WAV`);
    return oggPath;
  } catch (e) {
    console.error(`[${timestamp()}] FFmpeg conversion failed:`, e);
    return null; // keep WAV if conversion fails
  }
}

// ── Process Pipeline ───────────────────────────────────────────────

async function processAudio(
  wavPath: string,
  deviceId: string,
  ts: string
): Promise<void> {
  const dateStr = ts.slice(0, 10);

  // 1. Transcribe (from WAV)
  console.log(`[${timestamp()}] Transcribing: ${ts} (${STT_PROVIDER})...`);
  const text = await transcribe(wavPath);

  // 2. Convert WAV → OGG (regardless of transcription result, save space)
  convertWavToOgg(wavPath);

  if (!text) {
    console.log(`[${timestamp()}] Empty transcription, skipping analysis`);
    return;
  }

  console.log(
    `[${timestamp()}] Transcribed (${text.length} chars): ${text.slice(0, 100)}...`
  );

  // 2. Save raw transcript
  const transcriptDir = join(DATA_DIR, "transcripts", dateStr);
  ensureDir(transcriptDir);
  writeFileSync(
    join(transcriptDir, `${ts}.json`),
    JSON.stringify(
      { timestamp: ts, device: deviceId, text, provider: STT_PROVIDER },
      null,
      2
    )
  );

  // 3. Analyze with LLM
  console.log(`[${timestamp()}] Analyzing...`);
  const analysis = await analyzeTranscript(text);

  // 4. Save analysis
  const analyzedDir = join(DATA_DIR, "analyzed", dateStr);
  ensureDir(analyzedDir);
  writeFileSync(
    join(analyzedDir, `${ts}.json`),
    JSON.stringify(
      { timestamp: ts, device: deviceId, text, ...analysis },
      null,
      2
    )
  );

  const { facts, decisions, tasks } = analysis;
  console.log(
    `[${timestamp()}] Done: ${facts.length} facts, ${decisions.length} decisions, ${tasks.length} tasks`
  );

  // 5. Append to daily summary
  appendDailySummary(dateStr, ts, text, analysis);
}

// ── JSON Body Parser ────────────────────────────────────────────────

async function readJsonBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
}

// ── HTTP Server ────────────────────────────────────────────────────

async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  // Health check
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        service: "listener-receiver",
        stt: STT_PROVIDER,
        stt_language: sttLanguage || "auto",
        analysis: ANTHROPIC_API_KEY ? "enabled" : "disabled",
        groqKeys: GROQ_API_KEYS.length,
        devices: deviceStatuses.size,
      })
    );
    return;
  }

  // Settings: get current
  if (req.method === "GET" && req.url === "/settings") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ stt_language: sttLanguage || "auto" }));
    return;
  }

  // Settings: update
  if (req.method === "POST" && req.url === "/settings") {
    try {
      const body = await readJsonBody(req);
      if (body.stt_language !== undefined) {
        sttLanguage = body.stt_language === "auto" ? "" : String(body.stt_language);
        console.log(`[${timestamp()}] STT language changed to: ${sttLanguage || "auto-detect"}`);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, stt_language: sttLanguage || "auto" }));
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON body" }));
    }
    return;
  }

  // Health ping from devices
  if (req.method === "POST" && req.url === "/health-ping") {
    try {
      const body = await readJsonBody(req);
      const deviceId = body.device_id;
      if (!deviceId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "device_id required" }));
        return;
      }
      deviceStatuses.set(deviceId, {
        device_id: body.device_id,
        uptime_seconds: body.uptime_seconds ?? 0,
        cpu_temp: body.cpu_temp ?? 0,
        load_avg: body.load_avg ?? [],
        ram_used_mb: body.ram_used_mb ?? 0,
        ram_total_mb: body.ram_total_mb ?? 0,
        chunks_recorded: body.chunks_recorded ?? 0,
        chunks_uploaded: body.chunks_uploaded ?? 0,
        queue_size: body.queue_size ?? 0,
        recording: body.recording ?? false,
        lastSeen: Date.now(),
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON body" }));
    }
    return;
  }

  // List devices
  if (req.method === "GET" && req.url === "/devices") {
    const now = Date.now();
    const TEN_MINUTES = 10 * 60 * 1000;
    const devices = Array.from(deviceStatuses.values()).map((d) => ({
      ...d,
      online: now - d.lastSeen < TEN_MINUTES,
    }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(devices));
    return;
  }

  // Receive audio file
  if (req.method === "POST" && req.url === "/audio") {
    // Auth
    if (AUTH_TOKEN) {
      const auth = req.headers.authorization;
      if (auth !== `Bearer ${AUTH_TOKEN}`) {
        res.writeHead(401);
        res.end("Unauthorized");
        return;
      }
    }

    try {
      const parsed = await parseMultipart(req);

      if (!parsed.file) {
        res.writeHead(400);
        res.end("No audio file in request");
        return;
      }

      const deviceId = parsed.fields.device_id || "unknown";
      const ts =
        parsed.fields.timestamp ||
        new Date().toISOString().replace(/[:.]/g, "-");
      const dateStr = ts.slice(0, 10);

      // Save WAV
      const audioDir = join(DATA_DIR, "audio", dateStr);
      ensureDir(audioDir);
      const wavPath = join(audioDir, `${ts}.wav`);
      writeFileSync(wavPath, parsed.file.data);

      const sizeMb = (parsed.file.data.length / (1024 * 1024)).toFixed(1);
      console.log(
        `[${timestamp()}] Received: ${ts} from ${deviceId} (${sizeMb} MB)`
      );

      // Respond immediately, process in background
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "received", timestamp: ts }));

      // Process pipeline (async)
      processAudio(wavPath, deviceId, ts).catch((e) =>
        console.error(`Processing failed for ${ts}:`, e)
      );
    } catch (e) {
      console.error("Request error:", e);
      res.writeHead(500);
      res.end("Internal error");
    }
    return;
  }

  // Retranscribe an existing audio file with a different language
  if (req.method === "POST" && req.url === "/retranscribe") {
    try {
      const body = await readJsonBody(req);
      const { date, file, language } = body;
      if (!date || !file) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "date and file required" }));
        return;
      }

      // Find audio file (ogg or wav)
      const audioDir = join(DATA_DIR, "audio", date);
      const baseName = file.replace(/\.(json|ogg|wav)$/, "");
      let audioPath = join(audioDir, `${baseName}.ogg`);
      let isOgg = true;
      if (!existsSync(audioPath)) {
        audioPath = join(audioDir, `${baseName}.wav`);
        isOgg = false;
        if (!existsSync(audioPath)) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Audio file not found" }));
          return;
        }
      }

      // If OGG, convert back to WAV temporarily for Groq
      let wavPath = audioPath;
      const tmpWav = join(tmpdir(), `retranscribe-${baseName}.wav`);
      if (isOgg) {
        try {
          execFileSync("ffmpeg", ["-y", "-i", audioPath, "-ar", "16000", "-ac", "1", tmpWav], { timeout: 60_000, stdio: "pipe" });
          wavPath = tmpWav;
        } catch (e) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Failed to convert OGG to WAV" }));
          return;
        }
      }

      const lang = language === "auto" ? "" : (language || "");
      console.log(`[${timestamp()}] Retranscribing ${baseName} with language: ${lang || "auto"}`);
      const text = await transcribe(wavPath, lang);

      // Clean up temp file
      if (isOgg && existsSync(tmpWav)) {
        try { unlinkSync(tmpWav); } catch {}
      }

      if (!text) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, text: "", message: "Empty transcription" }));
        return;
      }

      // Update transcript file
      const transcriptDir = join(DATA_DIR, "transcripts", date);
      const transcriptPath = join(transcriptDir, `${baseName}.json`);
      const existing = existsSync(transcriptPath) ? JSON.parse(readFileSync(transcriptPath, "utf-8")) : {};
      existing.text = text;
      existing.provider = `${STT_PROVIDER}${lang ? ` (${lang})` : ""}`;
      writeFileSync(transcriptPath, JSON.stringify(existing, null, 2));

      // Re-analyze
      const analysis = await analyzeTranscript(text);
      const analyzedDir = join(DATA_DIR, "analyzed", date);
      ensureDir(analyzedDir);
      writeFileSync(
        join(analyzedDir, `${baseName}.json`),
        JSON.stringify({ ...existing, ...analysis }, null, 2)
      );

      console.log(`[${timestamp()}] Retranscribed: ${text.length} chars`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, text, language: lang || "auto" }));
    } catch (e) {
      console.error("Retranscribe error:", e);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal error" }));
    }
    return;
  }

  // Daily summary
  if (req.method === "GET" && req.url?.startsWith("/summary/")) {
    const dateStr = req.url.replace("/summary/", "");
    const summaryPath = join(DATA_DIR, "summaries", `${dateStr}.md`);

    if (existsSync(summaryPath)) {
      res.writeHead(200, {
        "Content-Type": "text/markdown; charset=utf-8",
      });
      res.end(readFileSync(summaryPath, "utf-8"));
    } else {
      res.writeHead(404);
      res.end("No summary for this date");
    }
    return;
  }

  // List dates
  if (req.method === "GET" && req.url === "/dates") {
    const summaryDir = join(DATA_DIR, "summaries");
    ensureDir(summaryDir);
    const dates = readdirSync(summaryDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(".md", ""))
      .sort()
      .reverse();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(dates));
    return;
  }

  res.writeHead(404);
  res.end("Not found");
}

// ── Start ──────────────────────────────────────────────────────────

const server = createServer(handleRequest);
server.listen(PORT, () => {
  console.log(`\n=== Listener Receiver ===`);
  console.log(`Port: ${PORT}`);
  console.log(`Data: ${DATA_DIR}`);
  console.log(`STT: ${STT_PROVIDER}`);
  console.log(`Groq keys: ${GROQ_API_KEYS.length}`);
  console.log(`Auth: ${AUTH_TOKEN ? "enabled" : "disabled"}`);
  console.log(`LLM: ${ANTHROPIC_API_KEY ? "enabled" : "disabled"}`);
  console.log(`\nEndpoints:`);
  console.log(`  POST /audio          -- upload WAV file`);
  console.log(`  POST /health-ping    -- device health ping`);
  console.log(`  GET  /devices        -- list device statuses`);
  console.log(`  GET  /summary/DATE   -- daily summary`);
  console.log(`  GET  /dates          -- list available dates`);
  console.log(`  GET  /health         -- health check\n`);
});
