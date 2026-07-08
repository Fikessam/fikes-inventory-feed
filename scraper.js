#!/usr/bin/env node
/**
 * Fikes Chevrolet Inventory Scraper
 * --------------------------------------------------------------------------
 * Scrapes vehicle data from fikeschevy.com VDPs and generates a Meta
 * (Facebook/Instagram) Commerce Manager automotive XML feed.
 *
 * WHY PUPPETEER:
 * fikeschevy.com runs on Dealer Inspire behind a Cloudflare WAF. Plain HTTP
 * clients (axios, got) — even with full browser headers, cookie jars, and a
 * Referer set — are blocked with a 403. Headless Chrome via Puppeteer, with
 * `--disable-blink-features=AutomationControlled` and a spoofed
 * `navigator.webdriver`, gets past that.
 *
 * WHY THE SITEMAP, NOT THE LISTING PAGES:
 * The /new-vehicles/ and /used-vehicles/ search/listing pages were
 * confirmed to serve a fake "no results" page specifically to Puppeteer's
 * requests — independent of headers, client hints, or cookie/session
 * state. VDP pages themselves were confirmed to load fine throughout; the
 * block was only ever on the listing/search widget. The Yoast SEO XML
 * sitemap at /dealer-inspire-inventory/inventory_sitemap is confirmed to
 * list every current VDP URL directly and unblocked, so this version
 * fetches that sitemap and visits each VDP URL directly — it never touches
 * a listing/search page at all.
 *
 * DEDUPE POLICY (read this before touching this file):
 * Every VDP URL discovered is scraped unconditionally. There is NO
 * "skip if already seen" check anywhere inside the scraping loop — that
 * exact pattern previously caused 50 real, unique vehicles to be silently
 * dropped as false-positive duplicates (120 -> 70).
 * The ONLY deduplication in this entire file is one filter pass that runs
 * once, after all scraping has finished, on the completed array. See
 * `main()` near the bottom — search for "THE ONLY DEDUPE PASS".
 *
 * OUTPUT:
 *   docs/inventory.json — raw structured vehicle data
 *   docs/feed.xml        — Meta Commerce Manager Vehicles catalog feed,
 *                          using the <listings><listing> schema (NOT the
 *                          generic <rss><channel><item> Google-base product
 *                          feed format — that schema is silently rejected
 *                          by Commerce Manager for this catalog type with
 *                          "File format isn't supported"). See the comment
 *                          above vehicleToFeedItem() for the full schema
 *                          reference, confirmed against Meta's own
 *                          downloaded XML template and live test uploads.
 * --------------------------------------------------------------------------
 */

'use strict';

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const { XMLValidator } = require('fast-xml-parser');

// ============================================================================
// Config
// ============================================================================

const BASE_URL = 'https://www.fikeschevy.com';
const SITEMAP_URL = `${BASE_URL}/dealer-inspire-inventory/inventory_sitemap`;

const NAV_TIMEOUT_MS = 45000;
const NAV_RETRY_ATTEMPTS = 3;
const REQUEST_DELAY_MS = 1200; // politeness delay between page loads

const PIXEL_ID = '911722818604064';
const DEALER_ADDRESS = {
  street: '771 Military St N',
  city: 'Hamilton',
  state: 'AL',
  zip: '35570',
  country: 'US',
};

const OUTPUT_DIR = path.join(__dirname, 'docs');

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

// Real Chrome 125 sends these client hints headers automatically. A
// manually-set User-Agent string with no matching sec-ch-ua/sec-fetch-*
// headers is a textbook automation fingerprint.
const SEC_CH_UA = '"Chromium";v="125", "Not.A/Brand";v="24", "Google Chrome";v="125"';

const BLOCKED_RESOURCE_TYPES = new Set(['image', 'font', 'media', 'stylesheet']);

// ============================================================================
// VIN / condition extraction from VDP URLs
// ============================================================================

// Confirmed pattern: VIN is the last 17 characters before the trailing slash
// in a VDP URL slug, e.g.
//   /inventory/new-2026-chevrolet-equinox-lt-1GNAXKEX1RZ123456/
const VIN_FROM_URL_RE = /\/inventory\/[^/]+-([A-HJ-NPR-Z0-9]{17})\/?$/i;

function extractVinFromUrl(rawUrl) {
  const clean = rawUrl.split('?')[0].split('#')[0];
  const match = clean.match(VIN_FROM_URL_RE);
  return match ? match[1].toUpperCase() : null;
}

function isVdpUrl(rawUrl) {
  return /\/inventory\//i.test(rawUrl) && extractVinFromUrl(rawUrl) !== null;
}

// VDP slugs are /inventory/{condition}-{year}-{make}-{model}-{trim}-{VIN}/ —
// pull the condition token straight from the URL rather than relying on
// page title text, since the slug format is the more structurally reliable
// of the two confirmed patterns and doesn't require a page load to read.
const CONDITION_FROM_URL_RE = /\/inventory\/(certified-pre-owned|certified|pre-owned|used|new)-/i;

function extractConditionFromUrl(rawUrl) {
  const match = rawUrl.match(CONDITION_FROM_URL_RE);
  if (!match) return null;
  return match[1].toLowerCase() === 'new' ? 'new' : 'used';
}

// ============================================================================
// Title parsing (year / make / model / trim)
// ============================================================================

const CONDITION_PREFIX_RE = /^(certified\s+pre-?owned|pre-?owned|certified|new|used)\s+/i;

// Some GM model names carry a trailing numeric/suffix token that belongs to
// the model, not the trim — e.g. "Silverado 1500", "Silverado 2500HD",
// "Bolt EUV". Fold these into the model when present.
const MODEL_SUFFIX_RE = /^(\d{3,4}(HD)?|EUV|EV|ZR2|ZL1|SS)$/i;

function parseTitle(rawTitle) {
  if (!rawTitle) return { year: null, make: null, model: null, trim: null };

  let title = rawTitle.trim().replace(/\s+/g, ' ');
  title = title.replace(CONDITION_PREFIX_RE, '').trim();

  const parts = title.split(' ').filter(Boolean);
  let idx = 0;

  const year = /^\d{4}$/.test(parts[0] || '') ? parts[idx++] : null;
  const make = parts[idx++] || null;
  let model = parts[idx++] || null;

  if (parts[idx] && MODEL_SUFFIX_RE.test(parts[idx])) {
    model = `${model} ${parts[idx]}`;
    idx += 1;
  }

  const trim = parts.slice(idx).join(' ').trim() || null;

  return { year, make, model, trim };
}

// ============================================================================
// Browser / page setup
// ============================================================================

async function launchBrowser() {
  return puppeteer.launch({
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
  });
}

async function configurePage(page, { isEntryPage = false } = {}) {
  await page.setUserAgent(USER_AGENT);
  await page.setViewport({ width: 1366, height: 900 });
  await page.setExtraHTTPHeaders({
    'accept-language': 'en-US,en;q=0.9',
    referer: `${BASE_URL}/`,
    'cache-control': 'max-age=0',
    // Client hints — real Chrome 125 sends all of these on every navigation
    // request. sec-fetch-site is 'none' only for a true direct/first-party
    // entry (the homepage warmup); every internal navigation after that is
    // 'same-origin', matching how a real browser would report a link click
    // within the same site.
    'sec-ch-ua': SEC_CH_UA,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': isEntryPage ? 'none' : 'same-origin',
    'sec-fetch-user': '?1',
  });

  // Stealth: hide the automation fingerprint that Cloudflare's WAF checks for.
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    window.chrome = window.chrome || { runtime: {} };
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  });

  // Skip heavy assets we don't need — we only read DOM attributes/text/raw
  // response bodies, we never need the actual image/font/css bytes.
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (BLOCKED_RESOURCE_TYPES.has(req.resourceType())) {
      req.abort();
    } else {
      req.continue();
    }
  });
}

async function gotoWithRetry(page, url, attempts = NAV_RETRY_ATTEMPTS) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
      return response;
    } catch (err) {
      lastErr = err;
      console.warn(`    nav attempt ${i + 1}/${attempts} failed for ${url}: ${err.message}`);
      await delay(2000);
    }
  }
  throw lastErr;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// Inventory sitemap — replaces listing-page crawling entirely
// ============================================================================

const LOC_TAG_RE = /<loc>([^<]+)<\/loc>/g;

// Extracts every <loc> entry that looks like a VDP URL, in document order,
// with NO uniqueness filtering. If the same VDP URL is genuinely listed
// twice in the sitemap (e.g. the known duplicate listing case), both
// entries get scraped — exactly like every other URL — and the single
// end-of-run VIN dedupe pass in main() is what collapses that down, same
// as it always has.
function parseSitemapVdpUrls(xmlText) {
  const urls = [];
  let match;
  while ((match = LOC_TAG_RE.exec(xmlText)) !== null) {
    const loc = match[1].trim().replace(/&amp;/g, '&');
    if (isVdpUrl(loc)) {
      urls.push(loc);
    }
  }
  return urls;
}

// Fetches the sitemap's raw XML via a SECOND navigation on the SAME page
// object used for the homepage warmup — not a brand-new page, and not an
// in-page fetch() call. Both of those were tried and both failed:
//
//   - A fresh page navigated straight to the sitemap URL (first version of
//     this function) came back with a valid response and no error, but 0
//     <loc> matches — confirmed against a real browser tab that the actual
//     sitemap is fully populated with 68 URLs, so that response was wrong,
//     not empty-by-design.
//   - An in-page fetch() call to the same URL (second version) was blocked
//     outright with "TypeError: Failed to fetch" before any content came
//     back at all.
//
// Root cause: configurePage() sets sec-fetch-site: 'same-origin' whenever
// isEntryPage is not explicitly true — but the first version of this
// function opened a brand-new page and navigated it straight to the
// sitemap with that header still set to 'same-origin', even though that
// page had never been anywhere yet. A real browser's actual first
// navigation in a new tab sends sec-fetch-site: 'none', not 'same-origin'.
// That mismatch (claiming a same-origin follow-up on a tab with no prior
// navigation) is exactly the kind of automation fingerprint Cloudflare's
// WAF checks for, and is the most likely explanation for silently getting
// served a decoy/empty response instead of the real sitemap.
//
// Fix: don't open a second page at all. Take the SAME page that already
// did the homepage warmup navigation, and navigate IT a second time to the
// sitemap URL. That's a genuine same-origin follow-up navigation in one
// continuous session/tab — which is what the sec-fetch-site: same-origin
// header was already (correctly) claiming, just previously on the wrong
// page. This restores page.goto()/response.text() (fetch() is blocked
// harder, per above) but now with header/reality parity.
async function fetchInventorySitemapUrls(warmedUpPage) {
  console.log(`Fetching inventory sitemap: ${SITEMAP_URL}`);
  const response = await gotoWithRetry(warmedUpPage, SITEMAP_URL);
  const status = response ? response.status() : null;
  const xmlText = await response.text();
  const urls = parseSitemapVdpUrls(xmlText);
  console.log(`  HTTP ${status}, ${xmlText.length} bytes, ${urls.length} VDP URLs found in sitemap`);
  if (urls.length === 0) {
    console.warn(`  Sitemap response preview: ${xmlText.slice(0, 300)}`);
  }
  return urls;
}

// ============================================================================
// VDP scrape — one full vehicle record per URL
// ============================================================================

const LABEL_ALIASES = {
  exterior: 'Exterior',
  interior: 'Interior',
  drivetrain: 'Drivetrain',
  transmission: 'Transmission',
  engine: 'Engine',
  mileage: 'Mileage',
  'fuel type': 'Fuel Type',
  'body style': 'Body Style',
  stock: 'Stock',
  'stock #': 'Stock',
  vin: 'VIN',
};

async function scrapeVdp(browser, url) {
  const page = await browser.newPage();
  await configurePage(page);

  try {
    await gotoWithRetry(page, url);

    // Drivetrain/Body Style/Stock/pricing are present immediately, but
    // Mileage/Exterior/Interior/Transmission/Engine are coming back null —
    // the likely cause is the same one that hit the listing pages: a
    // separate widget (commonly a vAuto/HomeNet-style specs feed on DI
    // templates) populates these specific fields via JS after
    // domcontentloaded fires. Give it a beat to show up before reading
    // body text. If it never shows (genuinely missing data on some older
    // trade-ins, etc.) just proceed — the debug capture below will tell us
    // if that's actually what's happening instead.
    await page
      .waitForFunction(() => /mileage\s*:/i.test(document.body.innerText || ''), { timeout: 8000 })
      .catch(() => {});

    const vin = extractVinFromUrl(url);
    const condition = extractConditionFromUrl(url) || 'used';

    const data = await page.evaluate((vinArg, labelAliases) => {
      function resolveUrl(src) {
        try {
          return new URL(src, document.baseURI).href;
        } catch (e) {
          return src;
        }
      }

      const bodyText = document.body.innerText || '';
      const lines = bodyText
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);

      // ---- Title ----
      const titleEl = document.querySelector('h1');
      const rawTitle = titleEl
        ? titleEl.textContent.trim().replace(/\s+/g, ' ')
        : (document.title || '').trim();

      // ---- Specs ----
      // Confirmed via direct page inspection: labels render alone on their
      // own line, with the value on the very next line — e.g.
      //   Exterior:
      //   Black
      // findLabeledValue looks for a line that IS the label (with or
      // without a trailing colon) and returns the next non-empty line as
      // the value, capped at a sane length so a malformed match can't pull
      // in an unrelated wall of text.
      const MAX_SPEC_VALUE_LENGTH = 120;

      function findLabeledValue(labelText) {
        const escaped = labelText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const labelOnlyRe = new RegExp(`^${escaped}:?\\s*$`, 'i');
        for (let i = 0; i < lines.length; i += 1) {
          if (labelOnlyRe.test(lines[i])) {
            const value = (lines[i + 1] || '').trim();
            if (value && value.length <= MAX_SPEC_VALUE_LENGTH) return value;
          }
        }
        return null;
      }

      const specs = {};
      for (const aliasKey of Object.keys(labelAliases)) {
        const canonical = labelAliases[aliasKey];
        if (canonical in specs) continue; // already found via an earlier alias for this field
        const value = findLabeledValue(aliasKey);
        if (value) specs[canonical] = value;
      }

      // Fallback: same-line "Label: Value" format, in case any field ever
      // renders that way instead of label-then-next-line. Only fills gaps
      // the pass above didn't already find — never overrides it.
      const specLineRe = /^([A-Za-z][A-Za-z .#]{1,30}):\s*(.+)$/;
      for (const line of lines) {
        const m = line.match(specLineRe);
        if (!m) continue;
        const canonical = labelAliases[m[1].trim().toLowerCase()];
        if (canonical && !(canonical in specs)) {
          specs[canonical] = m[2].trim();
        }
      }

      // Debug capture — only fires for fields that are STILL missing after
      // both passes above. For each such field, grab every raw line
      // containing that keyword (even ones neither pass matched) so we can
      // see the real on-page text instead of guessing at another tweak.
      // Stays silent for vehicles that scrape clean.
      const specDebug = {};
      const debugTargets = ['Mileage', 'Exterior', 'Interior', 'Transmission', 'Engine'];
      for (const field of debugTargets) {
        if (!specs[field]) {
          const keyword = field.toLowerCase();
          specDebug[field] = lines.filter((l) => l.toLowerCase().includes(keyword));
        }
      }

      // ---- Pricing ----
      // New: MSRP / Fikes Sales Event (discount) / Net Price (3-line)
      // Used: Fikes Price (single line, no breakdown)
      let msrp = null;
      let salesEvent = null;
      let netPrice = null;
      let fikesPrice = null;
      for (const line of lines) {
        let m;
        if ((m = line.match(/^MSRP\s*\$?\s*([\d,]+)/i))) {
          msrp = m[1].replace(/,/g, '');
        } else if ((m = line.match(/^Fikes Sales Event\s*-?\$?\s*([\d,]+)/i))) {
          salesEvent = m[1].replace(/,/g, '');
        } else if ((m = line.match(/^Net Price\s*\$?\s*([\d,]+)/i))) {
          netPrice = m[1].replace(/,/g, '');
        } else if ((m = line.match(/^Fikes Price\s*\$?\s*([\d,]+)/i))) {
          fikesPrice = m[1].replace(/,/g, '');
        }
      }

      // ---- Images ----
      // VIN-in-URL is the ONLY matching signal. This is deliberate: a
      // hostname-only fallback (matching any image on the page from a
      // known CDN, e.g. vini.gm.com/realimages) was tested and confirmed
      // to pull in unrelated vehicles' photos whenever a same-CDN "Similar
      // Vehicles" widget was present on the page and this vehicle had no
      // real photos of its own — exactly the contamination bug this
      // replaced. A vehicle with no VIN-matched images now correctly
      // returns an empty array rather than risk showing the wrong car.
      const rawImgSrcs = Array.from(document.querySelectorAll('img'))
        .map((img) => {
          const raw =
            img.getAttribute('src') ||
            img.getAttribute('data-src') ||
            img.getAttribute('data-lazy-src') ||
            '';
          return raw ? resolveUrl(raw) : '';
        })
        .filter(Boolean);

      const srcsetUrls = Array.from(document.querySelectorAll('source, img'))
        .map((el) => el.getAttribute('srcset') || '')
        .filter(Boolean)
        .flatMap((ss) => ss.split(',').map((part) => resolveUrl(part.trim().split(' ')[0])));

      const allImgUrls = Array.from(new Set([...rawImgSrcs, ...srcsetUrls]));
      const vinUpper = (vinArg || '').toUpperCase();

      const images = allImgUrls.filter((src) => vinUpper && src.toUpperCase().includes(vinUpper));

      // ---- Days in stock ----
      // Sourced from a hidden Custom HTML block added to the DI Lightning
      // VDP "Detail Components" template (2026-07-06): the block renders
      // `{days_in_stock}` — DI's own merge variable, backed by DCS/D2C2's
      // real "Age" field — inside a <span class="days-hidden"> that's
      // hidden from customers via a `.days-hidden { display: none; }` rule
      // in the site's Customize Styles CSS editor (an inline `style=""`
      // attribute on the span itself was tried first and got silently
      // stripped by DI's WYSIWYG sanitizer, which is why this uses a class
      // + separate stylesheet rule instead). Every VDP carries this same
      // block, so no per-page-type branching is needed here. If the
      // element is ever missing (block removed, class renamed, one-off DI
      // caching lag on a brand-new listing), this just returns null and
      // the vehicle still scrapes fine minus this one field.
      const daysInStockEl = document.querySelector('.days-hidden');
      const daysInStockRaw = daysInStockEl ? daysInStockEl.textContent.trim() : null;
      const daysInStock =
        daysInStockRaw && /^\d+$/.test(daysInStockRaw) ? parseInt(daysInStockRaw, 10) : null;

      return {
        rawTitle,
        specs,
        specDebug,
        pricing: { msrp, salesEvent, netPrice, fikesPrice },
        images,
        daysInStock,
      };
    }, vin, LABEL_ALIASES);

    if (data.specDebug && Object.keys(data.specDebug).length > 0) {
      console.log(`  Missing spec fields for VIN ${vin}: ${Object.keys(data.specDebug).join(', ')}`);
      try {
        fs.writeFileSync(`debug-specs-${vin || 'unknown'}.json`, JSON.stringify(data.specDebug, null, 2));
      } catch (err) {
        console.warn(`  Failed to write spec debug for ${vin}: ${err.message}`);
      }
    }

    if (data.images.length === 0) {
      console.log(`  WARNING: 0 VIN-matched images found for VIN ${vin} — will be excluded from feed.xml`);
    }

    // Convert the scraped "days in stock" count into an actual calendar
    // date Meta can use for the "Days on lot" attribute/filter in Commerce
    // Manager product sets. Computed as (today - daysInStock), formatted
    // YYYY-MM-DD. This is necessarily an approximation re-derived on every
    // scraper run — it will drift by however many days pass between runs
    // relative to DCS/D2C2's own internal "Age" counter, since we don't
    // have a way to pin the *original* date, only "days in stock as of
    // right now". For a twice-daily scrape schedule this drift is at most
    // ~12 hours, which is immaterial for a "30+ days" style threshold.
    let dateFirstOnLot = null;
    if (data.daysInStock != null) {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - data.daysInStock);
      dateFirstOnLot = d.toISOString().slice(0, 10);
    }

    const { year, make, model, trim } = parseTitle(data.rawTitle);

    const mileageRaw = data.specs.Mileage ? data.specs.Mileage.replace(/[^\d]/g, '') : null;

    const vehicle = {
      vin,
      condition,
      year,
      make,
      model,
      trim,
      title: data.rawTitle,
      url,
      exterior_color: data.specs.Exterior || null,
      interior_color: data.specs.Interior || null,
      drivetrain: data.specs.Drivetrain || null,
      transmission: data.specs.Transmission || null,
      engine: data.specs.Engine || null,
      mileage: mileageRaw ? parseInt(mileageRaw, 10) : null,
      fuel_type: data.specs['Fuel Type'] || null,
      body_style: data.specs['Body Style'] || null,
      stock_number: data.specs.Stock || null,
      days_in_stock: data.daysInStock,
      date_first_on_lot: dateFirstOnLot,
      pricing: {
        msrp: data.pricing.msrp ? parseInt(data.pricing.msrp, 10) : null,
        sales_event_discount: data.pricing.salesEvent ? parseInt(data.pricing.salesEvent, 10) : null,
        net_price: data.pricing.netPrice ? parseInt(data.pricing.netPrice, 10) : null,
        fikes_price: data.pricing.fikesPrice ? parseInt(data.pricing.fikesPrice, 10) : null,
      },
      price:
        condition === 'new'
          ? data.pricing.netPrice
            ? parseInt(data.pricing.netPrice, 10)
            : data.pricing.msrp
            ? parseInt(data.pricing.msrp, 10)
            : null
          : data.pricing.fikesPrice
          ? parseInt(data.pricing.fikesPrice, 10)
          : null,
      images: data.images,
    };

    return vehicle;
  } finally {
    await page.close();
  }
}

// ============================================================================
// Output: docs/inventory.json + docs/feed.xml
// ============================================================================

function escapeXml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildDescription(v) {
  const bits = [];
  if (v.condition === 'used' && v.mileage != null) bits.push(`${v.mileage.toLocaleString()} miles`);
  if (v.exterior_color) bits.push(`${v.exterior_color} exterior`);
  if (v.interior_color) bits.push(`${v.interior_color} interior`);
  if (v.transmission) bits.push(v.transmission);
  if (v.engine) bits.push(v.engine);
  return bits.length ? bits.join(', ') : v.title;
}

// ----------------------------------------------------------------------------
// body_style normalization
// ----------------------------------------------------------------------------
// Meta's Vehicles catalog schema requires body_style on every listing AND
// only accepts a fixed enum of values — raw dealership text like "Sport
// Utility Vehicle" or "Crew Cab Pickup" is rejected outright as an
// "Unsupported value", and a missing body_style is rejected as "Required
// value missing". Confirmed via live Commerce Manager test uploads on
// 2026-06-20: SEDAN, SUV, VAN, and PICKUP are valid. No other values have
// been tested yet — if a vehicle doesn't match any pattern below, it falls
// back to SUV (logged so it's visible, not silently guessed) rather than
// emitting an untested enum value that could fail the whole item. If a
// fundamentally different vehicle type joins inventory (e.g. a true coupe
// or convertible trade-in), test the candidate value with a 1-vehicle
// manual upload in Commerce Manager BEFORE adding it here.
const SUV_MODEL_HINTS = [
  'equinox', 'trailblazer', 'trax', 'traverse', 'suburban', 'tahoe', 'blazer',
  'xt4', 'xt5', '4runner', 'rav4', 'rogue', 'santa fe', 'cr-v', 'venza', 'glb', 'x3',
];
const PICKUP_MODEL_HINTS = ['silverado', 'sierra', 'f-150', 'tacoma', 'colorado'];
const VAN_MODEL_HINTS = ['sprinter', 'express', 'savana'];

function normalizeBodyStyle(v) {
  const raw = (v.body_style || '').toLowerCase();
  const model = (v.model || '').toLowerCase();
  const title = (v.title || '').toLowerCase();

  if (/sedan/.test(raw)) return 'SEDAN';
  if (/(sport utility|suv|activity vehicle)/.test(raw)) return 'SUV';
  if (/(cargo van|van)/.test(raw)) return 'VAN';
  if (/(pickup|cab)/.test(raw)) return 'PICKUP';

  if (VAN_MODEL_HINTS.some((m) => model.includes(m))) return 'VAN';
  if (PICKUP_MODEL_HINTS.some((m) => model.includes(m))) return 'PICKUP';
  if (SUV_MODEL_HINTS.some((m) => model.includes(m))) return 'SUV';

  if (/sedan/.test(title)) return 'SEDAN';
  if (/suv/.test(title)) return 'SUV';
  if (/(crew cab|pickup|truck)/.test(title)) return 'PICKUP';
  if (/van/.test(title)) return 'VAN';

  console.warn(
    `  No body_style match for VIN ${v.vin} (model="${v.model}", raw body_style="${v.body_style}") — defaulting to SUV`
  );
  return 'SUV';
}

// ----------------------------------------------------------------------------
// Feed item — Meta Vehicles catalog "listings/listing" schema
// ----------------------------------------------------------------------------
// IMPORTANT: this is NOT the generic Google-base RSS product feed format
// (<rss><channel><item> with g:-prefixed tags). That format is what every
// non-automotive Commerce Manager catalog uses, and it's what this file
// used to emit — but Meta's Vehicles-type catalog (the one this dealership
// catalog actually is) silently rejects it at the WHOLE-FILE level with
// "File format isn't supported", because the root structure itself isn't
// recognized as a valid vehicle listings file, no matter how clean the XML
// inside it is.
//
// Confirmed correct schema (verified against Meta's own downloaded XML
// template for a Vehicles catalog, AND against live Commerce Manager test
// uploads on 2026-06-20):
//   - root element: <listings>, each vehicle: <listing> (NOT <rss>/<item>)
//   - NO g: namespace, NO g: prefix on any tag
//   - vehicle page URL field is <url>, NOT <link>
//   - <address format="simple"><component name="addr1">...</component>...
//     NOT <address><addr1>...</addr1>...
//   - <mileage><unit>.../<value>... NOT <mileage><g:value>/<g:unit>
//   - each image is its own <image><url>...</url></image> block, NOT flat
//     image_link / additional_image_link tags
function vehicleToFeedItem(v) {
  const price = v.price != null ? `${Number(v.price).toFixed(2)} USD` : '';
  const images = v.images || [];
  const bodyStyle = normalizeBodyStyle(v);

  const imageBlocks = images
    .map((img) => `    <image>\n      <url>${escapeXml(img)}</url>\n    </image>`)
    .join('\n');

  // Optional — Meta uses this to power the "Days on lot" attribute/filter
  // in Commerce Manager product sets. Only emitted when we actually got a
  // days_in_stock value off the VDP; omitting the tag entirely for a
  // vehicle we couldn't read it for is safer than emitting an empty/wrong
  // date, since Meta already tolerates this field being absent (it's not
  // one of the required fields for a valid listing).
  const dateFirstOnLotTag = v.date_first_on_lot
    ? `\n    <date_first_on_lot>${escapeXml(v.date_first_on_lot)}</date_first_on_lot>`
    : '';

  return `  <listing>
    <vehicle_id>${escapeXml(v.vin)}</vehicle_id>
    <description>${escapeXml(buildDescription(v))}</description>
    <url>${escapeXml(v.url)}</url>
    <title>${escapeXml(v.title)}</title>
    <body_style>${bodyStyle}</body_style>
    <price>${price}</price>
    <address format="simple">
      <component name="addr1">${escapeXml(DEALER_ADDRESS.street)}</component>
      <component name="city">${escapeXml(DEALER_ADDRESS.city)}</component>
      <component name="region">${escapeXml(DEALER_ADDRESS.state)}</component>
      <component name="postal_code">${escapeXml(DEALER_ADDRESS.zip)}</component>
      <component name="country">${escapeXml(DEALER_ADDRESS.country)}</component>
    </address>
    <make>${escapeXml(v.make)}</make>
    <model>${escapeXml(v.model)}</model>
    <year>${escapeXml(v.year)}</year>
    <vin>${escapeXml(v.vin)}</vin>
    <state_of_vehicle>${v.condition === 'new' ? 'NEW' : 'USED'}</state_of_vehicle>
    <mileage>
      <unit>MI</unit>
      <value>${v.mileage != null ? v.mileage : 0}</value>
    </mileage>
    <transmission>${escapeXml(v.transmission)}</transmission>
    <drivetrain>${escapeXml(v.drivetrain)}</drivetrain>
    <exterior_color>${escapeXml(v.exterior_color)}</exterior_color>
    <interior_color>${escapeXml(v.interior_color)}</interior_color>
    <vehicle_type>car_truck</vehicle_type>${dateFirstOnLotTag}
${imageBlocks}
  </listing>`;
}

function writeOutputs(vehicles) {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const noImageVehicles = vehicles.filter((v) => !v.images || v.images.length === 0);
  if (noImageVehicles.length > 0) {
    console.log(
      `${noImageVehicles.length} vehicle(s) have 0 images and will be EXCLUDED from feed.xml ` +
        '(still present in inventory.json for visibility): ' +
        noImageVehicles.map((v) => v.vin).join(', ')
    );
  }

  const noDaysInStockVehicles = vehicles.filter((v) => v.days_in_stock == null);
  if (noDaysInStockVehicles.length > 0) {
    console.log(
      `${noDaysInStockVehicles.length} vehicle(s) missing days_in_stock (the hidden ` +
        '.days-hidden DI block wasn\'t found on their VDP — check for a stale ' +
        'Cloudflare cache on that specific page before assuming a real problem): ' +
        noDaysInStockVehicles.map((v) => v.vin).join(', ')
    );
  }

  // ---- inventory.json ----
  // Keeps every scraped vehicle, including zero-image ones, so nothing is
  // silently lost — this is the full audit trail.
  const jsonOut = {
    generated_at: new Date().toISOString(),
    pixel_id: PIXEL_ID,
    dealer_address: DEALER_ADDRESS,
    total_vehicles: vehicles.length,
    new_count: vehicles.filter((v) => v.condition === 'new').length,
    used_count: vehicles.filter((v) => v.condition === 'used').length,
    no_image_count: noImageVehicles.length,
    no_image_vins: noImageVehicles.map((v) => v.vin),
    no_days_in_stock_count: noDaysInStockVehicles.length,
    no_days_in_stock_vins: noDaysInStockVehicles.map((v) => v.vin),
    vehicles,
  };
  fs.writeFileSync(path.join(OUTPUT_DIR, 'inventory.json'), JSON.stringify(jsonOut, null, 2));

  // ---- feed.xml ----
  // Meta requires at least one valid image per catalog item — a zero-image
  // item would fail feed validation anyway, so exclude those vehicles here
  // rather than submitting a known-bad item. They're still fully visible
  // in inventory.json above for follow-up (e.g. asking the dealership for
  // real photos on these specific VINs).
  const feedVehicles = vehicles.filter((v) => v.images && v.images.length > 0);
  const items = feedVehicles.map(vehicleToFeedItem).join('\n');
  // Root structure is <listings><listing>...</listing></listings> — this is
  // Meta's Vehicles catalog schema, confirmed against their own downloaded
  // template and against live Commerce Manager test uploads on 2026-06-20.
  // It is NOT <rss><channel><item>; see the comment above vehicleToFeedItem
  // for the full explanation. Pixel association lives in Commerce Manager
  // (Catalog > Settings > Event Sources), not in the feed file itself, so
  // pixel_id is documented here only as a comment, not emitted as a tag.
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!-- Fikes Vehicles — Meta Commerce Manager automotive inventory feed -->
<!-- Pixel ID ${PIXEL_ID} is associated with this catalog via Commerce -->
<!-- Manager > Settings > Event Sources, not via this feed file. -->
<!-- ${noImageVehicles.length} vehicle(s) excluded from this feed for having -->
<!-- 0 real images (see inventory.json no_image_vins for the list). -->
<listings>
  <title>Fikes Vehicles</title>
${items}
</listings>
`;
  fs.writeFileSync(path.join(OUTPUT_DIR, 'feed.xml'), xml);

  console.log(
    `Wrote ${vehicles.length} vehicles -> ${path.join(OUTPUT_DIR, 'inventory.json')} ` +
      `and ${feedVehicles.length} vehicles -> ${path.join(OUTPUT_DIR, 'feed.xml')} ` +
      `(${noImageVehicles.length} excluded from feed for 0 images)`
  );
}

// Validates the feed.xml actually written to disk (not the in-memory
// string). Throws on failure; the caller in main() lets that propagate up
// to the top-level catch, which sets a non-zero exit code — required so an
// unattended GitHub Actions run actually fails the job instead of
// committing a broken feed.xml silently.
function validateFeedXml(feedPath) {
  const xml = fs.readFileSync(feedPath, 'utf8');

  // General well-formedness: tag balance, attribute syntax, declaration,
  // etc. Confirmed via direct testing that this does NOT catch an illegal
  // "--" inside a comment's content (fast-xml-parser treats comment bodies
  // as opaque and doesn't check that specific spec rule), so that case is
  // checked explicitly below rather than assumed to be covered here.
  const result = XMLValidator.validate(xml, { allowBooleanAttributes: true });
  if (result !== true) {
    const { code, msg, line, col } = result.err;
    throw new Error(`feed.xml failed XML validation: [${code}] ${msg} (line ${line}, col ${col})`);
  }

  // Explicit check for the exact bug class that caused this issue: XML
  // comments may not contain the literal two-character sequence "--"
  // anywhere in their content, not just at the closing delimiter.
  const commentRe = /<!--([\s\S]*?)-->/g;
  const offenders = [];
  let match;
  while ((match = commentRe.exec(xml)) !== null) {
    if (match[1].includes('--')) {
      offenders.push(match[1].trim());
    }
  }
  if (offenders.length > 0) {
    throw new Error(
      `feed.xml has ${offenders.length} XML comment(s) containing an illegal "--" sequence: ${offenders.join(' | ')}`
    );
  }

  // Explicit guard for the root-schema regression that caused this issue in
  // the first place: an <rss>/<item> (generic product feed) root is
  // syntactically valid XML but is the WRONG schema for a Vehicles catalog
  // and gets silently rejected by Commerce Manager as "File format isn't
  // supported" — a failure mode the two checks above can't catch, since the
  // file is perfectly well-formed XML. Fail loudly here instead.
  const stripped = xml
    .replace(/<\?xml[\s\S]*?\?>/, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
  if (!/^<listings[\s>]/.test(stripped)) {
    throw new Error(
      'feed.xml root element is not <listings> — this is required for Meta\'s Vehicles catalog schema. ' +
        'If you see <rss> here, the feed has regressed to the generic product-feed format, which Commerce ' +
        'Manager rejects entirely for this catalog type.'
    );
  }

  console.log(`feed.xml passed XML validation (${feedPath})`);
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const browser = await launchBrowser();

  // No "seen VIN" check is allowed anywhere near this array while it's
  // being built. Every VDP URL gets pushed in, full stop.
  const allVehicles = [];

  try {
    // Cloudflare warmup: visit the homepage first to establish a normal
    // browsing session before requesting the sitemap or any VDP page.
    // Going straight to a deep page as the very first request of the
    // session trips the WAF challenge and hangs until nav timeout —
    // confirmed by the homepage-first approach working previously. This is
    // a separate concern from the listing-page "no results" issue, so it
    // stays in place even though listing pages are no longer visited.
 const warmupPage = await browser.newPage();
    await configurePage(warmupPage, { isEntryPage: true });
    console.log(`Warming up session: ${BASE_URL}`);
    await gotoWithRetry(warmupPage, BASE_URL);
    await delay(REQUEST_DELAY_MS);
    const vdpUrls = await fetchInventorySitemapUrls(warmupPage);
    await warmupPage.close();

    for (const url of vdpUrls) {
      console.log(`  scraping: ${url}`);
      try {
        const vehicle = await scrapeVdp(browser, url);
        allVehicles.push(vehicle); // unconditional — no skip/seen logic
      } catch (err) {
        console.warn(`  FAILED to scrape ${url}: ${err.message}`);
      }
      await delay(REQUEST_DELAY_MS);
    }
  } finally {
    await browser.close();
  }

  console.log(`Scraped ${allVehicles.length} total VDP records (pre-dedupe).`);

  // ==========================================================================
  // THE ONLY DEDUPE PASS IN THIS FILE.
  // Runs exactly once, after all scraping is fully complete, on the
  // finished array. Nothing upstream of this point ever checks "have I
  // seen this VIN before" — see file header for why.
  // ==========================================================================
  const seen = new Set();
  const finalVehicles = allVehicles.filter((v) => {
    if (seen.has(v.vin)) return false;
    seen.add(v.vin);
    return true;
  });

  console.log(`Final vehicle count after one-time VIN dedupe: ${finalVehicles.length}`);

  writeOutputs(finalVehicles);

  // Validation step — runs unconditionally after the file is on disk,
  // local or in CI. Throws on failure, which propagates to the
  // main().catch() below and sets process.exitCode = 1, so an unattended
  // GitHub Actions run is marked failed rather than committing a broken
  // feed.xml silently.
  validateFeedXml(path.join(OUTPUT_DIR, 'feed.xml'));
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exitCode = 1;
  });
}

module.exports = {
  extractVinFromUrl,
  extractConditionFromUrl,
  parseTitle,
  isVdpUrl,
  parseSitemapVdpUrls,
  normalizeBodyStyle,
  vehicleToFeedItem,
  writeOutputs,
  validateFeedXml,
};
