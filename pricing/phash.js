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
// Algorithm: DCT-based pHash
//   1. Resize to 32×32 greyscale via Sharp.
//   2. 2D DCT-II over the 32×32 pixel matrix (row-wise then column-wise).
//   3. Take top-left 8×8 low-frequency block; compute median excluding [0,0]
//      (DC term dropped to reduce brightness bias — see design §Algorithm).
//   4. Threshold each of the 64 coefficients against median → 1 bit.
//   5. Pack into a 64-bit BigInt (bit i = row*8+col, LSB-first).
//
// Storage: BigInt stored on disk as 16-char zero-padded lowercase hex string.
// Format: { "<hex16>": { "set_id": "sv1", "number": "23" }, ... }

import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import sharp from 'sharp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');
const PHASH_FILE = join(REPO_ROOT, 'data', 'card-phashes.json');

// In-memory index: Map<bigint, { set_id, number }>
const _index = new Map();

// Debounced-write state
let _writeTimer = null;
let _dirtyCount = 0;
const FLUSH_COUNT_THRESHOLD = 100;
const FLUSH_IDLE_MS = 5000;

// Flush mutex — prevents concurrent writers from racing on the same tmp path.
let _flushPromise = null;   // the single in-flight flush; null when idle
let _flushQueued  = false;  // a second flush was requested while one is in-flight

// =============================================================================
// DCT-II helpers
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
// computePhash
// =============================================================================

/**
 * Compute a 64-bit perceptual hash for the given image buffer.
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
  // Bit order: i = row*8 + col, where row and col are 0-indexed in the 8×8 block.
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
// lookupByPhash
// =============================================================================

/**
 * Linear scan of _index; returns the closest entry within threshold.
 *
 * @param {bigint} hash
 * @param {number} threshold  Maximum Hamming distance to accept (inclusive).
 * @returns {{ card: { set_id: string, number: string }, distance: number } | null}
 */
export function lookupByPhash(hash, threshold) {
  let best = null;
  let bestDist = threshold + 1;

  for (const [key, card] of _index) {
    const dist = hammingDistance(hash, key);
    if (dist <= threshold && dist < bestDist) {
      best = card;
      bestDist = dist;
    }
  }

  return best ? { card: best, distance: bestDist } : null;
}

// =============================================================================
// Disk persistence helpers
// =============================================================================

function indexToObject() {
  const obj = {};
  for (const [hash, card] of _index) {
    // BigInt as 16-char lowercase hex so JSON.stringify can handle it.
    obj[hash.toString(16).padStart(16, '0')] = card;
  }
  return obj;
}

async function flushToDisk() {
  if (_flushPromise) {
    // Another flush is already in-flight.  Signal that a trailing flush is
    // needed (to capture any entries added since that flush started), then
    // wait for the current one to land.
    _flushQueued = true;
    await _flushPromise;
    // If _flushQueued was consumed by whoever started the trailing flush,
    // we're done — don't start a redundant third flush.
    if (!_flushQueued) return;
  }

  // We are now the designated flusher.
  _flushPromise = (async () => {
    do {
      _flushQueued = false;
      _writeTimer  = null;
      _dirtyCount  = 0;
      const obj  = indexToObject();
      const json = JSON.stringify(obj);
      // Write to a temp file then atomically rename so a kill mid-write cannot
      // truncate card-phashes.json. fs.promises.rename is atomic on POSIX (Render).
      const tmpPath = PHASH_FILE + '.tmp';
      await fs.promises.writeFile(tmpPath, json, 'utf8');
      // fs.promises.rename is atomic on POSIX (Render — production target).
      // On Windows it raises EPERM when the destination already exists;
      // fall back to a direct overwrite in that case.
      try {
        await fs.promises.rename(tmpPath, PHASH_FILE);
      } catch (err) {
        if (err.code !== 'EPERM') throw err;
        await fs.promises.writeFile(PHASH_FILE, json, 'utf8');
        try { await fs.promises.unlink(tmpPath); } catch { /* best-effort */ }
      }
      // Loop if another caller queued a flush while we were writing.
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
 * Read card-phashes.json into _index. Tolerates missing file (empty index).
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
    // Corrupt JSON (e.g. truncated write before atomic-rename was in place).
    // Preserve the file for operator inspection; treat the index as empty so
    // the server can start and re-populate via addToIndex.
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

  _index.clear();
  for (const [hexStr, card] of Object.entries(obj)) {
    _index.set(BigInt('0x' + hexStr), card);
  }
}

// =============================================================================
// addToIndex
// =============================================================================

/**
 * Add a hash → card mapping to the in-memory index and schedule a debounced
 * disk write. Flushes immediately after every FLUSH_COUNT_THRESHOLD additions;
 * otherwise resets a 5 s idle timer.
 *
 * @param {bigint} hash
 * @param {{ set_id: string, number: string }} card
 * @returns {Promise<void>}
 */
export async function addToIndex(hash, card) {
  _index.set(hash, card);
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
// flushNow — explicit flush for tests and the crawler
// =============================================================================

/**
 * Immediately write the current in-memory index to disk and cancel any
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
 * Seed the in-memory index with test entries without touching disk.
 * Used by phash-lookup.spec.js.
 *
 * @param {Array<{ hash: bigint, card: { set_id: string, number: string } }>} entries
 */
export function __seedIndex(entries) {
  for (const { hash, card } of entries) {
    _index.set(hash, card);
  }
}

/**
 * Clear the in-memory index without touching disk.
 * Used by phash-lookup.spec.js to isolate tests.
 */
export function __resetIndex() {
  _index.clear();
}
