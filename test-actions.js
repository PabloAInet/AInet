/* ---------------------------------------------------------------------------
 * test-actions.js — Lite cesta „4 · Přímé API“ (vlastní GPT s Actions)
 *
 * Projde /openapi-actions.json tak, jak ho použije ChatGPT: schéma musí
 * odpovídat omezením GPT Actions (operationId, krátké popisy, jeden server)
 * a každá operace ze schématu musí na serveru opravdu existovat a vracet
 * JSON. Scénář veřejného GPT (Authentication: None): dotaz → odpověď agenta
 * → pokračování; scénář vlastníka (X-Owner-Token): čtení a psaní pošty.
 * --------------------------------------------------------------------------- */

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PORT = Number(process.env.TEST_PORT || 4913);
const BASE = `http://127.0.0.1:${PORT}`;
const CEKANI_MS = 2500;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "ainet-actions-"));

let ok = 0, chyb = 0;
const t = (popis, podminka, detail = "") => {
  if (podminka) { ok++; console.log("  ✓ " + popis); }
  else { chyb++; console.log("  ✗ " + popis + (detail ? "  → " + detail : "")); }
};
const spi = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = encodeURIComponent;
// GPT Actions posílá JSON požadavky a čeká JSON; Accept "*/*" je nejhorší rozumný případ
async function volej(metoda, cesta, { telo, token } = {}) {
  const r = await fetch(BASE + cesta, {
    method: metoda,
    headers: { Accept: "*/*", ...(telo ? { "Content-Type": "application/json" } : {}), ...(token ? { "X-Owner-Token": token } : {}) },
    body: telo ? JSON.stringify(telo) : undefined,
  });
  const typ = r.headers.get("content-type") || "";
  const text = await r.text();
  let data = null; try { data = JSON.parse(text); } catch {}
  return { status: r.status, typ, data, text };
}
const vyres = (ukol) => {
  const soucet = ukol["1_soucet"].replace(/[^0-9+ ]/g, "").split("+").map(Number).reduce((a, b) => a + b, 0);
  return { soucet, otoc: ukol["2_otoc"].split(": ")[1].split("").reverse().join(""), opis: ukol["3_opis"].split(": ")[1] };
};

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
    const fReg = (await volej("GET", "/pripoj/Fable/Pavel/orchestrace,research")).data;
    const fr = vyres(fReg.ukol);
    await volej("GET", `/overit/Fable/${fr.soucet}/${enc(fr.otoc)}/${enc(fr.opis)}`);
    const fableKod = fReg.obnovovaci_kod, fableToken = fReg.token, fableId = fReg.id;

    console.log("\n1) Schéma podle pravidel GPT Actions");
    const sch = (await volej("GET", "/openapi-actions.json")).data;
    t("OpenAPI 3.1 s jedním serverem", sch.openapi === "3.1.0" && Array.isArray(sch.servers) && sch.servers.length === 1 && /^https?:\/\//.test(sch.servers[0].url));
    t("popis API je do 300 znaků", sch.info.description.length <= 300, sch.info.description.length + " znaků");
    const operace = [];
    for (const [cesta, metody] of Object.entries(sch.paths)) for (const [m, o] of Object.entries(metody)) operace.push({ cesta, m: m.toUpperCase(), o });
    t("nejvýš 30 operací", operace.length <= 30, String(operace.length));
    t("každá operace má operationId", operace.every((x) => x.o.operationId));
    t("operationId jsou jedinečné", new Set(operace.map((x) => x.o.operationId)).size === operace.length);
    const dlouhe = operace.filter((x) => ((x.o.summary || "") + (x.o.description || "")).length > 300);
    t("popisy operací jsou do 300 znaků", dlouhe.length === 0, dlouhe.map((x) => x.o.operationId).join(","));
    const getSKodem201 = operace.filter((x) => x.m === "GET" && x.o.responses && x.o.responses["201"]);
    t("GET operace slibují 200, ne 201 (server vrací 200)", getSKodem201.length === 0, getSKodem201.map((x) => x.o.operationId).join(","));
    const ops = Object.fromEntries(operace.map((x) => [x.o.operationId, x]));
    t("návštěva jde bez autentizace", ["startVisit", "askAgent", "askForAdvice", "getReplies", "continueThread", "getMessage"].every((id) => ops[id] && Array.isArray(ops[id].o.security) && ops[id].o.security.length === 0));
    const priv = await fetch(BASE + "/privacy").then(async (r) => ({ s: r.status, t: await r.text() }));
    t("zásady soukromí (/privacy) existují — GPT je potřebuje ke zveřejnění", priv.s === 200 && /ochrana soukromí/.test(priv.t) && /IP adresy neukládáme/.test(priv.t));

    console.log("\n2) Veřejný GPT (Authentication: None) — scénář bezplatného uživatele");
    const sv = await volej("GET", `/navsteva?to=Fable&dotaz=${enc("Co umis a s cim poradis?")}&n=a1`);
    t("startVisit s dotazem: 200 a JSON", sv.status === 200 && sv.typ.includes("application/json"), `${sv.status} ${sv.typ}`);
    t("…vydá propustku a odešle dotaz", sv.data.propustka && sv.data.dotaz_odeslan && sv.data.dotaz_odeslan.id, JSON.stringify(sv.data).slice(0, 200));
    const prop = sv.data.propustka, host = sv.data.prezdivka;
    const [gr] = await Promise.all([
      volej("GET", `/s/${prop}`),
      (async () => { await spi(700); return volej("GET", `/napis/${fableKod}/${host}/${enc("Umim radit s analyzou a organizaci.")}`); })(),
    ]);
    t("getReplies na odpověď počká a vrátí ji", gr.status === 200 && (gr.data.zpravy || []).some((m) => /analyzou/.test(m.text)), JSON.stringify(gr.data).slice(0, 200));
    t("odpověď je spárovaná s dotazem", (gr.data.zpravy || []).some((m) => m.odpoved_na === sv.data.dotaz_odeslan.id));
    const ct = await volej("GET", `/dal/${prop}/rozved`);
    t("continueThread: 200 a odeslano", ct.status === 200 && ct.data.odeslano === true && ct.data.komu === "Fable", `${ct.status} ${JSON.stringify(ct.data).slice(0, 160)}`);
    const aa = await volej("GET", `/zeptat?propustka=${prop}&to=Fable&text=${enc("Jak vyhubit orobinec?")}`);
    t("askAgent (dotaz v parametrech): 200 a odeslano", aa.status === 200 && aa.data.odeslano === true && aa.data.text_ktery_dorazil === "Jak vyhubit orobinec?", `${aa.status} ${JSON.stringify(aa.data).slice(0, 160)}`);
    const af = await volej("GET", `/poradit?propustka=${prop}&tema=${enc("analyza dat")}`);
    t("askForAdvice: 200, server vybere rádce a řekne proč", af.status === 200 && af.data.odeslano === true && af.data.proc_prave_on, `${af.status} ${JSON.stringify(af.data).slice(0, 160)}`);
    const gm = await volej("GET", `/api/messages/${sv.data.dotaz_odeslan.id}?propustka=${prop}`);
    t("getMessage s propustkou vrátí dotaz i odpověď", gm.status === 200 && gm.data.odpoved && /analyzou/.test(gm.data.odpoved.text));
    const gmCizi = await volej("GET", `/api/messages/${sv.data.dotaz_odeslan.id}`);
    t("getMessage bez propustky soukromou zprávu nevydá", gmCizi.status === 403);
    for (const [id, cesta] of [["listAgents", "/api/agents"], ["listArtifacts", "/api/artifacts"], ["getDrift", "/api/drift"], ["findPartners", `/api/match?agent=${fableId}&project=research`]]) {
      const r = await volej("GET", cesta);
      t(`${id}: 200 a JSON`, r.status === 200 && r.typ.includes("application/json") && r.data !== null, `${r.status} ${r.text.slice(0, 100)}`);
    }

    console.log("\n3) GPT vlastníka (API Key → hlavička X-Owner-Token)");
    const rm = await volej("GET", "/api/messages", { token: fableToken });
    t("readMessages s hlavičkou vrátí i soukromé zprávy agenta", rm.status === 200 && JSON.stringify(rm.data).includes("orobinec"), `${rm.status} ${rm.text.slice(0, 160)}`);
    const dotazNaOdpoved = aa.data.id;
    const sm = await volej("POST", "/api/messages", { token: fableToken, telo: { from: fableId, to: host, text: "Kosit pod hladinou.", in_reply_to: dotazNaOdpoved } });
    t("sendMessage s hlavičkou odešle odpověď návštěvníkovi", sm.status === 201 || sm.status === 200, `${sm.status} ${sm.text.slice(0, 160)}`);
    const po = await volej("GET", `/api/messages/${dotazNaOdpoved}?propustka=${prop}`);
    t("…a spáruje ji s dotazem (in_reply_to)", po.data && po.data.zprava.stav === "answered" && /hladinou/.test((po.data.odpoved || {}).text || ""));
    const sm2 = await volej("POST", "/api/messages", { telo: { from: fableId, to: host, text: "bez tokenu" } });
    t("sendMessage bez tokenu neprojde", sm2.status >= 400);
    const tw = await volej("GET", "/api/work", { token: fableToken });
    t("takeWork s hlavičkou: odpověď JSON", tw.status < 500 && tw.data !== null, `${tw.status} ${tw.text.slice(0, 120)}`);

    console.log("\n4) Registrace a návrat přes Actions");
    const rg = await volej("GET", "/api/lite/register?name=GptAgent&owner=Pavel&skills=research");
    t("registerAgent: token, kód a úkoly", rg.status === 200 && rg.data.token && rg.data.ukol);
    const rv = vyres(rg.data.ukol);
    const vf = await volej("GET", `/api/lite/verify?token=${rg.data.token}&a1=${rv.soucet}&a2=${enc(rv.otoc)}&a3=${enc(rv.opis)}`);
    t("verifyAgent: ověřeno", vf.data && vf.data.stav === "verified", JSON.stringify(vf.data).slice(0, 160));
    const rs = await volej("GET", `/api/lite/resume?code=${rg.data.obnovovaci_kod}`);
    t("resumeAgent: tentýž token", rs.data && rs.data.token === rg.data.token);

    console.log("\n5) Každá cesta ze schématu na serveru existuje");
    const vzor = { propustka: prop, kod: "diky", id: sv.data.dotaz_odeslan.id };
    for (const x of operace) {
      if (x.m !== "GET") continue;
      const cesta = x.cesta.replace(/\{(\w+)\}/g, (_, k) => vzor[k] || "x");
      const r = await volej("GET", cesta, { token: fableToken });
      t(`${x.o.operationId} (${x.cesta}) není 404`, r.status !== 404 || /nenalezen|není|Neznám/.test(r.text), `${r.status} ${r.text.slice(0, 80)}`);
    }
  } catch (e) {
    chyb++;
    console.log("  ✗ výjimka: " + e.message);
  }

  console.log(chyb ? `\n❌ ${chyb} z ${ok + chyb} kroků selhalo` : `\n✅ ${ok}/${ok} kroků prošlo`);
  konec(chyb ? 1 : 0);
})();
