const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const sizes = [16, 32, 48, 128];
const iconDirectory = path.resolve(__dirname, "../icons");

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function insideRoundedRect(x, y, size) {
  const radius = size * 0.27;
  const cx = Math.max(radius, Math.min(size - radius, x));
  const cy = Math.max(radius, Math.min(size - radius, y));
  return Math.hypot(x - cx, y - cy) <= radius;
}

function samplePixel(x, y, size) {
  const samples = 4;
  let backgroundCoverage = 0;
  let plusCoverage = 0;
  let dotCoverage = 0;

  for (let sy = 0; sy < samples; sy += 1) {
    for (let sx = 0; sx < samples; sx += 1) {
      const px = x + (sx + 0.5) / samples;
      const py = y + (sy + 0.5) / samples;
      if (!insideRoundedRect(px, py, size)) {
        continue;
      }

      backgroundCoverage += 1;
      const halfStroke = size * 0.063;
      const plusStart = size * 0.27;
      const plusEnd = size * 0.73;
      const vertical = Math.abs(px - size / 2) <= halfStroke && py >= plusStart && py <= plusEnd;
      const horizontal = Math.abs(py - size / 2) <= halfStroke && px >= plusStart && px <= plusEnd;
      if (vertical || horizontal) {
        plusCoverage += 1;
      }

      if (Math.hypot(px - size * 0.77, py - size * 0.24) <= size * 0.085) {
        dotCoverage += 1;
      }
    }
  }

  const total = samples * samples;
  const backgroundAlpha = backgroundCoverage / total;
  const plusAlpha = plusCoverage / total;
  const dotAlpha = dotCoverage / total;

  if (backgroundAlpha === 0) {
    return [0, 0, 0, 0];
  }

  let color = [183, 229, 90];
  if (plusAlpha > 0) {
    const blend = plusAlpha / backgroundAlpha;
    color = color.map((value, index) => Math.round(value * (1 - blend) + [23, 32, 8][index] * blend));
  }
  if (dotAlpha > 0) {
    const blend = dotAlpha / backgroundAlpha;
    color = color.map((value) => Math.round(value * (1 - blend) + 255 * blend));
  }

  return [...color, Math.round(backgroundAlpha * 255)];
}

function createPng(size) {
  const rowLength = size * 4 + 1;
  const raw = Buffer.alloc(rowLength * size);

  for (let y = 0; y < size; y += 1) {
    raw[y * rowLength] = 0;
    for (let x = 0; x < size; x += 1) {
      const offset = y * rowLength + 1 + x * 4;
      const [red, green, blue, alpha] = samplePixel(x, y, size);
      raw[offset] = red;
      raw[offset + 1] = green;
      raw[offset + 2] = blue;
      raw[offset + 3] = alpha;
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

for (const size of sizes) {
  fs.writeFileSync(path.join(iconDirectory, `icon-${size}.png`), createPng(size));
}

console.log(`generated ${sizes.length} icons`);
