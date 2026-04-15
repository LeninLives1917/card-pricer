# Card Pricer — Setup Guide

## Quick Start (2 minutes)

```bash
cd card-pricer
cp .env.example .env
# Edit .env and add your ANTHROPIC_API_KEY (required)
npm install
npm start
```

Open **http://localhost:3000** on your phone (same Wi-Fi network) or your computer.

To install as a home screen app: open in Safari/Chrome on your phone → Share → "Add to Home Screen".

---

## API Keys — What You Need

### Required
| API | Purpose | How to Get |
|-----|---------|-----------|
| **Anthropic** | Card identification via Claude Vision | [console.anthropic.com](https://console.anthropic.com/) — create key, ~$0.01 per scan |

### Optional (Improves Accuracy)
| API | Purpose | How to Get |
|-----|---------|-----------|
| **eBay** | Recent sold listings for price comparison | [developer.ebay.com](https://developer.ebay.com/) — create app, get App ID + Cert ID |
| **Cardmarket** | Direct lowest-price lookups (all games) | [cardmarket.com API](https://www.cardmarket.com/en/Magic/Data/API) — apply with seller account |

### Free (No Key Needed)
- **Scryfall** — Magic: The Gathering prices (includes Cardmarket trend prices)
- **Pokemon TCG API** — Pokemon prices (includes Cardmarket + TCGPlayer data)

---

## How Pricing Works

The app uses a waterfall approach for maximum accuracy:

1. **Game-specific free APIs** (Scryfall for MTG, Pokemon TCG API for Pokemon) — these include Cardmarket trend prices built in
2. **Direct Cardmarket API** (if configured) — overrides with live lowest-price data
3. **Scraping fallback** — if no API keys, scrapes Cardmarket search results
4. **eBay sold listings** (if configured) — recent sale prices for comparison

### Buy Price Formula
```
Buy Price = Cardmarket Lowest × Condition Multiplier × Buy Percentage

Condition Multipliers:
  NM  = 100%
  LP  = 85%
  MP  = 70%
  HP  = 50%
  DMG = 30%
```

You set the buy percentage with the slider (default 60%).

---

## Using at a Show

1. Open the app on your phone
2. Point camera at a card → tap the capture button
3. AI identifies the card, set, number, and estimates condition
4. Prices appear instantly — Cardmarket low + eBay sold median
5. Green "Buy Price" shows what to pay at your chosen margin
6. Card goes into your session log with a running total

**Batch mode**: Switch to "Binder Page" mode, photograph a full 9-pocket page, and it identifies + prices all visible cards at once.

**Accuracy tips**:
- Good, even lighting (avoid glare on holos)
- Capture the full card including corners for condition grading
- Use the hint field if the AI struggles (e.g., type "Pokemon SV06" to narrow it down)
- If the AI gets it wrong, tap "Wrong card? Search" to correct manually

---

## Running on Your Phone at a Show

**Option A — Local network (easiest)**
Run the server on a laptop. Connect your phone to the same Wi-Fi. Open `http://<laptop-ip>:3000`.

**Option B — Deploy to the cloud**
Deploy to any Node.js host (Railway, Render, Fly.io, etc.):
```bash
# Example with Railway
npm install -g @railway/cli
railway login
railway init
railway up
```

**Option C — Ngrok tunnel**
```bash
npm start &
npx ngrok http 3000
# Use the ngrok URL on your phone
```
