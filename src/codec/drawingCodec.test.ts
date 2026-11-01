import { describe, expect, it } from 'vitest';
import { deflateSync, inflateSync } from 'node:zlib';
import vectors from '../../tests/fixtures/test-vectors-v1.json';
import type { Stroke } from '../domain/drawing';
import { decodeDrawing, encodeDrawing } from './drawingCodec';

describe('Gate1: v1 compatibility', () => {
  for (const vector of vectors.validCases) {
    it(`decodes ${vector.name} exactly`, async () => {
      expect(await decodeDrawing(vector.encoded)).toEqual(vector.expectedDecoded);
    });
    it(`round trips ${vector.name} with original settings`, async () => {
      const { thinDist, quant } = vector.encoder;
      const encoded = await encodeDrawing(vector.input as Stroke[], thinDist, quant);
      expect(await decodeDrawing(encoded)).toEqual(vector.expectedDecoded);
    });
  }
  for (const vector of vectors.invalidCases) {
    it(`rejects ${vector.name}`, async () => {
      await expect(decodeDrawing(vector.encoded)).rejects.toThrow();
    });
  }
});

const pack = (bytes: number[] | Uint8Array): string => deflateSync(new Uint8Array(bytes)).toString('base64url');
const vint = (n: number): number[] => {
  const bytes = [];
  do { const low = n % 128; n = Math.floor(n / 128); bytes.push(low + (n ? 128 : 0)); } while (n);
  return bytes;
};
const dot = (x = 0, y = 0): Stroke => ({ c: 0, w: 0, pts: [[x, y]] });
const repeated = (n: number): Stroke => ({ c: 7, w: 2, pts: Array.from({ length: n }, () => [0, 0]) });

describe('v1 boundaries and complete validation', () => {
  it('preserves empty drawings, empty strokes, endpoints and thinning before quantization', async () => {
    expect(await decodeDrawing(await encodeDrawing([]))).toEqual([]);
    const strokes: Stroke[] = [{ c: 0, w: 0, pts: [] }, { c: 7, w: 2, pts: [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]] }];
    expect(await decodeDrawing(await encodeDrawing(strokes, 3, 2))).toEqual([
      { c: 0, w: 0, pts: [] }, { c: 7, w: 2, pts: [[0, 0], [4, 0], [4, 0]] },
    ]);
  });
  it.each([1, 2, 3, 4, 5, 6, 7, 8])('accepts quant %i and original ceil coordinate limits', async quant => {
    const x = Math.ceil(960 / quant) * quant, y = Math.ceil(720 / quant) * quant;
    const strokes = [dot(x, y)];
    expect(await decodeDrawing(await encodeDrawing(strokes, 0, quant))).toEqual(strokes);
    await expect(decodeDrawing(pack([1, quant, 1, 0, 0, 1, ...vint(2 * (x / quant + 1)), 0]))).rejects.toThrow('coord');
    await expect(decodeDrawing(pack([1, quant, 1, 0, 0, 1, 0, ...vint(2 * (y / quant + 1))]))).rejects.toThrow('coord');
  });
  it.each([0, 9, 255])('rejects quant %i in payload', async quant => {
    await expect(decodeDrawing(pack([1, ...vint(quant), 0]))).rejects.toThrow('quant');
  });
  it.each([0, 2, 255])('rejects version %i', async version => {
    await expect(decodeDrawing(pack([...vint(version), 2, 0]))).rejects.toThrow('version');
  });
  it.each([[8, 0], [0, 3], [200, 0]])('rejects style c=%i w=%i', async (c, w) => {
    await expect(decodeDrawing(pack([1, 2, 1, ...vint(c), w, 0]))).rejects.toThrow('style');
  });
  it('accepts 500 strokes and rejects 501', async () => {
    expect(await decodeDrawing(await encodeDrawing(Array.from({ length: 500 }, () => dot())))).toHaveLength(500);
    await expect(decodeDrawing(pack([1, 2, ...vint(501)]))).rejects.toThrow('strokes');
    await expect(encodeDrawing(Array.from({ length: 501 }, () => dot()))).rejects.toThrow();
  });
  it('accepts 20000 points per stroke and 60000 total, rejects one more', async () => {
    const strokes = [repeated(20_000), repeated(20_000), repeated(20_000)];
    expect(await decodeDrawing(await encodeDrawing(strokes, 0))).toEqual(strokes);
    await expect(decodeDrawing(pack([1, 2, 1, 0, 0, ...vint(20_001)]))).rejects.toThrow('points');
    const raw = Array.from(inflateSync(Buffer.from(await encodeDrawing(strokes, 0), 'base64url')));
    raw[2] = 4;
    raw.push(0, 0, 1, 0, 0);
    await expect(decodeDrawing(pack(raw))).rejects.toThrow('total');
    await expect(encodeDrawing([repeated(20_001)], 0)).rejects.toThrow();
    await expect(encodeDrawing([...strokes, dot()], 0)).rejects.toThrow('total');
  });
  it('applies point limits after thinning, preserving long compressible drawing input', async () => {
    expect(await decodeDrawing(await encodeDrawing([repeated(60_001)]))).toEqual([
      { c: 7, w: 2, pts: [[0, 0], [0, 0]] },
    ]);
  });
  it.each([
    [1, 2, 1, 0, 0, 1, 1, 0], // negative x
    [1, 2, 1, 0, 0, 1, 0, 1], // negative y
    [1, 2, 0, 0], // trailing bytes
    [129, 0, 2, 0], // overlong version
    [1, 128, 0, 0], // overlong quant
    [128, 128, 128, 128, 128, 128, 0], // too long varint
    [1, 2, 128], // truncated varint
  ].map(raw => [raw]))('rejects malformed raw %j', async raw => {
    await expect(decodeDrawing(pack(raw))).rejects.toThrow();
  });
  it('rejects every raw and compressed truncation, never returning a partial work', async () => {
    const encoded = await encodeDrawing([dot(), dot(960, 720)], 0);
    const compressed = Buffer.from(encoded, 'base64url');
    const raw = inflateSync(compressed);
    for (let n = 0; n < raw.length; n++) await expect(decodeDrawing(pack(raw.subarray(0, n)))).rejects.toThrow();
    for (let n = 1; n < compressed.length; n++) await expect(decodeDrawing(compressed.subarray(0, n).toString('base64url'))).rejects.toThrow();
  });
  it('rejects compressed trailing junk and concatenated streams', async () => {
    const bytes = Buffer.from(await encodeDrawing([]), 'base64url');
    await expect(decodeDrawing(Buffer.concat([bytes, Buffer.from([0])]).toString('base64url'))).rejects.toThrow();
    await expect(decodeDrawing(Buffer.concat([bytes, bytes]).toString('base64url'))).rejects.toThrow();
  });
  it('rejects decompression bombs while reading and caps the encoded input', async () => {
    await expect(decodeDrawing(pack(new Uint8Array(500_000)))).rejects.toThrow('version');
    await expect(decodeDrawing(pack(new Uint8Array(500_001)))).rejects.toThrow('too big');
    await expect(decodeDrawing('A'.repeat(20_000))).rejects.not.toThrow('bad encoded length');
    await expect(decodeDrawing('A'.repeat(20_001))).rejects.toThrow('length');
  });
  it.each(['', '=', 'AAAA=', 'abc+', 'abc/', ' abc', 'a', 'eJxjZGJkYGBMqQAAAWcA4h'])('rejects invalid/noncanonical base64url %s', async encoded => {
    await expect(decodeDrawing(encoded)).rejects.toThrow();
  });
  it.each([0, 9, 1.5, NaN, Infinity])('rejects invalid encoder quant %s', async quant => {
    await expect(encodeDrawing([], 3, quant)).rejects.toThrow('quant');
  });
  it.each([-1, NaN, Infinity])('rejects invalid thin distance %s', async distance => {
    await expect(encodeDrawing([], distance)).rejects.toThrow();
  });
  it.each([null, {}, [null], [{ c: -1, w: 0, pts: [] }], [{ c: 0, w: 1.5, pts: [] }],
    [{ c: 0, w: 0, pts: null }], [{ c: 0, w: 0, pts: [[NaN, 0]] }], [{ c: 0, w: 0, pts: [['0', 0]] }],
    [{ c: 0, w: 0, pts: [[0]] }], [dot(-1, 0)], [dot(0, Infinity)], [dot(1000, 0)],
  ].map(value => [value]))('rejects invalid encoder input %j', async value => {
    await expect(encodeDrawing(value as unknown as Stroke[])).rejects.toThrow();
  });
  it('rejects sparse points rather than silently encoding missing coordinates as zero', async () => {
    await expect(encodeDrawing([{ c: 0, w: 0, pts: [new Array(2) as [number, number]] }])).rejects.toThrow('point');
  });
  it('caps encoded output for a complex valid drawing', async () => {
    let seed = 1;
    const random = (max: number): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
    const stroke: Stroke = { c: 0, w: 0, pts: Array.from({ length: 10_000 }, () => [random(961), random(721)]) };
    await expect(encodeDrawing([stroke], 0, 1)).rejects.toThrow('too long');
  });
});
