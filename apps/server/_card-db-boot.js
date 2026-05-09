// apps/server/_card-db-boot.js
// Owner: A1 | Slice: S5 (transient)
//
// TRANSIENT — slice S6 / S10 (A2 + A3) will fold this into db/card-db/persist.js.
// Until then route handlers + _legacy-pricing import from here. Do NOT add new
// code in this file.
//
// Verbatim extraction of V1 server.js's CARD_DB / CARD_PRICES persistence
// layer (lines 1646-2242):
//   - in-memory Map for both stores
//   - Pokellector + POKEMONTCG_UNRELIABLE source-priority rules in addCardToDb
//   - lookupLocalDb (UNRELIABLE-set guard preserved)
//   - Google Sheet → JSON → pokemontcg.io download cascade in initCardDb
//   - downloadCardDatabase (paged, throttled, incremental save)
//   - importUnreliableSetsFromTCGGO (admin-triggered)
//   - applyPokellectorCorrections (always wins)
//   - 5-min dirty save interval
//
// The exports keep V1 names so the move into db/card-db/persist.js is a
// rename + path edit, not a re-architecture.

import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { axios, supabase } from './_clients.js';
import {
  bulkSaveCardPrices,
  loadAllCardPrices,
} from '../../db/price-snapshot/store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Repo root is two levels up from apps/server/. CARD_DB / CARD_PRICES files
// continue to live in <repo>/data/ exactly as V1.
const REPO_ROOT = join(__dirname, '..', '..');

const CARD_DB_FILE = join(REPO_ROOT, 'data', 'card-db.json');
const CARD_PRICES_FILE = join(REPO_ROOT, 'data', 'card-prices.json');
const CRAWL_MARKER = join(REPO_ROOT, 'data', '.crawl-active');

export const CARD_DB = new Map();
export const CARD_PRICES = new Map();

let cardDbReady = false;
let cardDbCount = 0;
let cardDbLoading = false;
let cardDbDirty = false;
let _lastPriceRefreshAt = 0;
let unreliableImportDone = false;

export function getCardDbState() {
  return {
    ready: cardDbReady,
    loading: cardDbLoading,
    count: CARD_DB.size,
    fileExists: fs.existsSync(CARD_DB_FILE),
    lastRefreshAt: _lastPriceRefreshAt,
  };
}
export function getCardDbFile() { return CARD_DB_FILE; }
export function isCardDbLoading() { return cardDbLoading; }
export function getLastPriceRefreshAt() { return _lastPriceRefreshAt; }
export function clearCardDbForRebuild() {
  CARD_DB.clear();
  cardDbReady = false;
}
export function resetUnreliableImportFlag() { unreliableImportDone = false; }
export function markCardDbDirty() { cardDbDirty = true; }

// V1 set-name + unreliable lookups live in _legacy-pricing.js. To avoid an
// import cycle we keep a local copy of just the names this file needs.
// The sub-agents who absorb both modules in S6/S10 collapse them.
const POKEMONTCG_UNRELIABLE = new Set([
  'mep', 'me1', 'me2pt5', 'wht', 'bbt',
]);
const PKM_SET_NAMES = {
  'sv1':  'Scarlet & Violet', 'sv2':  'Paldea Evolved', 'sv3':  'Obsidian Flames',
  'sv3pt5': 'Pokemon 151', 'sv4':  'Paradox Rift', 'sv4pt5': 'Paldean Fates',
  'sv5':  'Temporal Forces', 'sv6':  'Twilight Masquerade', 'sv6pt5': 'Shrouded Fable',
  'sv7':  'Stellar Crown', 'sv8':  'Surging Sparks', 'sv8pt5': 'Prismatic Evolutions',
  'sv9':  'Journey Together', 'sv10': 'Destined Rivals',
  'bbt':  'Black Bolt', 'wht':  'White Flare',
  'me1':  'Mega Evolution', 'me2':  'Phantasmal Flames', 'me2pt5': 'Ascended Heroes',
  'me3':  'Perfect Order',
  'svp':  'SV Black Star Promos', 'mep':  'Mega Evolution Promos',
  'swshp': 'Sword & Shield Promos', 'swsh12pt5': 'Crown Zenith',
  'swsh12pt5gg': 'Crown Zenith Galarian Gallery',
};

// V1 server.js:1563-1628.
const POKELLECTOR_CORRECTIONS = {
  'me1': {
    setName: 'Mega Evolution', setCode: 'ME1',
    cards: {
      1:'Bulbasaur',2:'Ivysaur',3:'Mega Venusaur ex',4:'Exeggcute',5:'Exeggutor',
      6:'Tangela',7:'Tangrowth',8:'Chikorita',9:'Bayleef',10:'Meganium',
      11:'Shuckle',12:'Celebi',13:'Seedot',14:'Nuzleaf',15:'Shiftry',
      16:'Nincada',17:'Ninjask',18:'Dhelmise',19:'Vulpix',20:'Ninetales',
      21:'Numel',22:'Mega Camerupt ex',23:'Litleo',24:'Pyroar',25:'Volcanion',
      26:'Scorbunny',27:'Raboot',28:'Cinderace',29:'Sizzlipede',30:'Centiskorch',
      31:'Chi-Yu',32:'Mantine',33:'Corphish',34:'Kyogre',35:'Snover',
      36:'Mega Abomasnow ex',37:'Clauncher',38:'Clawitzer',39:'Sobble',40:'Drizzile',
      41:'Inteleon',42:'Snom',43:'Frosmoth',44:'Eiscue',45:'Magnemite',
      46:'Magneton',47:'Magnezone',48:'Raikou',49:'Electrike',50:'Mega Manectric ex',
      51:'Pachirisu',52:'Helioptile',53:'Heliolisk',54:'Abra',55:'Kadabra',
      56:'Alakazam',57:'Jynx',58:'Ralts',59:'Kirlia',60:'Mega Gardevoir ex',
      61:'Shedinja',62:'Spoink',63:'Grumpig',64:'Xerneas',65:'Greavard',
      66:'Houndstone',67:'Gimmighoul',68:'Sandshrew',69:'Sandslash',70:'Onix',
      71:'Tyrogue',72:'Makuhita',73:'Hariyama',74:'Lunatone',75:'Solrock',
      76:'Riolu',77:'Mega Lucario ex',78:'Croagunk',79:'Toxicroak',80:'Marshadow',
      81:'Stonjourner',82:'Nacli',83:'Naclstack',84:'Garganacl',85:'Crawdaunt',
      86:'Mega Absol ex',87:'Spiritomb',88:'Yveltal',89:'Nickit',90:'Thievul',
      91:'Shroodle',92:'Grafaiai',93:'Steelix',94:'Mega Mawile ex',95:'Dialga',
      96:'Tinkatink',97:'Tinkatuff',98:'Tinkaton',99:'Gholdengo',100:'Mega Latias ex',
      101:'Latios',102:'Spearow',103:'Fearow',104:'Mega Kangaskhan ex',105:'Delibird',
      106:'Miltank',107:'Buneary',108:'Lopunny',109:'Yungoos',110:'Gumshoos',
      111:'Stufful',112:'Bewear',113:"Acerola's Mischief",114:'Boss\'s Orders [Ghetsis]',
      115:'Energy Switch',116:'Fighting Gong',117:'Forest of Vitality',118:'Iron Defender',
      119:"Lillie's Determination",120:"Lt. Surge's Bargain",121:'Mega Signal',
      122:'Mystery Garden',123:'Pokémon Center Lady',124:'Premium Power Pro',
      125:'Rare Candy',126:'Repel',127:'Risky Ruins',128:'Strange Timepiece',
      129:'Surfing Beach',130:'Switch',131:'Ultra Ball',132:"Wally's Compassion",
      133:'Bulbasaur',134:'Ivysaur',135:'Exeggutor',136:'Shuckle',137:'Ninjask',
      138:'Vulpix',139:'Litleo',140:'Snover',141:'Clawitzer',142:'Inteleon',
      143:'Helioptile',144:'Shedinja',145:'Houndstone',146:'Marshadow',147:'Garganacl',
      148:'Spiritomb',149:'Shroodle',150:'Steelix',151:'Spearow',152:'Delibird',
      153:'Gumshoos',154:'Stufful',155:'Mega Venusaur ex',156:'Mega Camerupt ex',
      157:'Mega Abomasnow ex',158:'Mega Manectric ex',159:'Mega Gardevoir ex',
      160:'Mega Lucario ex',161:'Mega Absol ex',162:'Mega Mawile ex',
      163:'Mega Latias ex',164:'Mega Kangaskhan ex',165:"Acerola's Mischief",
      166:'Air Balloon',167:'Buddy-Buddy Poffin',168:'Fighting Gong',
      169:"Lillie's Determination",170:"Lt. Surge's Bargain",171:'Mega Signal',
      172:'Mystery Garden',173:'Night Stretcher',174:'Premium Power Pro',
      175:'Rare Candy',176:"Wally's Compassion",177:'Mega Venusaur ex',
      178:'Mega Gardevoir ex',179:'Mega Lucario ex',180:'Mega Absol ex',
      181:'Mega Latias ex',182:'Mega Kangaskhan ex',183:"Acerola's Mischief",
      184:"Lillie's Determination",185:"Lt. Surge's Bargain",186:"Wally's Compassion",
      187:'Mega Gardevoir ex',188:'Mega Lucario ex',
    }
  },
  'mep': {
    setName: 'Mega Evolution Promos', setCode: 'MEP',
    cards: {
      1:'Meganium',2:'Inteleon',3:'Alakazam',4:'Lunatone',5:'Drifloon',
      6:'Drifblim',7:'Psyduck',8:'Golduck',9:'Alakazam',10:'Riolu',
      11:'Mega Latias ex',12:'Mega Lucario ex',13:'Mega Venusaur ex',14:'Ceruledge',
      15:'Zacian',16:'Flygon',17:'Toxtricity',18:'Cottonee',19:'Whimsicott',
      20:'Sneasel',21:'Weavile',22:'Charcadet',23:'Mega Charizard ex',24:'Oricorio ex',
      25:'Mega Kangaskhan ex',26:'Meloetta',27:'Haunter',28:'Celebratory Fanfare',
      31:"N's Zekrom",32:'Mega Gardevoir ex',33:'Mega Lucario ex',
      36:'Mega Feraligatr ex',64:'Serperior',65:'Barbaracle',66:'Tyrantrum',
      67:'Doublade',69:'Chikorita',70:'Tyrunt',71:'Mega Zygarde ex',
      74:'Delphox',75:'Ampharos',76:'Crobat',77:'Goodra',78:'Toxel',79:'Charmeleon',
    }
  },
};

function applyPokellectorCorrections() {
  let count = 0;
  for (const [setId, setData] of Object.entries(POKELLECTOR_CORRECTIONS)) {
    for (const [num, name] of Object.entries(setData.cards)) {
      addCardToDb(setId, String(num), {
        name,
        setName: setData.setName,
        setCode: setData.setCode,
        rarity: '',
        hp: '',
        source: 'pokellector',
      });
      count++;
    }
  }
  console.log(`[CARD-DB] Applied ${count} Pokellector corrections (me1: ${Object.keys(POKELLECTOR_CORRECTIONS.me1.cards).length}, mep: ${Object.keys(POKELLECTOR_CORRECTIONS.mep.cards).length})`);
  cardDbDirty = true;
}

export function addCardToDb(setId, number, data) {
  const key = `${setId}-${number}`;
  const existing = CARD_DB.get(key);
  if (existing && existing.source === 'pokellector' && data.source !== 'pokellector') {
    return;
  }
  if (existing && data.source === 'sheet' &&
      (existing.source === 'fallback' || existing.source === 'tcggo' || existing.source === 'manual')) {
    return;
  }
  CARD_DB.set(key, data);
}

export function lookupLocalDb(setId, cardNumber) {
  const cleanNum = String(cardNumber).replace(/^0+/, '') || String(cardNumber);
  const key = `${setId}-${cleanNum}`;
  const entry = CARD_DB.get(key);
  if (entry) {
    if (POKEMONTCG_UNRELIABLE.has(setId)) {
      const trusted = entry.source === 'pokellector' || entry.source === 'tcggo' || entry.source === 'fallback' || entry.source === 'manual';
      if (!trusted) {
        console.log(`[LOCAL-DB] SKIP untrusted entry: ${key} → ${entry.name} (source: ${entry.source || 'none'})`);
        return null;
      }
    }
    console.log(`[LOCAL-DB] HIT: ${key} → ${entry.name} (source: ${entry.source || 'unknown'})`);
    return {
      game: 'pokemon',
      name: entry.name,
      set_name: entry.setName,
      set_code: (entry.setCode || setId).toUpperCase(),
      card_number: cleanNum,
      rarity: entry.rarity || '',
      hp: entry.hp || '',
      reference_image: entry.image || null,
      cardmarket_url: entry.cardmarketUrl || null,
      tcgplayer_url: entry.tcgplayerUrl || null,
      verified: true,
      db_source: 'local-db',
      _manual: true
    };
  }
  return null;
}

export function saveCardDbToFile() {
  try {
    if (fs.existsSync(CRAWL_MARKER)) {
      console.log('[CARD-DB] crawler active — skipping dirty save (will resume after crawl)');
      return;
    }
    const dataDir = join(REPO_ROOT, 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

    const obj = {};
    for (const [key, val] of CARD_DB) {
      obj[key] = val;
    }
    fs.writeFileSync(CARD_DB_FILE, JSON.stringify(obj));
    const sizeMB = (fs.statSync(CARD_DB_FILE).size / 1024 / 1024).toFixed(1);
    console.log(`[CARD-DB] Saved ${CARD_DB.size} cards to ${CARD_DB_FILE} (${sizeMB} MB)`);
    cardDbDirty = false;
  } catch (e) {
    console.error(`[CARD-DB] Failed to save: ${e.message}`);
  }
}

function loadCardDbFromFile() {
  try {
    if (!fs.existsSync(CARD_DB_FILE)) return false;
    const raw = fs.readFileSync(CARD_DB_FILE, 'utf8');
    const obj = JSON.parse(raw);
    const keys = Object.keys(obj);
    if (keys.length === 0) return false;

    for (const key of keys) {
      CARD_DB.set(key, obj[key]);
    }
    cardDbCount = CARD_DB.size;
    cardDbReady = true;
    const sizeMB = (fs.statSync(CARD_DB_FILE).size / 1024 / 1024).toFixed(1);
    console.log(`[CARD-DB] Loaded ${cardDbCount} cards from file (${sizeMB} MB)`);
    return true;
  } catch (e) {
    console.error(`[CARD-DB] Failed to load file: ${e.message}`);
    return false;
  }
}

function savePriceDbToFile() {
  // Dual-write: JSON file (V2 backup, deprecated per V2_ARCHITECTURE §4.2,
  // dropped in a follow-up release) AND Postgres card_prices (primary).
  // The file write happens synchronously; the Postgres bulk-upsert is
  // fire-and-forget so a slow/unavailable DB doesn't block the in-memory
  // refresh path.
  try {
    const dataDir = join(REPO_ROOT, 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    const obj = { _lastRefreshAt: _lastPriceRefreshAt, cards: {} };
    for (const [key, val] of CARD_PRICES) obj.cards[key] = val;
    fs.writeFileSync(CARD_PRICES_FILE, JSON.stringify(obj));
    const sizeMB = (fs.statSync(CARD_PRICES_FILE).size / 1024 / 1024).toFixed(1);
    console.log(`[PRICE-DB] Saved ${CARD_PRICES.size} priced cards to ${CARD_PRICES_FILE} (${sizeMB} MB)`);
  } catch (e) {
    console.error(`[PRICE-DB] Failed to save: ${e.message}`);
  }

  // Postgres dual-write. Reconstruct rows from the Map values (which are
  // camelCase per V1 shape) into the snake_case columns the table expects.
  if (!supabase || CARD_PRICES.size === 0) return;
  const rows = [];
  for (const val of CARD_PRICES.values()) {
    if (!val?.setId || !val?.number || !val?.name) continue;
    rows.push({
      set_id: val.setId,
      number: String(val.number),
      name: val.name,
      set_name: val.setName || null,
      set_code: val.setCode || null,
      rarity: val.rarity || null,
      image: val.image || null,
      cardmarket_url: val.cardmarketUrl || null,
      tcgplayer_url: val.tcgplayerUrl || null,
      tcg: val.tcg || null,
      cm: val.cm || null,
      fetched_at: val.fetchedAt ? new Date(val.fetchedAt).toISOString() : new Date().toISOString(),
    });
  }
  bulkSaveCardPrices(rows)
    .then((res) => {
      if (!res.ok) {
        console.warn(`[PRICE-DB] Postgres dual-write completed with errors (${res.errors.length}): first=${res.errors[0]}`);
      } else {
        console.log(`[PRICE-DB] Postgres dual-write upserted ${res.inserted} rows`);
      }
    })
    .catch((err) => {
      console.warn('[PRICE-DB] Postgres dual-write threw:', err?.message || err);
    });
}

function loadPriceDbFromFile() {
  try {
    if (!fs.existsSync(CARD_PRICES_FILE)) return false;
    const raw = fs.readFileSync(CARD_PRICES_FILE, 'utf8');
    const obj = JSON.parse(raw);
    const cards = obj?.cards || obj || {};
    const keys = Object.keys(cards);
    if (keys.length === 0) return false;
    for (const key of keys) CARD_PRICES.set(key, cards[key]);
    _lastPriceRefreshAt = obj?._lastRefreshAt || 0;
    const sizeMB = (fs.statSync(CARD_PRICES_FILE).size / 1024 / 1024).toFixed(1);
    console.log(`[PRICE-DB] Loaded ${CARD_PRICES.size} priced cards from file (${sizeMB} MB)`);
    return true;
  } catch (e) {
    console.error(`[PRICE-DB] Failed to load file: ${e.message}`);
    return false;
  }
}

export async function downloadCardDatabase({ force = false } = {}) {
  if (cardDbLoading) return;
  cardDbLoading = true;
  const PAGE_SIZE = 250;
  const apiKey = process.env.POKEMON_TCG_API_KEY || '';
  const BATCH = apiKey ? 5 : 3;
  const WAVE_DELAY_MS = apiKey ? 0 : 7500;
  const SAVE_EVERY_N_PAGES = 20;
  const reqOpts = (params) => ({
    params,
    timeout: 30000,
    headers: apiKey ? { 'X-Api-Key': apiKey } : {}
  });
  const pageParams = (page) => ({
    pageSize: PAGE_SIZE,
    page,
    select: 'id,name,number,rarity,set,hp,supertype,subtypes,cardmarket,tcgplayer,images'
  });

  try {
    console.log(force ? '[CARD-DB] Force refresh — pulling all pages from pokemontcg.io...' : '[CARD-DB] No local file — downloading from pokemontcg.io...');
    console.log(`[CARD-DB] API key: ${apiKey ? 'present (high rate limit)' : 'NOT SET — throttling to 25 req/min'}; BATCH=${BATCH}, WAVE_DELAY=${WAVE_DELAY_MS}ms`);

    const firstResp = await axios.get('https://api.pokemontcg.io/v2/cards', reqOpts(pageParams(1)));
    const totalCount = firstResp.data?.totalCount || 0;
    const totalPages = Math.ceil(totalCount / PAGE_SIZE);
    console.log(`[CARD-DB] Total: ${totalCount} cards across ${totalPages} pages`);

    processPageData(firstResp.data?.data || []);
    console.log(`[CARD-DB] Page 1/${totalPages} (${CARD_DB.size} cards, ${CARD_PRICES.size} priced)`);

    let pagesSinceSave = 1;
    let pagesFailed = 0;
    const failedPages = [];

    for (let start = 2; start <= totalPages; start += BATCH) {
      const pages = [];
      for (let p = start; p < start + BATCH && p <= totalPages; p++) {
        pages.push(
          axios.get('https://api.pokemontcg.io/v2/cards', reqOpts(pageParams(p)))
            .then(r => { processPageData(r.data?.data || []); return p; })
            .catch(e => {
              const status = e?.response?.status;
              const msg = status ? `HTTP ${status}` : e.message;
              console.log(`[CARD-DB] Page ${p} failed: ${msg}`);
              pagesFailed++;
              failedPages.push(p);
              return null;
            })
        );
      }
      const done = await Promise.all(pages);
      const maxPage = Math.max(...done.filter(Boolean), 0);
      pagesSinceSave += BATCH;
      if (maxPage % 10 === 0 || maxPage === totalPages) {
        console.log(`[CARD-DB] Progress: page ${maxPage}/${totalPages} (${CARD_DB.size} cards, ${CARD_PRICES.size} priced, ${pagesFailed} failed)`);
      }
      if (pagesSinceSave >= SAVE_EVERY_N_PAGES) {
        try {
          _lastPriceRefreshAt = Date.now();
          saveCardDbToFile();
          savePriceDbToFile();
        } catch (saveErr) {
          console.warn('[CARD-DB] Incremental save failed (continuing):', saveErr.message);
        }
        pagesSinceSave = 0;
      }
      if (WAVE_DELAY_MS > 0 && start + BATCH <= totalPages) {
        await new Promise(r => setTimeout(r, WAVE_DELAY_MS));
      }
    }

    cardDbCount = CARD_DB.size;
    cardDbReady = true;
    _lastPriceRefreshAt = Date.now();
    if (pagesFailed > 0) {
      console.warn(`[CARD-DB] Download complete with ${pagesFailed} failed page(s): ${failedPages.slice(0, 30).join(',')}${failedPages.length > 30 ? '…' : ''}`);
    } else {
      console.log(`[CARD-DB] Download complete! ${cardDbCount} cards (${CARD_PRICES.size} priced).`);
    }

    saveCardDbToFile();
    savePriceDbToFile();
  } catch (e) {
    console.error(`[CARD-DB] Download failed: ${e.message}`);
    console.error(e.stack);
    if (CARD_DB.size > 0) {
      cardDbCount = CARD_DB.size;
      cardDbReady = true;
      console.log(`[CARD-DB] Partial: ${cardDbCount} cards available`);
      saveCardDbToFile();
      if (CARD_PRICES.size > 0) {
        _lastPriceRefreshAt = Date.now();
        savePriceDbToFile();
      }
    }
  }
  cardDbLoading = false;
}

function processPageData(cards) {
  // Buffer rows that map to card_prices Postgres columns. After populating
  // the in-memory Map (the runtime hot path for arbitrage), fire-and-forget
  // a bulk upsert. We never await it — admin.js reads the Map, not the
  // table, so Postgres latency must not gate the in-memory population.
  const priceRowsForPg = [];

  for (const c of cards) {
    const setId = c.set?.id || '';
    const num = c.number || '';
    if (!setId || !num) continue;
    if (POKEMONTCG_UNRELIABLE.has(setId)) continue;

    addCardToDb(setId, num, {
      name: c.name,
      setName: c.set?.name || '',
      setCode: (c.set?.ptcgoCode || setId).toUpperCase(),
      rarity: c.rarity || '',
      hp: c.hp || '',
      supertype: c.supertype || '',
      subtypes: c.subtypes || [],
      image: c.images?.large || c.images?.small || '',
      cardmarketUrl: c.cardmarket?.url || null,
      tcgplayerUrl: c.tcgplayer?.url || null,
      source: 'pokemontcg',
    });

    if (c.tcgplayer?.prices || c.cardmarket?.prices) {
      const cleanNum = String(num).replace(/^0+/, '') || String(num);
      CARD_PRICES.set(`${setId.toLowerCase()}-${cleanNum}`, {
        name: c.name,
        setId,
        setName: c.set?.name || '',
        setCode: (c.set?.ptcgoCode || setId).toUpperCase(),
        number: c.number,
        rarity: c.rarity || '',
        image: c.images?.small || c.images?.large || '',
        cardmarketUrl: c.cardmarket?.url || null,
        tcgplayerUrl: c.tcgplayer?.url || null,
        tcg: c.tcgplayer?.prices || null,
        cm: c.cardmarket?.prices || null,
        fetchedAt: Date.now()
      });

      priceRowsForPg.push({
        set_id: setId,
        number: c.number,
        name: c.name,
        set_name: c.set?.name || null,
        set_code: (c.set?.ptcgoCode || setId).toUpperCase(),
        rarity: c.rarity || null,
        image: c.images?.small || c.images?.large || null,
        cardmarket_url: c.cardmarket?.url || null,
        tcgplayer_url: c.tcgplayer?.url || null,
        tcg: c.tcgplayer?.prices || null,
        cm: c.cardmarket?.prices || null,
        fetched_at: new Date().toISOString(),
      });
    }
  }

  // Fire-and-forget Postgres dual-write. bulkSaveCardPrices is failsafe —
  // it returns { ok:true, inserted:0 } when supabase is null, and chunks
  // 1000 rows per call internally. processPageData runs ~92 times during
  // a fresh download (250 cards/page × ~92 pages).
  if (priceRowsForPg.length > 0 && supabase) {
    bulkSaveCardPrices(priceRowsForPg).catch((err) => {
      console.warn(`[PRICE-DB] Postgres dual-write failed for page (${priceRowsForPg.length} rows):`, err?.message || err);
    });
  }
}

export function cacheCardResult(setId, cardNumber, cardData) {
  if (!setId || !cardNumber) return;
  const cleanNum = String(cardNumber).replace(/^0+/, '') || String(cardNumber);
  addCardToDb(setId, cleanNum, {
    name: cardData.name,
    setName: cardData.set_name || '',
    setCode: cardData.set_code || setId.toUpperCase(),
    rarity: cardData.rarity || '',
    hp: cardData.hp || '',
    image: cardData.reference_image || '',
    cardmarketUrl: cardData.cardmarket_url || null,
    tcgplayerUrl: cardData.tcgplayer_url || null,
    source: 'fallback',
  });
  cardDbDirty = true;
  console.log(`[LOCAL-DB] Cached: ${setId}-${cleanNum} → ${cardData.name}`);
}

// V1 server.js:1982-1986 — periodic save of dirty entries.
// Wrapped behind a start function so test imports don't leave an open
// interval handle keeping Node alive. apps/server/server.js calls this
// explicitly on boot, alongside initCardDb().
export function startCardDbDirtySaveInterval() {
  return setInterval(() => {
    if (cardDbDirty && CARD_DB.size > 0) {
      saveCardDbToFile();
    }
  }, 5 * 60 * 1000);
}

async function loadCardDbFromSheet() {
  const sheetUrl = process.env.CARD_DB_SHEET_URL;
  if (!sheetUrl) return false;

  try {
    console.log('[CARD-DB] Fetching Google Sheet CSV...');
    const resp = await axios.get(sheetUrl, { timeout: 30000, responseType: 'text' });
    const csv = resp.data;
    if (!csv || csv.length < 50) {
      console.log('[CARD-DB] Sheet is empty or too small');
      return false;
    }

    const lines = csv.split('\n');
    const header = lines[0].toLowerCase();
    if (!header.includes('set_id') && !header.includes('name')) {
      console.log('[CARD-DB] Sheet missing expected headers');
      return false;
    }

    let loaded = 0;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const cols = parseCSVLine(line);
      if (cols.length < 3) continue;

      const setId = (cols[0] || '').trim();
      const num = (cols[1] || '').trim();
      const name = (cols[2] || '').trim();
      if (!setId || !num || !name) continue;

      const verified = (cols[7] || '').trim().toLowerCase();
      const isVerified = verified === 'yes' || verified === 'true' || verified === '1';

      addCardToDb(setId, num, {
        name: name,
        setName: (cols[3] || '').trim(),
        setCode: (cols[4] || setId).trim().toUpperCase(),
        rarity: (cols[5] || '').trim(),
        hp: (cols[6] || '').trim(),
        source: isVerified ? 'manual' : 'sheet',
      });
      loaded++;
    }

    if (loaded > 0) {
      cardDbCount = CARD_DB.size;
      cardDbReady = true;
      console.log(`[CARD-DB] Loaded ${loaded} cards from Google Sheet`);
      saveCardDbToFile();
      return true;
    }
    return false;
  } catch (e) {
    console.error(`[CARD-DB] Google Sheet fetch failed: ${e.message}`);
    return false;
  }
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

export async function importUnreliableSetsFromTCGGO() {
  const apiKey = process.env.RAPIDAPI_KEY;
  if (!apiKey) {
    console.log('[TCGGO-IMPORT] No RAPIDAPI_KEY — skipping unreliable set import');
    return;
  }
  if (unreliableImportDone) return;

  const setsToImport = [...POKEMONTCG_UNRELIABLE]
    .filter(s => PKM_SET_NAMES[s]);

  console.log(`[TCGGO-IMPORT] Importing ${setsToImport.length} unreliable sets: ${setsToImport.join(', ')}`);
  let totalImported = 0;

  for (const setId of setsToImport) {
    const setName = PKM_SET_NAMES[setId];
    let page = 1;
    let setCount = 0;
    let hasMore = true;

    while (hasMore) {
      try {
        const resp = await axios.get('https://pokemon-tcg-api.p.rapidapi.com/cards/search', {
          params: { search: setName, per_page: 50, page },
          headers: {
            'X-RapidAPI-Key': apiKey,
            'X-RapidAPI-Host': 'pokemon-tcg-api.p.rapidapi.com',
            'Accept': 'application/json'
          },
          timeout: 15000
        });

        const data = resp.data?.data;
        if (!data || data.length === 0) {
          hasMore = false;
          break;
        }

        for (const card of data) {
          const epName = (card.episode?.name || '').toLowerCase();
          const epCode = (card.episode?.code || '').toUpperCase();
          if (!epName.includes(setName.toLowerCase()) && epCode !== setId.toUpperCase()) continue;

          const num = String(card.card_number || '').replace(/^0+/, '');
          if (!num) continue;

          addCardToDb(setId, num, {
            name: card.name,
            setName: card.episode?.name || setName,
            setCode: (card.episode?.code || setId).toUpperCase(),
            rarity: card.rarity || '',
            hp: '',
            image: card.image || '',
            source: 'tcggo',
          });
          setCount++;
        }

        if (data.length < 50) {
          hasMore = false;
        } else {
          page++;
          await new Promise(r => setTimeout(r, 300));
        }
      } catch (e) {
        if (e.response?.status === 429) {
          console.log(`[TCGGO-IMPORT] Rate limited on ${setName} page ${page} — pausing 5s`);
          await new Promise(r => setTimeout(r, 5000));
          continue;
        }
        console.log(`[TCGGO-IMPORT] Error on ${setName} page ${page}: ${e.response?.status || e.message}`);
        hasMore = false;
      }
    }

    console.log(`[TCGGO-IMPORT] ${setName} (${setId}): ${setCount} cards imported`);
    totalImported += setCount;

    await new Promise(r => setTimeout(r, 500));
  }

  if (totalImported > 0) {
    cardDbDirty = true;
    cardDbCount = CARD_DB.size;
    console.log(`[TCGGO-IMPORT] Done — imported ${totalImported} cards across ${setsToImport.length} sets (DB total: ${CARD_DB.size})`);
    saveCardDbToFile();
  }
  unreliableImportDone = true;
}

/**
 * Warm CARD_PRICES from the Postgres `card_prices` table (V2 primary).
 * Failsafe: returns false on null client / empty / error so the caller can
 * fall through to the file backup. See db/price-snapshot/store.js.
 */
async function loadPriceDbFromPostgres() {
  if (!supabase) return false;
  try {
    const map = await loadAllCardPrices();
    if (!map || map.size === 0) return false;
    for (const [key, val] of map) CARD_PRICES.set(key, val);
    // Best-effort fetched_at watermark — pick the newest entry's timestamp
    // so /api/admin/refresh-status shows something sensible after a warm-up.
    let newest = 0;
    for (const v of CARD_PRICES.values()) {
      if (v.fetchedAt && v.fetchedAt > newest) newest = v.fetchedAt;
    }
    if (newest > 0) _lastPriceRefreshAt = newest;
    console.log(`[PRICE-DB] Loaded ${CARD_PRICES.size} priced cards from Postgres card_prices`);
    return true;
  } catch (e) {
    console.warn('[PRICE-DB] Postgres warm-up failed:', e?.message || e);
    return false;
  }
}

export async function initCardDb() {
  // Boot signals operator-initiated restart — clear any leftover crawler marker
  // so dirty-save can resume normally. If the crawler is somehow still running
  // (mid-write at restart time), the marker absence allows a save race; that
  // race is acceptable since restarts are operator-initiated and the crawler
  // would just need to be re-run.
  try { fs.unlinkSync(CRAWL_MARKER); console.log('[CARD-DB] cleared stale crawl marker'); } catch { /* ENOENT — marker not present, normal */ }

  const fromSheet = await loadCardDbFromSheet();
  // Always merge file contents — file may contain pokemontcg-enriched entries
  // from the offline crawler that the sheet doesn't have.
  const fromFile = loadCardDbFromFile();
  if (!fromSheet && !fromFile) {
    await downloadCardDatabase();
  }

  applyPokellectorCorrections();
  saveCardDbToFile();

  // Boot order for CARD_PRICES (V2 F16 / S10):
  //   1. Postgres card_prices (primary) — survives Render free-tier sleep
  //      and redeploys; populated by both processPageData() and
  //      savePriceDbToFile() dual-writes.
  //   2. JSON file (backup, deprecated — dropped in a follow-up release).
  //   3. Otherwise rely on the pokemontcg.io download path that ran above
  //      (downloadCardDatabase populates CARD_PRICES inline) or wait for an
  //      admin-triggered refresh-prices.
  if (CARD_PRICES.size === 0) {
    const fromPg = await loadPriceDbFromPostgres();
    if (!fromPg) loadPriceDbFromFile();
  }
}
// Card DB initialisation is now EXPLICIT — apps/server/server.js calls
// initCardDb() before app.listen. Removed the eager-import auto-boot
// because pricing/adapters/pokemontcg.js imports lookupLocalDb from this
// module, and tests that import the adapter were inadvertently kicking
// off a 5-minute pokemontcg.io download. V1 root server.js keeps its
// own auto-boot at line 2237 — this change only affects the V2 path.
