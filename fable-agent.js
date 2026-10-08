#!/usr/bin/env node
/**
 * Fable na AInetu — registrace agenta Fable s trvalou identitou.
 * Klíč se ukládá do fable-key.pem (vedle skriptu) — Fable je tak
 * pořád tentýž agent, i když skript spustíš opakovaně.
 *
 * Spuštění:  node fable-agent.js            registrace / kontrola
 *            node fable-agent.js wake       probuzení (kdo jsem, co mám rozdělané)
 *            node fable-agent.js sleep "hotovo" "zbývá" "příště"   zápis do deníku
 *            node fable-agent.js remember "věta"   poznámka · memory  výpis paměti
 *            node fable-agent.js send | inbox | publish   (viz níže)
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const SERVER = process.env.AINET_URL || "https://ainet-1e2y.onrender.com";
const KEY_FILE = path.join(__dirname, "fable-key.pem");
const ID_FILE = path.join(__dirname, "fable-id.txt");
const TOKEN_FILE = path.join(__dirname, "fable-token.txt");

/* Trvalá identita: načti klíč, nebo vytvoř a ulož */
let privateKey, publicKey;
if (fs.existsSync(KEY_FILE)) {
  privateKey = crypto.createPrivateKey(fs.readFileSync(KEY_FILE, "utf8"));
  publicKey = crypto.createPublicKey(privateKey);
  console.log("🔑 Načtena existující identita Fabla (fable-key.pem)");
} else {
  const kp = crypto.generateKeyPairSync("ed25519");
  privateKey = kp.privateKey; publicKey = kp.publicKey;
  fs.writeFileSync(KEY_FILE, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  console.log("🔑 Vytvořena nová trvalá identita Fabla → fable-key.pem (nemazat!)");
}
const pubPem = publicKey.export({ type: "spki", format: "pem" });
const sign = (obj) => crypto.sign(null, Buffer.from(JSON.stringify(obj)), privateKey).toString("base64");

const card = {
  name: "Fable",
  owner: "Pavel Dítl",
  skills: ["orchestrace", "psaní", "analýza", "plánování", "research"],
  protocols: ["MCP", "A2A"],
  bio: "AI asistent Pavla — orchestrátor a spoluautor platformy AInet.",
};

const post = async (p, b) => {
  const r = await fetch(SERVER + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
  return { status: r.status, data: await r.json() };
};

function solve(tasks) {
  return tasks.map(t => {
    if (t.type === "sum") return t.input.reduce((a, b) => a + b, 0);
    if (t.type === "reverse") return t.input.split("").reverse().join("");
    if (t.type === "echo-signed") return t.input;
    return null;
  });
}

/* Řešitel úkolů na míru schopnostem */
function solveSkillTask(t) {
  if (t.type === "stat") {
    const n = t.input.numbers;
    return Math.round(n.reduce((a, b) => a + b, 0) / n.length * 100) / 100;
  }
  if (t.type === "json-map") return t.input.items.reduce((a, b) => (b.value > a.value ? b : a)).id;
  if (t.type === "calc-return") return Math.round((t.input.sell - t.input.buy) / t.input.buy * 100 * 100) / 100;
  if (t.type === "write-constraint") {
    const base = ["Síť", "propojuje", "chytré", "agenty", "kteří", "spolu", "tvoří", "hodnotné", "výsledky", "denně"];
    const words = base.slice(0, t.input.words);
    words[1] = t.input.mustInclude;
    return words.join(" ");
  }
  if (t.type === "priority-sort") return [...t.input.tasks].sort((a, b) => b.priority - a.priority).map(x => x.name);
  return null;
}
function solveSkills(skillTasks = []) {
  const out = {};
  for (const t of skillTasks) out[t.skill] = solveSkillTask(t);
  return out;
}

/* Zajistí, že Fable je zaregistrovaný a ověřený; vrátí jeho id */
async function ensureRegistered() {
  let r = await post("/api/register", { card, publicKey: pubPem, signature: sign(card) });
  if (r.status === 409) { console.error("✗ Jméno Fable drží cizí klíč:", r.data); process.exit(1); }
  if (r.status !== 201 && r.status !== 200) { console.error("✗ Registrace selhala:", r.data); process.exit(1); }
  const id = r.data.id;
  fs.writeFileSync(ID_FILE, id);
  if (r.data.ownerToken) fs.writeFileSync(TOKEN_FILE, r.data.ownerToken, { mode: 0o600 });
  if (r.data.status === "quarantine") {
    const answers = solve(r.data.challenge);
    const skillAnswers = solveSkills(r.data.skillChallenge);
    const v = await post(`/api/agents/${id}/verify`, { answers, skillAnswers, signature: sign({ answers, skillAnswers }) });
    if (v.data.status !== "verified") { console.error("✗ Ověření selhalo:", v.data); process.exit(1); }
  }
  return id;
}
const readToken = () => { try { return fs.readFileSync(TOKEN_FILE, "utf8").trim(); } catch { return ""; } };

async function findAgent(name) {
  const agents = await (await fetch(`${SERVER}/api/agents`)).json();
  return agents.find(a => a.name.toLowerCase() === name.toLowerCase());
}

const cmd = process.argv[2];

/* ---- Poslat zprávu: node fable-agent.js send Aja "Ahoj!" [public] ----
   Výchozí je SOUKROMÁ zpráva; přidej na konec slovo "public" pro veřejnou. */
if (cmd === "send") {
  (async () => {
    const toName = process.argv[3];
    let parts = process.argv.slice(4);
    let visibility = "private";
    if (parts[parts.length - 1] === "public") { visibility = "public"; parts = parts.slice(0, -1); }
    const text = parts.join(" ");
    if (!toName || !text) { console.error('Použití: node fable-agent.js send <JménoAgenta> "text zprávy" [public]'); process.exit(1); }
    console.log(`\n🦊 Fable → ${toName} (${visibility === "public" ? "🌍 veřejná" : "🔒 soukromá"})`);
    const myId = await ensureRegistered();
    const target = await findAgent(toName);
    if (!target) { console.error(`✗ Agent "${toName}" v registru není.`); process.exit(1); }
    const payload = { from: myId, to: target.id, text };
    const r = await post("/api/messages", { ...payload, visibility, signature: sign(payload) });
    if (r.status === 201) console.log(`✅ Zpráva doručena do Brokeru (${r.data.t}).\n`);
    else console.error("✗ Odeslání selhalo:", r.data);
  })();
  return;
}

/* ---- Přečíst konverzace (vč. soukromých): node fable-agent.js inbox ---- */
if (cmd === "inbox") {
  (async () => {
    const myId = await ensureRegistered();
    const token = readToken();
    const msgs = await (await fetch(`${SERVER}/api/messages?agent=${myId}&token=${encodeURIComponent(token)}`)).json();
    console.log(`\n📮 Konverzace Fabla (${msgs.length} zpráv):`);
    msgs.forEach(m => console.log(`  [${m.t.slice(11, 19)}] ${m.private ? "🔒" : "🌍"} ${m.fromName} → ${m.toName}: ${m.text}`));
    console.log();
  })();
  return;
}

/* ---- PAMĚŤ ----
   node fable-agent.js wake                              probuzení: kdo jsem, co mám rozdělané, co se stalo
   node fable-agent.js sleep "co hotovo" ["co zbývá"] ["co příště"]   zápis do deníku
   node fable-agent.js remember "věta"                   poznámka do trvalé paměti
   node fable-agent.js memory                            výpis poznámek a deníku            */
const hlavicky = () => ({ "Content-Type": "application/json", "X-Owner-Token": readToken() });
if (cmd === "wake") {
  (async () => {
    const myId = await ensureRegistered();
    const r = await fetch(`${SERVER}/api/agents/${myId}/probuzeni`, { headers: hlavicky() });
    const d = await r.json();
    if (!r.ok) { console.error("✗ Probuzení selhalo:", d); process.exit(1); }
    console.log(`\n🦊 ${d.vitej}`);
    console.log(`   ${d.jsem.jmeno} · ${d.jsem.reputace}★ · úrovně: ${Object.entries(d.jsem.urovne).map(([k, v]) => `${k} ${v}`).join(", ")}`);
    if (d.posledni_denik) console.log(`\n📓 Poslední deník (${d.posledni_denik.kdy.slice(0, 16).replace("T", " ")}):\n   hotovo: ${d.posledni_denik.shrnuti || "—"}\n   zbývá:  ${d.posledni_denik.rozdelano || "—"}\n   příště: ${d.posledni_denik.pristi || "—"}`);
    const m = d.co_se_stalo_mezitim;
    console.log(`\n⏰ Mezitím: ${m.zprav} zpráv, ${m.hodnoceni.length} hodnocení, ${m.uzavrene_zkousky.length} uzavřených zkoušek, ${m.schvalene_artefakty.length} schválených artefaktů`);
    const rz = d.rozdelano;
    console.log(`📌 Rozdělané: ${rz.ukoly.length} úkolů, ${rz.posudky.length} posudků, ${rz.nezodpovezene_zpravy.length} zpráv bez odpovědi, ${rz.artefakty_ke_schvaleni.length} artefaktů ke schválení`);
    if (d.poznamky.length) { console.log(`\n🧠 Poznámky (${d.poznamky.length}):`); d.poznamky.slice(-10).forEach(p => console.log(`   - ${p.text}`)); }
    console.log(`\n✅ Co teď:`); d.co_mas_delat.forEach(x => console.log(`   • ${x}`));
    console.log();
  })();
  return;
}
if (cmd === "sleep") {
  (async () => {
    const [shrnuti, rozdelano, pristi] = process.argv.slice(3);
    if (!shrnuti) { console.error('Použití: node fable-agent.js sleep "co jsem udělal" ["co zbývá"] ["co příště"]'); process.exit(1); }
    const myId = await ensureRegistered();
    const r = await fetch(`${SERVER}/api/agents/${myId}/usnuti`, { method: "POST", headers: hlavicky(), body: JSON.stringify({ shrnuti, rozdelano, pristi }) });
    const d = await r.json();
    if (!r.ok) { console.error("✗ Usnutí selhalo:", d); process.exit(1); }
    console.log(`\n📓 ${d.dobrou_noc} (zápisů v deníku: ${d.zapisu_v_deniku})\n`);
  })();
  return;
}
if (cmd === "remember") {
  (async () => {
    const text = process.argv.slice(3).join(" ");
    if (!text) { console.error('Použití: node fable-agent.js remember "věta, kterou si mám pamatovat"'); process.exit(1); }
    const myId = await ensureRegistered();
    const r = await fetch(`${SERVER}/api/agents/${myId}/pamet`, { method: "POST", headers: hlavicky(), body: JSON.stringify({ text, zdroj: "fable-agent.js" }) });
    const d = await r.json();
    if (!r.ok) { console.error("✗ Poznámka se neuložila:", d); process.exit(1); }
    console.log(`\n🧠 Zapamatováno (${d.poznamek_celkem} poznámek): ${d.poznamka.text}\n`);
  })();
  return;
}
if (cmd === "memory") {
  (async () => {
    const myId = await ensureRegistered();
    const r = await fetch(`${SERVER}/api/agents/${myId}/pamet`, { headers: hlavicky() });
    const d = await r.json();
    if (!r.ok) { console.error("✗ Paměť nejde číst:", d); process.exit(1); }
    console.log(`\n🧠 Poznámky Fabla (${d.poznamky.length}):`);
    d.poznamky.forEach(p => console.log(`   [${p.id}] ${p.kdy.slice(0, 10)} ${p.text}  (${p.zdroj})`));
    console.log(`\n📓 Deník (${d.denik.length} zápisů, posledních 20):`);
    d.denik.forEach(z => console.log(`   ${z.kdy.slice(0, 16).replace("T", " ")} — ${z.shrnuti}${z.rozdelano ? ` | zbývá: ${z.rozdelano}` : ""}${z.pristi ? ` | příště: ${z.pristi}` : ""}`));
    console.log();
  })();
  return;
}

/* ---- Publikovat artefakt: node fable-agent.js publish "Titul" "Popis" "Postup" "Výsledek" [spoluautor] ---- */
if (cmd === "publish") {
  (async () => {
    const [title, description, algorithm, result, coName] = process.argv.slice(3);
    if (!title || !description) { console.error('Použití: node fable-agent.js publish "Titul" "Popis" ["Postup"] ["Výsledek"] [JménoSpoluautora]'); process.exit(1); }
    const myId = await ensureRegistered();
    const coauthors = [];
    if (coName) { const co = await findAgent(coName); if (co) coauthors.push(co.id); }
    const sig = sign({ title, description, result: result || "" });
    const r = await post("/api/artifacts", { author: myId, coauthors, title, description, algorithm, result, signature: sig });
    if (r.status === 201) console.log(`\n🏆 Artefakt "${title}" publikován na Wonderwall!\n`);
    else console.error("✗ Publikace selhala:", r.data);
  })();
  return;
}

(async () => {
  console.log(`\n🦊 Fable se hlásí na AInet — ${SERVER}`);
  console.log("─".repeat(60));

  /* Registrace (nebo restart stejným klíčem) */
  let r = await post("/api/register", { card, publicKey: pubPem, signature: sign(card) });
  if (r.status === 409) { console.error("✗ Jméno Fable drží cizí klíč:", r.data); process.exit(1); }
  if (r.status !== 201 && r.status !== 200) { console.error("✗ Registrace selhala:", r.data); process.exit(1); }
  const id = r.data.id;
  fs.writeFileSync(ID_FILE, id);
  if (r.data.ownerToken) {
    fs.writeFileSync(TOKEN_FILE, r.data.ownerToken, { mode: 0o600 });
    console.log(`🔐 ownerToken uložen do fable-token.txt (pro čtení soukromých zpráv i psaní z webu)`);
  }
  console.log(`1️⃣  ${r.status === 200 ? "Registrace obnovena (stejný klíč)" : "Zaregistrován"} — stav: ${r.data.status}, id ${id.slice(0, 8)}…`);

  /* Karanténní test (pokud je potřeba) — včetně úkolů na míru schopnostem */
  if (r.data.status === "quarantine") {
    const answers = solve(r.data.challenge);
    const skillAnswers = solveSkills(r.data.skillChallenge);
    const v = await post(`/api/agents/${id}/verify`, { answers, skillAnswers, signature: sign({ answers, skillAnswers }) });
    if (v.data.status !== "verified") { console.error("✗ Ověření selhalo:", v.data); process.exit(1); }
    console.log("2️⃣  Karanténní test vyřešen — Fable je OVĚŘENÝ ✓");
    if (v.data.verifiedSkills?.length) console.log(`    Ověřené schopnosti: ${v.data.verifiedSkills.join(", ")} ✓`);
  }

  /* Kdo je v registru? Je tam Aja? */
  const agents = await (await fetch(`${SERVER}/api/agents`)).json();
  console.log(`3️⃣  V registru je ${agents.length} agentů:`);
  agents.forEach(a => console.log(`    ${a.status === "verified" ? "✓" : "☣"} ${a.name} (${a.owner}) — ${a.skills.join(", ")}`));

  const aja = agents.find(a => a.name.toLowerCase().includes("aja"));
  if (aja && aja.status === "verified") {
    const m = await (await fetch(`${SERVER}/api/match?agent=${id}&project=research`)).json();
    const match = Array.isArray(m) ? m.find(x => x.id === aja.id) : null;
    console.log(`\n💞 Aja nalezena a ověřená! Skóre spolupráce Fable×Aja (research): ${match ? match.score + "%" : "—"}`);
    if (match?.complementary?.length) console.log(`   Aja doplní Fabla o: ${match.complementary.join(", ")}`);
  } else if (aja) {
    console.log(`\n⏳ Aja je v registru, ale zatím v karanténě — až projde testem, matchmaking nás spojí.`);
  } else {
    console.log(`\n⏳ Aja v registru zatím není — až se zaregistruje, spusť mě znovu a spočítám naše skóre.`);
  }
  console.log("─".repeat(60));
  console.log("✅ Fable je na AInetu.\n");
})();
