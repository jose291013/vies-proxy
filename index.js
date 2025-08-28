import express from "express";
import cors from "cors";
import { XMLParser } from "fast-xml-parser";
import { fetch } from "undici";

const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "").split(",").map(s=>s.trim()).filter(Boolean);
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 12000);

const app = express();

// CORS strict
app.use((req,res,next)=>{
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

function parseVat(raw){
  const cleaned = (raw||"").toUpperCase().replace(/[\s.-]/g,"").replace(/^EU/,"");
  const countryCode = cleaned.slice(0,2);
  const vatNumber = cleaned.slice(2);
  if (!/^[A-Z]{2}$/.test(countryCode) || !/^[0-9A-Z+*.]{2,}$/.test(vatNumber)) return null;
  return { countryCode, vatNumber };
}

async function checkVatVIES(countryCode, vatNumber){
  const url = "https://ec.europa.eu/taxation_customs/vies/services/checkVatService";
  const soap = `
  <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                    xmlns:urn="urn:ec.europa.eu:taxud:vies:services:checkVat:types">
    <soapenv:Header/>
    <soapenv:Body>
      <urn:checkVat>
        <urn:countryCode>${countryCode}</urn:countryCode>
        <urn:vatNumber>${vatNumber}</urn:vatNumber>
      </urn:checkVat>
    </soapenv:Body>
  </soapenv:Envelope>`.trim();

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      "SOAPAction": '""',
      "User-Agent": "VIES-Proxy/1.1"
    },
    body: soap,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });

  const text = await res.text();

  // 1) tentative parse XML “largement” tolérante
  try {
    const parser = new XMLParser({ ignoreAttributes: false });
    const xml = parser.parse(text);

    const envKey  = Object.keys(xml).find(k => /:envelope$/i.test(k) || k === "Envelope") || "Envelope";
    const env     = xml[envKey] || xml.Envelope || xml;
    const bodyKey = Object.keys(env).find(k => /:body$/i.test(k) || k === "Body") || "Body";
    const body    = env[bodyKey];

    if (!body) throw new Error("ParseError: Body not found");

    const faultKey = Object.keys(body).find(k => /:fault$/i.test(k) || k === "Fault");
    if (faultKey) {
      const fs = body[faultKey]?.faultstring || body[faultKey]?.faultcode || "SOAP Fault";
      const msg = String(fs || "").toUpperCase();
      const err = new Error(`VIES Fault: ${fs}`);
      err._fault = msg;
      throw err;
    }

    const okKey = Object.keys(body).find(k => /:checkvatresponse$/i.test(k) || k === "checkVatResponse");
    const ok = body[okKey];
    if (!ok) throw new Error("ParseError: checkVatResponse not found");

    const valid = String(ok.valid).toLowerCase() === "true";
    const name = (ok.name || "").trim();
    const address = (ok.address || "").replace(/\n+/g, "\n").trim();

    return {
      valid,
      countryCode: ok.countryCode || countryCode,
      vatNumber: ok.vatNumber || vatNumber,
      requestDate: ok.requestDate || null,
      name,
      address
    };
  } catch (e) {
    // 2) fallback regex (au cas où les namespaces bougent)
    const mValid   = text.match(/<[\w:]*valid>(true|false)<\/[\w:]*valid>/i);
    const mCC      = text.match(/<[\w:]*countryCode>([^<]+)<\/[\w:]*countryCode>/i);
    const mVAT     = text.match(/<[\w:]*vatNumber>([^<]+)<\/[\w:]*vatNumber>/i);
    const mName    = text.match(/<[\w:]*name>([^<]*)<\/[\w:]*name>/i);
    const mAddress = text.match(/<[\w:]*address>([\s\S]*?)<\/[\w:]*address>/i);
    const mFault   = text.match(/<[\w:]*faultstring>([^<]+)<\/[\w:]*faultstring>/i);

    if (mFault) {
      const err = new Error(`VIES Fault: ${mFault[1]}`);
      err._fault = String(mFault[1]).toUpperCase();
      throw err;
    }
    if (!mValid) throw new Error("ParseError: neither structured nor regex parse worked");

    return {
      valid: mValid[1].toLowerCase() === "true",
      countryCode: (mCC?.[1] || countryCode),
      vatNumber: (mVAT?.[1] || vatNumber),
      requestDate: null,
      name: (mName?.[1] || "").trim(),
      address: (mAddress?.[1] || "").replace(/\n+/g,"\n").trim()
    };
  }
}

app.get("/health", (req,res)=>res.json({ ok:true }));

app.get("/api/vies-check", async (req,res)=>{
  try{
    const { vat } = req.query;
    const parsed = parseVat(vat);
    if (!parsed) return res.status(400).json({ ok:false, error:"VAT invalide (format)" });

    const r = await checkVatVIES(parsed.countryCode, parsed.vatNumber);
    return res.json({ ok:true, ...r });
  } catch (e){
    const msg = (e?.message || "").toUpperCase();
    console.error("[VIES ERROR]", e?.message);

    if (msg.includes("INVALID_INPUT"))  return res.status(400).json({ ok:false, error:"VIES: INVALID_INPUT (format non conforme)" });
    if (msg.includes("MS_UNAVAILABLE") || msg.includes("SERVICE_UNAVAILABLE")) return res.status(503).json({ ok:false, error:"VIES indisponible (réessayer)" });
    if (msg.includes("GLOBAL_MAX_CONCURRENT_REQ") || msg.includes("BUSY"))      return res.status(429).json({ ok:false, error:"VIES rate limit (trop de requêtes)" });
    if (msg.includes("PARSEERROR"))     return res.status(502).json({ ok:false, error:"Erreur de parsing SOAP" });

    return res.status(502).json({ ok:false, error: e?.message || "Erreur VIES" });
  }
});

app.listen(PORT, ()=> console.log(`[vies-proxy] :${PORT}`));
