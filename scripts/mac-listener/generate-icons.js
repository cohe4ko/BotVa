/**
 * Generate tray icons for Mac Listener.
 * Creates PNG files: microphone icon in idle/recording/uploading states.
 * Run: node generate-icons.js
 */
const { deflateSync } = require("zlib");
const { writeFileSync, mkdirSync } = require("fs");
const { join } = require("path");

const ASSETS_DIR = join(__dirname, "assets");
mkdirSync(ASSETS_DIR, { recursive: true });

// ── Minimal PNG encoder ──────────────────────────────────────────────

function createPNG(width, height, rgba) {
  // PNG signature
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const ihdrChunk = makeChunk("IHDR", ihdr);

  // IDAT chunk — raw image data with filter byte per row
  const rawData = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    rawData[y * (1 + width * 4)] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const srcIdx = (y * width + x) * 4;
      const dstIdx = y * (1 + width * 4) + 1 + x * 4;
      rawData[dstIdx] = rgba[srcIdx];
      rawData[dstIdx + 1] = rgba[srcIdx + 1];
      rawData[dstIdx + 2] = rgba[srcIdx + 2];
      rawData[dstIdx + 3] = rgba[srcIdx + 3];
    }
  }
  const compressed = deflateSync(rawData);
  const idatChunk = makeChunk("IDAT", compressed);

  // IEND chunk
  const iendChunk = makeChunk("IEND", Buffer.alloc(0));

  return Buffer.concat([sig, ihdrChunk, idatChunk, iendChunk]);
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeB = Buffer.from(type, "ascii");
  const crcData = Buffer.concat([typeB, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcData), 0);
  return Buffer.concat([len, typeB, data, crc]);
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ── Drawing helpers ──────────────────────────────────────────────────

function createCanvas(w, h) {
  return { w, h, data: new Uint8Array(w * h * 4) };
}

function setPixel(canvas, x, y, r, g, b, a) {
  if (x < 0 || x >= canvas.w || y < 0 || y >= canvas.h) return;
  const idx = (y * canvas.w + x) * 4;
  // Alpha blend
  const srcA = a / 255;
  const dstA = canvas.data[idx + 3] / 255;
  const outA = srcA + dstA * (1 - srcA);
  if (outA === 0) return;
  canvas.data[idx] = Math.round((r * srcA + canvas.data[idx] * dstA * (1 - srcA)) / outA);
  canvas.data[idx + 1] = Math.round((g * srcA + canvas.data[idx + 1] * dstA * (1 - srcA)) / outA);
  canvas.data[idx + 2] = Math.round((b * srcA + canvas.data[idx + 2] * dstA * (1 - srcA)) / outA);
  canvas.data[idx + 3] = Math.round(outA * 255);
}

function fillCircle(canvas, cx, cy, r, cr, cg, cb, ca) {
  for (let y = Math.floor(cy - r - 1); y <= Math.ceil(cy + r + 1); y++) {
    for (let x = Math.floor(cx - r - 1); x <= Math.ceil(cx + r + 1); x++) {
      const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      if (dist <= r + 0.5) {
        const alpha = dist > r - 0.5 ? Math.max(0, (r + 0.5 - dist)) : 1;
        setPixel(canvas, x, y, cr, cg, cb, Math.round(ca * alpha));
      }
    }
  }
}

function fillRect(canvas, x1, y1, x2, y2, r, g, b, a) {
  for (let y = Math.max(0, y1); y <= Math.min(canvas.h - 1, y2); y++) {
    for (let x = Math.max(0, x1); x <= Math.min(canvas.w - 1, x2); x++) {
      setPixel(canvas, x, y, r, g, b, a);
    }
  }
}

function fillRoundRect(canvas, x1, y1, x2, y2, radius, r, g, b, a) {
  for (let y = y1; y <= y2; y++) {
    for (let x = x1; x <= x2; x++) {
      let inside = true;
      // Check corners
      if (x < x1 + radius && y < y1 + radius) {
        inside = Math.sqrt((x - (x1 + radius)) ** 2 + (y - (y1 + radius)) ** 2) <= radius + 0.5;
      } else if (x > x2 - radius && y < y1 + radius) {
        inside = Math.sqrt((x - (x2 - radius)) ** 2 + (y - (y1 + radius)) ** 2) <= radius + 0.5;
      } else if (x < x1 + radius && y > y2 - radius) {
        inside = Math.sqrt((x - (x1 + radius)) ** 2 + (y - (y2 - radius)) ** 2) <= radius + 0.5;
      } else if (x > x2 - radius && y > y2 - radius) {
        inside = Math.sqrt((x - (x2 - radius)) ** 2 + (y - (y2 - radius)) ** 2) <= radius + 0.5;
      }
      if (inside) setPixel(canvas, x, y, r, g, b, a);
    }
  }
}

// ── Draw microphone icon ─────────────────────────────────────────────

function drawMicIcon(size, color) {
  const c = createCanvas(size, size);
  const [cr, cg, cb] = color;
  const s = size / 22; // scale factor

  // Mic head (rounded rect / ellipse)
  const headCx = size / 2;
  const headTop = Math.round(1 * s);
  const headBot = Math.round(12 * s);
  const headW = Math.round(3.5 * s);

  // Draw mic head as rounded rectangle
  fillRoundRect(c,
    Math.round(headCx - headW), headTop,
    Math.round(headCx + headW), headBot,
    Math.round(3 * s),
    cr, cg, cb, 255
  );

  // Mic holder arc (U shape below head)
  const arcCy = Math.round(10 * s);
  const arcR = Math.round(5.5 * s);
  const lineW = Math.round(1.2 * s);
  for (let angle = 0; angle <= Math.PI; angle += 0.02) {
    const ax = headCx + arcR * Math.cos(angle);
    const ay = arcCy + arcR * Math.sin(angle);
    fillCircle(c, ax, ay, lineW / 2, cr, cg, cb, 255);
  }

  // Stand (vertical line from arc bottom)
  const standTop = Math.round(arcCy + arcR);
  const standBot = Math.round(18.5 * s);
  fillRect(c,
    Math.round(headCx - lineW / 2), standTop,
    Math.round(headCx + lineW / 2), standBot,
    cr, cg, cb, 255
  );

  // Base (horizontal line)
  const baseW = Math.round(3.5 * s);
  fillRect(c,
    Math.round(headCx - baseW), Math.round(standBot),
    Math.round(headCx + baseW), Math.round(standBot + lineW),
    cr, cg, cb, 255
  );

  return c;
}

// ── Generate all icons ───────────────────────────────────────────────

// Template image (black, macOS will tint it) — @1x and @2x
for (const [suffix, size] of [["", 22], ["@2x", 44]]) {
  const c = drawMicIcon(size, [0, 0, 0]);
  const png = createPNG(c.w, c.h, Buffer.from(c.data));
  writeFileSync(join(ASSETS_DIR, `trayTemplate${suffix}.png`), png);
  console.log(`Created trayTemplate${suffix}.png (${size}x${size})`);
}

// Recording icon (red) — @1x and @2x
for (const [suffix, size] of [["", 22], ["@2x", 44]]) {
  const c = drawMicIcon(size, [255, 59, 48]);
  // Add red dot indicator top-right
  fillCircle(c, Math.round(size * 0.78), Math.round(size * 0.15), Math.round(size * 0.12), 255, 59, 48, 255);
  const png = createPNG(c.w, c.h, Buffer.from(c.data));
  writeFileSync(join(ASSETS_DIR, `tray-recording${suffix}.png`), png);
  console.log(`Created tray-recording${suffix}.png (${size}x${size})`);
}

// Uploading icon (blue) — @1x and @2x
for (const [suffix, size] of [["", 22], ["@2x", 44]]) {
  const c = drawMicIcon(size, [50, 130, 246]);
  const png = createPNG(c.w, c.h, Buffer.from(c.data));
  writeFileSync(join(ASSETS_DIR, `tray-uploading${suffix}.png`), png);
  console.log(`Created tray-uploading${suffix}.png (${size}x${size})`);
}

console.log("\nDone! Icons saved to assets/");
