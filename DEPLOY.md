# Hosting Elevation as its own website

Status: **ready to deploy, not deployed.** Nothing in this repo publishes anything. The owner has not yet chosen a
domain or a host or approved a public launch. Until then the game lives only in the private Claude artifact.

## What gets deployed

```sh
npm install
npm run build:site            # → dist/site/   (SITE_URL=https://your.domain npm run build:site once there is a domain)
```

`dist/site/` is a plain static folder, served as it is by any static host:

| File | What it is | Caching (`_headers`) |
|---|---|---|
| `index.html` | The page, with social tags (Open Graph and Twitter card), theme colours, manifest and icons | revalidate every time |
| `app.<hash>.js`, `style.<hash>.css` | All the game code, settings and the first month of routes; the CSS | one year, immutable |
| `data/<hash>/` | Route files (`routes/`), maps (`maps/`) and shaded relief (`relief/`), loaded on demand | one year, immutable |
| `sw.js` | Service worker: offline play, quick repeat visits | no-cache |
| `manifest.webmanifest`, `icons/` | Install as an app on phones (home-screen icon, standalone window) | a day / a week |
| `_headers` | Caching and security headers (CSP, nosniff, referrer policy, no framing) | – |
| `robots.txt` | Allows crawling | – |

The hashed names change whenever their contents change, so a new build never mixes with an old cached one.

## Settings (`config.js`)

| Setting | Default | |
|---|---|---|
| `tiles` | OpenStreetMap standard tiles, `maxZoom: 11` | The "Map" layer. See DATA.md for the tile policy; switch to a tile provider before real traffic. |
| `ads` | `{ enabled: false }` | Reserved ad slots, no provider (see ADS.md). |
| `sw` | `true` in the site build | Service worker. |

The artifact build ignores `config.js` and writes its own settings: no tiles, no ads, no service worker, and the
relief labelled "interim".

## Choosing a host (free tiers are enough to start)

| Host | `_headers` | Notes |
|---|---|---|
| Cloudflare Pages | Read as is | Generous free tier, unlimited bandwidth, custom domain with free TLS. Simplest fit. |
| Netlify | Read as is | Free tier has a bandwidth cap (100 GB/month). |
| GitHub Pages | Ignored (no custom headers) | Works, but the security headers and long caching can't be set; the hashed file names still keep updates safe. |
| Any S3/CDN or nginx | Copy the headers into its config | |

Deploying is: build, then upload `dist/site/` (or connect the repo and set the build command to
`npm ci && npm run build:site` with output folder `dist/site`).

## What's left before launch (owner's decisions)

1. **Launch approval.** Nothing goes public until the owner says so.
2. **Domain.** Buy one (about $10–15 a year) and point it at the host; then build with `SITE_URL` so the share image
   and canonical link use it.
3. **Host.** Cloudflare Pages is the suggested default (see above).
4. **Map tiles at scale.** Fine on OpenStreetMap's free tiles while traffic is light; move `tiles.url` to a provider
   (free tiers exist) before promoting the site, especially with ads on.
5. **Ads.** Pick a provider, then follow ADS.md (privacy policy, consent banner for the EU/UK, CSP hosts).
6. **Old GitHub Pages copy.** An earlier version was set up for GitHub Pages (branch `claude/eloquent-wozniak-mwx5wg`
   has a `.nojekyll` file). If Pages is still switched on in the repo settings it may be serving that old copy:
   check Settings → Pages and turn it off, or leave it if it is already off.
7. **Privacy page.** The game stores everything in the player's own browser (localStorage) and has no accounts or
   analytics; a short privacy page saying so is needed before ads or analytics are added.
