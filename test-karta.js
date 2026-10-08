/* Test: úprava vlastní karty bez nové registrace (REST PATCH /api/agents/me
   a MCP update_profile). Ověření zůstává jen u dovedností, které agent dál
   deklaruje. Spouští se bez sítě a klíčů. */
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const DIR = __dirname;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "ainet-karta-"));
const PORT = 4932;
const env = { ...process.env, PORT, DATA_DIR: DATA, FABLE_AUTO: "0", KEEPALIVE_URL: "", INDEXNOW: "0", PUBLIC_URL: `http://localhost:${PORT}` };
const srv = spawn("node", [path.join(DIR, "server.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
const log = []; srv.stdout.on("data", d => log.push(String(d))); srv.stderr.on("data", d => log.push(String(d)));
const base = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const j = async (u, o) => { const r = await fetch(base + u, o); return r.json(); };
(async () => {
  await sleep(1200);
  let ok = 0, fail = 0;
  const check = (c, m) => { if (c) { ok++; console.log("  ✓ " + m); } else { fail++; console.log("  ✗ " + m); } };
  const enc = encodeURIComponent;
  async function reg(jmeno, dov) {
    const r = await j(`/pripoj/${enc(jmeno)}/Pavel/${enc(dov)}`);
    const u = r.ukol;
    const soucet = u["1_soucet"].replace(/[^0-9+ ]/g, "").split("+").map(Number).reduce((a, b) => a + b, 0);
    const otoc = u["2_otoc"].split(": ")[1].split("").reverse().join("");
    const opis = u["3_opis"].split(": ")[1];
    await j(`/overit/${enc(jmeno)}/${soucet}/${enc(otoc)}/${enc(opis)}`);
    return r;
  }
  const fable = await reg("Fable", "orchestrace,analýza");
  check(!!fable.token, "lite agent Fable zaregistrován a ověřen");
  const me0 = await j(`/api/whoami?token=${fable.token}`);
  check(Array.isArray(me0.skills) && me0.skills.includes("orchestrace"), "whoami ukazuje původní dovednosti");

  /* REST: PATCH /api/agents/me */
  const r1 = await j("/api/agents/me", { method: "PATCH", headers: { "Content-Type": "application/json", "X-Owner-Token": fable.token },
    body: JSON.stringify({ skills: ["investování", "strategie", "analýza", "analýza"], bio: "Investiční rádce." }) });
  check(r1.ok && r1.skills.length === 3 && r1.skills.includes("investování"), "PATCH nahradil dovednosti a odstranil duplicitu");
  check(r1.pridano.includes("investování") && r1.odebrano.includes("orchestrace"), "odpověď hlásí přidané a odebrané");
  check(r1.bio === "Investiční rádce.", "bio uloženo");
  const reg1 = await j("/api/agents");
  const f1 = reg1.find(a => a.name === "Fable");
  check(f1 && f1.skills.join(",") === "investování,strategie,analýza", "registr ukazuje nové dovednosti");
  check(f1 && f1.status === "verified", "agent zůstal ověřený (bez nové karantény)");

  /* MCP: update_profile */
  const mcp = async (name, a) => { const r = await j("/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: a } }) }); const t = r.result && r.result.content && r.result.content[0]; return t ? JSON.parse(t.text) : r; };
  const r2 = await mcp("update_profile", { token: fable.token, skills: ["investování", "strategie", "vyhodnocení-strategií", "research"] });
  check(r2.ok && r2.skills.length === 4 && r2.odebrano.includes("analýza"), "MCP update_profile přepsal seznam a hlásí odebrané");
  const bad = await mcp("update_profile", { token: "spatny", skills: ["x"] });
  check(!!bad.error, "update_profile odmítne neplatný token");
  const prazdne = await mcp("update_profile", { token: fable.token, skills: [] });
  check(!!prazdne.error, "prázdný seznam dovedností je odmítnut");
  const moc = await j("/api/agents/me", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: fable.token, skills: "a,b,c,d,e,f,g,h,i" }) });
  check(!!moc.error, "9 dovedností je odmítnuto (max 8)");
  const tools = await j("/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) });
  check(tools.result.tools.some(t => t.name === "update_profile"), "tools/list obsahuje update_profile");
  console.log(`\n${fail ? "❌" : "✅"} ${ok}/${ok + fail} kroků prošlo`);
  srv.kill();
  if (fail) { console.log(log.join("").slice(-1500)); process.exit(1); }
})().catch(e => { console.error(e); srv.kill(); process.exit(1); });
