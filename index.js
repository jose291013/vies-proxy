import express from "express";
import cors from "cors";
import { XMLParser } from "fast-xml-parser";
import { fetch } from "undici";

// ---------- CONFIG ----------
const PORT = process.env.PORT || 3000;
// Liste d'origines autorisées (séparées par des virgules).
// Exemple: https://shop.mondomaine.com,https://b2b.mondomaine.com
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// ---------- APP ----------
const app = express();

// CORS: on n’ouvre qu’aux domaines Pressero/ton site
app.use((req, res, next) => {
  const origin = req.headers.origin || "";
  if (ALLOWED_ORIGINS.length && ALLOWED_ORIGINS.includes(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Vary", "Origin");
  }
  res.header("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Petit util pour normaliser/valider le VAT
function parseVat(raw) {
  const cleaned = (raw || "")
    .toUpperCase()
    .replace(/[\s.-]/g, "")
    .replace(/^EU/, ""); // parfois 'EU' parasite

  const countryCode = cleaned.slice(0, 2);
  const vatNumber = cleaned.slice(2);

  if (!/^[A-Z]{2}$/.test(countryCode) || !/^[0-9A-Z+*.]{2,}$/.test(vatNumber)) {
    return null;
  }
  return { countryCode, vatNumber };
}

// Appel SOAP VIES via endpoint HTTP (le service répond en SOAP)
async function checkVatVIES(countryCode, vatNumber) {
  const url = "https://ec.europa.eu/taxation_customs/vies/services/checkVatService";
  const soapEnvelope = `
    <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                      xmlns:urn="urn:ec.europa.eu:taxud:vies:services:checkVat:types">
      <soapenv:Header/>
      <soapenv:Body>
        <urn:checkVat>
          <urn:countryCode>${countryCode}</urn:countryCode>
          <urn:vatNumber>${vatNumber}</urn:vatNumber>
        </urn:checkVat>
      </soapenv:Body>
    </soapenv:Envelope>
  `.trim();

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      "User-Agent": "VIES-Proxy/1.0"
    },
    body: soapEnvelope,
    signal: AbortSignal.timeout(10000) // 10s
  });

  const text = await res.text();
  const parser = new XMLParser({ ignoreAttributes: false });
  const xml = parser.parse(text);

  const body =
    xml?.["S:Envelope"]?.["S:Body"] ||
    xml?.["soap:Envelope"]?.["soap:Body"] ||
    xml?.Envelope?.Body;

  const ok = body?.checkVatResponse || body?.["ns2:checkVatResponse"];
  const fault = body?.Fault || body?.["soap:Fault"] || body?.["S:Fault"];
  if (fault) {
    const faultString = fault.faultstring || fault["faultstring"] || "SOAP Fault";
    throw new Error(`VIES Fault: ${faultString}`);
  }
  if (!ok) throw new Error("Réponse VIES inattendue");

  return {
    valid: String(ok.valid).toLowerCase() === "true",
    countryCode: ok.countryCode,
    vatNumber: ok.vatNumber,
    requestDate: ok.requestDate,
    name: (ok.name || "").trim(),
    address: (ok.address || "").replace(/\n+/g, "\n").trim()
  };
}

// Health check basique (utile pour Render)
app.get("/health", (req, res) => res.json({ ok: true }));

// Endpoint principal: /api/vies-check?vat=FR40303265045
app.get("/api/vies-check", async (req, res) => {
  try {
    const { vat } = req.query;
    const parsed = parseVat(vat);
    if (!parsed) {
      return res.status(400).json({ ok: false, error: "VAT invalide (format)" });
    }

    const result = await checkVatVIES(parsed.countryCode, parsed.vatNumber);
    return res.json({ ok: true, ...result });
  } catch (e) {
    const msg = e?.message || "Erreur VIES";
    // 502 si VIES down / SOAP Fault
    return res.status(502).json({ ok: false, error: msg });
  }
});

app.listen(PORT, () => {
  console.log(`[vies-proxy] listening on :${PORT}`);
});
