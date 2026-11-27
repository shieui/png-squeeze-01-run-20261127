// png-squeeze: a lossless PNG optimizer in pure Node.js standard library.
//
// Reads every instance under the input directory (one 1280x720 RGBA screenshot
// per instance, stored as a PNG), and writes the same image back as a PNG in as
// few bytes as possible, losslessly. Every pixel's RGBA must decode exactly,
// including a fully transparent pixel's colour.
//
// How it works:
//   1. Decode the input PNG to raw RGBA.
//   2. Analyse the pixels: are they all opaque? all grey? how many distinct
//      colours are there? Is there a single fully-transparent colour that no
//      opaque pixel uses (so a tRNS key can replace the alpha channel)?
//   3. Build every lossless form that fits the image: a palette form (at most
//      256 colours, in frequency order and in luminance order), a grey form,
//      a grey+alpha form, an RGB form (with or without a tRNS key) and an RGBA
//      form. For each form, try several ways of choosing each row's PNG
//      filter: fixed filters, the minimum-signed-sum heuristic, the
//      fewest-distinct-byte-pairs heuristic, and a per-row brute force that
//      actually deflates each of the five filters against the 32 KiB already
//      written and keeps the smallest.
//   4. Screen every candidate by deflating it once at zlib level 6 and pick
//      the smallest (counting PLTE/tRNS chunk overhead). Re-encode the best
//      two candidates at zlib level 9 under a few deterministic settings and
//      keep the smallest stream.
//   5. Write the PNG with only IHDR, PLTE, tRNS, IDAT and IEND chunks.
//   6. Verify each written file in-process before exiting: decode it back
//      and confirm every pixel is byte-identical to the input, the chunk
//      set is only IHDR/PLTE/tRNS/IDAT/IEND with correct CRCs, bit depth 8,
//      not interlaced, and the file is at most 4 MiB; exit non-zero on any
//      failure.
//
// Everything is a fixed amount of work: no wall clock is read, no randomness
// is used, and every tie is broken by the lowest value, so two runs produce
// byte-identical output. Only Node's built-in modules are used; no external
// program is ever started and nothing is read from the network.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { constants, deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// PNG container: CRC-32, chunk assembly.
// ---------------------------------------------------------------------------

const CRC_TABLE: Int32Array = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const PNG_SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);

function textBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Assemble a PNG from [type, data] chunks. */
function assemblePng(chunks: Array<[string, Uint8Array]>): Uint8Array {
  let size = PNG_SIGNATURE.length;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(PNG_SIGNATURE, 0);
  let at = PNG_SIGNATURE.length;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    out.set(textBytes(type), at + 4);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

function ihdrData(width: number, height: number, colourType: number): Uint8Array {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8; // bit depth
  d[9] = colourType;
  d[10] = 0; // compression
  d[11] = 0; // filter method
  d[12] = 0; // no interlace
  return d;
}

// ---------------------------------------------------------------------------
// PNG decoding to RGBA.
// ---------------------------------------------------------------------------

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Decode any bit-depth-8, non-interlaced PNG of colour type 0/2/3/4/6 to RGBA. */
function decodePng(bytes: Uint8Array): { width: number; height: number; rgba: Uint8Array } {
  if (bytes.length < 8 || !PNG_SIGNATURE.every((b, i) => bytes[i] === b)) {
    throw new Error('not a PNG file');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let width = 0;
  let height = 0;
  let colourType = -1;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idatParts: Uint8Array[] = [];
  let ended = false;
  while (at < bytes.length) {
    if (ended) throw new Error('bytes after IEND');
    if (at + 12 > bytes.length) throw new Error('truncated chunk header');
    const len = view.getUint32(at);
    if (at + 12 + len > bytes.length) throw new Error('truncated chunk');
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (crc32(bytes, at + 4, at + 8 + len) !== view.getUint32(at + 8 + len)) {
      throw new Error(`${type} chunk fails its CRC`);
    }
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') {
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      width = dv.getUint32(0);
      height = dv.getUint32(4);
      if (data[8] !== 8) throw new Error('bit depth is not 8');
      colourType = data[9];
      if (!(colourType in CHANNELS)) throw new Error(`unsupported colour type ${colourType}`);
      if (data[12] !== 0) throw new Error('interlaced PNG');
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IDAT') {
      idatParts.push(data);
    } else if (type === 'IEND') {
      ended = true;
    } else {
      throw new Error(`unsupported chunk ${type}`);
    }
  }
  if (!ended || idatParts.length === 0) throw new Error('missing IEND or IDAT');
  const bpp = CHANNELS[colourType];
  const stride = width * bpp;
  const expected = height * (stride + 1);
  const raw = inflateSync(idatParts.length === 1 ? idatParts[0] : Buffer.concat(idatParts), {
    maxOutputLength: expected + 1,
  });
  if (raw.length !== expected) throw new Error('inflated size mismatch');

  // Unfilter row by row into samples.
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    if (filter > 4) throw new Error(`row ${y} has filter ${filter}`);
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const up = dst - stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? samples[dst + i - bpp] : 0;
      const b = y > 0 ? samples[up + i] : 0;
      const c = y > 0 && i >= bpp ? samples[up + i - bpp] : 0;
      let pred = 0;
      if (filter === 1) pred = a;
      else if (filter === 2) pred = b;
      else if (filter === 3) pred = (a + b) >> 1;
      else if (filter === 4) pred = paethPredictor(a, b, c);
      samples[dst + i] = raw[src + i] + pred;
    }
  }

  // Expand samples to RGBA.
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) {
    rgba.set(samples);
  } else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s + 1];
      rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = g;
      rgba[d + 1] = g;
      rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s];
      rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    if (palette === null) throw new Error('palette PNG without PLTE');
    const entries = palette.length / 3;
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      if (e >= entries) throw new Error(`palette index ${e} out of range`);
      rgba[d] = palette[e * 3];
      rgba[d + 1] = palette[e * 3 + 1];
      rgba[d + 2] = palette[e * 3 + 2];
      rgba[d + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
  }
  return { width, height, rgba };
}

// ---------------------------------------------------------------------------
// Analysis: what the pixels allow.
// ---------------------------------------------------------------------------

interface ColourEntry {
  key: number; // (r << 24) | (g << 16) | (b << 8) | a, as an unsigned 32-bit int
  r: number;
  g: number;
  b: number;
  a: number;
  count: number;
}

interface Analysis {
  opaque: boolean;
  grey: boolean;
  colours: ColourEntry[] | null; // null when more than 256 distinct colours
  /** The single fully-transparent grey/RGB value usable as a tRNS key, or -1. */
  transparentKey: number;
}

/** Pack one pixel's channels into one unsigned 32-bit key. */
function colourKey(r: number, g: number, b: number, a: number): number {
  return (((r << 24) >>> 0) | (g << 16) | (b << 8) | a) >>> 0;
}

function analyse(rgba: Uint8Array): Analysis {
  const n = rgba.length >>> 2;
  let opaque = true;
  let grey = true;
  const counts = new Map<number, number>();
  let tooMany = false;
  // A tRNS key is possible only when every non-opaque pixel is fully
  // transparent and they all share one colour, and no opaque pixel uses it.
  let key = -1;
  let keyPossible = true;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    const r = rgba[d];
    const g = rgba[d + 1];
    const b = rgba[d + 2];
    const a = rgba[d + 3];
    if (a !== 255) opaque = false;
    if (r !== g || r !== b) grey = false;
    if (keyPossible) {
      if (a === 255) {
        // Opaque pixel: remembered below in the second pass.
      } else if (a === 0) {
        const v = grey ? r : (r << 16) | (g << 8) | b;
        if (key === -1) key = v;
        else if (key !== v) keyPossible = false;
      } else {
        keyPossible = false;
      }
    }
    if (!tooMany) {
      const k = colourKey(r, g, b, a);
      const c = counts.get(k);
      if (c === undefined) {
        if (counts.size === 256) tooMany = true;
        else counts.set(k, 1);
      } else {
        counts.set(k, c + 1);
      }
    }
  }
  let transparentKey = -1;
  if (keyPossible && key !== -1) {
    // No opaque pixel may share the transparent value.
    let clash = false;
    for (let d = 0; d < rgba.length; d += 4) {
      if (rgba[d + 3] !== 255) continue;
      const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
      if (v === key) {
        clash = true;
        break;
      }
    }
    if (!clash) transparentKey = key;
  }
  let colours: ColourEntry[] | null = null;
  if (!tooMany) {
    colours = [];
    for (const [k, count] of counts) {
      colours.push({
        key: k,
        r: (k >>> 24) & 0xff,
        g: (k >>> 16) & 0xff,
        b: (k >>> 8) & 0xff,
        a: k & 0xff,
        count,
      });
    }
  }
  return { opaque, grey, colours, transparentKey };
}

// ---------------------------------------------------------------------------
// Forms: the lossless encodings a pixel buffer can take.
// ---------------------------------------------------------------------------

interface Form {
  colourType: number;
  bpp: number;
  samples: Uint8Array;
  plte: Uint8Array | null;
  trns: Uint8Array | null;
  /** Filter choices to try for this form: a fixed type, or a heuristic name. */
  filters: Array<number | 'minsum' | 'pairs' | 'brute'>;
}

/** The image's samples in a non-palette colour type. */
function channelSamples(rgba: Uint8Array, colourType: number): Uint8Array {
  const n = rgba.length >>> 2;
  if (colourType === 6) return rgba;
  const ch = colourType === 0 ? 1 : colourType === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (colourType === 0) {
      out[s] = rgba[d];
    } else if (colourType === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

function luminance(e: ColourEntry): number {
  return 299 * e.r + 587 * e.g + 114 * e.b;
}

/**
 * Order palette entries: fully transparent entries first (least alpha
 * first, so tRNS stays short), then by the given order, ties broken by the
 * colour key so the result is deterministic.
 */
function orderPalette(colours: ColourEntry[], by: 'count' | 'luminance'): ColourEntry[] {
  return [...colours].sort((x, y) => {
    const tx = x.a === 255 ? 1 : 0;
    const ty = y.a === 255 ? 1 : 0;
    if (tx !== ty) return tx - ty;
    if (tx === 0 && x.a !== y.a) return x.a - y.a;
    if (by === 'count') {
      if (y.count !== x.count) return y.count - x.count;
    } else {
      const lx = luminance(x);
      const ly = luminance(y);
      if (lx !== ly) return lx - ly;
    }
    return x.key - y.key;
  });
}

/** Build a palette form from ordered entries. */
function paletteForm(rgba: Uint8Array, entries: ColourEntry[]): Form {
  const index = new Map<number, number>();
  const plte = new Uint8Array(entries.length * 3);
  let lastTransparent = 0;
  entries.forEach((c, i) => {
    index.set(c.key, i);
    plte[i * 3] = c.r;
    plte[i * 3 + 1] = c.g;
    plte[i * 3 + 2] = c.b;
    if (c.a !== 255) lastTransparent = i + 1;
  });
  const trns =
    lastTransparent === 0
      ? null
      : Uint8Array.from(entries.slice(0, lastTransparent), (c) => c.a);
  const n = rgba.length >>> 2;
  const indices = new Uint8Array(n);
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    indices[i] = index.get(colourKey(rgba[d], rgba[d + 1], rgba[d + 2], rgba[d + 3])) as number;
  }
  return { colourType: 3, bpp: 1, samples: indices, plte, trns, filters: [] };
}

const CHANNEL_FILTERS: Array<number | 'minsum' | 'pairs' | 'brute'> = [0, 2, 4, 'minsum', 'pairs', 'brute'];

/** Every lossless form worth trying for this image. */
function formsOf(rgba: Uint8Array, info: Analysis): Form[] {
  const forms: Form[] = [];
  if (info.colours !== null) {
    // Palette in frequency order: flat areas compress best unfiltered.
    const byCount = paletteForm(rgba, orderPalette(info.colours, 'count'));
    byCount.filters = [0];
    forms.push(byCount);
    // Palette in luminance order: neighbouring indices hold similar colours,
    // so per-row filter choice can win.
    const byLum = paletteForm(rgba, orderPalette(info.colours, 'luminance'));
    byLum.filters = [0, 'minsum', 'brute'];
    forms.push(byLum);
    if (!info.grey) return forms;
  }
  // A channel form as well (grey images can also be palettes, and the grey
  // form has no PLTE overhead; non-grey images with no palette need it).
  let colourType: number;
  let trns: Uint8Array | null = null;
  if (info.grey) {
    colourType = info.opaque || info.transparentKey !== -1 ? 0 : 4;
    if (info.transparentKey !== -1) trns = Uint8Array.of(0, info.transparentKey);
  } else {
    colourType = info.opaque || info.transparentKey !== -1 ? 2 : 6;
    if (info.transparentKey !== -1) {
      const k = info.transparentKey;
      trns = Uint8Array.of(0, k >>> 16, 0, (k >>> 8) & 0xff, 0, k & 0xff);
    }
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[colourType] as number;
  forms.push({
    colourType,
    bpp,
    samples: channelSamples(rgba, colourType),
    plte: null,
    trns,
    filters: CHANNEL_FILTERS,
  });
  return forms;
}

/** Bytes a form's PLTE and tRNS chunks add to the file. */
function chunkOverhead(form: Form): number {
  return (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);
}

// ---------------------------------------------------------------------------
// Filtering: the five PNG filters and the per-row choice heuristics.
// ---------------------------------------------------------------------------

/** Filter one row of `cur` (bpp bytes a pixel) against `prev` into `out`. */
function filterRow(type: number, cur: Uint8Array, prev: Uint8Array | null, bpp: number, out: Uint8Array): void {
  const n = cur.length;
  if (type === 0) {
    out.set(cur);
  } else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  } else if (type === 3) {
    for (let i = 0; i < n; i++) {
      out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
    }
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paethPredictor(a, b, c);
    }
  }
}

/** Sum of the absolute values of a filtered row's bytes read as signed. */
function signedSum(row: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

/** How many distinct neighbouring byte pairs a filtered row holds. */
function distinctPairs(row: Uint8Array, seen: Uint32Array, stamp: number): number {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) {
      seen[pair] = stamp;
      n++;
    }
  }
  return n;
}

const BRUTE_CONTEXT = 32768; // bytes of already-written data a row trial may use
const BRUTE_LEVEL = 4; // zlib level the brute-force trials are weighed at

/**
 * Filter every row of `samples` by `choice` into `raw` (height rows of
 * stride+1 bytes, each starting with its filter byte). `choice` is a fixed
 * filter type, or a per-row heuristic: 'minsum' (least signed sum),
 * 'pairs' (fewest distinct byte pairs), or 'brute' (deflate each of the five
 * filters against the data already written and keep the smallest stream).
 */
function filterSamples(
  samples: Uint8Array,
  width: number,
  height: number,
  bpp: number,
  choice: number | 'minsum' | 'pairs' | 'brute',
): Uint8Array {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trials: Uint8Array[] = [];
  for (let t = 0; t < 5; t++) trials.push(new Uint8Array(stride + 1));
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    let bestType = 0;
    let bestCost = Infinity;
    for (let t = 0; t < 5; t++) {
      trials[t][0] = t;
      filterRow(t, cur, prev, bpp, trials[t].subarray(1));
      let cost: number;
      if (choice === 'minsum') {
        cost = signedSum(trials[t].subarray(1));
      } else if (choice === 'pairs') {
        cost = distinctPairs(trials[t].subarray(1), seen, ++stamp);
      } else {
        // Brute force: what this row really costs inside the stream so far.
        const context = raw.subarray(Math.max(0, at - BRUTE_CONTEXT), at);
        cost = deflateSync(trials[t], {
          level: BRUTE_LEVEL,
          memLevel: 9,
          dictionary: context.length === 0 ? undefined : context,
        }).length;
      }
      if (cost < bestCost) {
        bestCost = cost;
        bestType = t;
      }
    }
    raw.set(trials[bestType], at);
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Screening and final encoding.
// ---------------------------------------------------------------------------

const SCREEN = { level: 6, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY };

interface Candidate {
  form: Form;
  raw: Uint8Array;
  screenedBytes: number; // level-6 stream bytes + chunk overhead
}

/** Deflate `raw` under each final setting and return the smallest stream. */
function bestFinalDeflate(raw: Uint8Array): Uint8Array {
  const settings = [
    { level: 9, memLevel: 9, strategy: constants.Z_DEFAULT_STRATEGY },
    { level: 9, memLevel: 9, strategy: constants.Z_FILTERED },
    { level: 9, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY },
  ];
  let best: Uint8Array | null = null;
  for (const s of settings) {
    const stream = deflateSync(raw, s);
    if (best === null || stream.length < best.length) best = stream;
  }
  return best as Uint8Array;
}

/** The smallest PNG (as bytes) holding this RGBA image. */
function encodeImage(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const info = analyse(rgba);
  const forms = formsOf(rgba, info);
  const screened: Candidate[] = [];
  for (const form of forms) {
    const overhead = chunkOverhead(form);
    for (const choice of form.filters) {
      const raw = filterSamples(form.samples, width, height, form.bpp, choice);
      const stream = deflateSync(raw, SCREEN);
      screened.push({ form, raw, screenedBytes: stream.length + overhead });
    }
  }
  screened.sort((a, b) => a.screenedBytes - b.screenedBytes);
  // Re-encode the two best screenings at level 9 and keep the smallest file.
  let bestPng: Uint8Array | null = null;
  let bestSize = Infinity;
  const finalists = screened.slice(0, 2);
  for (const cand of finalists) {
    const stream = bestFinalDeflate(cand.raw);
    const size = stream.length + chunkOverhead(cand.form);
    if (size < bestSize) {
      bestSize = size;
      const chunks: Array<[string, Uint8Array]> = [['IHDR', ihdrData(width, height, cand.form.colourType)]];
      if (cand.form.plte !== null) chunks.push(['PLTE', cand.form.plte]);
      if (cand.form.trns !== null) chunks.push(['tRNS', cand.form.trns]);
      chunks.push(['IDAT', stream]);
      chunks.push(['IEND', new Uint8Array(0)]);
      bestPng = assemblePng(chunks);
    }
  }
  return bestPng as Uint8Array;
}

// ---------------------------------------------------------------------------
// Verification: read each written file back and prove it is a valid,
// lossless answer before the run can succeed.
// ---------------------------------------------------------------------------

const MAX_OUTPUT_BYTES = 4194304; // 4 MiB
const ALLOWED_CHUNKS = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']);

/**
 * Check a written PNG file against the rules the scorer's checker enforces
 * and against the pixels it must hold. Throws on any failure; the driver
 * turns that into a non-zero exit. This only reads the file: it never
 * changes the bytes written.
 */
function verifyPng(bytes: Uint8Array, width: number, height: number, expected: Uint8Array): void {
  if (bytes.length > MAX_OUTPUT_BYTES) {
    throw new Error(`output is ${bytes.length} bytes, over the 4 MiB limit`);
  }
  if (bytes.length < 8 || !PNG_SIGNATURE.every((b, i) => bytes[i] === b)) {
    throw new Error('output is not a PNG file');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let seenIhdr = false;
  let seenIdat = false;
  let seenIend = false;
  let seenPlte = false;
  let colourType = -1;
  while (at < bytes.length) {
    if (seenIend) throw new Error('bytes after IEND');
    if (at + 12 > bytes.length) throw new Error('truncated chunk header');
    const len = view.getUint32(at);
    if (at + 12 + len > bytes.length) throw new Error('truncated chunk');
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (!ALLOWED_CHUNKS.has(type)) throw new Error(`disallowed chunk ${type}`);
    if (crc32(bytes, at + 4, at + 8 + len) !== view.getUint32(at + 8 + len)) {
      throw new Error(`${type} chunk fails its CRC`);
    }
    if (type === 'IHDR') {
      if (seenIhdr) throw new Error('second IHDR chunk');
      if (at !== 8) throw new Error('IHDR is not the first chunk');
      if (len !== 13) throw new Error('IHDR is not 13 bytes');
      const dv = new DataView(bytes.buffer, bytes.byteOffset + at + 8, 13);
      if (dv.getUint32(0) !== width || dv.getUint32(4) !== height) {
        throw new Error('IHDR dimensions do not match the input');
      }
      if (bytes[at + 16] !== 8) throw new Error('bit depth is not 8');
      colourType = bytes[at + 17];
      if (!(colourType in CHANNELS)) throw new Error(`unsupported colour type ${colourType}`);
      if (bytes[at + 20] !== 0) throw new Error('interlaced PNG');
      seenIhdr = true;
    } else if (type === 'PLTE') {
      if (!seenIhdr) throw new Error('PLTE before IHDR');
      if (seenPlte) throw new Error('second PLTE chunk');
      if (colourType !== 3) throw new Error('PLTE in a non-palette PNG');
      if (len % 3 !== 0 || len === 0) throw new Error('PLTE length is not a whole palette');
      seenPlte = true;
    } else if (type === 'tRNS') {
      if (!seenIhdr) throw new Error('tRNS before IHDR');
      if (seenIdat) throw new Error('tRNS after IDAT');
    } else if (type === 'IDAT') {
      if (!seenIhdr) throw new Error('IDAT before IHDR');
      seenIdat = true;
    } else if (type === 'IEND') {
      if (!seenIhdr || !seenIdat) throw new Error('IEND without IHDR or IDAT');
      if (len !== 0) throw new Error('IEND is not empty');
      seenIend = true;
    }
    at += 12 + len;
  }
  if (!seenIhdr || !seenIdat || !seenIend) throw new Error('missing IHDR, IDAT or IEND');
  // Decode it back with the same decoder used for the input and compare
  // every pixel: a fully transparent pixel's colour included.
  const back = decodePng(bytes);
  if (back.width !== width || back.height !== height) {
    throw new Error('decoded dimensions do not match the input');
  }
  if (back.rgba.length !== expected.length) throw new Error('decoded pixel count mismatch');
  for (let i = 0; i < expected.length; i++) {
    if (back.rgba[i] !== expected[i]) {
      throw new Error(`decoded pixel differs from the input at byte ${i}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Driver: every instance in the input directory, in sorted order.
// ---------------------------------------------------------------------------

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

let totalBytes = 0;
let instanceCount = 0;
try {
  for (const id of readdirSync(INPUT_DIR).sort()) {
    const { width, height, rgba } = decodePng(new Uint8Array(readFileSync(join(INPUT_DIR, id, 'image.png'))));
    const png = encodeImage(rgba, width, height);
    mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
    writeFileSync(join(OUTPUT_DIR, id, 'image.png'), png);
    // Verify the file as written, not the bytes in memory.
    verifyPng(new Uint8Array(readFileSync(join(OUTPUT_DIR, id, 'image.png'))), width, height, rgba);
    totalBytes += png.length;
    instanceCount++;
    console.log(`${id}: ${png.length} bytes`);
  }
  console.log(`total: ${totalBytes} bytes (${instanceCount} instances)`);
} catch (err) {
  console.error(`error: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
