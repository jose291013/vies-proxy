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

  // helpers robustes aux namespaces
  const pick = (obj, tag) => {
    const t = (tag || "").toLowerCase();
    const k = Object.keys(obj || {}).find(k => {
      const kl = k.toLowerCase();
      const tail = kl.includes(":") ? kl.split(":").pop() : kl;
      return kl === t || tail === t;
    });
    return k ? obj[k] : undefined;
  };
  const findChild = (obj, tag) => {
    const t = (tag || "").toLowerCase();
    const k = Object.keys(obj || {}).find(k => {
      const kl = k.toLowerCase();
      const tail = kl.includes(":") ? kl.split(":").pop() : kl;
      return tail === t;
    });
    return k ? obj[k] : undefined;
  };

  // Envelope / Body
  const env = findChild(xml, "envelope") || xml.Envelope || xml;
  const body = findChild(env, "body");
  if (!body) throw new Error("ParseError: Body not found");

  // Fault ?
  const fault = findChild(body, "fault");
  if (fault) {
    const fs = pick(fault, "faultstring") || pick(fault, "faultcode") || "SOAP Fault";
    const err = new Error(`VIES Fault: ${fs}`);
    err._fault = String(fs || "").toUpperCase();
    throw err;
  }

  // Response (standard ou approx)
  const ok = findChild(body, "checkVatResponse") || findChild(body, "checkVatApproxResponse");
  if (!ok) throw new Error("ParseError: *Response not found");

  // Champs robustes aux prefixes
  let validVal = pick(ok, "valid");
  let valid;
  if (typeof validVal === "boolean") valid = validVal;
  else if (validVal != null) valid = String(validVal).trim().toLowerCase() === "true";
  else {
    // fallback regex direct sur le XML brut
    const m = text.match(/<[\w:]*valid>\s*(true|false)\s*<\/[\w:]*valid>/i);
    if (!m) throw new Error("ParseError: valid not found");
    valid = m[1].toLowerCase() === "true";
  }

  const countryCode = pick(ok, "countryCode") || null;
  const vatNumber   = pick(ok, "vatNumber")   || null;
  const requestDate = pick(ok, "requestDate") || null;
  const name        = (pick(ok, "name") || pick(ok, "traderName") || "").trim();
  const address     = ((pick(ok, "address") || pick(ok, "traderAddress") || "") + "")
                        .replace(/\r?\n+/g, "\n").trim();

  const traderMatch = {
    name: pick(ok, "traderNameMatch") || null,
    address: pick(ok, "traderAddressMatch") || null
  };

  return { valid, countryCode, vatNumber, requestDate, name, address, traderMatch };
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

