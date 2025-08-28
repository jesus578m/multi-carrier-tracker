// app.js
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

// 🔧 Flag para (des)activar scraping con Playwright.
// Déjalo sin definir o en "0" para desactivar (estable en Railway).
const USE_SCRAPE = process.env.USE_SCRAPE === "1";

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use("/frontend", express.static(path.join(__dirname, "frontend")));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// Genera el enlace oficial por paquetería
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
      return `https://www.deltacargo.com/Cargo/trackShipment?airbillnumber=${encodeURIComponent(code)}`;
    case "expeditors":
      return `https://www.expeditors.com/tracking`;
    default:
      return null;
  }
}

// Utilidad opcional para scraping (solo si USE_SCRAPE=1)
async function withPage(fn) {
  if (!USE_SCRAPE) throw new Error("SCRAPE_DISABLED");
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
  });
  const page = await context.newPage();
  try {
    return await fn(page);
  } finally {
    await context.close();
    await browser.close();
  }
}

// Un ejemplo de parser para FedEx (solo se usará si activas USE_SCRAPE=1)
async function scrapeFedEx(url) {
  return withPage(async (page) => {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
    const text = await page.evaluate(() => document.body.innerText || "");
    const status =
      (text.match(/Estado de la entrega\s*([^\n]+)/i)?.[1]) ||
      (text.match(/\bEntregado\b/i)?.[0]) ||
      (text.match(/\bDelivered\b/i)?.[0]) || null;
    const deliveredAt =
      (text.match(/Entregado\s+El\s+([^\n]+)/i)?.[1]) ||
      (text.match(/Delivered\s+on\s+([^\n]+)/i)?.[1]) || null;
    const signedBy =
      (text.match(/Firmado por[:\s]+([A-ZÁÉÍÓÚÑ.\s]+)/i)?.[1]) ||
      (text.match(/Signed by[:\s]+([A-Za-z.\s]+)/i)?.[1]) || null;
    const eta =
      (text.match(/Entrega (?:estimada|prevista|programada)\s*[:\-]?\s*([^\n]+)/i)?.[1]) ||
      (text.match(/Estimated delivery\s*[:\-]?\s*([^\n]+)/i)?.[1]) || null;
    return { status, deliveredAt, signedBy, eta };
  });
}

async function scrapeByCarrier(carrier, url) {
  const c = (carrier || "").toLowerCase();
  if (c.includes("fedex")) return await scrapeFedEx(url);
  // otros carriers aquí si luego activas USE_SCRAPE
  return {};
}

app.post("/api/track", async (req, res) => {
  try {
    const { carrier, code } = req.body || {};
    if (!carrier || !code) {
      return res.status(400).json({ ok: false, error: "Faltan parámetros: carrier y code" });
    }

    const url = officialLink(carrier, code);
    if (!url) {
      return res.status(400).json({ ok: false, error: "Carrier no soportado", carrier });
    }

    let details = {};
    try {
      details = await scrapeByCarrier(carrier, url);
    } catch (e) {
      // Si scraping está desactivado o falla, seguimos con detalles vacíos
      details = {};
    }

    return res.json({
      ok: true,
      carrier,
      code,
      officialUrl: url,
      ...details, // status/eta/etc si alguna vez activas scraping
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Error interno" });
  }
});

// Raíz -> UI
app.get("/", (_req, res) => res.redirect("/frontend/index.html"));

app.listen(port, () => console.log(`Multi-carrier tracker listening on port ${port}`));

