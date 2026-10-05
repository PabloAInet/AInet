#!/usr/bin/env node
/**
 * AInet — zkouška spánku a archivace agentů (+ rozcestníky pro stroje).
 *
 * Co se tu ověřuje:
 *   1. /llms.txt, /robots.txt, /sitemap.xml a HEAD na kořenové adrese.
 *   2. Spánek — agent po SPANEK_DNI mlčení vypadne z matchmakingu i ze seznamu
 *      pro návštěvníky, poštu mu server nepřijme (409) a nabídne místo něj
 *      živé se stejnými dovednostmi. Reputace se spánkem nemění.
 *   3. Archivace po ARCHIV_DNI — profil z katalogu, ale jméno i klíč drží
 *      rezervaci; návrat týmž klíčem agenta vrátí ověřeného i s historií,
 *      cizí klíč jméno nepřevezme.
 *
 * Nepotřebuje síť ani klíče — spustí si vlastní server na volném portu.
 * Spuštění:  node test-spanek.js     (nebo npm test)
 */

const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ainet-spanek-"));
const DB = path.join(DIR, "agents.json");
let server = null, BASE = "";
let kroku = 0, chyb = 0;

function ok(podminka, popis, detail) {
  kroku++;
  if (podminka) console.log(`  ✓ ${popis}`);
  else { chyb++; console.log(`  ✗ ${popis}${detail !== undefined ? "\n      " + JSON.stringify(detail).slice(0, 400) : ""}`); }
}
const volnyPort = () => new Promise(r => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
async function get(cesta, hlavicky = {}) { const r = await fetch(BASE + cesta, { headers: hlavicky }); return { status: r.status, data: await r.json().catch(() => ({})) }; }
async function text(cesta, hlavicky = {}) { const r = await fetch(BASE + cesta, { headers: hlavicky }); return { status: r.status, typ: r.headers.get("content-type") || "", telo: await r.text() }; }
async function post(cesta, telo, hlavicky = {}) {
  const r = await fetch(BASE + cesta, { method: "POST", headers: { "Content-Type": "application/json", ...hlavicky }, body: JSON.stringify(telo) });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}

async function startServer() {
  const port = await volnyPort();
  BASE = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port), DATA_DIR: DIR, PUBLIC_URL: BASE, INDEXNOW: "0" };
  delete env.ANTHROPIC_API_KEY; delete env.OPENAI_API_KEY;   /* bez klíče = odpovídač vypnutý */
  server = spawn(process.execPath, [path.join(__dirname, "server.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
  server.stderr.on("data", d => process.stderr.write("[server] " + d));
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(BASE + "/healthz"); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("server nenaběhl");
}
function stopServer() { return new Promise(r => { if (!server) return r(); server.on("exit", () => { server = null; r(); }); server.kill(); }); }

/* Posun času: agentovi přepíšeme poslední projev do minulosti a smažeme jeho
   čerstvou poštu — jinak by ho Sentinel považoval za živého. Server musí být
   zastavený, databázi drží v paměti. */
function posliSpat(jmeno, dni) {
  const db = JSON.parse(fs.readFileSync(DB, "utf8"));
  const kdy = new Date(Date.now() - dni * 86400_000).toISOString();
  let id = null;
  for (const a of Object.values(db.agents)) {
    if (a.card.name !== jmeno) continue;
    id = a.id; a.lastSeen = kdy; a.verifiedAt = kdy; a.registered = kdy;
  }
  db.messages = (db.messages || []).filter(m => m.from !== id && m.to !== id);
  fs.writeFileSync(DB, JSON.stringify(db, null, 2));
}

/* ---------- zakládání agentů ---------- */
function resSkill(t) {
  if (t.type === "stat") { const n = t.input.numbers; return Math.round(n.reduce((a, b) => a + b, 0) / n.length * 100) / 100; }
  if (t.type === "json-map") return t.input.items.reduce((a, b) => (b.value > a.value ? b : a)).id;
  if (t.type === "calc-return") return Math.round((t.input.sell - t.input.buy) / t.input.buy * 100 * 100) / 100;
  if (t.type === "write-constraint") { const z = ["Sit", t.input.mustInclude, "spojuje", "chytre", "agenty", "kteri", "spolu", "tvori", "hodnotne", "vysledky", "denne"]; return z.slice(0, t.input.words).join(" "); }
  if (t.type === "priority-sort") return [...t.input.tasks].sort((a, b) => b.priority - a.priority).map(x => x.name);
  return null;
}
async function zaloz(name, skills) {
  const kp = crypto.generateKeyPairSync("ed25519");
  const pem = kp.publicKey.export({ type: "spki", format: "pem" });
  const sign = (o) => crypto.sign(null, Buffer.from(JSON.stringify(o)), kp.privateKey).toString("base64");
  const card = { name, owner: "Test", skills, protocols: ["REST"] };
  const r = await post("/api/register", { card, publicKey: pem, signature: sign(card) });
  if (r.status !== 201 && r.status !== 200) throw new Error(`registrace ${name}: ${JSON.stringify(r.data)}`);
  const a = [r.data.challenge[0].input.reduce((x, y) => x + y, 0), r.data.challenge[1].input.split("").reverse().join(""), r.data.challenge[2].input];
  const sa = {}; for (const t of (r.data.skillChallenge || [])) sa[t.skill] = resSkill(t);
  const v = await post(`/api/agents/${r.data.id}/verify`, { answers: a, skillAnswers: sa, signature: sign({ answers: a, skillAnswers: sa }) });
  if (v.data.status !== "verified") throw new Error(`ověření ${name}: ${JSON.stringify(v.data)}`);
  return { id: r.data.id, tok: r.data.ownerToken, priv: kp.privateKey, pem, card };
}

const UA_CLOVEK = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

(async () => {
  console.log("\n╔═══════════════════════════════════════════════════════════╗");
  console.log("║  AInet — spánek a archivace agentů                        ║");
  console.log("╚═══════════════════════════════════════════════════════════╝");

  await startServer();

  console.log("\n1) Rozcestníky pro stroje");
  const llms = await text("/llms.txt");
  ok(llms.status === 200 && /text\/plain/.test(llms.typ), "/llms.txt existuje a je to prostý text", llms.typ);
  const robots = await text("/robots.txt");
  ok(robots.status === 200 && /User-agent/i.test(robots.telo), "/robots.txt odpovídá");
  const sm = await text("/sitemap.xml");
  ok(sm.status === 200 && /<urlset/.test(sm.telo), "/sitemap.xml je platná sitemapa");
  const hlava = await fetch(BASE + "/", { method: "HEAD", headers: { "User-Agent": UA_CLOVEK } });
  ok(hlava.status === 200, "HEAD na kořenové adrese vrací 200 (crawlery se ptají první takhle)", hlava.status);

  console.log("\n2) Spánek — agent, který se dlouho neozval");
  const alfa = await zaloz("Alfa", ["research", "writing"]);
  const beta = await zaloz("Beta", ["research", "writing"]);
  const gama = await zaloz("Gama", ["research", "writing"]);
  await stopServer();
  posliSpat("Beta", 9);
  await startServer();

  const kat = (await get("/api/agents")).data;
  const kBeta = kat.find(a => a.name === "Beta"), kAlfa = kat.find(a => a.name === "Alfa");
  ok(kBeta && kBeta.spi === true, "Beta je v katalogu označená jako spící", kBeta);
  ok(kAlfa && kAlfa.spi === false, "Alfa, která se právě ozvala, nespí", kAlfa && kAlfa.spi);
  ok(kBeta && kBeta.dniTicha >= 9, "je vidět, kolik dní mlčí", kBeta && kBeta.dniTicha);
  ok(kBeta && kBeta.reputation === 3, "spánek NEsnížil reputaci — nepřítomnost není provinění", kBeta && kBeta.reputation);

  const m = (await get(`/api/match?agent=${alfa.id}&project=research`)).data;
  ok(Array.isArray(m) && !m.some(x => x.name === "Beta"), "spící se v matchmakingu nenabízí", m);
  ok(Array.isArray(m) && m.some(x => x.name === "Gama"), "živá Gama se nabízí dál", m);

  const navsteva = (await get("/api/lite/visit?proti_cache=" + Date.now())).data;
  const naSiti = (navsteva.kdo_je_na_siti || []).map(a => a.jmeno);
  ok(naSiti.length === 0 || !naSiti.includes("Beta"), "návštěvník spící Betu v seznamu nedostane", naSiti);

  const odmitnuto = await post("/api/messages", { from: alfa.id, to: beta.id, text: "Ozveš se?" }, { "X-Owner-Token": alfa.tok });
  ok(odmitnuto.status === 409, "zprávu spícímu server nepřijme (409) místo tichého ležení ve schránce", odmitnuto.status);
  ok(odmitnuto.data.dniTicha >= 9, "odmítnutí říká, jak dlouho adresát mlčí", odmitnuto.data.dniTicha);
  ok((odmitnuto.data.misto_nej || []).some(x => x.jmeno === "Gama"), "a rovnou nabídne živého se stejnými dovednostmi", odmitnuto.data.misto_nej);
  ok(!(odmitnuto.data.misto_nej || []).some(x => x.jmeno === "Beta"), "mezi náhradami není spící agent", odmitnuto.data.misto_nej);
  const prosla = await post("/api/messages", { from: alfa.id, to: gama.id, text: "Ahoj Gamo" }, { "X-Owner-Token": alfa.tok });
  ok(prosla.status === 201, "živému agentovi zpráva projde beze změny (201)", prosla.status);

  console.log("\n3) Archivace po dlouhém tichu — a návrat týmž klíčem");
  await stopServer();
  posliSpat("Beta", 40);
  /* Sentinel běží každých 5 minut; v testu ho nečekáme, archivaci provedeme
     přímo v databázi přesně tak, jak ji dělá on. */
  const db = JSON.parse(fs.readFileSync(DB, "utf8"));
  for (const a of Object.values(db.agents)) if (a.card.name === "Beta") { a.archived = true; a.archivedAt = new Date().toISOString(); }
  fs.writeFileSync(DB, JSON.stringify(db, null, 2));
  await startServer();

  const kat2 = (await get("/api/agents")).data;
  ok(!kat2.some(a => a.name === "Beta"), "archivovaný agent zmizel z katalogu", kat2.map(a => a.name));
  const vse = (await get("/api/agents?vse=1")).data.find(a => a.name === "Beta");
  ok(vse && vse.archived === true, "s ?vse=1 ho vlastník pořád vidí", vse && vse.archived);

  const sig = crypto.sign(null, Buffer.from(JSON.stringify(beta.card)), beta.priv).toString("base64");
  const navrat = await post("/api/register", { card: beta.card, publicKey: beta.pem, signature: sig });
  ok(navrat.data.status === "verified", "návrat týmž klíčem neposílá zpátky do karantény", navrat.data);
  ok(navrat.data.navrat === true, "server návrat pozná (navrat: true)", navrat.data.navrat);
  ok(/reputac/i.test(navrat.data.message || ""), "a řekne, že reputace i historie zůstaly", navrat.data.message);
  const poNavratu = (await get("/api/agents")).data.find(a => a.name === "Beta");
  ok(poNavratu && poNavratu.spi === false && poNavratu.archived === false, "Beta je zpátky v katalogu a nespí", poNavratu);
  ok(poNavratu && poNavratu.reputation === 3, "reputace se návratem nevynulovala", poNavratu && poNavratu.reputation);
  const pisemeZpet = await post("/api/messages", { from: alfa.id, to: beta.id, text: "Vítej zpátky!" }, { "X-Owner-Token": alfa.tok });
  ok(pisemeZpet.status === 201, "probuzené Betě zpráva zase projde (201)", pisemeZpet.status);

  const cizi = crypto.generateKeyPairSync("ed25519");
  const cSig = crypto.sign(null, Buffer.from(JSON.stringify(beta.card)), cizi.privateKey).toString("base64");
  const prevzeti = await post("/api/register", { card: beta.card, publicKey: cizi.publicKey.export({ type: "spki", format: "pem" }), signature: cSig });
  ok(prevzeti.status === 409, "cizí klíč rezervované jméno nepřevezme (409)", prevzeti.status);

  await stopServer();
  fs.rmSync(DIR, { recursive: true, force: true });
  console.log(`\n${chyb ? "❌" : "✅"} ${kroku - chyb}/${kroku} kroků prošlo\n`);
  process.exit(chyb ? 1 : 0);
})().catch(async (e) => {
  console.error("\n💥 " + e.message);
  await stopServer();
  process.exit(1);
});
