// Multi-carrier tracking API server
//
// This server exposes endpoints for tracking shipments across several carriers
// without relying on official APIs. It uses Playwright to automate
// interactions with public tracking pages. Each carrier implementation is
// best-effort: selectors and heuristics may need adjustments if the
// providers change their websites.
//
// To run the server locally:
//   npm install
//   npm run dev
//
// The server will be available at http://localhost:3000 and the static
// frontend UI at /frontend/index.html.

import express from 'express';
import { chromium } from 'playwright';

const app = express();
const port = process.env.PORT || 3000;

// Simple in-memory cache to reduce repeated scraping.
// Entries expire after a fixed TTL.
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const cache = new Map();

/**
 * Get a cached result if available and not expired.
 * @param {string} key
 * @returns {object|null}
 */
function getFromCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  const now = Date.now();
  if (now < entry.expires) return entry.value;
  cache.delete(key);
  return null;
}

/**
 * Set a value in the cache.
 * @param {string} key
 * @param {object} value
 */
function setInCache(key, value) {
  const expires = Date.now() + CACHE_TTL_MS;
  cache.set(key, { value, expires });
}

/**
 * Utility to extract date-like strings from a text body.
 * Supports formats like '26 August 2025', '26 Ago 2025', etc.
 * @param {string} text
 * @returns {string|null}
 */
function extractDate(text) {
  // Match dates in formats with day + word month + year. Month names in
  // English and Spanish.
  const months = [
    'January','February','March','April','May','June','July','August','September','October','November','December',
    'Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre',
    'Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec',
    'Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'
  ];
  const monthRegex = months.join('|');
  const dateRegex = new RegExp(`\b(\d{1,2})\s+(${monthRegex})\s+(\d{4})\b`, 'i');
  const match = text.match(dateRegex);
  return match ? match[0].trim() : null;
}

/**
 * Utility to extract a status from a text body. Looks for common status
 * keywords in English and Spanish.
 * @param {string} text
 * @returns {string|null}
 */
function extractStatus(text) {
  const statuses = [
    'Delivered', 'Out for delivery', 'In Transit', 'In transit', 'Shipped', 'Shipment information received',
    'Entregado', 'En reparto', 'En tránsito', 'En transito', 'En Camino', 'Recibido', 'Despachado', 'En camino'
  ];
  for (const status of statuses) {
    const regex = new RegExp(status, 'i');
    if (regex.test(text)) return status;
  }
  return null;
}

/**
 * Generic scraper wrapper. Launches a browser, runs a callback, and ensures
 * proper teardown. The callback receives the Playwright page instance.
 * @param {function(page: import('playwright').Page): Promise<object>} fn
 */
async function withBrowser(fn) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    const result = await fn(page);
    await browser.close();
    return result;
  } catch (err) {
    await browser.close();
    throw err;
  }
}

/**
 * Scrape tracking details from DHL.
 * @param {string} trackingNumber
 */
async function scrapeDHL(trackingNumber) {
  return withBrowser(async (page) => {
    await page.goto('https://www.dhl.com/mx-es/home/rastreo.html', { waitUntil: 'domcontentloaded' });
    // Accept cookies if present
    const acceptBtn = await page.$('button[aria-label="accept functional cookies"]');
    if (acceptBtn) await acceptBtn.click().catch(() => {});

    // Find and fill the tracking input. DHL's page uses input[name="trackingNumber"] or similar.
    const inputSelector = 'input[type="text"]';
    await page.fill(inputSelector, trackingNumber);
    // Press enter to submit
    await page.keyboard.press('Enter');
    // Wait for potential result container to appear
    await page.waitForTimeout(5000);
    const bodyText = await page.textContent('body');
    const latestDate = extractDate(bodyText || '');
    const latestStatus = extractStatus(bodyText || '') || 'Unknown';
    return { latest_status: latestStatus, latest_date: latestDate };
  });
}

/**
 * Scrape tracking details from FedEx.
 * @param {string} trackingNumber
 */
async function scrapeFedEx(trackingNumber) {
  return withBrowser(async (page) => {
    await page.goto('https://www.fedex.com/es-mx/tracking.html', { waitUntil: 'domcontentloaded' });
    // FedEx tracking field may have id or name like trackingnumber.
    const inputSelector = 'input[id*="tracking"]';
    await page.fill(inputSelector, trackingNumber);
    await page.keyboard.press('Enter');
    // Wait a bit for results to load. FedEx uses dynamic loading.
    await page.waitForTimeout(8000);
    const bodyText = await page.textContent('body');
    const latestDate = extractDate(bodyText || '');
    const latestStatus = extractStatus(bodyText || '') || 'Unknown';
    return { latest_status: latestStatus, latest_date: latestDate };
  });
}

/**
 * Scrape tracking details from UPS.
 * @param {string} trackingNumber
 */
async function scrapeUPS(trackingNumber) {
  return withBrowser(async (page) => {
    await page.goto('https://es-us.ups.com/track?loc=es_US&requester=ST/', { waitUntil: 'domcontentloaded' });
    // Accept cookies if necessary.
    const cookieButton = await page.$('button#onetrust-accept-btn-handler');
    if (cookieButton) await cookieButton.click().catch(() => {});
    // UPS uses input[name="trackNums"] or similar.
    const inputSelector = 'input[id*="stApp_trackingNumber"]';
    await page.fill(inputSelector, trackingNumber);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(7000);
    const bodyText = await page.textContent('body');
    const latestDate = extractDate(bodyText || '');
    const latestStatus = extractStatus(bodyText || '') || 'Unknown';
    return { latest_status: latestStatus, latest_date: latestDate };
  });
}

/**
 * Scrape tracking details from Delta Cargo.
 * @param {string} trackingNumber
 */
async function scrapeDelta(trackingNumber) {
  return withBrowser(async (page) => {
    await page.goto('https://www.deltacargo.com/Cargo/trackShipment', { waitUntil: 'domcontentloaded' });
    // Accept cookies or prompts if present
    const cookie = await page.$('button[aria-label="Accept"]');
    if (cookie) await cookie.click().catch(() => {});
    // Normalize tracking number: allow dashes removed
    const normalized = trackingNumber.replace(/[^A-Za-z0-9]/g, '');
    // Input fields for AWB number may be multiple (3-digit prefix and 8-digit number). Try to detect.
    const awbPrefix = normalized.slice(0, 3);
    const awbNumber = normalized.slice(3);
    const prefixSelector = 'input[name*="shipperPrefix"]';
    const numberSelector = 'input[name*="masterAirwayBill"]';
    const prefixEl = await page.$(prefixSelector);
    const numberEl = await page.$(numberSelector);
    if (prefixEl && numberEl) {
      await prefixEl.fill(awbPrefix);
      await numberEl.fill(awbNumber);
    } else {
      // Fallback: single input field
      const single = await page.$('input[type="text"]');
      if (single) await single.fill(trackingNumber);
    }
    // Submit by pressing enter
    await page.keyboard.press('Enter');
    await page.waitForTimeout(7000);
    const bodyText = await page.textContent('body');
    const latestDate = extractDate(bodyText || '');
    const latestStatus = extractStatus(bodyText || '') || 'Unknown';
    return { latest_status: latestStatus, latest_date: latestDate };
  });
}

/**
 * Scrape tracking details from Expeditors. Expeditors has regional portals,
 * so this function serves as a placeholder and may need adjustment.
 * @param {string} trackingNumber
 */
async function scrapeExpeditors(trackingNumber) {
  return withBrowser(async (page) => {
    // This is a placeholder; you may need to update the URL to match your
    // Expeditors portal. Many Expeditors customers track via
    // https://exp.oceanexp.com/ or similar. Adjust selectors accordingly.
    await page.goto('https://www.expeditors.com/tracking', { waitUntil: 'domcontentloaded' });
    // Attempt to find a generic input field
    const input = await page.$('input[type="text"]');
    if (input) {
      await input.fill(trackingNumber);
      await page.keyboard.press('Enter');
    }
    await page.waitForTimeout(7000);
    const bodyText = await page.textContent('body');
    const latestDate = extractDate(bodyText || '');
    const latestStatus = extractStatus(bodyText || '') || 'Unknown';
    return { latest_status: latestStatus, latest_date: latestDate };
  });
}

// Mapping of carrier id to scraper function
const scrapers = {
  dhl: scrapeDHL,
  fedex: scrapeFedEx,
  ups: scrapeUPS,
  delta: scrapeDelta,
  expeditors: scrapeExpeditors
};

// Endpoint: GET /track/:carrier?number=XYZ
app.get('/track/:carrier', async (req, res) => {
  const { carrier } = req.params;
  const trackingNumber = (req.query.number || '').toString().trim();
  if (!scrapers[carrier]) {
    return res.status(404).json({ error: `Unsupported carrier '${carrier}'` });
  }
  if (!trackingNumber) {
    return res.status(400).json({ error: 'Missing "number" query parameter' });
  }
  const cacheKey = `${carrier}:${trackingNumber}`;
  const cached = getFromCache(cacheKey);
  if (cached) {
    return res.json({ carrier, trackingNumber, ...cached, cached: true });
  }
  try {
    const result = await scrapers[carrier](trackingNumber);
    setInCache(cacheKey, result);
    res.json({ carrier, trackingNumber, ...result, cached: false });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Tracking failed' });
  }
});

// Serve static frontend from the "frontend" directory
app.use('/frontend', express.static('frontend'));

// Redirect root to frontend UI
app.get('/', (req, res) => {
  res.redirect('/frontend/index.html');
});

// Start the server
app.listen(port, () => {
  console.log(`Multi-carrier tracker listening on port ${port}`);
});