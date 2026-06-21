# Fikes Chevrolet Inventory Crawler

Scrapes new and used vehicle inventory from [fikeschevy.com](https://www.fikeschevy.com) and outputs a **Meta-formatted XML feed** for Facebook Commerce Manager.

## Stack

- **Node.js** + **Axios** + **Cheerio** — no headless browser needed (site is server-side rendered on Dealer Inspire)
- **GitHub Actions** — runs on a schedule, commits updated feed
- **GitHub Pages** — hosts `feed.xml` at a public URL

---

## Quick Start

```bash
git clone https://github.com/<you>/<repo>.git
cd <repo>
npm install
node scraper.js          # fast mode — SRP cards only
node scraper.js --deep   # deep mode — also scrapes VDPs for GM CDN images
```

Output lands in `docs/`:
- `docs/feed.xml` — Meta XML catalog feed
- `docs/inventory.json` — raw JSON (debug/backup)

---

## Deployment

### 1. Push to GitHub

```bash
git init
git remote add origin https://github.com/<you>/<repo>.git
git add .
git commit -m "init"
git push -u origin main
```

### 2. Enable GitHub Pages

In your repo → **Settings → Pages**:
- Source: **Deploy from a branch**
- Branch: `main` / folder: `/docs`
- Save

Your feed URL will be:
```
https://<you>.github.io/<repo>/feed.xml
```

### 3. Connect to Facebook Commerce Manager

1. Go to [Facebook Commerce Manager](https://business.facebook.com/commerce)
2. Open the **"Fikes Vehicles"** catalog
3. **Data Sources → Add Items → Use a Feed URL**
4. Paste your GitHub Pages feed URL
5. Set **Schedule**: Hourly or Daily
6. Map fields if prompted (VIN, title, price, image_link are auto-detected)

**Pixel ID already embedded in feed:** `911722818604064`

---

## How It Works

```
SRP page (new-vehicles/ + used-vehicles/)
  └─ Parse vehicle cards with Cheerio
      ├─ VIN extracted from URL slug (last 17 chars before trailing /)
      ├─ Year/Make/Model/Trim from card title
      ├─ MSRP + Net Price from price elements
      └─ Images from card thumbnail (+ GM CDN if --deep)

Output → Meta RSS/XML feed (one <item> per VIN)
```

### Pagination

Dealer Inspire paginates via `?page=N`. The crawler auto-detects the last page from pagination links and loops through all pages.

### GM CDN Images (`--deep` mode)

When `--deep` is passed, each VDP is also fetched and the HTML is scanned for GM CDN image URLs matching:
```
https://vini.gm.com/realimages/{VIN}/{hash}.jpeg
```
Up to 10 images per vehicle are included in the feed via `<additional_image_link>` tags.

---

## Selector Notes (Dealer Inspire)

If the site updates and scraping breaks, check these selectors in `scraper.js`:

| Field | Selector |
|-------|----------|
| Vehicle cards | `.vehicle-card, .inventory-listing-item, [data-vin]` |
| VDP link | `a.vehicle-card-link, a[href*='/inventory/']` |
| Title | `.vehicle-card-title, .vehicle-title, h2, h3` |
| MSRP | `.vehicle-card-msrp, .msrp, [class*='msrp']` |
| Net price | `.vehicle-card-price, .net-price, [class*='net-price']` |
| Mileage | `[class*='mileage'], .odometer` |
| Ext color | `[class*='exterior'], [class*='ext-color']` |
| Int color | `[class*='interior'], [class*='int-color']` |

Run `node scraper.js` and inspect `docs/inventory.json` to verify fields are populating.

---

## Schedule (GitHub Actions)

The workflow runs at **6 AM and 6 PM Central** daily. To change:

```yaml
# .github/workflows/crawl.yml
- cron: "0 11,23 * * *"  # 11:00 and 23:00 UTC = 6AM/6PM CT
```

Trigger a manual run anytime from **Actions → Crawl Inventory & Deploy Feed → Run workflow**.
