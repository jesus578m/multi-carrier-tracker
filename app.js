import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use("/frontend", express.static(path.join(__dirname, "frontend")));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

/** Construye el link oficial por paquetería */
function officialLink(carrier, code) {
  const c = carrier.toLowerCase();
  switch (c) {
    case "dhl":
      // sitio MX-ES con query
      return `https://www.dhl.com/mx-es/home/rastreo.html?tracking-id=${encodeURIComponent(code)}`;
    case "fedex":
      // UI nueva de FedEx con parámetro
      return `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(code)}&cntry_code=mx_esp`;
    case "ups":
      return `https://www.ups.com/track?loc=es_MX&tracknum=${encodeURIComponent(code)}&requester=ST/`;
    case "delta":
    case "delta-cargo":
    case "deltacargo":
      // Delta Cargo (AWB)
      return `https://www.deltacargo.com/Cargo/trackShipment?airbillnumber=${encodeURIComponent(code)}`;
    case "expeditors":
      // Página de tracking pública (ingreso manual del número)
      return `https://www.expeditors.com/tracking`;
    default:
      return null;
  }
}

/** Heurística simple para extraer status/ETA del texto de la página */
function extractStatusAndEta(bigText) {
  const text = bigText.replace(/\s+/g, " ").trim();

  // Palabras clave de estado (ES/EN)
  const statusCandidates = [
    /entregado/i,
    /en tránsito/i,
    /en camino/i,
    /recogido/i,
    /listo para entrega/i,
    /demorado/i,
    /delivered/i,
    /out for delivery/i,
    /in transit/i,
    /picked up/i,
    /delayed/i
  ];
  const foundStatus = statusCandidates.find((re) => re.test(text));
  const status = foundStatus ? text.match(foundStatus)[0] : null;

  // ETA / fecha estimada (varios formatos)
  // Español
  const etaRegexes = [
    /entrega (estimada|prevista|programada)\s*[:\-]?\s*([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{2,4})/i,
    /(fecha|entrega) (estimada|prevista|programada)\s*[:\-]?\s*([A-Za-zÁÉÍÓÚÑa-z]+\.?\s*\d{1,2},?\s*\d{4})/i,
    // Inglés
    /(estimated|scheduled)\s*delivery\s*[:\-]?\s*([A-Za-z]+\s*\d{1,2},?\s*\d{4})/i,
    /(estimated|scheduled)\s*delivery\s*[:\-]?\s*([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{2,4})/i
  ];
  let etaText = null;
  for (const re of etaRegexes) {
    const m = text.match(re);
    if (m) {
      // último grupo capturado con la fecha
      etaText = m[m.length - 1];
      break;
    }
  }

  return { status, etaText };
}

/** Abre la página oficial y extrae texto general */
async function scrapePublicPage(url) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
  });
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    // muchas páginas de tracking cargan contenido async
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
    // texto “grande” de la página:
    const bodyText = await page.evaluate(() => document.body.innerText || "");
    const title = await page.title();
    return { bodyText, title };
  } finally {
    await context.close();
    await browser.close();
  }
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

    // Intento de scraping ligero
    let status = null;
    let etaText = null;
    let title = null;
    try {
      const { bodyText, title: pageTitle } = await scrapePublicPage(url);
      title = pageTitle;
      const parsed = extractStatusAndEta(bodyText);
      status = parsed.status;
      etaText = parsed.etaText;
    } catch (e) {
      // Fall-back: solo devolvemos el link oficial
    }

    return res.json({
      ok: true,
      carrier,
      code,
      officialUrl: url,
      status: status || null,
      eta: etaText || null,
      title
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Error interno" });
  }
});

// Raíz -> redirige a la UI
app.get("/", (_req, res) => res.redirect("/frontend/index.html"));

app.listen(port, () => {
  console.log(`Multi-carrier tracker listening on port ${port}`);
});
