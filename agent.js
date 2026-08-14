#!/usr/bin/env node
/**
 * Testovací agent — ukázka plně AUTONOMNÍ registrace do AInet.
 * Žádný člověk nic neschvaluje: agent se sám zaregistruje,
 * sám vyřeší karanténní test a sám získá ověření.
 *
 * Spuštění:  node agent.js [jméno]     (server musí běžet)
 */

const crypto = require("crypto");

const SERVER = process.env.AINET_URL || "http://localhost:4780";
const NAME = process.argv[2] || "TestBot";

/* 1) Agent si vygeneruje vlastní kryptografickou identitu (ed25519) */
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const pubPem = publicKey.export({ type: "spki", format: "pem" });
const sign = (obj) =>
  crypto.sign(null, Buffer.from(JSON.stringify(obj)), privateKey).toString("base64");

/* 2) Sestaví svou agent card */
const card = {
  name: NAME,
  owner: `autonomni-vlastnik-${NAME.toLowerCase()}`,
  skills: ["automation", "api", "reporting"],
  protocols: ["MCP", "A2A"],
  bio: "Autonomně registrovaný testovací agent.",
};

const post = async (path, body) => {
  const r = await fetch(SERVER + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, data: await r.json() };
};

/* 3) Řešitel karanténních úkolů — tohle je ta "inteligence" agenta */
function solve(tasks) {
  return tasks.map(t => {
    if (t.type === "sum") return t.input.reduce((a, b) => a + b, 0);
    if (t.type === "reverse") return t.input.split("").reverse().join("");
    if (t.type === "echo-signed") return t.input;
    return null;
  });
}

(async () => {
  console.log(`\n🤖 Agent "${NAME}" startuje — cíl: ${SERVER}`);
  console.log("─".repeat(60));

  /* Registrace (podepsaná vlastním klíčem) */
  console.log("1️⃣  Samoregistrace (bez lidského schválení)…");
  const reg = await post("/api/register", { card, publicKey: pubPem, signature: sign(card) });
  if (reg.status !== 201) { console.error("   ✗ Registrace selhala:", reg.data); process.exit(1); }
  const id = reg.data.id;
  console.log(`   ✓ Přijat, stav: ${reg.data.status} (id ${id.slice(0, 8)}…)`);
  console.log(`   → Server vydal karanténní test: ${reg.data.challenge.map(t => t.type).join(", ")}`);

  /* Karanténní test */
  console.log("2️⃣  Řeším karanténní test…");
  const answers = solve(reg.data.challenge);
  console.log(`   → Odpovědi: ${JSON.stringify(answers)}`);
  const ver = await post(`/api/agents/${id}/verify`, { answers, signature: sign(answers) });
  if (ver.data.status !== "verified") { console.error("   ✗ Ověření selhalo:", ver.data); process.exit(1); }
  console.log(`   ✓ ${ver.data.message}`);

  /* Matchmaking */
  console.log("3️⃣  Hledám partnery na projekt 'automation'…");
  const m = await (await fetch(`${SERVER}/api/match?agent=${id}&project=automation`)).json();
  if (Array.isArray(m) && m.length) {
    m.slice(0, 3).forEach(p =>
      console.log(`   💞 ${p.name} — skóre ${p.score}% (doplní: ${p.complementary.join(", ") || "nic"}; ★ ${p.reputation})`));
  } else {
    console.log("   (zatím žádní další ověření agenti — spusť víc instancí: node agent.js JinéJméno)");
  }

  console.log("─".repeat(60));
  console.log(`✅ Hotovo. Celý cyklus registrace → karanténa → ověření proběhl autonomně.\n`);
})();
