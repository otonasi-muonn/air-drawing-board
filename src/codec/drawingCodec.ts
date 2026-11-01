import { DH, DW, PALETTE, WIDTHS, type Point, type Stroke } from '../domain/drawing';

const MAX_ENCODED = 20_000;
const MAX_RAW = 500_000;
const MAX_STROKES = 500;
const MAX_POINTS = 20_000;
const MAX_TOTAL_POINTS = 60_000;

function writeVarint(value: number, out: number[]): void {
  do {
    let byte = value % 128;
    value = Math.floor(value / 128);
    if (value > 0) byte += 128;
    out.push(byte);
  } while (value > 0);
}

function thinPoints(points: Point[], distance: number): Point[] {
  if (points.length < 2) return points.slice();
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const previous = out[out.length - 1];
    const dx = points[i][0] - previous[0], dy = points[i][1] - previous[1];
    if (dx * dx + dy * dy >= distance * distance) out.push(points[i]);
  }
  if (out[out.length - 1] !== points[points.length - 1]) out.push(points[points.length - 1]);
  return out;
}

async function readBytes(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        throw new Error('too big');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function validateInput(strokes: Stroke[], thinDist: number, quant: number): void {
  if (!Number.isInteger(quant) || quant < 1 || quant > 8) throw new Error('bad quant');
  if (!Number.isFinite(thinDist) || thinDist < 0) throw new Error('bad thin distance');
  if (!Array.isArray(strokes) || strokes.length > MAX_STROKES) throw new Error('bad strokes');
  for (const stroke of strokes) {
    if (!stroke || !Number.isInteger(stroke.c) || stroke.c < 0 || stroke.c >= PALETTE.length ||
        !Number.isInteger(stroke.w) || stroke.w < 0 || stroke.w >= WIDTHS.length) throw new Error('bad style');
    if (!Array.isArray(stroke.pts)) throw new Error('bad points');
    for (const point of stroke.pts) {
      if (!Array.isArray(point) || point.length !== 2 || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) {
        throw new Error('bad point');
      }
      const [x, y] = point;
      if (x < 0 || y < 0 || Math.round(x / quant) > Math.ceil(DW / quant) ||
          Math.round(y / quant) > Math.ceil(DH / quant)) throw new Error('coord out of range');
    }
  }
}

/** v1: thin → quantize → delta/zigzag → varint → zlib deflate → base64url. */
export async function encodeDrawing(strokes: Stroke[], thinDist = 3, quant = 2): Promise<string> {
  validateInput(strokes, thinDist, quant);
  const out = [1];
  writeVarint(quant, out);
  writeVarint(strokes.length, out);
  let total = 0;
  for (const stroke of strokes) {
    const points = thinPoints(stroke.pts, thinDist);
    if (points.length > MAX_POINTS) throw new Error('too many points');
    total += points.length;
    if (total > MAX_TOTAL_POINTS) throw new Error('too many points total');
    writeVarint(stroke.c, out); writeVarint(stroke.w, out); writeVarint(points.length, out);
    let px = 0, py = 0;
    for (const [x, y] of points) {
      const qx = Math.round(x / quant), qy = Math.round(y / quant);
      const dx = qx - px, dy = qy - py;
      writeVarint(dx >= 0 ? dx * 2 : -dx * 2 - 1, out);
      writeVarint(dy >= 0 ? dy * 2 : -dy * 2 - 1, out);
      px = qx; py = qy;
    }
  }
  const compressed = await readBytes(new Blob([new Uint8Array(out)]).stream().pipeThrough(new CompressionStream('deflate')), MAX_RAW);
  const encoded = base64url(compressed);
  if (encoded.length > MAX_ENCODED) throw new Error('too long');
  return encoded;
}

/** 完全な検証が済んだ作品だけを返す。展開は上限付きの非同期readerで行う。 */
export async function decodeDrawing(str: string): Promise<Stroke[]> {
  if (typeof str !== 'string' || !str || str.length > MAX_ENCODED) throw new Error('bad encoded length');
  if (!/^[A-Za-z0-9_-]+$/.test(str)) throw new Error('invalid chars');
  const binary = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  const compressed = Uint8Array.from(binary, character => character.charCodeAt(0));
  if (base64url(compressed) !== str) throw new Error('noncanonical base64url');
  const raw = await readBytes(new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate')), MAX_RAW);
  let offset = 0;
  const readVarint = (): number => {
    let value = 0, multiplier = 1;
    for (let k = 0; k < 6; k++) {
      if (offset >= raw.length) throw new Error('eof');
      const byte = raw[offset++];
      value += (byte % 128) * multiplier;
      if (byte < 128) {
        if (k > 0 && byte === 0) throw new Error('noncanonical varint');
        return value;
      }
      multiplier *= 128;
    }
    throw new Error('varint too long');
  };
  if (readVarint() !== 1) throw new Error('bad version');
  const quant = readVarint();
  if (quant < 1 || quant > 8) throw new Error('bad quant');
  const maxX = Math.ceil(DW / quant), maxY = Math.ceil(DH / quant);
  const count = readVarint();
  if (count > MAX_STROKES) throw new Error('too many strokes');
  const strokes: Stroke[] = [];
  let total = 0;
  const unzig = (n: number): number => n % 2 === 0 ? n / 2 : -(n + 1) / 2;
  for (let s = 0; s < count; s++) {
    const c = readVarint(), w = readVarint(), n = readVarint();
    if (c >= PALETTE.length || w >= WIDTHS.length) throw new Error('bad style');
    if (n > MAX_POINTS) throw new Error('too many points');
    total += n;
    if (total > MAX_TOTAL_POINTS) throw new Error('too many points total');
    const pts: Point[] = [];
    let px = 0, py = 0;
    for (let p = 0; p < n; p++) {
      px += unzig(readVarint()); py += unzig(readVarint());
      if (px < 0 || py < 0 || px > maxX || py > maxY) throw new Error('coord out of range');
      pts.push([px * quant, py * quant]);
    }
    strokes.push({ c, w, pts });
  }
  if (offset !== raw.length) throw new Error('trailing data');
  return strokes;
}
