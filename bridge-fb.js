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
 *   VOICE_MAX_CHARS    – výchozí 1200 (~75 s řeči); delší odpovědi jdou jen textem
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
const VOICE_MAX = Number(process.env.VOICE_MAX_CHARS || 1200);
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
    body: JSON.stringify({ text, model_id: "eleven_multilingual_v2", voice_settings: { stability: Number(process.env.VOICE_STABILITY || 0.45), similarity_boost: Number(process.env.VOICE_SIMILARITY || 0.85), style: Number(process.env.VOICE_STYLE || 0.35), use_speaker_boost: true } }),
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
  if (!VOICE_ON) return;
  if (text.length > VOICE_MAX) { log(`hlasovka přeskočena: ${text.length} zn. > ${VOICE_MAX}`); return; }
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
  c.n = (c.n || 0) + 1;                       // kolo rozhovoru (odpovědi AI od začátku tématu)
  const KOLA = Number(process.env.MAX_KOLA || 4);
  const hint = c.n < KOLA ? `[kolo ${c.n}/${KOLA}]` : c.n === KOLA ? `[kolo ${KOLA}/${KOLA} – uzavři: závěr + objednání nebo rada]` : `[po uzávěru – odpověz stručně, nabídni objednání nebo nové téma]`;
  c.turns.push({ role: "user", content: `${text}\n\n${hint}` });
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
const HARD_CAP = Number(process.env.MAX_ZPRAV || 10);
async function poradna(psid, text) {
  const c0 = chats.get(psid);
  if (c0 && (c0.n || 0) >= HARD_CAP && Date.now() - c0.t < CHAT_TTL) {
    const msg = "Tady bych to pro dnešek uzavřel – víc už zvládne jen vyšetření. Napište „objednat“ a domluvíme termín, nebo se ozvěte zítra s novým dotazem. Při akutních potížích volejte 155.";
    await fbSend(psid, msg); log(`limit zpráv → FB ${psid}`); return;
  }
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


/* ---------- Okna (témata): ice breakers + menu v Messengeru + m.me?ref= ---------- */
const TEMATA = {
  poradna:  { title: "🩺 Poradna – mám zdravotní dotaz", opener: "Dobrý den, jsem AI asistent, kterého trénoval MUDr. Pavel Ditl. Napište mi, co vás trápí – zeptám se na pár věcí a poradím, co dál. Při akutních potížích volejte 155." },
  ordinace: { title: "📅 Ordinace – chci se objednat", opener: "Dobrý den, jsem AI asistent MUDr. Ditla. Objednám vás na křečové žíly, hemoroidy, pilonidální sinus nebo laparoskopickou operaci. S čím přicházíte?" },
  operace:  { title: "🔪 Operace – co mě čeká", opener: "Dobrý den, jsem AI asistent MUDr. Ditla. Rád vysvětlím, jak operace probíhá, jak se připravit a jak dlouho trvá návrat do práce – včetně laserové metody. Které operace se to týká?" },
  faq:      { title: "❓ Časté dotazy", opener: "Dobrý den, jsem AI asistent MUDr. Ditla. Nejčastěji se lidé ptají: Kdy k lékaři s hemoroidy? Bolí sono žil? Jak dlouho se hojí laser? Co si vzít do ordinace? Napište svou otázku, nebo některou z těchto." },
  medikace: { title: "💊 Medikace (připravujeme)", opener: "🚧 Medikaci na dálku zatím připravujeme – brzy půjde požádat MUDr. Ditla o eRecept s QR kódem. Zatím mi můžete napsat, jaký lék a proč potřebujete; předám to k posouzení. Jsem AI, nic sám nepředepisuji." },
};
const TOPIC_RE = /^TOPIC_([A-Z]+)$/;

async function startTopic(psid, key) {
  const t = TEMATA[key]; if (!t) return false;
  const now = Date.now();
  const c = { turns: [{ role: "user", content: `Pacient zvolil téma: ${t.title.replace(/^\S+\s/, "")}.` }, { role: "assistant", content: t.opener }], t: now, n: 1 };
  chats.set(psid, c);
  await fbSend(psid, t.opener);
  await sendVoiceIfShort(psid, t.opener);
  log(`téma ${key} → FB ${psid}`);
  return true;
}

/* Nastavení Messenger profilu (ice breakers + menu): GET /setup-messenger?key=VERIFY_TOKEN */
async function setupMessengerProfile() {
  const body = {
    get_started: { payload: "TOPIC_PORADNA" },
    greeting: [{ locale: "default", text: "Dobrý den! Jsem AI asistent, kterého trénoval MUDr. Pavel Ditl. Vyberte, s čím přicházíte, nebo rovnou napište." }],
    ice_breakers: [{ locale: "default", call_to_actions: [
      { question: TEMATA.poradna.title,  payload: "TOPIC_PORADNA" },
      { question: TEMATA.ordinace.title, payload: "TOPIC_ORDINACE" },
      { question: TEMATA.operace.title,  payload: "TOPIC_OPERACE" },
      { question: TEMATA.faq.title,      payload: "TOPIC_FAQ" },
    ] }],
    persistent_menu: [{ locale: "default", composer_input_disabled: false, call_to_actions: [
      { type: "postback", title: "🩺 Poradna",  payload: "TOPIC_PORADNA" },
      { type: "postback", title: "📅 Ordinace", payload: "TOPIC_ORDINACE" },
      { type: "nested", title: "Více…", call_to_actions: [
        { type: "postback", title: "🔪 Operace",      payload: "TOPIC_OPERACE" },
        { type: "postback", title: "❓ Časté dotazy", payload: "TOPIC_FAQ" },
        { type: "postback", title: "💊 Medikace (připravujeme)", payload: "TOPIC_MEDIKACE" },
      ] },
    ] }],
  };
  const r = await fetch(`https://graph.facebook.com/v21.0/me/messenger_profile?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.text() };
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
if (process.env.SETUP_MESSENGER_ON_BOOT !== "0" && PAGE_ACCESS_TOKEN) {
  setTimeout(async () => { try { const r = await setupMessengerProfile(); log(`messenger profil: ${r.status} ${r.body.slice(0, 120)}`); } catch (e) { log(`messenger profil: ${e.message}`); } }, 3000);
}

const SOUKROMI_HTML = `<!doctype html><html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ochrana soukromí – Pavel Ditl MD</title>
<style>body{font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;line-height:1.55;color:#111}h1{font-size:26px}h2{font-size:18px;margin-top:28px}</style></head><body>
<h1>Ochrana soukromí – AI poradna stránky Pavel Ditl MD</h1>
<p>Platí od 17. 9. 2026. Správce: MUDr. Pavel Ditl, provozovatel facebookové stránky <strong>Pavel Ditl MD</strong> a aplikace <strong>AInet Most</strong>.</p>
<h2>Co aplikace dělá</h2>
<p>Aplikace AInet Most přijímá zprávy, které pošlete stránce Pavel Ditl MD přes Messenger, a odpovídá na ně pomocí umělé inteligence. Odpovědi jsou informační a nenahrazují lékařské vyšetření. AI se v konverzaci vždy představí jako AI. Hlasové zprávy namlouvá umělá inteligence hlasem MUDr. Ditla.</p>
<h2>Jaké údaje zpracováváme</h2>
<ul><li>obsah zpráv, které stránce pošlete, a identifikátor vaší konverzace v Messengeru (PSID);</li>
<li>pokud se chcete objednat do ordinace: jméno, telefonní číslo, věk, popis potíží a preferovaný den vyšetření.</li></ul>
<p>Nepožadujeme rodné číslo, číslo pojištěnce, adresu ani fotografie. Prosíme, neposílejte je.</p>
<h2>Účel a právní základ</h2>
<p>Zodpovězení vašeho dotazu a objednání do ordinace (plnění smlouvy / oprávněný zájem, čl. 6 odst. 1 písm. b) a f) GDPR). Údaje o zdravotním stavu zpracováváme na základě vašeho výslovného souhlasu, který dáváte odesláním zprávy (čl. 9 odst. 2 písm. a) GDPR); souhlas můžete kdykoli odvolat.</p>
<h2>Kdo údaje zpracovává</h2>
<ul><li>Meta Platforms (Messenger) – doručení zpráv;</li>
<li>Render (hosting aplikace, EU/USA);</li>
<li>Anthropic (jazykový model generující odpovědi) a ElevenLabs (převod textu na hlas) – zpracovávají text konverzace pouze pro vytvoření odpovědi.</li></ul>
<h2>Doba uložení</h2>
<p>Obsah konverzace držíme v paměti aplikace nejvýše 24 hodin. Shrnutí objednávky (jméno, telefon, potíže, termín) předáváme ordinaci a mažeme po vyšetření, nejpozději do 90 dnů. Historii v Messengeru spravuje Meta podle svých pravidel.</p>
<h2>Vaše práva</h2>
<p>Máte právo na přístup k údajům, jejich opravu, výmaz, omezení zpracování, přenositelnost a právo vznést námitku. Napište na stránku Pavel Ditl MD do zpráv slovo <strong>SMAZAT</strong>, nebo kontaktujte správce e-mailem uvedeným na stránce; údaje odstraníme do 30 dnů. Stížnost lze podat u Úřadu pro ochranu osobních údajů (uoou.gov.cz).</p>
<h2>Smazání dat</h2>
<p>Pokyn ke smazání všech údajů spojených s vaší konverzací: pošlete stránce zprávu <strong>SMAZAT</strong>, nebo použijte odkaz <a href="/soukromi/smazani">/soukromi/smazani</a>.</p>
</body></html>`;

const MME = "https://m.me/1329907923537973";
const ROZCESTNIK_HTML = `<!doctype html><html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pavel Ditl MD – AI poradna</title>
<style>body{margin:0;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;background:#0e2a47;color:#f5f7fa}main{max-width:720px;margin:0 auto;padding:32px 20px}h1{font-size:26px;margin:0 0 6px}p.l{color:#aabed2;margin:0 0 24px}
.g{display:grid;grid-template-columns:1fr 1fr;gap:14px}a.t{display:block;background:#163a60;border-left:8px solid #58c4b4;border-radius:14px;padding:18px;color:#f5f7fa;text-decoration:none}a.t b{display:block;font-size:20px;margin-bottom:6px}a.t span{color:#aabed2;font-size:14px}a.t.uc{opacity:.6;border-left-color:#aabed2}
small{display:block;color:#aabed2;margin-top:24px}@media(max-width:520px){.g{grid-template-columns:1fr}}</style></head><body><main>
<h1>Pavel Ditl MD · AI poradna</h1><p class="l">Vyberte, s čím přicházíte. Otevře se Messenger a odpoví AI, kterou trénoval MUDr. Ditl.</p>
<div class="g">
<a class="t" href="${MME}?ref=poradna"><b>🩺 Poradna</b><span>Mám zdravotní dotaz – žíly, hemoroidy, kýla, hojení…</span></a>
<a class="t" href="${MME}?ref=ordinace"><b>📅 Ordinace</b><span>Chci se objednat: pondělí Bulovka, čtvrtek Neratovice</span></a>
<a class="t" href="${MME}?ref=operace"><b>🔪 Operace</b><span>Co mě čeká, příprava, laser, návrat do práce</span></a>
<a class="t" href="${MME}?ref=faq"><b>❓ Časté dotazy</b><span>Kdy k lékaři, bolí sono, co si vzít s sebou</span></a>
<a class="t uc" href="${MME}?ref=medikace"><b>💊 Medikace</b><span>🚧 Připravujeme – eRecept s QR kódem</span></a>
</div>
<small>Jsem AI – odpovědi jsou informační a nenahrazují vyšetření. Při akutních potížích volejte 155. · <a href="/soukromi" style="color:#58c4b4">Ochrana soukromí</a></small>
</main></body></html>`;

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
    if (url.pathname === "/setup-messenger" && req.method === "GET") {
      if (url.searchParams.get("key") !== VERIFY_TOKEN) { res.writeHead(403); return res.end("forbidden"); }
      const out = await setupMessengerProfile();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }); return res.end(JSON.stringify(out));
    }
    if (url.pathname === "/" || url.pathname === "/rozcestnik") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); return res.end(ROZCESTNIK_HTML); }
    if (url.pathname === "/soukromi" || url.pathname === "/privacy") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); return res.end(SOUKROMI_HTML); }
    if (url.pathname === "/soukromi/smazani") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); return res.end("<!doctype html><meta charset=utf-8><p>Pro smazání svých údajů pošlete stránce Pavel Ditl MD do Messengeru zprávu <b>SMAZAT</b>. Údaje odstraníme do 30 dnů.</p>"); }

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
          if (!psid) continue;
          /* kliknutí na okno (ice breaker / menu / Get started) nebo m.me?ref=tema */
          const payload = ev.postback?.payload || "";
          const ref = (ev.referral?.ref || ev.postback?.referral?.ref || "").toLowerCase();
          const hit = TOPIC_RE.exec(payload);
          const key = hit ? hit[1].toLowerCase() : (ref && TEMATA[ref] ? ref : null);
          if (key) {
            try { await startTopic(psid, key); } catch (e) { log(`téma: ${e.message}`); }
            continue;
          }
          const text = ev.message?.text;
          if (!text || ev.message?.is_echo) continue;
          if (/^\s*smazat\s*$/i.test(text)) {
            chats.delete(psid);
            await fbSend(psid, "Vaše konverzace byla z paměti poradny smazána. Historii v Messengeru můžete odstranit sami v aplikaci.");
            continue;
          }
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
