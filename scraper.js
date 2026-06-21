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
 *   docs/feed.xml        — Meta Commerce Manager automotive XML feed
 * --------------------------------------------------------------------------
 */

'use strict';

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

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

async function fetchInventorySitemapUrls(browser) {
  const page = await browser.newPage();
  await configurePage(page);

  try {
    console.log(`Fetching inventory sitemap: ${SITEMAP_URL}`);
    const response = await gotoWithRetry(page, SITEMAP_URL);
    const xmlText = await response.text();
    const urls = parseSitemapVdpUrls(xmlText);
    console.log(`  ${urls.length} VDP URLs found in sitemap`);
    return urls;
  } finally {
    await page.close();
  }
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
      // Capture any image whose src contains the VIN (covers the GM CDN
      // pattern vini.gm.com/realimages/{VIN}/{hash}.jpeg) PLUS known
      // non-GM CDNs used for used/trade-in vehicles (e.g. Saabs etc. served
      // from vehicle-images.carscommerce.inc), since not every used vehicle
      // is on GM's CDN.
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

      const images = allImgUrls.filter((src) => {
        const upper = src.toUpperCase();
        if (vinUpper && upper.includes(vinUpper)) return true;
        if (/vini\.gm\.com\/realimages/i.test(src)) return true;
        if (/vehicle-images\.carscommerce\.inc/i.test(src)) return true;
        return false;
      });

      return {
        rawTitle,
        specs,
        specDebug,
        pricing: { msrp, salesEvent, netPrice, fikesPrice },
        images,
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

function vehicleToFeedItem(v) {
  const price = v.price != null ? `${Number(v.price).toFixed(2)} USD` : '';
  const images = v.images || [];
  const primaryImage = images[0] || '';
  const additionalImages = images.slice(1, 10);

  return `  <item>
    <g:id>${escapeXml(v.vin)}</g:id>
    <g:vehicle_id>${escapeXml(v.vin)}</g:vehicle_id>
    <g:title>${escapeXml(v.title)}</g:title>
    <g:description>${escapeXml(buildDescription(v))}</g:description>
    <g:link>${escapeXml(v.url)}</g:link>
    <g:image_link>${escapeXml(primaryImage)}</g:image_link>
${additionalImages.map((img) => `    <g:additional_image_link>${escapeXml(img)}</g:additional_image_link>`).join('\n')}
    <g:condition>${v.condition === 'new' ? 'new' : 'used'}</g:condition>
    <g:availability>in stock</g:availability>
    <g:price>${price}</g:price>
    <g:make>${escapeXml(v.make)}</g:make>
    <g:model>${escapeXml(v.model)}</g:model>
    <g:year>${escapeXml(v.year)}</g:year>
    <g:vin>${escapeXml(v.vin)}</g:vin>
    <g:mileage>
      <g:value>${v.mileage != null ? v.mileage : 0}</g:value>
      <g:unit>MI</g:unit>
    </g:mileage>
    <g:transmission>${escapeXml(v.transmission)}</g:transmission>
    <g:drivetrain>${escapeXml(v.drivetrain)}</g:drivetrain>
    <g:fuel_type>${escapeXml(v.fuel_type)}</g:fuel_type>
    <g:exterior_color>${escapeXml(v.exterior_color)}</g:exterior_color>
    <g:interior_color>${escapeXml(v.interior_color)}</g:interior_color>
    <g:body_style>${escapeXml(v.body_style)}</g:body_style>
    <g:vehicle_type>car_truck</g:vehicle_type>
    <g:state_of_vehicle>${v.condition === 'new' ? 'NEW' : 'USED'}</g:state_of_vehicle>
    <g:address>
      <g:addr1>${escapeXml(DEALER_ADDRESS.street)}</g:addr1>
      <g:city>${escapeXml(DEALER_ADDRESS.city)}</g:city>
      <g:region>${escapeXml(DEALER_ADDRESS.state)}</g:region>
      <g:postal_code>${escapeXml(DEALER_ADDRESS.zip)}</g:postal_code>
      <g:country>${escapeXml(DEALER_ADDRESS.country)}</g:country>
    </g:address>
  </item>`;
}

function writeOutputs(vehicles) {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // ---- inventory.json ----
  const jsonOut = {
    generated_at: new Date().toISOString(),
    pixel_id: PIXEL_ID,
    dealer_address: DEALER_ADDRESS,
    total_vehicles: vehicles.length,
    new_count: vehicles.filter((v) => v.condition === 'new').length,
    used_count: vehicles.filter((v) => v.condition === 'used').length,
    vehicles,
  };
  fs.writeFileSync(path.join(OUTPUT_DIR, 'inventory.json'), JSON.stringify(jsonOut, null, 2));

  // ---- feed.xml ----
  const items = vehicles.map(vehicleToFeedItem).join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!-- Fikes Vehicles -- Meta Commerce Manager automotive inventory feed -->
<!-- Pixel ID ${PIXEL_ID} is associated with this catalog in Commerce -->
<!-- Manager > Settings > Event Sources (Meta does not read pixel binding -->
<!-- from the feed file itself); included below as <g:pixel_id> for -->
<!-- reference/record-keeping only. -->
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
<channel>
  <title>Fikes Vehicles</title>
  <link>${BASE_URL}</link>
  <description>Fikes Chevrolet live vehicle inventory feed for Facebook/Instagram Commerce Manager</description>
  <g:pixel_id>${PIXEL_ID}</g:pixel_id>
${items}
</channel>
</rss>
`;
  fs.writeFileSync(path.join(OUTPUT_DIR, 'feed.xml'), xml);

  console.log(
    `Wrote ${vehicles.length} vehicles -> ${path.join(OUTPUT_DIR, 'inventory.json')} and ${path.join(
      OUTPUT_DIR,
      'feed.xml'
    )}`
  );
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
    await warmupPage.close();

    const vdpUrls = await fetchInventorySitemapUrls(browser);

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
};
