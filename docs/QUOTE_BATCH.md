# Whole-list customer quote

*Shipped 7 Oct 2026. The `/quote` page for Pokémon now quotes a whole list, up
to 1,000 lines, in one request.*

## Why

The page used to make two live requests per card (identify, then a price
ladder fanning out to Cardmarket, pokemontcg.io, JustTCG, TCGGO and eBay), all
behind one 10-per-hour limiter that the email step shared. A customer with 5
cards had the email step refused, and because prices stay blurred until that
step succeeds, they never saw a quote. Nothing counted it.
`quote_leads` had 0 rows, ever.

## How it works

```
POST /api/v2/quote/batch  { lines: [...], game: 'pokemon' }
  each line -> resolveTypedLine()           pricing/text-entry (local catalogue, no network)
            -> Classic Collection check     reprints print the original's name + number
            -> price row                    pricing/quote-prices (hub snapshot, in memory)
            -> priced | unpriced | ask | not_found | not_supported
```

- **No remote fall-through.** The identify ladder takes search hit #1 when
  nothing confirms it; a public quote must not ship that. A line the local
  resolver cannot place is `not_found` with a message saying what to add.
- **Questions come back with prices** for every candidate, so the page settles
  a pick without another request. The page does not SHOW those prices on the
  buttons (the customer is identifying the card in their hand).
- **Reprints are asked, never assumed.** Celebrations (cel25c, in the
  catalogue) and 30th Celebration (me55c, `pricing/reference/classic-collection-reprints.json`)
  Classic Collection cards carry the original's name and number. A line that
  says `celebrations` / `classic` / `25th` / `30th` goes straight to the
  reprint; a line marked `1st` / `shadowless` is the original by definition.
- **1st Edition and Shadowless are not priced** (Cardmarket's guide does not
  split them out); they come back `unpriced` and the shop prices them by hand.
- **Reverse holo** uses the guide's `_holo` fields, only on cards that have a
  reverse printing; otherwise priced as the card that exists, flagged.
- **Market value is Cardmarket TREND**, falling back to avg7, avg30, avg. Not
  `low`: that is the cheapest copy in ANY condition. A trend more than 3x the
  30-day average is capped to the average and flagged (`price.capped`). A
  trend under a third of its 7- or 30-day average uses the median of the three
  (`price.dip`), and when they are more than 10x apart on a card worth EUR 2+
  nothing is quoted (`price_unstable`, by hand). The 6 Oct guide had Gengar
  (HS—Triumphant 94) at trend 0.02 beside avg30 908.54.
- **Graded cards** (PSA / BGS / CGC / SGC / "graded" / "slab") are priced by
  hand (`graded`): the guide prices raw cards.
- **Condition** typed on the line (`lp`, `pl`, ...) uses the server's
  Cardmarket-scale multipliers (`pricing/conditions.js`), so it prices the same
  online as at the till.

## Customer phrasing

Customers do not type like the shop. `pricing/text-entry/customer-line.js`
handles it, and the route (`resolveCustomer`) runs it in a fixed order:

1. **Always**: read the quantity (`2 x`, `x2`, `(x3)`, `qty: 4`, a spreadsheet
   column after a tab or comma), a language written out (`Japanese` -> not
   supported), grading marks, list numbering and separators, and phrases
   (`first edition`, `reverse holo`, `near mint`, `lightly played`, `RH`).
2. **The line as typed** goes to the resolver. If it resolves, that is the
   answer; nothing below runs. This is what keeps Light Dragonite, Good Rod and
   Reverse Valley intact.
3. Only if it failed (or came back with a question the typed denominator
   already rules out): **qualifiers moved** behind the number
   (`rev Gengar 94/162`, `4/102 Charizard`), then a **set name taken out**
   (`Charizard Base Set 4/102`), then **other words dropped**, longest kept span
   first. A dropped-words answer is trusted only when the words agree with the
   card's set (`contextAgrees`); otherwise the customer is asked "Is this your
   card?". A set name on the line also settles a question the number cannot
   (`Water Energy Gym Heroes 132/132`).
4. Grade and finish words that are part of the card's own name are not read as
   a grade ("Light Dragonite" is not lightly played).

Rewrites are bounded at `REWRITE_BUDGET` resolves per request; every line a
rewrite answered is marked `rescue` on the row and counted in `/api/health` ->
`quote_batch.rescued_by`, with `rewrite_budget_exhausted`.

Measured 7 Oct 2026, 2,000 sampled catalogue cards per format (the sweep is
`claude/customer-sweep.mjs` in the Card Pricing project):

| typed as | matched before | matched after | wrong card |
|---|---|---|---|
| `Charizard 4/102` | 100% | 100% | 0 |
| `rev Charizard 4/102` | 0.1% | 100% | 0 |
| `1st Edition Charizard 4/102` | 0% | 100% | 0 |
| `2 x Charizard 4/102` | 59.4% (qty lost on all) | 100% (qty kept) | 0 |
| `Charizard Base Set 4/102` | 3.5% | 100% | 0 |
| `Base Set Charizard 4/102` | 0.3% | 99.95% | 0 |
| `4/102 Charizard` | 0% | 100% | 0 |
| `nm Charizard 4/102` | 58.1% | 100% | 0 |

"Matched" means priced, by hand, or a question whose options include the right
card. Resolver time is about 4 ms a line on the build machine, so a 1,000-line
paste is a few seconds.

## The price data

boardbrewed-hub Supabase (`ycajinletezqllvnjsct`):

| object | what |
|---|---|
| `cm_price_snapshot` | Cardmarket's daily price guide, job `cardmarket-price-snapshot` 04:30 UTC |
| `cm_card_meta`, `cm_sets` | TCGdex card list with Cardmarket `id_product` |
| `quote_product_fill` | Cardmarket ids for cards TCGdex has not mapped (see below); an id TCGdex supplies wins |
| `quote_price_feed_build()` | the join, ~0.4 s warm |
| `quote_price_feed_cache` | one row, rebuilt hourly at :20 by pg_cron (`quote-price-feed-refresh`) |
| `rpc/quote_price_feed` | returns the cached document; SECURITY DEFINER, granted to anon |

Why cached: the live join measured 4.3 s cold through the API, over the anon
role's 3 s statement timeout.

card-pricer fetches it at boot (after the catalogue loads) and hourly
(`pricing/quote-prices/hub-feed.js`), joins it to the catalogue
(`pricing/quote-prices/feed-index.js`: set map, number normalisation, NAME
CHECK) and keeps the index in memory. A failed refresh keeps the last index.

Env (Render): `HUB_SUPABASE_URL`, `HUB_SUPABASE_KEY` (the hub's publishable key).

Coverage measured 7 Oct 2026 on the live catalogue (20,899 rows): 20,796
mapped (99.5%), 19,581 priced (93.7%). 30th Celebration (not in the catalogue
yet) is added from the hub as `me55-*`.

**Filling TCGdex's gaps.** TCGdex had a Cardmarket id for 63 of the 158 30th
Celebration cards and none of the 30 Classic Collection reprints, so a Mew ex
SIR (#152, trend ~99) quoted as "by hand" the morning it went live, while
Cardmarket's own guide priced it. Cardmarket's product list (`cm_products`,
expansion 6601) has the products but no collector numbers, and three products
are called "Mew ex". Their idProduct order is the set list with the cards
Cardmarket added late moved to the end, so `quote_product_fill` was built by a
longest-common-subsequence alignment of names (products by idProduct, cards by
number), repeated on what was left for the late batch. Checked: all 63 ids
TCGdex does have agree, and every card's attack names match the Cardmarket
product's. The Classic Collection is matched by name (unique apart from the
LEGEND halves). Result: all 188 cards priced.

**The other sets, same morning.** Order alignment agreed with TCGdex's own ids
on 50 sets but disagreed on 43 (holo and non-holo copies, regular and
full-art versions, same-name pairs like Torchic 25/26), so outside the 30th
Celebration order is not used as evidence. A gap card is filled only when,
inside its set's Cardmarket expansion (the one TCGdex's own ids point at) and
among products no card owns, its name is unique on both sides and its attacks
agree, or its attacks single out exactly one product. 485 filled. 68 of them
(Wizards and DP Black Star Promos: one TCGdex id to choose the expansion from,
and prices that look like graded or foreign copies) are kept but switched off
(`active = false`), Dave's call. Catalogue cards priced: 93.6% -> 95.5%.

Still unmapped (1,133 hub cards): promo sets (~300), Hidden Fates Shiny Vault
(94, no TCGdex id to find its expansion by), trainer kits (~330), and ~400
regular/full-art or holo/non-holo twins whose attacks are identical, which only
product order (unreliable, above) or a person can tell apart. They quote as
"by hand".

## Failure is loud

- `/api/health` -> `quote_prices`: NOT advisory. Fails when unconfigured,
  never loaded, older than 3 days (`PRICE_STALE_DAYS`), or mapping < 90%.
- `/api/health` -> `quote_batch`: quotes, lines, priced / asked / not-found
  ratios, unpriced by reason, and every 429 on the quote limiters.
- A stale or missing feed does not fall back to anything: every card comes back
  `unpriced` (`prices_stale` / `prices_unavailable`) and the customer can still
  send the list as a lead.

## Limits

| limiter | routes | budget |
|---|---|---|
| `quoteBatchLimiter` | `/api/v2/quote/batch` | 20 quotes / hour / IP |
| `quoteLookupLimiter` | `/api/v2/quote/identify-manual`, `/api/v2/quote/price` (other games) | 120 / hour / IP |
| `quoteLeadLimiter` | `/api/quote-lead` | 10 / hour / IP |

Leads take up to 1,000 cards (was 20) plus the lines to price by hand.

## Re-measuring

`claude/measure-typed-quote.mjs` in the Card Pricing project types every
catalogue card in ten formats through the real resolver. Results from 7 Oct are
in `claude/TYPED_QUOTE_ACCURACY.md`. Re-run after each crawl.

## Embedding

`/quote/?shop=brewed&embed=1` in an iframe. In embed mode the page posts
`{ type: 'cp:resize', height }` to the parent so an inline embed can size the
frame; the modal widget ignores message types it does not know. The website's
`/sell-cards` page uses this.
