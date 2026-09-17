#!/usr/bin/env node
/**
 * bridge-fb.js — most mezi Facebook Messengerem (stránka Pavel Ditl MD)
 * a agentem Fable na AInetu. Čistý Node 18+, bez závislostí.
 *
 * Jak to funguje:
 *   člověk napíše stránce do Messengeru
 *     → Meta pošle webhook sem (POST /webhook)
 *     → most pošle text Fablovi na AInet jako zprávu od agenta "FB-Most":
 *          "[FB:<psid>] <text>"
 *   Fable odpoví agentovi FB-Most zprávou ve stejném tvaru "[FB:<psid>] <odpověď>"
 *     → most ji každých 5 s vyzvedne z AInet inboxu a pošle do Messengeru.
 *
 * Env proměnné (nastav na Renderu, nikdy do kódu):
 *   PAGE_ACCESS_TOKEN  – token stránky z Meta for Developers (Messenger → Access Tokens)
 *   VERIFY_TOKEN       – libovolný řetězec, stejný zadáš v Meta při nastavení webhooku
 *   AINET_TOKEN        – Lite token agenta FB-Most (viz krok "registrace" níže)
 *   AINET_BASE         – výchozí https://ainet-1e2y.onrender.com
 *   FABLE_NAME         – výchozí "Fable"
 *   PORT               – Render ho dodá sám
 *   ELEVENLABS_API_KEY – (volitelné) klíč ElevenLabs; s ELEVENLABS_VOICE_ID posílá odpovědi i jako hlasovku
 *   ELEVENLABS_VOICE_ID– (volitelné) ID klonu hlasu "Pavel – ambulance"
 *   VOICE_MAX_CHARS    – výchozí 600; delší odpovědi jdou jen textem
 *   ANTHROPIC_API_KEY  – (volitelné) režim PORADNA: most odpovídá pacientům sám podle fb-instrukce.js
 *                        (rychlejší, s pamětí konverzace); objednávky posílá Fablovi na AInet.
 *                        Bez klíče běží původní režim: vše přeposílá Fablovi.
 *   ANTHROPIC_MODEL    – výchozí claude-sonnet-4-5
 *
 * Registrace mostu na AInetu (jednorázově, stačí prohlížeč):
 *   1) GET  AINET_BASE/api/lite/register?name=FB-Most&owner=Pavel%20Ditl&skills=messaging
 *      → vrátí { token, ukol }  → token ulož jako AINET_TOKEN
 *   2) GET  AINET_BASE/api/lite/verify?token=...&a1=SOUCET&a2=OTOCENY&a3=OPSANY
 */

const http = require("http");

const PORT = process.env.PORT || 4790;
const AINET = (process.env.AINET_BASE || "https://ainet-1e2y.onrender.com").replace(/\/$/, "");
const FABLE = process.env.FABLE_NAME || "Fable";
const { PAGE_ACCESS_TOKEN, VERIFY_TOKEN, AINET_TOKEN, ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID } = process.env;
const VOICE_ON = !!(ELEVENLABS_API_KEY && ELEVENLABS_VOICE_ID);
const VOICE_MAX = Number(process.env.VOICE_MAX_CHARS || 600);
const { ANTHROPIC_API_KEY } = process.env;
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";
const PORADNA = !!ANTHROPIC_API_KEY;
let INSTRUKCE = "";
if (PORADNA) { try { INSTRUKCE = require("./fb-instrukce.js"); } catch (e) { console.warn("[most] fb-instrukce.js chybí, režim poradna vypnut"); } }

for (const k of ["PAGE_ACCESS_TOKEN", "VERIFY_TOKEN", "AINET_TOKEN"]) {
  if (!process.env[k]) console.warn(`[most] chybí env ${k}`);
}

const log = (m) => console.log(`[most] ${new Date().toISOString()} ${m}`);
const TAG = /^\[FB:(\d+)\]\s*/;

/* ---------- AInet (Lite API) ---------- */
async function ainetSend(text) {
  const u = `${AINET}/api/lite/send?token=${encodeURIComponent(AINET_TOKEN)}&to=${encodeURIComponent(FABLE)}&text=${encodeURIComponent(text)}`;
  const r = await fetch(u);
  if (!r.ok) throw new Error(`AInet send ${r.status}: ${await r.text()}`);
}
async function ainetInbox() {
  const r = await fetch(`${AINET}/api/lite/inbox?token=${encodeURIComponent(AINET_TOKEN)}`);
  if (!r.ok) throw new Error(`AInet inbox ${r.status}`);
  const data = await r.json();
  /* Lite inbox vrací { zpravy: [{od, pro, kdy, text}] } */
  return Array.isArray(data) ? data : (data.zpravy || data.messages || []);
}

/* ---------- Messenger (Graph API) ---------- */
async function fbSend(psid, text) {
  const r = await fetch(`https://graph.facebook.com/v21.0/me/messages?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recipient: { id: psid }, messaging_type: "RESPONSE", message: { text: text.slice(0, 2000) } }),
  });
  if (!r.ok) throw new Error(`FB send ${r.status}: ${await r.text()}`);
}

/* ---------- Hlasovka: ElevenLabs TTS → Messenger audio ---------- */
/* výslovnost pro hlasovku: co model píše ↔ co má zaznít */
const VYSLOVNOST = [[/\bDitl/g, "Dytl"], [/\bDitla\b/g, "Dytla"], [/\bDitlem\b/g, "Dytlem"], [/\bDitlovi\b/g, "Dytlovi"], [/MUDr\.\s*/g, "doktor "], [/\bFN Bulovka\b/g, "Fakultní nemocnice Bulovka"], [/\b155\b/g, "sto padesát pět"]];
const proHlas = (t) => VYSLOVNOST.reduce((x, [re, to]) => x.replace(re, to), t);

async function ttsMp3(text) {
  text = proHlas(text);
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(ELEVENLABS_VOICE_ID)}?output_format=mp3_44100_64`, {
    method: "POST",
    headers: { "xi-api-key": ELEVENLABS_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ text, model_id: "eleven_multilingual_v2", voice_settings: { stability: 0.5, similarity_boost: 0.8, style: 0 } }),
  });
  if (!r.ok) throw new Error(`TTS ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return Buffer.from(await r.arrayBuffer());
}
async function fbSendAudio(psid, mp3) {
  const fd = new FormData();
  fd.append("recipient", JSON.stringify({ id: psid }));
  fd.append("messaging_type", "RESPONSE");
  fd.append("message", JSON.stringify({ attachment: { type: "audio", payload: { is_reusable: false } } }));
  fd.append("filedata", new Blob([mp3], { type: "audio/mpeg" }), "odpoved.mp3");
  const r = await fetch(`https://graph.facebook.com/v21.0/me/messages?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`, { method: "POST", body: fd });
  if (!r.ok) throw new Error(`FB audio ${r.status}: ${(await r.text()).slice(0, 200)}`);
}
/* text jde vždy; hlasovka je bonus – když selže, nic se neděje */
async function sendVoiceIfShort(psid, text) {
  if (!VOICE_ON || text.length > VOICE_MAX) return;
  try { await fbSendAudio(psid, await ttsMp3(text)); log(`hlasovka → FB ${psid} (${text.length} zn.)`); }
  catch (e) { log(`hlasovka: ${e.message}`); }
}

/* ---------- Režim PORADNA: model odpovídá sám, s pamětí konverzace ---------- */
const chats = new Map();                       // psid → { turns: [{role, content}], t }
const CHAT_TTL = 24 * 3600 * 1000, CHAT_MAX = 24;
const OBJ = /\[\[OBJEDNANI\]\]([\s\S]*?)\[\[\/OBJEDNANI\]\]/;

async function fbTyping(psid) {
  try {
    await fetch(`https://graph.facebook.com/v21.0/me/messages?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipient: { id: psid }, sender_action: "typing_on" }),
    });
  } catch {}
}

async function askModel(psid, text) {
  const now = Date.now();
  let c = chats.get(psid);
  if (!c || now - c.t > CHAT_TTL) c = { turns: [], t: now };
  c.turns.push({ role: "user", content: text });
  if (c.turns.length > CHAT_MAX) c.turns = c.turns.slice(-CHAT_MAX);
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: 700, system: INSTRUKCE, messages: c.turns }),
  });
  if (!r.ok) throw new Error(`model ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const data = await r.json();
  const full = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
  c.turns.push({ role: "assistant", content: full });
  c.t = now; chats.set(psid, c);
  return full;
}

/* Odpověď pacientovi + objednávka Pavlovi (přes Fabla na AInetu) */
async function poradna(psid, text) {
  await fbTyping(psid);
  const full = await askModel(psid, text);
  const hit = OBJ.exec(full);
  const reply = full.replace(OBJ, "").trim() || "Rozumím. Můžete mi to prosím napsat ještě jednou?";
  await fbSend(psid, reply);
  log(`poradna → FB ${psid}: ${reply.slice(0, 60)}`);
  await sendVoiceIfShort(psid, reply);
  if (hit) {
    const souhrn = `OBJEDNÁNÍ z Messengeru (psid ${psid}, ${new Date().toISOString().slice(0, 16)})\n${hit[1].trim()}`;
    log(`objednávka: ${hit[1].trim().split("\n").slice(0, 2).join(" | ")}`);
    try { await ainetSend(`[OBJEDNANI] ${souhrn}`); } catch (e) { log(`objednávka → AInet: ${e.message}`); }
  }
}

/* ---------- Doručování odpovědí z AInetu ---------- */
const seen = new Set();               // id zpráv, které už šly do Messengeru
let primed = false;                   // první průchod jen načte historii, nic neposílá

async function pump() {
  try {
    const msgs = await ainetInbox();
    for (const m of msgs) {
      const id = m.id || `${m.kdy || m.t}|${m.text}`;
      if (seen.has(id)) continue;
      seen.add(id);
      if (!primed) continue;
      const from = m.od || m.fromName || m.from || "";
      if (from !== FABLE) continue;
      const hit = TAG.exec(m.text || "");
      if (!hit) continue;
      const psid = hit[1];
      const reply = (m.text || "").replace(TAG, "").trim();
      if (!reply) continue;
      await fbSend(psid, reply);
      log(`Fable → FB ${psid}: ${reply.slice(0, 60)}`);
      await sendVoiceIfShort(psid, reply);
    }
    primed = true;
    if (seen.size > 5000) seen.clear();
  } catch (e) { log(`pump: ${e.message}`); }
}
setInterval(pump, 5000);
pump();

/* ---------- HTTP: webhook od Mety ---------- */
function readBody(req) {
  return new Promise((res, rej) => {
    let d = ""; req.on("data", c => { d += c; if (d.length > 1e6) req.destroy(); });
    req.on("end", () => { try { res(d ? JSON.parse(d) : {}); } catch (e) { rej(e); } });
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname === "/healthz") { res.writeHead(200); return res.end("ok"); }

    /* ověření webhooku (Meta ho zavolá jednou při nastavení) */
    if (url.pathname === "/webhook" && req.method === "GET") {
      const ok = url.searchParams.get("hub.mode") === "subscribe" && url.searchParams.get("hub.verify_token") === VERIFY_TOKEN;
      res.writeHead(ok ? 200 : 403);
      return res.end(ok ? url.searchParams.get("hub.challenge") : "forbidden");
    }

    /* příchozí zprávy z Messengeru */
    if (url.pathname === "/webhook" && req.method === "POST") {
      const body = await readBody(req);
      res.writeHead(200); res.end("EVENT_RECEIVED");   // Meta chce 200 hned
      if (body.object !== "page") return;
      for (const entry of body.entry || []) {
        for (const ev of entry.messaging || []) {
          const psid = ev.sender?.id;
          const text = ev.message?.text;
          if (!psid || !text || ev.message?.is_echo) continue;
          if (PORADNA && INSTRUKCE) {
            log(`FB ${psid} → poradna: ${text.slice(0, 60)}`);
            try { await poradna(psid, text); }
            catch (e) { log(`poradna: ${e.message}`); await fbSend(psid, "Omlouvám se, teď nemůžu odpovědět. Zkuste to prosím za chvíli; při akutních potížích volejte 155."); }
            continue;
          }
          log(`FB ${psid} → Fable: ${text.slice(0, 60)}`);
          try { await ainetSend(`[FB:${psid}] ${text}`); }
          catch (e) { log(`ainetSend: ${e.message}`); await fbSend(psid, "Fable je teď mimo síť, zkus to za chvíli."); }
        }
      }
      return;
    }

    /* ruční/agentní odpověď bez AInetu: GET /reply?key=VERIFY_TOKEN&psid=...&text=... */
    if (url.pathname === "/reply" && req.method === "GET") {
      if (url.searchParams.get("key") !== VERIFY_TOKEN) { res.writeHead(403); return res.end("forbidden"); }
      const psid = url.searchParams.get("psid"); const text = url.searchParams.get("text") || "";
      if (!psid || !text.trim()) { res.writeHead(400); return res.end("psid a text jsou povinné"); }
      await fbSend(psid, text.trim());
      log(`reply → FB ${psid}: ${text.slice(0, 60)}`);
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true }));
      await sendVoiceIfShort(psid, text.trim());
      return;
    }

    res.writeHead(404); res.end("not found");
  } catch (e) {
    log(`http: ${e.message}`);
    if (!res.headersSent) { res.writeHead(500); res.end(); }
  }
}).listen(PORT, () => log(`most běží na :${PORT} — webhook /webhook, AInet ${AINET}, cíl ${FABLE}, hlasovky ${VOICE_ON ? "zapnuté" : "vypnuté"}, režim ${PORADNA && INSTRUKCE ? "poradna (model " + MODEL + ")" : "přeposílání Fablovi"}`));
