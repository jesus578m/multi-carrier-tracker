import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 8080;

// Activa/desactiva scraping con Playwright (1 = encendido)
const USE_SCRAPE = process.env.USE_SCRAPE === "1";

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use("/frontend", express.static(path.join(__dirname, "frontend")));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString(), scrape: USE_SCRAPE });
});

function officialLink(carrier, code) {
  const c = (carrier || "").toLowerCase();
  switch (c) {
    case "dhl":
      return `https://www.dhl.com/mx-es/home/rastreo.html?tracking-id=${encodeURIComponent(code)}`;
    case "fedex":
      // forzar es-MX para textos en español cuando sea posible
      return `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(code)}&cntry_code=mx_esp`;
    case "ups":
      return `https://www.ups.com/track?loc=es_MX&tracknum=${encodeURIComponent(code)}&requester=ST/`;
    case "delta":
    case "delta-cargo":
    case "deltacargo":
      return `https://www.deltacargo.com/Cargo/trackShipment?airbillnumber=${encodeURIComponent(code)}`;
    case "expeditors":
      // expeditors requiere seleccionar tipo y nro; dejamos landing + extracción básica
      return `https://www.expeditors.com/tracking`;
    default:
      return null;
  }
}

async function withPage(fn) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
    locale: "es-ES"
  });
  const page = await context.newPage();
  try {
    return await fn(page);
  } finally {
    await context.close();
    await browser.close();
  }
}

/** Utilidad: texto plano de la página para regex */
async function readBodyText(page) {
  return await page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let buf = "";
    while (walker.nextNode()) buf += walker.currentNode.nodeValue + "\n";
    return buf.replace(/\u00A0/g, " ").replace(/[ \t]+/g, " ");
  });
}

/** -------- Scrapers por carrier (heurísticos, tolerantes a cambios) -------- */
async function scrapeFedEx(url) {
  return await withPage(async (page) => {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
    const text = await readBodyText(page);

    const status =
      (text.match(/Estado de la entrega\s*([^\n]+)/i)?.[1]) ||
      (text.match(/\bEntregado\b/i)?.[0]) ||
      (text.match(/\bEn camino\b/i)?.[0]) ||
      (text.match(/\bDelivered\b/i)?.[0]) ||
      null;

    const deliveredAt =
      (text.match(/Entregado\s*(?:el|on)\s*([^\n]+)/i)?.[1]) ||
      (text.match(/Delivered\s*(?:on)\s*([^\n]+)/i)?.[1]) ||
      null;

    const signedBy =
      (text.match(/Firmado por[:\s]+([A-ZÁÉÍÓÚÑ.\s]+)/i)?.[1]) ||
      (text.match(/Signed by[:\s]+([A-Za-z.\s]+)/i)?.[1]) ||
      null;

    const eta =
      (text.match(/Entrega (?:estimada|prevista|programada)\s*[:\-]?\s*([^\n]+)/i)?.[1]) ||
      (text.match(/Estimated delivery\s*[:\-]?\s*([^\n]+)/i)?.[1]) ||
      null;

    const origin =
      (text.match(/\bDESDE\b\s*([A-ZÁÉÍÓÚÑ ,\-]+)/i)?.[1]) ||
      (text.match(/\bFROM\b\s*([A-Z ,\-]+)/i)?.[1]) ||
      null;

    const destination =
      (text.match(/\bDESTINO\b\s*([A-ZÁÉÍÓÚÑ ,\-]+)/i)?.[1]) ||
      (text.match(/\bTO\b\s*([A-Z ,\-]+)/i)?.[1]) ||
      null;

    return { status, deliveredAt, signedBy, eta, origin, destination };
  });
}

async function scrapeDHL(url) {
  return await withPage(async (page) => {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
    const text = await readBodyText(page);

    const status =
      (text.match(/Estado\s*[:\-]?\s*([^\n]+)/i)?.[1]) ||
      (text.match(/\bEntregado\b/i)?.[0]) ||
      (text.match(/\bEn tránsito\b/i)?.[0]) ||
      null;

    const eta =
      (text.match(/Fecha de entrega (?:estimada|prevista)\s*[:\-]?\s*([^\n]+)/i)?.[1]) ||
      (text.match(/Estimated delivery\s*[:\-]?\s*([^\n]+)/i)?.[1]) ||
      null;

    const deliveredAt =
      (text.match(/Entregado\s*(?:el|on)\s*([^\n]+)/i)?.[1]) ||
      null;

    return { status, eta, deliveredAt };
  });
}

async function scrapeUPS(url) {
  return await withPage(async (page) => {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
    const text = await readBodyText(page);

    const status =
      (text.match(/Estado\s*[:\-]?\s*([^\n]+)/i)?.[1]) ||
      (text.match(/\bEntregado\b/i)?.[0]) ||
      (text.match(/\bEn tránsito\b/i)?.[0]) ||
      (text.match(/\bDelivered\b/i)?.[0]) ||
      (text.match(/\bIn Transit\b/i)?.[0]) ||
      null;

    const eta =
      (text.match(/Entrega (?:estimada|prevista)\s*[:\-]?\s*([^\n]+)/i)?.[1]) ||
      (text.match(/Estimated Delivery\s*[:\-]?\s*([^\n]+)/i)?.[1]) ||
      null;

    const deliveredAt =
      (text.match(/Entregado\s*(?:el|on)\s*([^\n]+)/i)?.[1]) ||
      (text.match(/Delivered\s*(?:on)\s*([^\n]+)/i)?.[1]) ||
      null;

    const signedBy =
      (text.match(/Firmado por[:\s]+([A-ZÁÉÍÓÚÑ.\s]+)/i)?.[1]) ||
      (text.match(/Signed by[:\s]+([A-Za-z.\s]+)/i)?.[1]) ||
      null;

    return { status, eta, deliveredAt, signedBy };
  });
}

async function scrapeDeltaCargo(url) {
  return await withPage(async (page) => {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
    const text = await readBodyText(page);

    const status =
      (text.match(/Estado\s*[:\-]?\s*([^\n]+)/i)?.[1]) ||
      (text.match(/En tránsito|Entregado|Listo para retiro/i)?.[0]) ||
      null;

    const eta =
      (text.match(/Fecha (?:estimada|prevista)\s*[:\-]?\s*([^\n]+)/i)?.[1]) ||
      null;

    const lastScan =
      (text.match(/(?:Última actualización|Last update)\s*[:\-]?\s*([^\n]+)/i)?.[1]) ||
      null;

    return { status, eta, lastScan };
  });
}

async function scrapeExpeditors(url) {
  return await withPage(async (page) => {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
    const text = await readBodyText(page);

    const status =
      (text.match(/Status\s*[:\-]?\s*([^\n]+)/i)?.[1]) ||
      (text.match(/Entregado|En tránsito|Listo/i)?.[0]) ||
      null;

    return { status };
  });
}

async function scrapeByCarrier(carrier, url) {
  const c = (carrier || "").toLowerCase();
  if (c.includes("fedex")) return await scrapeFedEx(url);
  if (c.includes("dhl")) return await scrapeDHL(url);
  if (c.includes("ups")) return await scrapeUPS(url);
  if (c.includes("delta")) return await scrapeDeltaCargo(url);
  if (c.includes("expeditors")) return await scrapeExpeditors(url);
  return {};
}

/** -------- API -------- */
app.get("/api/track", async (req, res) => {
  try {
    const { carrier, code } = req.query || {};
    if (!carrier || !code) {
      return res.status(400).json({ ok: false, error: "Faltan parámetros: carrier y code" });
    }

    const url = officialLink(carrier, code);
    if (!url) {
      return res.status(400).json({ ok: false, error: "Carrier no soportado", carrier });
    }

    let details = {};
    if (USE_SCRAPE) {
      try {
        details = await scrapeByCarrier(carrier, url);
      } catch {
        details = {};
      }
    }

    res.json({ ok: true, carrier, code, officialUrl: url, ...details });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Error interno" });
  }
});

// raíz -> UI
app.get("/", (_req, res) => res.redirect("/frontend/index.html"));

app.listen(port, () => console.log(`Server on :${port}, scrape=${USE_SCRAPE}`));


