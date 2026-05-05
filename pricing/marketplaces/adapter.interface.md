# Marketplace adapter interface

_Owner: A9. Slice: S18 (F18)._

Outbound listing adapters (Cardmarket / TCGPlayer / eBay / in-store) implement
a different shape from pricing adapters: they **push** state to an external
marketplace rather than **pull** prices. A pricing adapter (see
`pricing/adapter.interface.md`) is read-only; a marketplace adapter is the
write counterpart and is invoked from `apps/server/routes/inventory.js` when
a vendor lists, repriced, or sells a card.

V2 ships **skeletons only** for cardmarket / tcgplayer / ebay. The in-store
adapter is fully functional (it is a database-only no-op marketplace —
"someone bought it across the counter"). Real OAuth + REST integrations land
in V2.1+. The route layer always records the listing row in our DB regardless
of whether the external sync succeeds; an adapter that returns
`{ ok: false, reason: 'not_yet_implemented' }` is a soft-fail path, not a
route-level error.

---

## Contract

Every adapter exports a default object (or named module) with the following
shape. Operations are async; all return a `{ ok, ... }` envelope.

### `name: string`

Human-readable name. One of `'cardmarket' | 'tcgplayer' | 'ebay' | 'in_store'`.
Must match the `marketplace` CHECK constraint in `public.listings`.

### `isAvailable(): { ok: boolean, reason?: string }`

Synchronous environment probe. Returns `{ ok: true }` only when every credential
this adapter would need is present in `process.env`. Used by the route layer to
short-circuit before calling list/update/sold and surface a clear 503-style
error to the client.

### `listItem(item, ask_eur, ctx) → Promise<{ ok, external_url?, listing_id?, reason? }>`

Push a new listing to the marketplace.

- `item`     — the `inventory_items` row (card_meta + condition + cost meta).
- `ask_eur`  — numeric ask price in EUR.
- `ctx`      — optional `{ owner_user_id, shop_id, env }` for credential lookup.

V2 default for cardmarket / tcgplayer / ebay: `{ ok: false, reason: 'not_yet_implemented' }`.
The route still inserts a `listings` row so P&L tracking works; the
`external_url` will be `null` until the integration ships.

### `updateListing(external_listing_id, fields, ctx) → Promise<{ ok, reason? }>`

Patch an existing external listing (typically `ask_eur` price changes).
`fields` is `{ ask_eur?: number, notes?: string }`.

### `markSold(external_listing_id, ctx) → Promise<{ ok, sold_eur?, fees_eur?, reason? }>`

Confirm an external listing as sold and report back actuals (the marketplace
is the source of truth for the final sale price + its own fees). For cards
that sold without our help (e.g. eBay auction), the route layer can short-
circuit and pass `{ sold_eur, fees_eur }` directly to `db/inventory/listings.markSold`
instead of round-tripping through this method.

### `delistItem(external_listing_id, ctx) → Promise<{ ok, reason? }>`

Pull a listing back. Used when a vendor decides to consign or return a card
that was previously listed externally.

---

## Required environment variables

| Adapter      | Env vars                                                               | Notes |
|--------------|------------------------------------------------------------------------|-------|
| `cardmarket` | `CARDMARKET_OAUTH_KEY`, `CARDMARKET_OAUTH_SECRET`, `CARDMARKET_TOKEN`, `CARDMARKET_TOKEN_SECRET` | OAuth 1.0a; per-user tokens stored encrypted in `profiles` (V2.1). |
| `tcgplayer`  | `TCGPLAYER_PRO_KEY`                                                    | Pro Sellers tier required for listing API. |
| `ebay`       | `EBAY_APP_ID`, `EBAY_CERT_ID`                                          | Same credential pair as the V1 sold-listings pricing adapter. |
| `in_store`   | _(none)_                                                               | No external call; `listings` row is the source of truth. |

When any required env var is missing, `isAvailable()` returns
`{ ok: false, reason: 'missing_credentials:<VAR>' }` and write ops return
`{ ok: false, reason: 'not_yet_implemented' }` (V2) or
`{ ok: false, reason: 'unconfigured' }` (V2.1+).

---

## Route layer expectations

`apps/server/routes/inventory.js` calls adapters from a single dispatch table
(`pricing/marketplaces/index.js` or inline switch). Adapters MUST NOT throw on
the happy path — return `{ ok: false, reason }` instead. Throwing is reserved
for genuinely unrecoverable bugs (the route layer surfaces a 500).

Append-only event log: every adapter call that returns `ok: true` is paired
with an `inventory_events` row written by the DB layer (`db/inventory/listings.js`).
A failed adapter call (`ok: false`) still writes the listing row (so the
vendor can see the intent in the UI) but the `'listed'` event records the
adapter `reason` in `data` for forensics.
