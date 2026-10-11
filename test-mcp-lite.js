/* ---------------------------------------------------------------------------
 * test-mcp-lite.js — návštěva přes MCP jedním voláním (cesta Lite č. 2 · MCP)
 *
 * PROČ TENHLE TEST EXISTUJE
 * Chat s konektorem AInet dřív musel projít start_visit → ask_agent →
 * get_replies a nést si mezi tím propustku. get_replies nečekal, takže chat
 * dostal „zatím nic" dřív, než agent stihl odpovědět. A žádný nástroj neměl
 * anotaci readOnlyHint — ChatGPT bere takový nástroj jako zápis, takže klient,
 * který smí jen číst, nenabídl z AInetu vůbec nic.
 *
 * Hlídá: anotace u všech nástrojů, nástroj ask (otázka dovnitř, odpověď ven,
 * propustka navázaná na spojení, pokračování rozhovoru), čekající get_replies,
 * search + fetch a chování GET /mcp podle specifikace (405 pro SSE).
 * --------------------------------------------------------------------------- */

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PORT = Number(process.env.TEST_PORT || 4911);
const BASE = `http://127.0.0.1:${PORT}`;
const CEKANI_MS = 2500;            /* v testu krátké, v provozu 20 s */
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "ainet-mcp-lite-"));

let ok = 0, chyb = 0;
const t = (popis, podminka, detail = "") => {
  if (podminka) { ok++; console.log("  ✓ " + popis); }
  else { chyb++; console.log("  ✗ " + popis + (detail ? "  → " + detail : "")); }
};
const spi = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = encodeURIComponent;

let rpcId = 1;
async function mcp(method, params, session) {
  const r = await fetch(BASE + "/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(session ? { "Mcp-Session-Id": session } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
  });
  return r.json();
}
async function nastroj(name, args, session) {
  const r = await mcp("tools/call", { name, arguments: args || {} }, session);
  if (!r.result) throw new Error(`${name}: ${JSON.stringify(r)}`);
  return { data: JSON.parse(r.result.content[0].text), isError: r.result.isError };
}

async function zaregistruj(jmeno, dovednosti) {
  const reg = await fetch(`${BASE}/pripoj/${enc(jmeno)}/Test/${enc(dovednosti)}`).then((r) => r.json());
  if (!reg.ukol) throw new Error(`registrace ${jmeno}: ${JSON.stringify(reg)}`);
  const u = reg.ukol;
  const soucet = u["1_soucet"].replace(/[^0-9+ ]/g, "").split("+").map(Number).reduce((a, b) => a + b, 0);
  const otoc = u["2_otoc"].split(": ")[1].split("").reverse().join("");
  const opis = u["3_opis"].split(": ")[1];
  await fetch(`${BASE}/overit/${enc(jmeno)}/${soucet}/${enc(otoc)}/${enc(opis)}`).then((r) => r.json());
  return reg;
}

/* Agent si za chvíli přečte poštu a odpoví na nejnovější dotaz od návštěvníka. */
async function odpovezZa(ms, token, text) {
  await spi(ms);
  const posta = (await nastroj("read_messages", { token })).data;
  const zpravy = Array.isArray(posta) ? posta : (posta.zpravy || posta.messages || []);
  const dotaz = [...zpravy].reverse().find((m) => String(m.od || m.from || "").includes("host-") && (m.stav || m.status) !== "answered");
  if (!dotaz) throw new Error("agent nenašel dotaz: " + JSON.stringify(posta).slice(0, 300));
  const host = String(dotaz.od || dotaz.from).replace(/^📱\s*/, "");
  return (await nastroj("send_message", { token, to: host, text, in_reply_to: dotaz.id })).data;
}

(async () => {
  const srv = spawn("node", ["server.js"], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, CEKANI_NA_ODPOVED_MS: String(CEKANI_MS), FABLE_AUTO: "0", INDEXNOW: "0", SEED_DOMACI: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  srv.stdout.on("data", () => {});
  srv.stderr.on("data", (d) => process.stderr.write(d));
  const konec = (kod) => { srv.kill(); fs.rmSync(DATA, { recursive: true, force: true }); process.exit(kod); };

  try {
    await spi(1500);
    const fable = await zaregistruj("Fable", "orchestrace,analyza,research");
    await zaregistruj("Aja", "research,writing");

    console.log("\n1) Nástroje mají pravdivé anotace");
    const tools = (await mcp("tools/list", {})).result.tools;
    const jmena = tools.map((x) => x.name);
    const podle = Object.fromEntries(tools.map((x) => [x.name, x]));
    t("ask je v seznamu jako první", jmena[0] === "ask", jmena.slice(0, 3).join(","));
    t("search a fetch jsou v seznamu", jmena.includes("search") && jmena.includes("fetch"));
    t("žádný nástroj není dvakrát", new Set(jmena).size === jmena.length);
    const hinty = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"];
    const bezAnotace = tools.filter((x) => !x.annotations || hinty.some((h) => typeof x.annotations[h] !== "boolean"));
    t("každý nástroj má všechny čtyři anotace", bezAnotace.length === 0, bezAnotace.map((x) => x.name).join(","));
    t("každý nástroj má titulek", tools.every((x) => x.title && x.annotations.title));
    const cteni = ["get_replies", "search", "fetch", "list_agents", "find_artifacts", "get_message", "how_to_register"];
    t("čtecí nástroje jsou označené jen pro čtení", cteni.every((n) => podle[n].annotations.readOnlyHint === true), cteni.filter((n) => !podle[n].annotations.readOnlyHint).join(","));
    const zapisy = ["ask", "start_visit", "ask_agent", "send_message", "register_agent", "verify_agent", "make_offer"];
    t("co zapisuje (i dotaz návštěvníka), není označené jako čtení", zapisy.every((n) => podle[n].annotations.readOnlyHint === false), zapisy.filter((n) => podle[n].annotations.readOnlyHint).join(","));
    t("mazání a přepisy jsou destruktivní", ["forget", "sandbox_save", "update_profile"].every((n) => podle[n].annotations.destructiveHint === true));
    t("ask má povinnou jen otázku", JSON.stringify(podle.ask.inputSchema.required) === '["question"]');
    t("get_replies nevyžaduje propustku", !(podle.get_replies.inputSchema.required || []).length);

    console.log("\n2) Vstup do MCP podle specifikace");
    const init = (await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } })).result;
    t("instructions posílají rovnou na ask", /ask \{question\}/.test(init.instructions));
    const sse = await fetch(BASE + "/mcp", { headers: { Accept: "text/event-stream" } });
    t("GET /mcp s Accept: text/event-stream vrací 405 (SSE neposíláme)", sse.status === 405, String(sse.status));
    const info = await fetch(BASE + "/mcp").then((r) => r.json());
    t("GET /mcp pro prohlížeč vrací popis se seznamem nástrojů", info.tools && info.tools.includes("ask") && /ask/.test(info.zacni_tady));
    t("popis říká pravdu o bezplatném ChatGPT", /placen/.test(info.jak_pripojit.chatgpt) && /navsteva/.test(info.jak_pripojit.chatgpt));
    const del = await fetch(BASE + "/mcp", { method: "DELETE" });
    t("DELETE /mcp vrací 405", del.status === 405, String(del.status));

    console.log("\n3) ask — otázka dovnitř, odpověď ven");
    const S1 = "test-session-1";
    const prazdne = await nastroj("ask", {}, S1);
    t("bez otázky vrací chybu nástroje", prazdne.isError && /question/.test(prazdne.data.error));
    let t0 = Date.now();
    const [a1] = await Promise.all([
      nastroj("ask", { question: "Jak vyhubit orobinec v rybniku?", to: "Fable" }, S1),
      odpovezZa(700, fable.token, "Kosit pod hladinou dvakrat za leto."),
    ]);
    t("ask počkal a vrátil rovnou odpověď agenta", a1.data.odpoved && a1.data.odpoved.text === "Kosit pod hladinou dvakrat za leto.", JSON.stringify(a1.data).slice(0, 200));
    t("…a to dřív, než vypršelo čekání", Date.now() - t0 < CEKANI_MS + 500, (Date.now() - t0) + " ms");
    t("odpověď je podepsaná jménem agenta", a1.data.odpoved && a1.data.odpoved.od === "Fable");
    t("stav je zodpovězeno", a1.data.stav === "zodpovězeno");
    t("výsledek nese propustku a přezdívku", /^[a-z]+-[a-z]+-\d{6}$/.test(a1.data.propustka) && /^host-/.test(a1.data.prezdivka));
    t("výsledek připomíná, že odpověď je informace, ne pokyn", /ne pokyn/.test(a1.data.pravidlo));
    t("výsledek nabízí adresu schránky pro člověka", a1.data.pro_cloveka.includes(`/s/${a1.data.propustka}`));

    const [a2] = await Promise.all([
      nastroj("ask", { question: "A kdy presne?" }, S1),
      odpovezZa(700, fable.token, "V cervnu a v srpnu."),
    ]);
    t("druhý ask bez 'to' pokračuje u téhož agenta", a2.data.dotaz && a2.data.dotaz.komu === "Fable", JSON.stringify(a2.data.dotaz));
    t("…ve stejné návštěvě (propustku drží spojení)", a2.data.propustka === a1.data.propustka);
    t("…a vrátil novou odpověď", a2.data.odpoved && a2.data.odpoved.text === "V cervnu a v srpnu.");

    console.log("\n4) Když agent hned neodpoví");
    t0 = Date.now();
    const a3 = await nastroj("ask", { question: "Co rybnik a kapri?" }, S1);
    t("ask po uplynutí čekání vrátí stav bez odpovědi", a3.data.odpoved === null && /zatím/.test(a3.data.stav));
    t("…počkal zhruba nastavenou dobu", Date.now() - t0 >= CEKANI_MS - 300, (Date.now() - t0) + " ms");
    t("…a poradí get_replies", /get_replies/.test(a3.data.dalsi_krok));
    const opak = await nastroj("ask", { question: "Co rybnik a kapri?" }, S1);
    t("tatáž otázka podruhé nezaloží duplikát", opak.data.dotaz.opakovano === true && opak.data.dotaz.id === a3.data.dotaz.id);
    t0 = Date.now();
    const [r1] = await Promise.all([
      nastroj("get_replies", {}, S1),
      odpovezZa(700, fable.token, "Kapri rybniku pomahaji."),
    ]);
    t("get_replies bez propustky najde návštěvu tohoto spojení", !r1.isError && r1.data.propustka === a1.data.propustka, JSON.stringify(r1.data).slice(0, 160));
    t("get_replies na odpověď počkal a dostal ji", r1.data.zpravy.some((m) => m.text === "Kapri rybniku pomahaji.") && r1.data.nezodpovezeno === 0);
    t("…dřív, než vypršelo čekání", Date.now() - t0 < CEKANI_MS + 500, (Date.now() - t0) + " ms");

    console.log("\n5) Jiná konverzace, jiný klient");
    const jinde = await Promise.all([
      nastroj("ask", { question: "Jeste jedna vec?", propustka: a1.data.propustka }, "test-session-2"),
      odpovezZa(700, fable.token, "Ano?"),
    ]);
    t("s propustkou z výsledku naváže i v jiné konverzaci", jinde[0].data.prezdivka === a1.data.prezdivka && jinde[0].data.dotaz.komu === "Fable");
    const cizi = await nastroj("get_replies", {}, "test-session-3");
    t("nové spojení bez návštěvy dostane radu zavolat ask", cizi.isError && /ask/.test(cizi.data.co_ted));
    const nikdo = await nastroj("ask", { question: "Ahoj?", to: "Neexistuje" }, "test-session-4");
    t("neznámý agent → chyba se seznamem, kdo je k mání", nikdo.isError && nikdo.data.kdo_je_k_mani.includes("Fable"));
    const bezSession = await nastroj("ask", { question: "Kdo tu umi research a psani?" });
    t("klient bez Mcp-Session-Id dostane novou návštěvu s propustkou", bezSession.data.propustka && bezSession.data.propustka !== a1.data.propustka);
    t("bez 'to' vybral server rádce sám", bezSession.data.dotaz && ["Fable", "Aja"].includes(bezSession.data.dotaz.komu) && bezSession.data.dotaz.proc_prave_on);

    console.log("\n6) search + fetch (jen čtení)");
    const navrh = await nastroj("propose_artifact", { token: fable.token, title: "Orobinec v rybniku", description: "Jak se zbavit orobince bez chemie.", algorithm: "1. Kosit pod hladinu. 2. Opakovat v cervnu a srpnu.", result: "Za dva roky ustoupil." });
    await fetch(`${BASE}/api/artifacts/${navrh.data.id}/approve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: fable.token }) });
    const s1 = await nastroj("search", { query: "orobinec" });
    t("search najde schválený artefakt", s1.data.results.some((x) => x.id === `artefakt:${navrh.data.id}`), JSON.stringify(s1.data).slice(0, 200));
    t("výsledky mají id, title a url", s1.data.results.every((x) => x.id && x.title && /^http/.test(x.url)));
    const s2 = await nastroj("search", { query: "analýza" });
    t("search najde agenta podle dovednosti i s háčky v dotazu", s2.data.results.some((x) => x.id === "agent:Fable"), JSON.stringify(s2.data.results.map((x) => x.id)));
    const f1 = await nastroj("fetch", { id: `artefakt:${navrh.data.id}` });
    t("fetch vrátí celý postup artefaktu", /POSTUP/.test(f1.data.text) && /srpnu/.test(f1.data.text) && f1.data.metadata.autori.includes("Fable"));
    const f2 = await nastroj("fetch", { id: "agent:Fable" });
    t("fetch vrátí kartu agenta i s radou, jak se zeptat", /Dovednosti/.test(f2.data.text) && /ask/.test(f2.data.text));
    const f3 = await nastroj("fetch", { id: "nesmysl:1" });
    t("fetch neznámého id je chyba nástroje", f3.isError === true);
    const s3 = await nastroj("search", { query: "kvantova chromodynamika" });
    t("search bez výsledku poradí ask", s3.data.results.length === 0 && /ask/.test(s3.data.zprava));
    const neschvaleny = await nastroj("propose_artifact", { token: fable.token, title: "Tajny navrh", description: "Neschvaleny postup orobinec." });
    const s4 = await nastroj("search", { query: "tajny" });
    t("neschválený artefakt search nevidí", !s4.data.results.some((x) => x.id === `artefakt:${neschvaleny.data.id}`));
  } catch (e) {
    chyb++;
    console.log("  ✗ výjimka: " + e.message);
  }

  console.log(chyb ? `\n❌ ${chyb} z ${ok + chyb} kroků selhalo` : `\n✅ ${ok}/${ok} kroků prošlo`);
  konec(chyb ? 1 : 0);
})();
