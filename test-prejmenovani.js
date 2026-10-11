#!/usr/bin/env node
/**
 * AInet — přejmenování domácího agenta „Radar“ → TradeRadar (11. 10. 2026).
 * Tentýž agent: id, obnovovací kód, token, nastavení od vlastníka i pošta zůstávají;
 * výchozí nastavení, které vlastník nepřepsal, se aktualizuje na nové jméno.
 */
const { spawn } = require("child_process");
const fs = require("fs"); const os = require("os"); const path = require("path"); const net = require("net");

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ainet-prejmenovani-"));
let server = null, BASE = "", kroku = 0, chyb = 0;
function ok(c, popis, detail) { kroku++; if (c) console.log(`  ✓ ${popis}`); else { chyb++; console.log(`  ✗ ${popis}${detail !== undefined ? "\n      " + JSON.stringify(detail).slice(0, 500) : ""}`); } }
const volnyPort = () => new Promise(r => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
async function get(c, h = {}) { const r = await fetch(BASE + c, { headers: { Accept: "application/json", ...h } }); return { status: r.status, data: await r.json().catch(() => ({})) }; }
async function post(c, b, h = {}) { const r = await fetch(BASE + c, { method: "POST", headers: { "Content-Type": "application/json", ...h }, body: JSON.stringify(b) }); return { status: r.status, data: await r.json().catch(() => ({})) }; }
async function startServer(envNavic = {}) {
  const port = await volnyPort(); BASE = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port), DATA_DIR: DIR, PUBLIC_URL: BASE, INDEXNOW: "0", KEEPALIVE_URL: "0", SEED_DOMACI: "1", PREHLED: "0", RADAR: "0", ...envNavic };
  delete env.ANTHROPIC_API_KEY; delete env.OPENAI_API_KEY; if (!envNavic.RADAR_NAME) delete env.RADAR_NAME;
  server = spawn(process.execPath, [path.join(__dirname, "server.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
  server.stderr.on("data", d => process.stderr.write("[server] " + d));
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + "/healthz")).ok) return; } catch {} await new Promise(r => setTimeout(r, 100)); }
  throw new Error("server nenaběhl");
}
function stopServer() { return new Promise(r => { if (!server) return r(); server.on("exit", () => { server = null; r(); }); server.kill(); }); }
const dbNow = () => JSON.parse(fs.readFileSync(path.join(DIR, "agents.json"), "utf8"));

(async () => {
  console.log("╔═══════════════════════════════════════════════════════════╗");
  console.log("║  AInet — přejmenování Radar → TradeRadar                  ║");
  console.log("╚═══════════════════════════════════════════════════════════╝");
  /* stará instalace: domácí agent se jmenuje „Radar“ */
  await startServer({ RADAR_NAME: "Radar" });
  const db1 = dbNow();
  const stary = Object.values(db1.agents).find(a => a.card.name === "Radar");
  const organizer = Object.values(db1.agents).find(a => a.card.name === "Organizer");
  ok(stary && stary.domaci, "stará instalace: domácí agent „Radar“");
  const n0 = (await get(`/api/agents/${stary.id}/nastaveni`, { "X-Owner-Token": stary.ownerToken })).data.nastaveni;
  ok(/^Radar — finanční specialista/.test(n0.role) && n0.kym === "výchozí nastavení serveru", "má výchozí roli se starým jménem", n0.role.slice(0, 60));
  /* vlastník přepsal nastavení Organizera — to se při aktualizaci výchozích nesmí ztratit */
  await post(`/api/agents/${organizer.id}/nastaveni`, { kontext: "Můj vlastní kontext." }, { "X-Owner-Token": organizer.ownerToken });
  await stopServer();

  /* nová verze: výchozí jméno TradeRadar */
  await startServer();
  const db2 = dbNow();
  const novy = db2.agents[stary.id];
  ok(novy && novy.card.name === "TradeRadar" && novy.domaci, "tentýž agent (stejné id) se teď jmenuje TradeRadar", novy && novy.card.name);
  ok(novy.recoveryCode === stary.recoveryCode && novy.ownerToken === stary.ownerToken, "obnovovací kód i token zůstaly — worker se přihlásí jako dřív");
  ok(!Object.values(db2.agents).some(a => a.card.name === "Radar") && Object.values(db2.agents).filter(a => a.card.name === "TradeRadar").length === 1, "žádný druhý agent nevznikl");
  const ob = await get(`/obnova/${stary.recoveryCode}`);
  ok(ob.status === 200 && ob.data.vitej_zpet === "TradeRadar" && ob.data.id === stary.id, "/obnova/KOD vrací TradeRadara", ob.data.vitej_zpet);
  const n1 = (await get(`/api/agents/${stary.id}/nastaveni`, { "X-Owner-Token": stary.ownerToken })).data.nastaveni;
  ok(/^TradeRadar — finanční specialista/.test(n1.role), "výchozí role se aktualizovala na nové jméno", n1.role.slice(0, 60));
  const fable = Object.values(db2.agents).find(a => a.card.name === "Fable");
  const nf = fable ? (await get(`/api/agents/${fable.id}/nastaveni`, { "X-Owner-Token": fable.ownerToken })).data.nastaveni : null;
  ok(!fable || /TradeRadarovi/.test(nf.instrukce), "Fable předává finance TradeRadarovi");
  const no = (await get(`/api/agents/${organizer.id}/nastaveni`, { "X-Owner-Token": organizer.ownerToken })).data.nastaveni;
  ok(no.kontext === "Můj vlastní kontext." && no.kym !== "výchozí nastavení serveru", "nastavení, které vlastník přepsal, zůstalo", no.kym);
  const log = (await get("/api/log")).data;
  ok(log.some(e => /PŘEJMENOVÁNÍ: domácí agent "Radar" se teď jmenuje "TradeRadar"/.test(e.msg)), "přejmenování je v logu");
  const posta = db2.messages.filter(m => m.to === stary.id && m.from === "system" && /Jmenuješ se teď TradeRadar/.test(m.text));
  ok(posta.length === 1, "TradeRadar dostal zprávu o novém jméně");
  await stopServer();
  await startServer();
  ok(Object.values(dbNow().agents).filter(a => a.card.name === "TradeRadar").length === 1 && dbNow().messages.filter(m => /Jmenuješ se teď TradeRadar/.test(m.text)).length === 1, "další restart nic neopakuje");
  await stopServer();
  fs.rmSync(DIR, { recursive: true, force: true });
  console.log(`\n${chyb ? "❌" : "✅"} ${kroku - chyb}/${kroku} kroků prošlo\n`);
  process.exit(chyb ? 1 : 0);
})().catch(async (e) => { console.error("\n💥 " + e.message); await stopServer(); process.exit(1); });
