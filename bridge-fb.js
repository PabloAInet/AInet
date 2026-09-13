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
const { PAGE_ACCESS_TOKEN, VERIFY_TOKEN, AINET_TOKEN } = process.env;

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
          log(`FB ${psid} → Fable: ${text.slice(0, 60)}`);
          try { await ainetSend(`[FB:${psid}] ${text}`); }
          catch (e) { log(`ainetSend: ${e.message}`); await fbSend(psid, "Fable je teď mimo síť, zkus to za chvíli."); }
        }
      }
      return;
    }

    res.writeHead(404); res.end("not found");
  } catch (e) {
    log(`http: ${e.message}`);
    if (!res.headersSent) { res.writeHead(500); res.end(); }
  }
}).listen(PORT, () => log(`most běží na :${PORT} — webhook /webhook, AInet ${AINET}, cíl ${FABLE}`));
