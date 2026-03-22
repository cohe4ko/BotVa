import { readFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, copyFileSync } from "fs";
import { join, basename } from "path";
import { request as httpRequest } from "http";
import { request as httpsRequest } from "https";
import { URL } from "url";
import type { AppConfig, UploadResult } from "./types";

/**
 * Upload WAV file to server using multipart/form-data.
 * Compatible with receive-transcript.ts /audio endpoint.
 */
export async function uploadAudio(
  wavPath: string,
  config: AppConfig
): Promise<UploadResult> {
  if (!config.uploadUrl) {
    return { ok: false, error: "No UPLOAD_URL configured" };
  }

  try {
    const fileData = readFileSync(wavPath);
    const filename = basename(wavPath);
    const timestamp = filename.replace(".wav", "");
    const boundary = "----MacListener" + Date.now().toString(36);

    // Build multipart body
    const parts: Buffer[] = [];

    // device_id field
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="device_id"\r\n\r\n${config.deviceId}\r\n`
    ));

    // timestamp field
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="timestamp"\r\n\r\n${timestamp}\r\n`
    ));

    // file
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: audio/wav\r\n\r\n`
    ));
    parts.push(fileData);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

    const body = Buffer.concat(parts);
    const url = new URL(config.uploadUrl);
    const isHttps = url.protocol === "https:";

    const headers: Record<string, string> = {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Content-Length": String(body.length),
    };
    if (config.uploadToken) {
      headers["Authorization"] = `Bearer ${config.uploadToken}`;
    }

    return new Promise<UploadResult>((resolve) => {
      const reqFn = isHttps ? httpsRequest : httpRequest;
      const req = reqFn(
        {
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname,
          method: "POST",
          headers,
          timeout: 120_000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            const responseBody = Buffer.concat(chunks).toString("utf-8");
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              let transcript: string | undefined;
              try {
                const json = JSON.parse(responseBody);
                transcript = json.transcript || json.text;
              } catch {}
              resolve({ ok: true, status: res.statusCode, transcript });
            } else {
              resolve({
                ok: false,
                status: res.statusCode,
                error: responseBody.slice(0, 200),
              });
            }
          });
        }
      );

      req.on("error", (err) => {
        resolve({ ok: false, error: err.message });
      });

      req.on("timeout", () => {
        req.destroy();
        resolve({ ok: false, error: "Upload timeout (120s)" });
      });

      req.write(body);
      req.end();
    });
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

// ── Retry Queue ──────────────────────────────────────────────────────

function getQueueDir(config: AppConfig): string {
  const dir = join(config.audioDir, "queue");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function queueForRetry(wavPath: string, config: AppConfig): void {
  const queueDir = getQueueDir(config);
  const dest = join(queueDir, basename(wavPath));
  copyFileSync(wavPath, dest);
  console.log(`Queued for retry: ${basename(wavPath)}`);
}

export async function processRetryQueue(config: AppConfig): Promise<number> {
  const queueDir = getQueueDir(config);
  if (!existsSync(queueDir)) return 0;

  const files = readdirSync(queueDir)
    .filter((f) => f.endsWith(".wav"))
    .sort();

  let uploaded = 0;
  for (const file of files) {
    const fullPath = join(queueDir, file);
    const result = await uploadAudio(fullPath, config);
    if (result.ok) {
      unlinkSync(fullPath);
      uploaded++;
    } else {
      break; // If one fails, likely all will
    }
  }
  return uploaded;
}

export function getQueueSize(config: AppConfig): number {
  const queueDir = getQueueDir(config);
  if (!existsSync(queueDir)) return 0;
  return readdirSync(queueDir).filter((f) => f.endsWith(".wav")).length;
}
