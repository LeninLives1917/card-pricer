# Deploying Card Pricer to Render

## 1. Push to GitHub (one-time)

If the code isn't on GitHub yet, easiest route is **GitHub Desktop**:

1. Install https://desktop.github.com
2. File → Add Local Repository → select the `card-pricer` folder
3. If it asks to "create a repository", say yes
4. Give it a name (e.g. `card-pricer`), keep it **Private**, click **Create Repository**
5. Click **Publish repository** in the top bar

(Or via CLI: `git init && git add . && git commit -m "initial" && gh repo create card-pricer --private --source=. --push`)

## 2. Connect to Render

1. Go to https://dashboard.render.com → **New +** → **Web Service**
2. **Connect a repository** — pick your GitHub account, authorise if needed, select `card-pricer`
3. Render should auto-detect `render.yaml` and prefill everything. If it doesn't:
   - **Name:** card-pricer
   - **Runtime:** Node
   - **Build command:** `npm install`
   - **Start command:** `node server.js`
   - **Plan:** Free

## 3. Add environment variables

In the Render service's **Environment** tab, add:

| Key | Value |
|---|---|
| `ANTHROPIC_API_KEY` | copy from your local `.env` |
| `EBAY_APP_ID` | copy from your local `.env` (if you use eBay) |
| `EBAY_CERT_ID` | copy from your local `.env` (if you use eBay) |
| `JUSTTCG_API_KEY` | copy from your local `.env` (if you use JustTCG) |
| `RAPIDAPI_KEY` | copy from your local `.env` (if you use TCGGO) |
| `DEFAULT_BUY_PERCENTAGE` | `60` |

(Skip any keys you don't have — the app handles missing ones gracefully.)

## 4. Deploy

Click **Create Web Service**. First build takes ~3-5 min. You'll get a URL like:

    https://card-pricer.onrender.com

Open it on laptop + phone. Phone-pairing via QR will "just work" because Render serves HTTPS (required for camera access on iOS/Android).

## 5. Custom domain (optional)

Render → Settings → Custom Domains → add `cards.boardandbrewed.ie` (or whatever), update DNS.

## Free-tier notes

- Render free-tier services sleep after 15 min of inactivity. First request after sleep takes ~30s to wake. At a card show, have the app open on laptop all day — it'll stay awake.
- In-memory QR rooms reset on redeploy or sleep — re-pair if this happens.
- Upgrade to **Starter ($7/mo)** if you need always-on.

## Future improvements

- Add a service worker for full offline support of the already-scanned log
- Persist rooms to SQLite (survives restarts)
- Auth on rooms (currently anyone with the code can push)
