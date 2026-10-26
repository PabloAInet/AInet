#!/usr/bin/env node
/**
 * AInet — zkouška mostu (bridge-fb.js): varovné příznaky v chatu na webu.
 *
 * Co se tu ověřuje (model je podvržený, síť ani klíče nejsou potřeba):
 *   1. Varovný příznak dostane pevnou větu o 155 jako první – i v odemčené (zkušební)
 *      konverzaci; model se o ní dozví a rozhovor pokračuje, takže planý poplach
 *      („horečku nemám“) odpověď nezablokuje.
 *   2. Po limitu zpráv a za paywallem jde jen pevná věta, bez nabídky placení.
 *   3. Když model neodpoví, pevná věta stejně odejde.
 */
const { spawn } = require("child_process");
const fs = require("fs"); const os = require("os"); const path = require("path"); const net = require("net");

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ainet-most-"));
const MOCK = path.join(DIR, "mock-fetch.js");
/* podvrh fetch v procesu mostu: model (api.anthropic.com) odpoví pevným textem a zapíše, co dostal; ostatní síť → prázdná odpověď */
fs.writeFileSync(MOCK, `
const fs = require("fs");
const orig = globalThis.fetch;
let n = 0;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes("api.anthropic.com")) {
    n++;
    const body = JSON.parse(opts.body || "{}");
    const last = (body.messages || []).at(-1);
    fs.appendFileSync(process.env.MOCK_LOG, JSON.stringify({ n, user: typeof last?.content === "string" ? last.content : "", veta155: (body.system || "").includes("Tohle může být akutní stav") }) + "\\n");
    if (process.env.MOCK_FAIL === "1") return new Response("přetíženo", { status: 529 });
    return new Response(JSON.stringify({ content: [{ type: "text", text: "ODPOVED MODELU " + n }], stop_reason: "end_turn" }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (u.startsWith("http://127.0.0.1")) return orig(url, opts);
  return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
};
`);
const VETA = "Tohle může být akutní stav. Volejte prosím hned 155 nebo jeďte na pohotovost. Na odpověď z chatu nečekejte.";
let chyb = 0, kroku = 0;
const ok = (c, popis, d) => { kroku++; if (c) console.log("  ✓ " + popis); else { chyb++; console.log("  ✗ " + popis + "\n      " + JSON.stringify(d).slice(0, 400)); } };
const volnyPort = () => new Promise(r => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
let bezi = null;
async function most(env) {
  const p = await volnyPort(); const log = path.join(DIR, `model-${p}.log`); fs.writeFileSync(log, "");
  const proc = spawn(process.execPath, ["-r", MOCK, path.join(__dirname, "bridge-fb.js")], { cwd: __dirname, env: { PATH: process.env.PATH, PORT: String(p), ANTHROPIC_API_KEY: "x", VERIFY_TOKEN: "v", PAGE_ACCESS_TOKEN: "t", AINET_TOKEN: "a", AINET_BASE: "http://ainet.mock", MOCK_LOG: log, ...env }, stdio: ["ignore", "ignore", "pipe"] });
  proc.stderr.on("data", d => process.stderr.write("[most] " + d));
  bezi = proc;
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${p}/web/chat`, { method: "OPTIONS" }); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  const chat = async (id, text) => { const r = await fetch(`http://127.0.0.1:${p}/web/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, text }) }); return { st: r.status, ...(await r.json()) }; };
  const model = () => fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  return { chat, model, stop: () => new Promise(r => { proc.on("exit", r); proc.kill(); }) };
}

(async () => {
  console.log("\n╔═══════════════════════════════════════════════════════════╗");
  console.log("║  AInet — most: varovné příznaky v chatu na webu           ║");
  console.log("╚═══════════════════════════════════════════════════════════╝");

  console.log("\n1) Zkušební provoz (2 otázky zdarma)");
  let m = await most({ ZDARMA_SMYCEK: "2" });
  let r = await m.chat("normalni01", "Dobrý den, chci se objednat.");
  ok(r.st === 200 && r.odpoved === "ODPOVED MODELU 1", "běžná zpráva: jen odpověď modelu", r);
  let z = m.model().at(-1);
  ok(z && !/pevnou větu o 155/.test(z.user) && z.veta155, "model nedostal poznámku o 155; pevná věta je v jeho pravidlech", z);
  r = await m.chat("varovani01", "Náhle mi otekla a bolí noha, co mám dělat?");
  ok(r.st === 200 && r.odpoved.startsWith(VETA + "\n\n") && /ODPOVED MODELU/.test(r.odpoved), "varovný příznak: nejdřív pevná věta, pak odpověď modelu", r);
  z = m.model().at(-1);
  ok(z && /systém pacientovi právě poslal pevnou větu o 155/.test(z.user), "model ví, že věta už odešla", z);
  r = await m.chat("plany0001", "Jsem týden po operaci kýly, horečku nemám. Kdy můžu do práce?");
  ok(r.st === 200 && r.odpoved.startsWith(VETA) && /ODPOVED MODELU/.test(r.odpoved), "planý poplach („horečku nemám“) odpověď nezablokuje", r);
  await m.chat("limit00001", "Mám hemoroidy, co pomáhá?");
  r = await m.chat("limit00001", "A co vláknina?");
  ok(r.zkusebni === true, "po 2. otázce přechod do zkušební placené konzultace (beze změny)", r);
  r = await m.chat("limit00001", "Teď mám černou stolici a jsem slabý.");
  ok(r.st === 200 && r.odpoved.startsWith(VETA) && /ODPOVED MODELU/.test(r.odpoved), "varovný příznak i v odemčené konverzaci", r);
  await m.stop();

  console.log("\n2) Bez limitu bezplatných otázek, nejvýš 2 zprávy");
  m = await most({ LIMIT_ZDARMA: "0", MAX_ZPRAV: "2" });
  await m.chat("cap0000001", "Otázka jedna"); await m.chat("cap0000001", "Otázka dvě");
  const pocet = m.model().length;
  r = await m.chat("cap0000001", "Mám dušnost a bolest na hrudi");
  ok(r.st === 200 && r.odpoved === VETA && m.model().length === pocet, "po limitu zpráv: jen pevná věta, model se nevolá", r);
  r = await m.chat("cap0000001", "Ještě jedna otázka");
  ok(/uzavřel/.test(r.odpoved), "po limitu bez varování: původní uzavírací věta", r);
  r = await m.chat("bezlimit01", "zmodralá noha");
  ok(r.odpoved.startsWith(VETA), "s vypnutým limitem se varovné příznaky kontrolují", r);
  await m.stop();

  console.log("\n3) Ostrá platba (1 otázka zdarma)");
  m = await most({ ZDARMA_SMYCEK: "1", PLATBA_URL: "https://buy.stripe.com/ostry" });
  r = await m.chat("platba0001", "Jak dlouho se hojí laser?");
  ok(r.platba && /ODPOVED MODELU/.test(r.odpoved), "po poslední bezplatné odpovědi platební odkaz (beze změny)", r);
  r = await m.chat("platba0001", "Silně krvácí z konečníku");
  ok(r.odpoved === VETA && !r.platba, "za paywallem varovný příznak: jen pevná věta, žádná nabídka placení", r);
  r = await m.chat("platba0001", "A ještě otázka");
  ok(r.platba && !r.odpoved.includes(VETA), "další běžná zpráva: paywall jako dřív", r);
  await m.stop();

  console.log("\n4) Model nedostupný");
  m = await most({ MOCK_FAIL: "1" });
  r = await m.chat("chyba00001", "bezvědomí u manžela");
  ok(r.st === 200 && r.odpoved === VETA, "varovný příznak: pevná věta, i když model neodpoví", r);
  r = await m.chat("chyba00002", "Kdy je ordinace?");
  ok(r.st === 500 && /Omlouvám se/.test(r.odpoved), "běžná zpráva: omluva jako dřív", r);
  await m.stop();

  fs.rmSync(DIR, { recursive: true, force: true });
  console.log(`\n${chyb ? "❌" : "✅"} ${kroku - chyb}/${kroku} kroků prošlo\n`);
  process.exit(chyb ? 1 : 0);
})().catch(e => { console.error("\n💥 " + e.message); if (bezi) bezi.kill(); process.exit(1); });
