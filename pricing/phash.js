// pricing/phash.js
//
// Owner: A2 (Pricing engine) — PR 1 of perceptual-hash card lookup
// Cross-references:
//   - pricing/confidence.js (PHASH_HAMMING_MAX, SEALED_BASE_CONFIDENCE reused
//                            as PHASH_WRITE_MIN)
//   - docs/design/phash-lookup.md (algorithm spec, storage shape)
//   - apps/server/server.js — loadIndex() called once at boot (PR 2)
//   - pricing/identify-core.js — addToIndex() called post-Sonnet (PR 2)
//
// Algorithms:
//   pHash — DCT-based (original implementation)
//   dHash — gradient/difference hash (9×8 greyscale → column differences)
//   wHash — wavelet-based (32×32 → 2D Haar → top-left 8×8 block threshold)
//
// Auto-crop: cropToCard() uses Sharp .trim() + 5% inset to strip uniform
// borders before hashing. This is the "simpler" approach per the design brief
// (Sharp.trim heuristic chosen over full edge detection to stay under the
// 150 LOC complexity ceiling). On detection failure the original buffer is
// returned unchanged.
//
// Storage shape (v2):
//   {
//     "version": 2,
//     "phash": { "<hex16>": { "set_id": "sv1", "number": "1" }, ... },
//     "dhash": { "<hex16>": { ... }, ... },
//     "whash": { "<hex16>": { ... }, ... }
//   }
//
// Backward compat: v1 files (flat object, no "version" key) are loaded into
// _phashIndex only. dhash and whash indexes start empty in that case.
//
// BigInt hex strings are always 16-char zero-padded lowercase.

import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import sharp from 'sharp';
import { rectifyCard, isEnabled as rectifyEnabled } from './card-rectify.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');
const PHASH_FILE = join(REPO_ROOT, 'data', 'card-phashes.json');

// In-memory indexes: Map<bigint, { set_id, number }>
const _phashIndex = new Map();
const _dhashIndex = new Map();
const _whashIndex = new Map();

// Debounced-write state
let _writeTimer = null;
let _dirtyCount = 0;
const FLUSH_COUNT_THRESHOLD = 100;
const FLUSH_IDLE_MS = 5000;

// Flush mutex — prevents concurrent writers from racing on the same tmp path.
let _flushPromise = null;   // the single in-flight flush; null when idle
let _flushQueued  = false;  // a second flush was requested while one is in-flight

// =============================================================================
// DCT-II helpers (pHash)
// =============================================================================

// 1D DCT-II of length N over array x (in-place on a new Float64Array).
// X[k] = sum_{n=0}^{N-1} x[n] * cos(pi*(2n+1)*k / (2*N))
function dct1d(x, N) {
  const out = new Float64Array(N);
  for (let k = 0; k < N; k++) {
    let sum = 0;
    const scale = Math.PI * k / (2 * N);
    for (let n = 0; n < N; n++) {
      sum += x[n] * Math.cos(scale * (2 * n + 1));
    }
    out[k] = sum;
  }
  return out;
}

// 2D DCT-II: apply 1D DCT row-wise then column-wise over an N×N matrix
// stored as a flat Float64Array of length N*N.
function dct2d(pixels, N) {
  const tmp = new Float64Array(N * N);

  // Row-wise pass
  for (let r = 0; r < N; r++) {
    const row = pixels.subarray(r * N, r * N + N);
    const transformed = dct1d(row, N);
    for (let c = 0; c < N; c++) {
      tmp[r * N + c] = transformed[c];
    }
  }

  // Column-wise pass
  const out = new Float64Array(N * N);
  const col = new Float64Array(N);
  for (let c = 0; c < N; c++) {
    for (let r = 0; r < N; r++) col[r] = tmp[r * N + c];
    const transformed = dct1d(col, N);
    for (let r = 0; r < N; r++) out[r * N + c] = transformed[r];
  }

  return out;
}

// =============================================================================
// Haar wavelet helpers (wHash)
// =============================================================================

// One level of 1D Haar transform in-place over an even-length sub-array.
// Replaces pairs (a, b) with ((a+b)/2, (a-b)/2).
function haarLevel1d(arr, len) {
  const half = len >> 1;
  const tmp = new Float64Array(len);
  for (let i = 0; i < half; i++) {
    tmp[i]        = (arr[2 * i] + arr[2 * i + 1]) / 2;
    tmp[half + i] = (arr[2 * i] - arr[2 * i + 1]) / 2;
  }
  for (let i = 0; i < len; i++) arr[i] = tmp[i];
}

// 2D Haar wavelet transform (one level row-wise then column-wise) on an N×N
// flat Float64Array. N must be a power of 2.
function haar2d(pixels, N) {
  const data = new Float64Array(pixels);

  // Row-wise
  const row = new Float64Array(N);
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) row[c] = data[r * N + c];
    haarLevel1d(row, N);
    for (let c = 0; c < N; c++) data[r * N + c] = row[c];
  }

  // Column-wise
  const col = new Float64Array(N);
  for (let c = 0; c < N; c++) {
    for (let r = 0; r < N; r++) col[r] = data[r * N + c];
    haarLevel1d(col, N);
    for (let r = 0; r < N; r++) data[r * N + c] = col[r];
  }

  return data;
}

// =============================================================================
// cropToCard
// =============================================================================

/**
 * Crop a phone photo to the card boundaries using Sharp's trim heuristic
 * (remove uniform-colour borders) followed by a 5% inset crop to eliminate
 * any remaining near-uniform fringe. Returns a Buffer normalised to the
 * standard card aspect ratio (600×840).
 *
 * Approach chosen: Sharp .trim() + 5% inset (the "simpler" path from the
 * design brief). Stays well under the 150 LOC edge-detection ceiling.
 *
 * On any failure (no trimmable border, Sharp error, etc.) the original buffer
 * is returned unchanged so the caller can still hash the raw photo.
 *
 * @param {Buffer} buffer  Raw image bytes.
 * @returns {Promise<Buffer>}
 */
export async function cropToCard(buffer) {
  // Preferred path: true card-quad detection + perspective rectification.
  // The .trim() heuristic below is a randomiser on real photographs — measured
  // 1.0% vs 40.5% top-1 on realistic scenes (docs/V3_BENCHMARK.md §5.1). Gated
  // behind CARD_RECTIFY=1 and degrading to the original behaviour on any
  // failure, so enabling it cannot break a working deployment and disabling it
  // restores the previous behaviour exactly.
  if (rectifyEnabled()) {
    const rectified = await rectifyCard(buffer);
    if (rectified) return rectified;
    // else: no card found, or OpenCV unavailable — fall through to trim.
  }

  try {
    // Step 1: trim uniform borders (threshold 30 = allow ≤30/255 luminance
    // variance at the edge). background defaults to top-left pixel colour.
    const trimmed = await sharp(buffer)
      .trim({ threshold: 30 })
      .toBuffer({ resolveWithObject: true });

    const { data: trimBuf, info } = trimmed;
    const { width, height } = info;

    if (!width || !height) return buffer; // degenerate — return original

    // Step 2: 5% inset crop to strip any near-uniform fringe the trim missed.
    const insetX = Math.max(1, Math.round(width  * 0.05));
    const insetY = Math.max(1, Math.round(height * 0.05));
    const cropW  = Math.max(1, width  - insetX * 2);
    const cropH  = Math.max(1, height - insetY * 2);

    // Step 3: resize to standard card dimensions (standard Pokémon card ratio
    // ≈ 63mm × 88mm → 600×840 px). Using 'fill' matches CDN reference images.
    const result = await sharp(trimBuf)
      .extract({ left: insetX, top: insetY, width: cropW, height: cropH })
      .resize(600, 840, { fit: 'fill' })
      .toBuffer();

    return result;
  } catch {
    // Any Sharp error — return original buffer unchanged.
    return buffer;
  }
}

// =============================================================================
// computePhash
// =============================================================================

/**
 * Compute a 64-bit perceptual hash (DCT-based) for the given image buffer.
 *
 * @param {Buffer} buffer  Raw image bytes (any format Sharp can decode).
 * @returns {Promise<bigint>}
 */
export async function computePhash(buffer) {
  const raw = await sharp(buffer)
    .resize(32, 32, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer();

  const pixels = new Float64Array(raw.length);
  for (let i = 0; i < raw.length; i++) pixels[i] = raw[i];

  const dct = dct2d(pixels, 32);

  // Extract top-left 8×8 block coefficients (64 values).
  // Coefficient [0,0] is the DC term (average brightness); exclude it from
  // the median to prevent brightness shifts from dominating the threshold.
  const block = new Float64Array(64);
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      block[r * 8 + c] = dct[r * 32 + c];
    }
  }

  // Median of the 63 AC terms (index 1..63, skipping [0,0] at index 0).
  const ac = block.slice(1).sort();
  const mid = Math.floor(ac.length / 2);
  const median = ac.length % 2 === 0
    ? (ac[mid - 1] + ac[mid]) / 2
    : ac[mid];

  // Pack 64 bits: bit i = (block[i] > median) ? 1 : 0, stored LSB-first.
  let hash = 0n;
  for (let i = 0; i < 64; i++) {
    if (block[i] > median) hash |= (1n << BigInt(i));
  }

  return hash;
}

// =============================================================================
// computeDhash
// =============================================================================

/**
 * Compute a 64-bit difference hash (gradient hash) for the given image buffer.
 *
 * Algorithm:
 *   1. Resize to 9×8 greyscale (9 wide so we have 8 column-differences per row).
 *   2. For each of the 8 rows, bit i = (pixel[col i] > pixel[col i+1]) ? 1 : 0.
 *   3. Pack 64 bits (8 rows × 8 bits) into a BigInt, LSB-first.
 *
 * dHash is robust to lighting changes (it is differential, so brightness
 * offset cancels out).
 *
 * @param {Buffer} buffer  Raw image bytes.
 * @returns {Promise<bigint>}
 */
export async function computeDhash(buffer) {
  const raw = await sharp(buffer)
    .resize(9, 8, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer();

  // raw is 9×8 = 72 bytes, row-major.
  let hash = 0n;
  let bit = 0;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if (raw[r * 9 + c] > raw[r * 9 + c + 1]) {
        hash |= (1n << BigInt(bit));
      }
      bit++;
    }
  }

  return hash;
}

// =============================================================================
// computeWhash
// =============================================================================

/**
 * Compute a 64-bit wavelet hash (Haar-based) for the given image buffer.
 *
 * Algorithm:
 *   1. Resize to 32×32 greyscale.
 *   2. Apply one level of 2D Haar wavelet transform.
 *   3. Extract top-left 8×8 block (LL sub-band — lowest frequency).
 *   4. Compute median of the 64 values.
 *   5. Threshold each coefficient against median → 1 bit.
 *   6. Pack 64 bits into a BigInt, LSB-first.
 *
 * wHash is robust to noise (wavelet smooths high-frequency noise before
 * thresholding) while retaining spatial-frequency sensitivity similar to pHash.
 *
 * @param {Buffer} buffer  Raw image bytes.
 * @returns {Promise<bigint>}
 */
export async function computeWhash(buffer) {
  const raw = await sharp(buffer)
    .resize(32, 32, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer();

  const pixels = new Float64Array(raw.length);
  for (let i = 0; i < raw.length; i++) pixels[i] = raw[i];

  const wavelet = haar2d(pixels, 32);

  // Extract top-left 8×8 LL sub-band.
  const block = new Float64Array(64);
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      block[r * 8 + c] = wavelet[r * 32 + c];
    }
  }

  // Median of all 64 values (unlike pHash we keep [0,0] — the DC term in the
  // wavelet domain is the global mean scaled by level, not a dominating outlier).
  const sorted = block.slice().sort();
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];

  let hash = 0n;
  for (let i = 0; i < 64; i++) {
    if (block[i] > median) hash |= (1n << BigInt(i));
  }

  return hash;
}

// =============================================================================
// Hamming distance (XOR + popcount)
// =============================================================================

function hammingDistance(a, b) {
  let x = a ^ b;
  let dist = 0;
  while (x !== 0n) {
    x &= x - 1n;
    dist++;
  }
  return dist;
}

// =============================================================================
// lookupByPhash — preserved for backward compat (queries _phashIndex only)
// =============================================================================

/**
 * Linear scan of _phashIndex; returns the closest entry within threshold.
 * Preserved for backward compatibility — prefer lookupByHashes for new callers.
 *
 * @param {bigint} hash
 * @param {number} threshold  Maximum Hamming distance to accept (inclusive).
 * @returns {{ card: { set_id: string, number: string }, distance: number } | null}
 */
export function lookupByPhash(hash, threshold) {
  let best = null;
  let bestDist = threshold + 1;

  for (const [key, card] of _phashIndex) {
    const dist = hammingDistance(hash, key);
    if (dist <= threshold && dist < bestDist) {
      best = card;
      bestDist = dist;
    }
  }

  return best ? { card: best, distance: bestDist } : null;
}

// =============================================================================
// lookupByHashes — queries all three indexes, returns best match across all
// =============================================================================

/**
 * Query all three indexes (phash, dhash, whash) and return the best match
 * across all, or null if none clears the threshold.
 *
 * Each hash type is queried independently. The global winner is the entry
 * with the smallest Hamming distance across all three index results.
 *
 * @param {{ phash: bigint, dhash: bigint, whash: bigint }} hashes
 * @param {number} threshold  Maximum Hamming distance (inclusive) for each type.
 * @returns {{ card: { set_id: string, number: string }, distance: number, hashType: string } | null}
 */
export function lookupByHashes(hashes, threshold) {
  let best = null;
  let bestDist = threshold + 1;
  let bestType = null;

  const checks = [
    { index: _phashIndex, hash: hashes.phash, type: 'phash' },
    { index: _dhashIndex, hash: hashes.dhash, type: 'dhash' },
    { index: _whashIndex, hash: hashes.whash, type: 'whash' },
  ];

  for (const { index, hash, type } of checks) {
    if (hash == null) continue;
    for (const [key, card] of index) {
      const dist = hammingDistance(hash, key);
      if (dist <= threshold && dist < bestDist) {
        best = card;
        bestDist = dist;
        bestType = type;
      }
    }
  }

  return best ? { card: best, distance: bestDist, hashType: bestType } : null;
}

// =============================================================================
// addToIndex
// =============================================================================

/**
 * Add hash → card mapping(s) to the appropriate in-memory indexes and schedule
 * a debounced disk write.
 *
 * Accepts either:
 *   - A plain bigint (legacy single-hash form; added to _phashIndex only)
 *   - An object { phash?, dhash?, whash? } (adds each provided hash to its index)
 *
 * @param {bigint | { phash?: bigint, dhash?: bigint, whash?: bigint }} hashes
 * @param {{ set_id: string, number: string }} card
 * @returns {Promise<void>}
 */
export async function addToIndex(hashes, card) {
  if (typeof hashes === 'bigint') {
    // Legacy single-hash call — add to phash index only.
    _phashIndex.set(hashes, card);
  } else {
    if (hashes.phash != null) _phashIndex.set(hashes.phash, card);
    if (hashes.dhash != null) _dhashIndex.set(hashes.dhash, card);
    if (hashes.whash != null) _whashIndex.set(hashes.whash, card);
  }

  _dirtyCount++;

  if (_dirtyCount >= FLUSH_COUNT_THRESHOLD) {
    if (_writeTimer !== null) {
      clearTimeout(_writeTimer);
      _writeTimer = null;
    }
    await flushToDisk();
    return;
  }

  if (_writeTimer !== null) clearTimeout(_writeTimer);
  _writeTimer = setTimeout(() => { flushToDisk().catch(console.error); }, FLUSH_IDLE_MS);
}

// =============================================================================
// Disk persistence helpers
// =============================================================================

function indexToObject(index) {
  const obj = {};
  for (const [hash, card] of index) {
    obj[hash.toString(16).padStart(16, '0')] = card;
  }
  return obj;
}

async function flushToDisk() {
  if (_flushPromise) {
    _flushQueued = true;
    await _flushPromise;
    if (!_flushQueued) return;
  }

  _flushPromise = (async () => {
    do {
      _flushQueued = false;
      _writeTimer  = null;
      _dirtyCount  = 0;

      const payload = {
        version: 2,
        phash: indexToObject(_phashIndex),
        dhash: indexToObject(_dhashIndex),
        whash: indexToObject(_whashIndex),
      };
      const json = JSON.stringify(payload);

      const tmpPath = PHASH_FILE + '.tmp';
      await fs.promises.writeFile(tmpPath, json, 'utf8');
      // Atomic rename (POSIX). On Windows falls back to direct overwrite.
      try {
        await fs.promises.rename(tmpPath, PHASH_FILE);
      } catch (err) {
        if (err.code !== 'EPERM') throw err;
        await fs.promises.writeFile(PHASH_FILE, json, 'utf8');
        try { await fs.promises.unlink(tmpPath); } catch { /* best-effort */ }
      }
    } while (_flushQueued);
  })();

  try {
    await _flushPromise;
  } finally {
    _flushPromise = null;
  }
}

// =============================================================================
// loadIndex
// =============================================================================

/**
 * Read card-phashes.json into the in-memory indexes. Tolerates missing file.
 * Detects format version:
 *   v1 — flat { "<hex16>": {set_id, number} } — loaded into _phashIndex only.
 *   v2 — { version: 2, phash: {}, dhash: {}, whash: {} } — loads all three.
 *
 * Called once at boot from apps/server/server.js.
 *
 * @returns {Promise<void>}
 */
export async function loadIndex() {
  let raw;
  try {
    raw = await fs.promises.readFile(PHASH_FILE, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }

  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    // Corrupt JSON — preserve for operator inspection, treat as empty.
    const corruptPath = PHASH_FILE + '.corrupt-' + Date.now();
    try {
      await fs.promises.rename(PHASH_FILE, corruptPath);
    } catch {
      // If the rename itself fails, leave the file in place — don't crash.
    }
    console.warn(
      `[phash] Corrupt card-phashes.json detected; treating as empty index. ` +
      `File preserved at ${corruptPath}.`
    );
    return;
  }

  _phashIndex.clear();
  _dhashIndex.clear();
  _whashIndex.clear();

  if (obj.version === 2) {
    // v2 format — load all three indexes.
    const loadMap = (src, map) => {
      if (!src || typeof src !== 'object') return;
      for (const [hexStr, card] of Object.entries(src)) {
        map.set(BigInt('0x' + hexStr), card);
      }
    };
    loadMap(obj.phash, _phashIndex);
    loadMap(obj.dhash, _dhashIndex);
    loadMap(obj.whash, _whashIndex);
    console.log(
      `[phash] v2 index loaded: phash=${_phashIndex.size} dhash=${_dhashIndex.size} whash=${_whashIndex.size}`
    );
  } else {
    // v1 format — flat object, no version key. Load into phash only.
    for (const [hexStr, card] of Object.entries(obj)) {
      if (hexStr === 'version') continue; // safety guard
      _phashIndex.set(BigInt('0x' + hexStr), card);
    }
    console.log(
      `[phash] v1 index loaded (legacy): phash=${_phashIndex.size} — re-crawl recommended to populate dhash/whash`
    );
  }
}

// =============================================================================
// flushNow — explicit flush for tests and the crawler
// =============================================================================

/**
 * Immediately write the current in-memory indexes to disk and cancel any
 * pending idle timer.
 *
 * @returns {Promise<void>}
 */
export async function flushNow() {
  if (_writeTimer !== null) {
    clearTimeout(_writeTimer);
    _writeTimer = null;
  }
  _dirtyCount = 0;
  await flushToDisk();
}

// =============================================================================
// Test hooks — underscore-prefixed, not for production use
// =============================================================================

/**
 * Seed the in-memory phash index with test entries without touching disk.
 * Kept for backward compat with phash-lookup.spec.js.
 *
 * @param {Array<{ hash: bigint, card: { set_id: string, number: string } }>} entries
 */
export function __seedIndex(entries) {
  for (const { hash, card } of entries) {
    _phashIndex.set(hash, card);
  }
}

/**
 * Clear all in-memory indexes without touching disk.
 */
export function __resetIndex() {
  _phashIndex.clear();
  _dhashIndex.clear();
  _whashIndex.clear();
}

/**
 * Seed specific indexes by type. Used by phash-lookup.spec.js and new tests.
 *
 * @param {'phash'|'dhash'|'whash'} type
 * @param {Array<{ hash: bigint, card: { set_id: string, number: string } }>} entries
 */
export function __seedIndexByType(type, entries) {
  const map = type === 'phash' ? _phashIndex
            : type === 'dhash' ? _dhashIndex
            : _whashIndex;
  for (const { hash, card } of entries) {
    map.set(hash, card);
  }
}
