// Anthropic vision call — port of v1's identifyCore. Single-card image →
// Claude Sonnet 4.6 → parsed card identification. Server-only (uses sharp
// for resize on large inputs).

import Anthropic from '@anthropic-ai/sdk';
import sharp from 'sharp';
import { env } from './env.js';

const TARGET_SIZE = 1800;
const JPEG_QUALITY = 92;

const SYSTEM_PROMPT = `You identify trading cards from photos. Read the card and return a JSON object with the card's information.

Output schema:
{
  "cards": [{
    "game": "pokemon" | "magic" | "yugioh" | "lorcana" | "onepiece" | "starwars" | "digimon" | "fleshandblood" | "dragonball",
    "name": "Card Name",
    "set_code": "ABC",
    "card_number": "133/132" | "SM211",
    "rarity": "Rare Holo",
    "hp": "120",
    "condition_estimate": "NM" | "LP" | "MP" | "HP" | "DMG",
    "attacks": ["Attack Name 1", "Attack Name 2"],
    "regulation_mark": "G" | "F" | "E" | null
  }]
}

Critical rules:
1. Read the card number at the bottom carefully — it's the most important field. Format is NUMBER/TOTAL (e.g. 133/132) for set cards, or LETTERS+NUMBER (e.g. SM211, SWSH066) for promos.
2. If number has no slash, it's a PROMO card.
3. Set code is 2-5 uppercase letters near the bottom (e.g. MEG, PFL, TWM, SVI).
4. Be precise. Don't guess. If unreadable, omit the field.
5. condition_estimate: assess wear/scratches/edge whitening. NM = mint, LP = light play, MP = moderate, HP = heavy, DMG = damaged.
6. regulation_mark: small letter in bottom-left of recent Pokemon cards (G/F/E/D). Omit if not visible or non-Pokemon.

Output ONLY the JSON. No prose.`;

let _anthropic: Anthropic | null = null;
function getClient(): Anthropic {
  if (_anthropic) return _anthropic;
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  _anthropic = new Anthropic({ apiKey });
  return _anthropic;
}

export interface IdentifyCoreResult {
  parsed: { cards?: unknown[] };
  imageBase64: string;
  imageMediaType: 'image/jpeg' | 'image/png';
}

export async function identifyCore(buffer: Buffer, hint?: string): Promise<IdentifyCoreResult> {
  // Skip server-side resize when input is already small enough (saves 50-200ms).
  const meta = await sharp(buffer).metadata().catch(() => ({}) as Record<string, never>);
  const srcMax = Math.max((meta as { width?: number }).width ?? 0, (meta as { height?: number }).height ?? 0);
  const fmt = (meta as { format?: string }).format;
  const passthrough = (fmt === 'jpeg' || fmt === 'png') && srcMax > 0 && srcMax <= TARGET_SIZE;

  const optimized = passthrough
    ? buffer
    : await sharp(buffer)
        .resize(TARGET_SIZE, TARGET_SIZE, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: JPEG_QUALITY })
        .toBuffer();
  const optimizedFormat = passthrough ? fmt : 'jpeg';
  const imageBase64 = optimized.toString('base64');
  const imageMediaType = (optimizedFormat === 'png' ? 'image/png' : 'image/jpeg') as
    | 'image/jpeg'
    | 'image/png';

  const userMessage =
    'Identify this trading card. FIRST read the card number at the bottom — most critical field. If no slash (SM211, SWSH066), it is a PROMO. Be extremely precise with set code and card number.' +
    (hint ? `\n\nUser hint: ${hint}` : '');

  const response = await getClient().messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: imageMediaType, data: imageBase64 } },
          { type: 'text', text: userMessage },
        ],
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  const text = textBlock && textBlock.type === 'text' ? textBlock.text : '';
  let parsed: { cards?: unknown[] };
  try {
    parsed = JSON.parse(text) as { cards?: unknown[] };
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) parsed = JSON.parse(m[0]) as { cards?: unknown[] };
    else throw new Error('Could not parse card identification response');
  }

  return { parsed, imageBase64, imageMediaType };
}
