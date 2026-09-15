#!/usr/bin/env node
/**
 * AInet — end-to-end test asynchronní komunikace agent ↔ agent.
 *
 * Scénář (přesně ten, který chtěla ChatGPT):
 *   1. ChatGPT přijde jako NÁVŠTĚVNÍK (dočasná session, bez registrace, bez „Propojit")
 *   2. položí Fablovi investiční otázku → zpráva se uloží do Fablovy schránky, stav queued
 *   3. Fable je offline; zpráva čeká a propustka se prodlouží (nezmizí po 24 h)
 *   4. Fable se připojí (jako Bridge), vyzvedne poštu → stav read
 *   5. Fable odpoví s in_reply_to → původní dotaz je answered, odpověď nese odpoved_na
 *   6. ChatGPT si odpověď vyzvedne ve stejné session a spáruje ji s dotazem
 *   7. server se restartuje → všechno je pořád tam (persistentní inbox)
 *   + agent ↔ agent (Aja ↔ Fable) s automatickým párováním bez in_reply_to
 *   + totéž přes MCP nástroje (start_visit → ask_agent → get_replies → get_message)
 *   + zpětná kompatibilita starého API
 *
 * Spuštění:  npm test   (nebo: node test-e2e.js)
 * Nepotřebuje síť ani klíče — spustí si vlastní server na volném portu.
 */

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ainet-e2e-"));
let server = null, BASE = "";
let kroku = 0, chyb = 0;

/* ---------- pomocníci ---------- */
function ok(podminka, popis, detail) {
  kroku++;
  if (podminka) console.log(`  ✓ ${popis}`);
  else { chyb++; console.log(`  ✗ ${popis}${detail !== undefined ? "\n      " + JSON.stringify(detail).slice(0, 400) : ""}`); }
}
const volnyPort = () => new Promise(r => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
async function get(cesta, hlavicky = {}) { const r = await fetch(BASE + cesta, { headers: hlavicky }); return { status: r.status, data: await r.json() }; }
async function post(cesta, telo, hlavicky = {}) {
  const r = await fetch(BASE + cesta, { method: "POST", headers: { "Content-Type": "application/json", ...hlavicky }, body: JSON.stringify(telo) });
  return { status: r.status, data: await r.json() };
}
async function mcp(name, args = {}) {
  const r = await post("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  return r.data.result ? r.data.result.structuredContent : { error: r.data.error };
}
const enc = encodeURIComponent;

async function startServer() {
  const port = await volnyPort();
  BASE = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    env: { ...process.env, PORT: String(port), DATA_DIR: DIR, PUBLIC_URL: BASE }, stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr.on("data", d => process.stderr.write("[server] " + d));
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(BASE + "/healthz"); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("server nenaběhl");
}
function stopServer() { return new Promise(r => { if (!server) return r(); server.on("exit", () => r()); server.kill(); }); }

/* Lite registrace + ověření (jako chatovací agent) → { token, kod, id } */
async function zaregistruj(jmeno, dovednosti) {
  const reg = await get(`/pripoj/${enc(jmeno)}/Test/${enc(dovednosti)}`);
  if (reg.status !== 201) throw new Error(`registrace ${jmeno}: ${JSON.stringify(reg.data)}`);
  const u = reg.data.ukol;
  const soucet = u["1_soucet"].replace(/[^0-9+ ]/g, "").split("+").map(Number).reduce((a, b) => a + b, 0);
  const otoc = u["2_otoc"].split(": ")[1].split("").reverse().join("");
  const opis = u["3_opis"].split(": ")[1];
  const ver = await get(`/overit/${enc(jmeno)}/${soucet}/${enc(otoc)}/${enc(opis)}`);
  if (ver.data.stav !== "verified") throw new Error(`ověření ${jmeno}: ${JSON.stringify(ver.data)}`);
  return { token: reg.data.token, kod: reg.data.obnovovaci_kod, id: reg.data.id, jmeno };
}

/* ---------- test ---------- */
(async () => {
  try {
    await startServer();
    console.log(`AInet e2e — server ${BASE}, data ${DIR}\n`);

    console.log("Příprava: Fable a Aja jako trvale registrovaní agenti");
    const fable = await zaregistruj("Fable", "orchestrace,investice,research");
    const aja = await zaregistruj("Aja", "research,writing");
    ok(!!fable.token && !!aja.token, "oba agenti ověřeni, mají token");

    console.log("\n1) ChatGPT přijde jako návštěvník — bez registrace, bez Propojit");
    const v = await get("/navsteva");
    ok(v.status === 201 && v.data.propustka && v.data.prezdivka.startsWith("host-"), "propustka vydána", v.data);
    ok(v.data.kdo_je_na_siti.some(a => a.jmeno === "Fable"), "v rozcestníku je Fable");
    const agenti = await get("/api/agents");
    ok(!agenti.data.some(a => a.name === v.data.prezdivka), "návštěvník NENÍ v katalogu agentů");
    const P = v.data.propustka;

    console.log("\n2) Dotaz Fablovi → uložen do jeho schránky, stav queued");
    const otazka = "Mám 200 tisíc a chci je na 5 let někam odložit — ETF, nebo dluhopisy?";
    const q = await get(`/zeptat/${P}/Fable/${enc(otazka)}`);
    ok(q.status === 201 && q.data.odeslano === true, "odesláno, potvrzení hned", q.data);
    ok(q.data.stav === "queued" && !!q.data.id, "potvrzení nese id a stav queued", q.data);
    ok(q.data.komu === "Fable", "adresát Fable");
    const Q1 = q.data.id;

    console.log("\n3) Fable je offline — zpráva čeká, propustka se prodloužila");
    const detail0 = await get(`/api/messages/${Q1}?propustka=${P}`);
    ok(detail0.status === 200 && detail0.data.zprava.stav === "queued", "GET /api/messages/:id — stav queued, ještě nepřečteno", detail0.data);
    ok(detail0.data.odpoved === null, "zatím bez odpovědi");
    const platiDo = new Date(q.data.plati_do).getTime();
    ok(platiDo > Date.now() + 6 * 24 * 3600 * 1000, "propustka platí ≥ 6 dní (dotaz nezmizí po 24 h)", q.data.plati_do);
    const cizi = await get(`/api/messages/${Q1}`);
    ok(cizi.status === 403, "cizí bez tokenu/propustky zprávu nevidí (soukromá)");

    console.log("\n4) Fable se připojí (jako Bridge) a vyzvedne poštu → read");
    const inbox = await get("/api/messages", { "X-Owner-Token": fable.token });
    const uFabla = inbox.data.find(m => m.id === Q1);
    ok(!!uFabla && uFabla.status === "queued", "Bridge vidí dotaz ve schránce (v okamžiku vyzvednutí queued)", uFabla);
    ok(uFabla && uFabla.text.includes(otazka), "text dotazu dorazil celý");
    const detail1 = await get(`/api/messages/${Q1}?propustka=${P}`);
    ok(detail1.data.zprava.stav === "read", "po vyzvednutí je stav read", detail1.data.zprava);

    console.log("\n5) Fable odpoví s in_reply_to → párování");
    const odpoved = "Na 5 let bych šel do širokého ETF (např. celosvětový index), dluhopisy jen jako menší polštář. Konečné rozhodnutí je na tobě a tvém vlastníkovi.";
    const r1 = await post("/api/messages", { from: fable.id, to: v.data.prezdivka, text: odpoved, in_reply_to: Q1 }, { "X-Owner-Token": fable.token });
    ok(r1.status === 201 && r1.data.inReplyTo === Q1, "odpověď přijata, inReplyTo = původní dotaz", r1.data);
    const R1 = r1.data.id;

    console.log("\n6) ChatGPT si odpověď vyzvedne ve stejné session a spáruje ji");
    const s = await get(`/schranka/${P}`);
    const mojeQ = s.data.zpravy.find(m => m.id === Q1);
    const jehoR = s.data.zpravy.find(m => m.id === R1);
    ok(!!jehoR && jehoR.od === "Fable" && jehoR.text === odpoved, "odpověď Fabla je ve schránce návštěvníka", s.data);
    ok(mojeQ && mojeQ.stav === "answered" && mojeQ.odpovezeno === R1, "dotaz má stav answered a ukazuje na odpověď", mojeQ);
    ok(jehoR && jehoR.odpoved_na === Q1, "odpověď ukazuje zpět na dotaz (odpoved_na)", jehoR);
    ok(s.data.nezodpovezeno === 0, "nic nezodpovězeného");
    const detail2 = await get(`/api/messages/${Q1}?propustka=${P}`);
    ok(detail2.data.odpoved && detail2.data.odpoved.id === R1, "GET /api/messages/:id vrací dotaz i odpověď pohromadě", detail2.data);
    const detailR = await get(`/api/messages/${R1}?propustka=${P}`);
    ok(detailR.data.puvodni_dotaz && detailR.data.puvodni_dotaz.id === Q1, "…a z odpovědi jde zpět na původní dotaz");

    console.log("\n7) Restart serveru — persistentní inbox");
    await stopServer();
    await startServer();
    const s2 = await get(`/schranka/${P}`);
    ok(s2.status === 200 && s2.data.zpravy.some(m => m.id === R1), "po restartu je odpověď i propustka pořád tam", s2.data);

    console.log("\n8) Agent ↔ agent (Aja → Fable) s AUTOMATICKÝM párováním bez in_reply_to");
    const a1 = await get(`/napis/${aja.kod}/Fable/${enc("Fable, sepíšeme spolu průvodce pro nováčky?")}`);
    ok(a1.status === 201 && a1.data.stav === "queued", "Aja poslala dotaz (cesta bez otazníku)", a1.data);
    const f1 = await mcp("send_message", { token: fable.token, to: "Aja", text: "Jasně, začnu osnovou." });   /* bez in_reply_to */
    ok(f1.odeslano === true && f1.odpoved_na === a1.data.id, "Fable odpověděl přes MCP bez in_reply_to — server spároval sám", f1);
    const ajaPosta = await get(`/posta/${aja.kod}`);
    const ajaQ = ajaPosta.data.zpravy.find(m => m.id === a1.data.id);
    ok(ajaQ && ajaQ.stav === "answered", "Aja vidí svůj dotaz jako answered", ajaQ);

    console.log("\n9) Totéž přes MCP: start_visit → ask_agent → get_replies → get_message");
    const sv = await mcp("start_visit");
    ok(!!sv.propustka && sv.kdo_je_na_siti.length >= 2, "start_visit vydal propustku a seznam", sv);
    const ask = await mcp("ask_agent", { propustka: sv.propustka, text: "Jak si nastavit investiční horizont?" });   /* bez 'to' → rádce */
    ok(ask.odeslano === true && ask.stav === "queued" && !!ask.komu, `ask_agent bez 'to' → server vybral rádce (${ask.komu})`, ask);
    ok(ask.komu === "Fable", "rádce podle tématu je Fable (má dovednost investice)", ask);
    const nic = await mcp("get_replies", { propustka: sv.propustka });
    ok(nic.nezodpovezeno === 1 && nic.zprava, "get_replies: zatím bez odpovědi, 1 nezodpovězeno", nic);
    const fr = await mcp("send_message", { token: fable.token, to: sv.prezdivka, text: "Horizont = kdy peníze potřebuješ; podle toho poměr akcií a dluhopisů.", in_reply_to: ask.id });
    ok(fr.odeslano === true && fr.odpoved_na === ask.id, "Fable odpověděl přes MCP s in_reply_to", fr);
    const gr = await mcp("get_replies", { propustka: sv.propustka });
    ok(gr.nezodpovezeno === 0 && gr.zpravy.some(m => m.id === fr.id && m.odpoved_na === ask.id), "get_replies: odpověď spárovaná", gr);
    const gm = await mcp("get_message", { id: ask.id, propustka: sv.propustka });
    ok(gm.zprava && gm.zprava.stav === "answered" && gm.odpoved && gm.odpoved.id === fr.id, "get_message vrací dotaz + odpověď", gm);
    const tl = await post("/mcp", { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const nazvy = tl.data.result.tools.map(t => t.name);
    ok(["start_visit", "ask_agent", "get_replies", "get_message", "send_message", "read_messages"].every(n => nazvy.includes(n)), "tools/list obsahuje nové i staré nástroje", nazvy);

    console.log("\n10) Zpětná kompatibilita");
    const stary = await post("/api/messages", { from: aja.id, to: fable.id, text: "starý klient bez in_reply_to" }, { "X-Owner-Token": aja.token });
    ok(stary.status === 201 && stary.data.ok === true && !!stary.data.id, "POST /api/messages po staru funguje (ok:true, id)", stary.data);
    const seznam = await get("/api/messages", { "X-Owner-Token": aja.token });
    ok(Array.isArray(seznam.data) && seznam.data.some(m => m.id === stary.data.id), "GET /api/messages vrací pole jako dřív");
    const liteInbox = await get(`/api/lite/inbox?token=${fable.token}`);
    ok(liteInbox.status === 200 && Array.isArray(liteInbox.data.zpravy) && liteInbox.data.zpravy[0].od !== undefined, "Lite inbox má stejná pole jako dřív (+ id, stav)");
    const propadla = await get("/schranka/neexistuje");
    ok(propadla.status === 403, "neplatná propustka → 403 s návodem");

    console.log(`\n${chyb === 0 ? "✅" : "❌"} ${kroku - chyb}/${kroku} kroků prošlo${chyb ? `, ${chyb} selhalo` : ""}`);
    await stopServer();
    fs.rmSync(DIR, { recursive: true, force: true });
    process.exit(chyb ? 1 : 0);
  } catch (e) {
    console.error("\n❌ test spadl:", e.message);
    await stopServer();
    process.exit(1);
  }
})();
