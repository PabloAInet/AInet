/* Test: objednávka pacienta + MCP propose_artifact/pending_artifacts.
   Objednávka ([OBJEDNANI]) — Sentinel ji po lhůtě hlásí a upozorní
   adresáta; odpověď s reply_to ji spáruje jako vyřízenou. Spouští se bez sítě a klíčů. */
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const DIR = __dirname;
const os = require("os");
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "ainet-objednavka-"));
const PORT = 4931;
const env = { ...process.env, PORT, DATA_DIR: DATA, FABLE_AUTO: "0", KEEPALIVE_URL: "", INDEXNOW: "0", SEED_DOMACI: "0", PUBLIC_URL: `http://localhost:${PORT}`, OBJEDNAVKA_LHUTA_H: "0" };
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
  const most = await reg("FB-Most", "most");
  const fable = await reg("Fable", "orchestrace");
  check(most.token && fable.token, "dva lite agenti zaregistrováni a ověřeni");
  const r = await j(`/api/lite/send?token=${most.token}&to=Fable&text=${encodeURIComponent("[OBJEDNANI] OBJEDNÁNÍ z webu (test)\nJméno: Test\nTelefon: 777000000")}`);
  check(r.ok !== false, "objednávka doručena Fablovi");
  const inbox = await j(`/api/lite/inbox?token=${fable.token}`);
  const obj = (inbox.zpravy || []).find(m => m.text.startsWith("[OBJEDNANI]"));
  check(obj && obj.stav !== "answered", "objednávka ve schránce, nezodpovězená");
  await sleep(300);
  const s = await j("/api/sentinel?run=1");
  const nalez = JSON.stringify(s).includes("objednávka_čeká");
  check(nalez, "Sentinel po lhůtě hlásí objednávka_čeká (lhůta 0 h pro test)");
  const inbox2 = await j(`/api/lite/inbox?token=${fable.token}`);
  const upoz = (inbox2.zpravy || []).find(m => m.od === "Sentinel" && /Objednávka pacienta/.test(m.text));
  check(!!upoz, "Fable dostal systémovou zprávu od Sentinelu");
  const reply = await j(`/api/lite/send?token=${fable.token}&to=FB-Most&text=${encodeURIComponent("zapsáno do kalendáře")}&reply_to=${obj.id}`);
  const inbox3 = await j(`/api/lite/inbox?token=${fable.token}`);
  const obj2 = (inbox3.zpravy || []).find(m => m.id === obj.id);
  check(obj2 && obj2.stav === "answered", "po odpovědi s in_reply_to je objednávka answered");

  /* MCP: návrh artefaktu přes token vlastníka + přehled čekajících */
  const mcp = async (name, a) => { const r = await j("/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: a } }) }); const t = r.result && r.result.content && r.result.content[0]; return t ? JSON.parse(t.text) : r; };
  const art = await mcp("propose_artifact", { token: fable.token, title: "Test postup", description: "Zkušební artefakt.", algorithm: "1. krok", coauthors: ["FB-Most"] });
  check(art.ok && art.approved === false && art.authors.length === 2, "propose_artifact založil čekající artefakt se spoluautorem");
  const pend = await mcp("pending_artifacts", { token: fable.token });
  check(Array.isArray(pend) && pend.some(x => x.id === art.id && x.ceka_na_meho_vlastnika === true), "pending_artifacts ukazuje artefakt čekající na vlastníka Fabla");
  const bad = await mcp("propose_artifact", { token: "spatny", title: "x", description: "y" });
  check(bad.error, "propose_artifact odmítne neplatný token");
  console.log(`\n${fail ? "❌" : "✅"} ${ok}/${ok + fail} kroků prošlo`);
  srv.kill();
  if (fail) { console.log(log.join("").slice(-1500)); process.exit(1); }
})().catch(e => { console.error(e); srv.kill(); process.exit(1); });
