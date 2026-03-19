/**
 * BotVa endpoint to receive transcripts from Orange Pi Listener.
 *
 * This is a standalone Express server that:
 * 1. Receives JSON transcripts via POST
 * 2. Saves them locally
 * 3. Sends them through LLM for analysis (facts, decisions, tasks)
 * 4. Stores structured results
 *
 * Usage: npx tsx scripts/orange-pi-listener/receive-transcript.ts
 * Or add to BotVa as a route.
 */

import { createServer, IncomingMessage, ServerResponse } from "http";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { join } from "path";

// ── Config ──────────────────────────────────────────────────────────

const PORT = parseInt(process.env.LISTENER_PORT || "3847");
const AUTH_TOKEN = process.env.LISTENER_AUTH_TOKEN || "";
const DATA_DIR = process.env.LISTENER_DATA_DIR || join(process.cwd(), "workspace/listener");
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";

// ── Storage ─────────────────────────────────────────────────────────

function ensureDir(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

interface Transcript {
  timestamp: string;
  text: string;
  provider: string;
}

interface AnalysisResult {
  timestamp: string;
  raw_text: string;
  facts: string[];
  decisions: string[];
  tasks: string[];
  topics: string[];
  summary: string;
  language: string;
}

// ── LLM Analysis ───────────────────────────────────────────────────

async function analyzeTranscript(text: string): Promise<Omit<AnalysisResult, "timestamp" | "raw_text">> {
  if (!ANTHROPIC_API_KEY) {
    return {
      facts: [],
      decisions: [],
      tasks: [],
      topics: [],
      summary: text.slice(0, 200),
      language: "unknown",
    };
  }

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
      return { facts: [], decisions: [], tasks: [], topics: [], summary: text.slice(0, 200), language: "unknown" };
    }

    const data = await response.json() as any;
    const content = data.content?.[0]?.text || "{}";
    return JSON.parse(content);
  } catch (e) {
    console.error("Analysis error:", e);
    return { facts: [], decisions: [], tasks: [], topics: [], summary: text.slice(0, 200), language: "unknown" };
  }
}

// ── HTTP Server ────────────────────────────────────────────────────

async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  // Health check
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "listener-receiver" }));
    return;
  }

  // Receive transcript
  if (req.method === "POST" && req.url === "/transcript") {
    // Auth check
    if (AUTH_TOKEN) {
      const auth = req.headers.authorization;
      if (auth !== `Bearer ${AUTH_TOKEN}`) {
        res.writeHead(401);
        res.end("Unauthorized");
        return;
      }
    }

    // Read body
    let body = "";
    for await (const chunk of req) body += chunk;

    let transcript: Transcript;
    try {
      transcript = JSON.parse(body);
    } catch {
      res.writeHead(400);
      res.end("Invalid JSON");
      return;
    }

    if (!transcript.text || !transcript.timestamp) {
      res.writeHead(400);
      res.end("Missing text or timestamp");
      return;
    }

    const dateStr = transcript.timestamp.slice(0, 10);
    const rawDir = join(DATA_DIR, "raw", dateStr);
    const analyzedDir = join(DATA_DIR, "analyzed", dateStr);
    ensureDir(rawDir);
    ensureDir(analyzedDir);

    // Save raw transcript
    const rawPath = join(rawDir, `${transcript.timestamp}.json`);
    writeFileSync(rawPath, JSON.stringify(transcript, null, 2));
    console.log(`[${new Date().toISOString()}] Received: ${transcript.timestamp} (${transcript.text.length} chars)`);

    // Analyze in background
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "received", timestamp: transcript.timestamp }));

    // Async analysis
    try {
      console.log(`[${new Date().toISOString()}] Analyzing: ${transcript.timestamp}...`);
      const analysis = await analyzeTranscript(transcript.text);

      const result: AnalysisResult = {
        timestamp: transcript.timestamp,
        raw_text: transcript.text,
        ...analysis,
      };

      const analyzedPath = join(analyzedDir, `${transcript.timestamp}.json`);
      writeFileSync(analyzedPath, JSON.stringify(result, null, 2));

      const factCount = result.facts.length;
      const taskCount = result.tasks.length;
      const decisionCount = result.decisions.length;
      console.log(`[${new Date().toISOString()}] Analyzed: ${factCount} facts, ${taskCount} tasks, ${decisionCount} decisions`);

      // Append to daily summary
      appendDailySummary(dateStr, result);
    } catch (e) {
      console.error(`Analysis failed for ${transcript.timestamp}:`, e);
    }

    return;
  }

  // Daily summary
  if (req.method === "GET" && req.url?.startsWith("/summary/")) {
    const dateStr = req.url.replace("/summary/", "");
    const summaryPath = join(DATA_DIR, "summaries", `${dateStr}.md`);

    if (existsSync(summaryPath)) {
      res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8" });
      res.end(readFileSync(summaryPath, "utf-8"));
    } else {
      res.writeHead(404);
      res.end("No summary for this date");
    }
    return;
  }

  res.writeHead(404);
  res.end("Not found");
}

function appendDailySummary(dateStr: string, result: AnalysisResult) {
  const summaryDir = join(DATA_DIR, "summaries");
  ensureDir(summaryDir);

  const summaryPath = join(summaryDir, `${dateStr}.md`);
  const time = result.timestamp.slice(11, 16).replace("-", ":");

  let entry = `\n## ${time}\n`;
  entry += `${result.summary}\n`;

  if (result.facts.length > 0) {
    entry += `\n**Facts:**\n`;
    result.facts.forEach(f => entry += `- ${f}\n`);
  }
  if (result.decisions.length > 0) {
    entry += `\n**Decisions:**\n`;
    result.decisions.forEach(d => entry += `- ${d}\n`);
  }
  if (result.tasks.length > 0) {
    entry += `\n**Tasks:**\n`;
    result.tasks.forEach(t => entry += `- [ ] ${t}\n`);
  }
  entry += `\n---\n`;

  if (existsSync(summaryPath)) {
    const existing = readFileSync(summaryPath, "utf-8");
    writeFileSync(summaryPath, existing + entry);
  } else {
    const header = `# Room Listener Summary -- ${dateStr}\n`;
    writeFileSync(summaryPath, header + entry);
  }
}

// ── Start ──────────────────────────────────────────────────────────

const server = createServer(handleRequest);
server.listen(PORT, () => {
  console.log(`Listener receiver started on port ${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
  console.log(`Auth: ${AUTH_TOKEN ? "enabled" : "disabled"}`);
  console.log(`LLM analysis: ${ANTHROPIC_API_KEY ? "enabled" : "disabled"}`);
  console.log(`\nEndpoints:`);
  console.log(`  POST /transcript    -- receive transcript`);
  console.log(`  GET  /summary/DATE  -- daily summary (e.g. /summary/2026-03-19)`);
  console.log(`  GET  /health        -- health check`);
});
