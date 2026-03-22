import { readFileSync } from "fs";

/**
 * Simple energy-based Voice Activity Detection.
 * Port of detect_speech_percentage() from listener.py.
 *
 * Reads WAV file, analyzes 20ms frames, returns percentage of frames with speech.
 */
export function detectSpeechPercentage(
  wavPath: string,
  threshold: number = 3
): number {
  try {
    const buf = readFileSync(wavPath);

    // Parse WAV header
    if (buf.length < 44) return 0;
    const riff = buf.toString("ascii", 0, 4);
    if (riff !== "RIFF") return 100; // Not a WAV, assume speech

    const sampleRate = buf.readUInt32LE(24);
    const bitsPerSample = buf.readUInt16LE(34);
    const numChannels = buf.readUInt16LE(22);

    if (bitsPerSample !== 16) return 100; // Only handle 16-bit

    // Find data chunk
    let dataOffset = 12;
    let dataSize = 0;
    while (dataOffset < buf.length - 8) {
      const chunkId = buf.toString("ascii", dataOffset, dataOffset + 4);
      const chunkSize = buf.readUInt32LE(dataOffset + 4);
      if (chunkId === "data") {
        dataOffset += 8;
        dataSize = chunkSize;
        break;
      }
      dataOffset += 8 + chunkSize;
    }

    if (dataSize === 0) return 100;

    // 20ms frames
    const frameSize = Math.floor(sampleRate * 0.02) * numChannels;
    const bytesPerFrame = frameSize * 2; // 16-bit = 2 bytes per sample

    let totalFrames = 0;
    let speechFrames = 0;
    let offset = dataOffset;

    while (offset + bytesPerFrame <= dataOffset + dataSize) {
      let sumSquares = 0;
      for (let i = 0; i < frameSize; i++) {
        const sample = buf.readInt16LE(offset + i * 2);
        sumSquares += sample * sample;
      }
      const rms = Math.sqrt(sumSquares / frameSize);
      const energy = rms / 327.68; // 0-100 scale (same as Python)

      totalFrames++;
      if (energy > threshold) {
        speechFrames++;
      }

      offset += bytesPerFrame;
    }

    if (totalFrames === 0) return 0;
    return (speechFrames / totalFrames) * 100;
  } catch (err) {
    console.error("VAD error:", err);
    return 100; // On error, assume speech (don't skip)
  }
}
