#!/usr/bin/env node
// scripts/v3-bench/audit-misses.js
//
// V3 Phase 0 — why did retrieval miss?
//
// The gate result (docs/V3_BENCHMARK.md §12) reports 45.3% top-1 on real
// photographs, with 25 misses where quad detection worked but retrieval failed.
// Those 25 have two very different causes with very different fixes:
//
//   a) the card is ABSENT from the catalogue  -> a data problem; no descriptor
//      work fixes it, and 45.3% understates retrieval quality
//   b) the card IS in the catalogue and the matcher failed -> a descriptor
//      problem; index-side augmentation is the remedy
//
// The review flow deliberately doesn't ask the operator to name cards the
// system got wrong, so the split is unmeasured. This script closes that gap by
// asking Claude to read the card's printed name / set / number off each missed
// photo, then checking that identity against the catalogue.
//
// This is a DIAGNOSTIC, not a component of the scanner. It exists to size a
// confound in the benchmark, and it costs one vision call per missed photo.
//
// Usage:
//   node scripts/v3-bench/audit-misses.js            # all misses
//   node scripts/v3-bench/audit-misses.js --limit 5  # cheap smoke test

import fs from 'fs';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { dirname, join, basename } from 'path';
import sharp from 'sharp';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const CACHE_DIR = process.env.V3_CACHE_DIR || join(homedir(), '.card-pricer-v3');
const PHOTO_DIR = join(CACHE_DIR, 'photos');
const ROWS_FILE = join(CACHE_DIR, 'gate-rows.json');
const MANIFEST_FILE = join(CACHE_DIR, 'manifest.json');
const OUT_FILE = join(CACHE_DIR, process.argv.includes('--include-undetected') ? 'miss-audit-undetected.json' : 'miss-audit.json');

const MODEL = process.env.AUDIT_MODEL || 'claude-opus-5';

function argVal(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : Number(process.argv[i + 1]);
}
const LIMIT = argVal('--limit');

// The model reads what is PRINTED on the card. It is deliberately not asked to
// guess a set ID — set IDs are an internal pokemontcg.io convention the card
// never shows, and inviting a guess would produce plausible-looking IDs that
// silently corrupt the audit.
const SCHEMA = {
  type: 'object',
  properties: {
    legible: { type: 'boolean', description: 'Is the card readable enough to identify at all?' },
    name: { type: 'string', description: 'Card name exactly as printed, e.g. "Antique Armor Fossil". Empty string if illegible.' },
    number: { type: 'string', description: 'Collector number as printed before the slash, e.g. "072" from "072/084". Empty string if not visible.' },
    setTotal: { type: 'string', description: 'The number AFTER the slash, e.g. "084". Empty string if not visible.' },
    setName: { type: 'string', description: 'Expansion/set name if identifiable from the symbol or text, else empty string.' },
    language: { type: 'string', description: 'Printed language, e.g. "English", "Japanese".' },
    notes: { type: 'string', description: 'Anything ambiguous, e.g. glare over the number. Empty string if none.' },
  },
  required: ['legible', 'name', 'number', 'setTotal', 'setName', 'language', 'notes'],
  additionalProperties: false,
};

const PROMPT =
  'Read the trading card in this photograph and report exactly what is printed on it. ' +
  'Report only what you can actually see — if the collector number is obscured by glare, ' +
  'leave it empty rather than inferring it from the artwork. Do not guess a set ID code.';

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('[audit] ANTHROPIC_API_KEY not set');
    process.exit(1);
  }
  for (const f of [ROWS_FILE, MANIFEST_FILE]) {
    if (!fs.existsSync(f)) { console.error(`[audit] missing ${f}`); process.exit(1); }
  }

  const rows = JSON.parse(fs.readFileSync(ROWS_FILE, 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));

  // Only the misses where detection SUCCEEDED. A detection failure is already a
  // known, separately-counted cause; mixing them in would blur the split.
  // --include-undetected also audits the photos where quad detection failed.
  // Those are already counted as a separate cause, but they can ALSO be absent
  // from the catalogue — without auditing them, the absent-card rate is only
  // measured on part of the miss set.
  const INCLUDE_UNDETECTED = process.argv.includes('--include-undetected');
  let misses = rows.filter(r => !r.hit && (INCLUDE_UNDETECTED ? !r.detected : r.detected));
  if (LIMIT) misses = misses.slice(0, LIMIT);
  console.log(`[audit] ${misses.length} detected-but-missed photos | model=${MODEL}`);

  // Catalogue index for the lookup, keyed on normalised name.
  const byName = new Map();
  for (const [id, c] of Object.entries(manifest.cards)) {
    const k = String(c.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!k) continue;
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push({ id, ...c });
  }

  const client = new Anthropic();
  const results = [];
  let inCatalogue = 0, absent = 0, illegible = 0, failed = 0;

  for (const row of misses) {
    const file = join(PHOTO_DIR, row.rel);
    let b64;
    try {
      // 1568px long edge is the API's own working resolution — sending the
      // 4000px original costs tokens for pixels that get downscaled anyway.
      b64 = (await sharp(file).rotate().resize(1568, 1568, { fit: 'inside' })
        .jpeg({ quality: 88 }).toBuffer()).toString('base64');
    } catch (err) {
      failed++; console.error(`[audit] ${basename(file)}: ${err.message}`); continue;
    }

    let parsed;
    try {
      const resp = await client.messages.create({
        model: MODEL,
        max_tokens: 8000,           // thinking is on by default and shares this budget
        output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
            { type: 'text', text: PROMPT },
          ],
        }],
      });

      if (resp.stop_reason === 'refusal') {
        failed++; console.error(`[audit] ${basename(file)}: refused`); continue;
      }
      const text = resp.content.find(b => b.type === 'text')?.text;
      parsed = JSON.parse(text);
    } catch (err) {
      failed++; console.error(`[audit] ${basename(file)}: ${err.message}`); continue;
    }

    if (!parsed.legible || !parsed.name) {
      illegible++;
      results.push({ file: row.rel, verdict: 'illegible', read: parsed });
      console.log(`  ${basename(row.rel).padEnd(26)} ILLEGIBLE`);
      continue;
    }

    const key = parsed.name.toLowerCase().replace(/[^a-z0-9]/g, '');
    const candidates = byName.get(key) || [];
    // A name match alone is weak — the same name recurs across sets. When the
    // collector number is legible, require it to match too.
    const num = String(parsed.number || '').replace(/^0+/, '');
    const exact = num
      ? candidates.filter(c => String(c.number).replace(/^0+/, '') === num)
      : candidates;

    const verdict = candidates.length === 0 ? 'absent-from-catalogue'
                  : exact.length === 0 ? 'name-present-number-absent'
                  : 'in-catalogue';
    if (verdict === 'in-catalogue') inCatalogue++; else absent++;

    results.push({
      file: row.rel, verdict, read: parsed, cos: row.cos,
      matches: exact.slice(0, 3).map(c => `${c.id} (${c.setName})`),
      nameMatches: candidates.length,
    });
    console.log(`  ${basename(row.rel).padEnd(26)} ${verdict.padEnd(26)} ` +
                `"${parsed.name}" ${parsed.number}${parsed.setTotal ? '/' + parsed.setTotal : ''}`);
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify({ model: MODEL, results }, null, 2), 'utf8');

  const n = inCatalogue + absent;
  console.log('');
  console.log('[audit] =============== split ===============');
  console.log(`[audit] identified          : ${n} of ${misses.length}`);
  console.log(`[audit] illegible / failed  : ${illegible} / ${failed}`);
  console.log('');
  console.log(`[audit] IN catalogue (matcher failed)  : ${inCatalogue}` +
              (n ? `  (${(inCatalogue / n * 100).toFixed(0)}%)` : ''));
  console.log(`[audit] NOT in catalogue (data gap)    : ${absent}` +
              (n ? `  (${(absent / n * 100).toFixed(0)}%)` : ''));
  console.log('');
  console.log(`[audit] wrote ${OUT_FILE}`);
}

main().catch(err => { console.error('[audit] FATAL:', err); process.exit(1); });
