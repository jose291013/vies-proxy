import express from "express";
import cors from "cors";
import { XMLParser } from "fast-xml-parser";
import { fetch } from "undici";

const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",").map(s=>s.trim()).filter(Boolean);
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 12000);
const NODE_ENV = process.env.NODE_ENV || "production";
const REQUESTER_VAT = process.env.REQUESTER_VAT || "";


// ---------- app & CORS ----------
const app = express();
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

// ---------- utils ----------
function parseVat(raw){
  const cleaned = (raw||"").toUpperCase().replace(/[\s.-]/g,"").replace(/^EU/,"");
  const cc = cleaned.slice(0,2);
  const num = cleaned.slice(2);
  if (!/^[A-Z]{2}$/.test(cc) || !/^[0-9A-Z+*.]{2,}$/.test(num)) return null;
  return { countryCode: cc, vatNumber: num };
}

function buildEnvelope(body){
  return `
  <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                    xmlns:urn="urn:ec.europa.eu:taxud:vies:services:checkVat:types">
    <soapenv:Header/>
    <soapenv:Body>${body}</soapenv:Body>
  </soapenv:Envelope>`.trim();
}

async function postSOAP(soap){
  const url = "https://ec.europa.eu/taxation_customs/vies/services/checkVatService";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      "SOAPAction": '""',
      "User-Agent": "VIES-Proxy/1.2"
    },
    body: soap,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });
  const text = await res.text();
  return { status: res.status, text };
}

function parseSOAP(text){
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
    const err = new Error(`VIES Fault: ${fs}`);
    err._fault = String(fs || "").toUpperCase();
    throw err;
  }

  const okKey1 = Object.keys(body).find(k => /:checkvatresponse$/i.test(k) || k === "checkVatResponse");
  const okKey2 = Object.keys(body).find(k => /:checkvatapproxresponse$/i.test(k) || k === "checkVatApproxResponse");
  const ok = body[okKey1] || body[okKey2];
  if (!ok) throw new Error("ParseError: *Response not found");

  // champs communs
  const valid   = String(ok.valid).toLowerCase() === "true";
  const cc      = ok.countryCode;
  const number  = ok.vatNumber;
  const date    = ok.requestDate || null;
  const name    = (ok.name || ok.traderName || "").trim();
  const address = (ok.address || ok.traderAddress || "").replace(/\n+/g,"\n").trim();

  // champs approx (si présent)
  const traderMatch = {
    name: ok.traderNameMatch || null,
    address: ok.traderAddressMatch || null
  };

  return { valid, countryCode: cc, vatNumber: number, requestDate: date, name, address, traderMatch };
}

// ---------- VIES calls ----------
async function checkVat(countryCode, vatNumber){
  const soap = buildEnvelope(`
    <urn:checkVat>
      <urn:countryCode>${countryCode}</urn:countryCode>
      <urn:vatNumber>${vatNumber}</urn:vatNumber>
    </urn:checkVat>`);
  const { text } = await postSOAP(soap);
  return { parsed: parseSOAP(text), raw: text };
}

async function checkVatApprox(countryCode, vatNumber, requesterCountryCode, requesterVatNumber, trader={}){
  const soap = buildEnvelope(`
    <urn:checkVatApprox>
      <urn:countryCode>${countryCode}</urn:countryCode>
      <urn:vatNumber>${vatNumber}</urn:vatNumber>
      <urn:traderName>${trader.name || ""}</urn:traderName>
      <urn:traderStreet>${trader.street || ""}</urn:traderStreet>
      <urn:traderPostcode>${trader.postcode || ""}</urn:traderPostcode>
      <urn:traderCity>${trader.city || ""}</urn:traderCity>
      <urn:requesterCountryCode>${requesterCountryCode}</urn:requesterCountryCode>
      <urn:requesterVatNumber>${requesterVatNumber}</urn:requesterVatNumber>
    </urn:checkVatApprox>`);
  const { text } = await postSOAP(soap);
  return { parsed: parseSOAP(text), raw: text };
}

// ---------- routes ----------
app.get("/health", (req,res)=> res.json({ ok:true }));

// GET /api/vies-check?vat=FR40303265045[&requesterVat=FRxx][&debug=1]
app.get("/api/vies-check", async (req,res)=>{
  const { vat, requesterVat, debug } = req.query;

  try {
    const target = parseVat(vat);
    if (!target) return res.status(400).json({ ok:false, error:"VAT invalide (format)" });

    // 1) checkVat standard
    let step1;
    try {
      step1 = await checkVat(target.countryCode, target.vatNumber);
    } catch (e) {
      const msg = (e?.message || "").toUpperCase();
      if (msg.includes("INVALID_INPUT"))  return res.status(400).json({ ok:false, error:"VIES: INVALID_INPUT (format non conforme)" });
      if (msg.includes("SERVICE_UNAVAILABLE") || msg.includes("MS_UNAVAILABLE")) return res.status(503).json({ ok:false, error:"VIES indisponible (réessayer)" });
      if (msg.includes("GLOBAL_MAX_CONCURRENT_REQ") || msg.includes("BUSY"))      return res.status(429).json({ ok:false, error:"VIES rate limit (trop de requêtes)" });
      if (msg.includes("PARSEERROR"))     return res.status(502).json({ ok:false, error:"Erreur de parsing SOAP" });
      throw e;
    }

    // Si déjà validé → retourne tout de suite
    if (step1.parsed.valid) {
      const out = { ok:true, ...step1.parsed };
      if (debug === "1" && NODE_ENV !== "production") out._raw = step1.raw.slice(0, 2000);
      return res.json(out);
    }

    // 2) Option: checkVatApprox si on a un requesterVat
    let step2;
    const rq = requesterVat ? parseVat(requesterVat)
         : (REQUESTER_VAT ? parseVat(REQUESTER_VAT) : null);
    if (rq) {
      try {
        step2 = await checkVatApprox(
          target.countryCode, target.vatNumber,
          rq.countryCode, rq.vatNumber,
          {} // trader infos vides
        );
      } catch (e) {
        // si approx casse, on ignore et on renvoie le step1
        step2 = null;
      }
    }

    const best = step2?.parsed?.valid ? step2 : step1;
    const out = { ok:true, ...best.parsed, source: step2?.parsed?.valid ? "approx" : "standard" };
    if (debug === "1") out._raw = best.raw.slice(0, 2000);
    return res.json(out);

  } catch (e) {
    console.error("[/api/vies-check]", e?.message);
    return res.status(502).json({ ok:false, error: e?.message || "Erreur VIES" });
  }
});

app.listen(PORT, ()=> console.log(`[vies-proxy] listening on :${PORT}`));

