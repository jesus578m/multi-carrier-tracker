import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 8080;
// 1 = activar scraping con Playwright (extrae Estado/ETA/Entregado/Firmado/Origen/Destino)
const USE_SCRAPE = process.env.USE_SCRAPE === "1";

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use("/frontend", express.static(path.join(__dirname, "frontend")));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, scrape: USE_SCRAPE, ts: new Date().toISOString() });
});

/* -------------------- Helpers -------------------- */

function officialLink(carrier, code) {
  const c = (carrier || "").toLowerCase();
  switch (c) {
    case "dhl":
      return `https://www.dhl.com/mx-es/home/rastreo.html?tracking-id=${encodeURIComponent(code)}`;
    case "fedex":
      return `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(code)}&cntry_code=mx_esp`;
    case "ups":
      return `https://www.ups.com/track?loc=es_MX&tracknum=${encodeURIComponent(code)}&requester=ST/`;
    case "delta":
    case "delta-cargo":
    case "deltacargo":
      return `https://www.deltacargo.com/Cargo/trackShipment?airbillnumber=${encodeURIComponent(code)}`;
    case "expeditors":
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

function sanitize(text) {
  return (text || "")
    .replace(/\u00A0/g, " ")                // nbsp
    .replace(/[ \t]+/g, " ")
    .replace(/skip to main content/gi, "")  // evitar falsos positivos
    .replace(/ir al contenido principal/gi, "")
    .trim();
}

async function readBodyText(page) {
  // Extrae todo el texto del body (más tolerante a cambios de DOM)
  return await page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let buf = "";
    while (walker.nextNode()) buf += walker.currentNode.nodeValue + "\n";
    return buf;
  });
}

const cap = (s) => (s ? s.trim().replace(/\s{2,}/g, " ") : s);

/* -------------------- Scrapers -------------------- */

// FEDEX
async function scrapeFedEx(url) {
  return await withPage(async (page) => {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
    const text = sanitize(await readBodyText(page));

    const status = cap(
      (text.match(/(?:^|\n)\s*Estado de la entrega\s*([^\n]+)/i)?.[1]) ||
      (text.match(/(?:^|\n)\s*(Entregado|En camino|Listo para la entrega)\b/i)?.[1]) ||
      (text.match(/(?:^|\n)\s*(Delivered|In transit|On vehicle for delivery)\b/i)?.[1])
    );

    // Permite que “El 27/08/25 …” esté en la línea posterior al bloque “ENTREGADO”
    const deliveredAt = cap(
      (text.match(/(?:^|\n)\s*Entregado\s*(?:el|on)?\s*([^\n]+)/i)?.[1]) ||
      (text.match(/ENTREGADO[\s\S]{0,120}?El\s+([^\n]+)/i)?.[1]) ||
      (text.match(/Delivered[\s\S]{0,120}?(?:on)?\s+([^\n]+)/i)?.[1])
    );

    const signedBy = cap(
      (text.match(/(?:^|\n)\s*Firmado por[:\s]+([A-ZÁÉÍÓÚÑ .-]{3,})/i)?.[1]) ||
      (text.match(/(?:^|\n)\s*Signed by[:\s]+([A-Za-z .-]{3,})/i)?.[1])
    );

    const origin = cap(
      (text.match(/(?:^|\n)\s*DESDE\s*([A-ZÁÉÍÓÚÑ ,.-]+)\b/)?.[1]) ||
      (text.match(/(?:^|\n)\s*FROM\s*([A-Z ,.-]+)\b/)?.[1])
    );

    // Destino: prioriza “ENTREGADO <LUGAR>”
    let destination = cap(
      (text.match(/(?:^|\n)\s*ENTREGADO\s*([A-ZÁÉÍÓÚÑ ,.-]+)\b/)?.[1])
    );
    if (!destination) {
      destination = cap(
        (text.match(/(?:^|\n)\s*LISTO PARA LA ENTREGA\s*([A-ZÁÉÍÓÚÑ ,.-]+)\b/)?.[1]) ||
        (text.match(/(?:^|\n)\s*EN CAMINO\s*([A-ZÁÉÍÓÚÑ ,.-]+)\b/)?.[1]) ||
        (text.match(/(?:^|\n)\s*TO\s*([A-Z ,.-]+)\b/)?.[1])
      );
    }
    if (destination && /main content/i.test(destination)) destination = null;

    const eta = cap(
      (text.match(/Entrega (?:estimada|prevista|programada)\s*[:\-]?\s*([^\n]+)/i)?.[1]) ||
      (text.match(/Estimated delivery\s*[:\-]?\s*([^\n]+)/i)?.[1]) ||
      null
    );

    return { status, deliveredAt, signedBy, eta, origin, destination };
  });
}

// DHL
async function scrapeDHL(url) {
  return await withPage(async (page) => {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
    const text = sanitize(await readBodyText(page));

    const status = cap(
      (text.match(/(?:^|\n)\s*Estado\s*[:\-]?\s*([^\n]+)/i)?.[1]) ||
      (text.match(/(?:^|\n)\s*(En tránsito|Entregado|Listo para la entrega)\b/i)?.[1]) ||
      (text.match(/(?:^|\n)\s*(In transit|Delivered|Out for delivery)\b/i)?.[1])
    );

    const eta = cap(
      (text.match(/Fecha de entrega (?:estimada|prevista)\s*[:\-]?\s*([^\n]+)/i)?.[1]) ||
      (text.match(/Estimated delivery\s*[:\-]?\s*([^\n]+)/i)?.[1]) ||
      null
    );

    const deliveredAt = cap(
      (text.match(/(?:^|\n)\s*Entregado\s*(?:el|on)\s*([^\n]+)/i)?.[1]) ||
      null
    );

    return { status, eta, deliveredAt };
  });
}

// UPS
async function scrapeUPS(url) {
  return await withPage(async (page) => {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
    const text = sanitize(await readBodyText(page));

    const status = cap(
      (text.match(/(?:^|\n)\s*Estado\s*[:\-]?\s*([^\n]+)/i)?.[1]) ||
      (text.match(/(?:^|\n)\s*(Entregado|En tránsito|Listo para entrega)\b/i)?.[1]) ||
      (text.match(/(?:^|\n)\s*(Delivered|In Transit|Out for Delivery)\b/i)?.[1])
    );

    const eta = cap(
      (text.match(/Entrega (?:estimada|prevista)\s*[:\-]?\s*([^\n]+)/i)?.[1]) ||
      (text.match(/Estimated Delivery\s*[:\-]?\s*([^\n]+)/i)?.[1]) ||
      null
    );

    const deliveredAt = cap(
      (text.match(/(?:^|\n)\s*Entregado\s*(?:el|on)\s*([^\n]+)/i)?.[1]) ||
      (text.match(/(?:^|\n)\s*Delivered\s*(?:on)\s*([^\n]+)/i)?.[1]) ||
      null
    );

    const signedBy = cap(
      (text.match(/(?:^|\n)\s*Firmado por[:\s]+([A-ZÁÉÍÓÚÑ .-]{3,})/i)?.[1]) ||
      (text.match(/(?:^|\n)\s*Signed by[:\s]+([A-Za-z .-]{3,})/i)?.[1]) ||
      null
    );

    let destination = cap(
      (text.match(/(?:^|\n)\s*ENTREGADO\s*([A-ZÁÉÍÓÚÑ ,.-]+)\b/)?.[1]) ||
      (text.match(/(?:^|\n)\s*DELIVERED\s*([A-Z ,.-]+)\b/)?.[1])
    );
    if (destination && /main content/i.test(destination)) destination = null;

    return { status, eta, deliveredAt, signedBy, destination };
  });
}

// DELTA CARGO
async function scrapeDeltaCargo(url) {
  return await withPage(async (page) => {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
    const text = sanitize(await readBodyText(page));

    const status = cap(
      (text.match(/(?:^|\n)\s*Estado\s*[:\-]?\s*([^\n]+)/i)?.[1]) ||
      (text.match(/(?:^|\n)\s*(En tránsito|Entregado|Listo|En bodega)\b/i)?.[1]) ||
      (text.match(/(?:^|\n)\s*(In Transit|Delivered|Ready|At warehouse)\b/i)?.[1])
    );

    const eta = cap(
      (text.match(/(?:^|\n)\s*Fecha (?:estimada|prevista)\s*[:\-]?\s*([^\n]+)/i)?.[1]) ||
      (text.match(/(?:^|\n)\s*Estimated (?:date|time)\s*[:\-]?\s*([^\n]+)/i)?.[1]) ||
      null
    );

    const lastScan = cap(
      (text.match(/(?:^|\n)\s*(Última actualización|Last update)\s*[:\-]?\s*([^\n]+)/i)?.[2]) ||
      null
    );

    return { status, eta, lastScan };
  });
}

// EXPEDITORS (básico, landing dinámica)
async function scrapeExpeditors(url) {
  return await withPage(async (page) => {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
    const text = sanitize(await readBodyText(page));

    const status = cap(
      (text.match(/(?:^|\n)\s*Status\s*[:\-]?\s*([^\n]+)/i)?.[1]) ||
      (text.match(/(?:^|\n)\s*(Delivered|In Transit|Available|Ready)/i)?.[1]) ||
      (text.match(/(?:^|\n)\s*(Entregado|En tránsito|Disponible|Listo)/i)?.[1]) ||
      null
    );

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

/* -------------------- API -------------------- */

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
      } catch (e) {
        console.error("Scrape error:", e.message);
        details = {};
      }
    }

    return res.json({ ok: true, carrier, code, officialUrl: url, ...details });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Error interno" });
  }
});

// raíz -> UI
app.get("/", (_req, res) => res.redirect("/frontend/index.html"));

app.listen(port, () => {
  console.log(`Server on :${port} | scraping=${USE_SCRAPE ? "ON" : "OFF"}`);
});
