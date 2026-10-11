/* ---------------------------------------------------------------------------
 * test-odkazy-get.js — Lite cesta „1 · Odkazy (GET)“ přesně podle návodu na webu
 *
 * Chat, který umí jen otevírat adresy (i bezplatný ChatGPT nebo Gemini), se
 * podle textu z boxu 1 na stránce Připojení zaregistruje, ověří, píše a čte
 * poštu. Test jde obě varianty, které box nabízí — s otazníkem (/api/lite/…)
 * a bez otazníku (/pripoj, /overit, /posta, /napis…) — a kontroluje i HTML,
 * které dostane nástroj chatu, když si řekne o text/html.
 * --------------------------------------------------------------------------- */

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PORT = Number(process.env.TEST_PORT || 4912);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "ainet-odkazy-"));
const LIMIT_ADRESY = 250;   /* nástroje chatů delší adresu neotevřou (změřeno 15. 9.: 242 projde, 270 ne) */

let ok = 0, chyb = 0;
const t = (popis, podminka, detail = "") => {
  if (podminka) { ok++; console.log("  ✓ " + popis); }
  else { chyb++; console.log("  ✗ " + popis + (detail ? "  → " + detail : "")); }
};
const spi = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = encodeURIComponent;
const get = (u) => fetch(u.startsWith("http") ? u : BASE + u).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));
const html = (u) => fetch(BASE + u, { headers: { Accept: "text/html,application/xhtml+xml" } }).then(async (r) => ({ status: r.status, type: r.headers.get("content-type") || "", text: await r.text() }));
const vyres = (ukol) => {
  const soucet = ukol["1_soucet"].replace(/[^0-9+ ]/g, "").split("+").map(Number).reduce((a, b) => a + b, 0);
  const otoc = ukol["2_otoc"].split(": ")[1].split("").reverse().join("");
  const opis = ukol["3_opis"].split(": ")[1];
  return { soucet, otoc, opis };
};
const hexToken = /[0-9a-f]{30,}/;

(async () => {
  const srv = spawn("node", ["server.js"], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, FABLE_AUTO: "0", INDEXNOW: "0", SEED_DOMACI: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  srv.stdout.on("data", () => {});
  srv.stderr.on("data", (d) => process.stderr.write(d));
  const konec = (kod) => { srv.kill(); fs.rmSync(DATA, { recursive: true, force: true }); process.exit(kod); };

  try {
    await spi(1500);
    /* Fable jako protějšek, kterému se píše */
    const fReg = await get("/pripoj/Fable/Pavel/orchestrace,research");
    const fr = vyres(fReg.data.ukol);
    await get(`/overit/Fable/${fr.soucet}/${enc(fr.otoc)}/${enc(fr.opis)}`);
    const fableKod = fReg.data.obnovovaci_kod;

    console.log("\n1) Box na stránce Připojení");
    const stranka = await fetch(BASE + "/").then((r) => r.text());
    t("box 1 · Odkazy (GET) na stránce je", stranka.includes("1 · 🔗 Odkazy (GET)") && stranka.includes('id="liteThread"') && stranka.includes('id="cestaThread"'));
    t("box Návštěva ze stránky zmizel", !stranka.includes('id="hostDotaz"') && !stranka.includes("Návštěva — jednorázový přístup"));
    t("cesty jsou očíslované 1–4", ["1 · 🔗 Odkazy", "2 · 📋 Schránkový můstek", "3 · 🧩 Konektor", "4 · ⚡ Přímé API"].every((x) => stranka.includes(x)));
    const cesta = stranka.slice(stranka.indexOf("function cestaText()"), stranka.indexOf("async function copyCesta()"));
    t("varianta bez otazníku už neposílá chat psát token do adresy", cesta.length > 100 && !cesta.includes("TVUJ_TOKEN"));
    const pozvanka = stranka.slice(stranka.indexOf('id="pro-ai"'), stranka.indexOf("</aside>"));
    t("pozvánka pro AI vede na odkazy GET (/start) a přímé API, ne na návštěvu", pozvanka.includes("onrender.com/start") && pozvanka.includes("onrender.com/openapi-actions.json") && !pozvanka.includes("navsteva"));
    const start = await fetch(BASE + "/start").then((r) => r.text());
    t("/start nabízí i variantu bez otazníku (/pripoj) a návrat kódem", start.includes("/pripoj/TVE_JMENO/") && start.includes("/obnova/OBNOVOVACI_KOD"));

    console.log("\n2) Varianta s otazníkem (/api/lite/…)");
    const reg = await get("/api/lite/register?name=ZkouskaGet&owner=Pavel&skills=research,writing&model=silny&usili=vysoke&premysleni=ano");
    t("registrace vrátí token, obnovovací kód a tři úkoly", reg.status === 200 && reg.data.token && /^[a-z]+-[a-z]+-\d+$/.test(reg.data.obnovovaci_kod) && Object.keys(reg.data.ukol || {}).length === 3, JSON.stringify(reg.data).slice(0, 200));
    t("odpověď říká, kam poslat odpovědi", /\/api\/lite\/verify\?token=/.test(reg.data.odesli_odpovedi_na));
    const zastupne = await get("/api/lite/register?name=JMENO_AGENTA&owner=Pavel&skills=research");
    t("zástupné jméno z návodu server nevezme", zastupne.status >= 400, String(zastupne.status) + " " + JSON.stringify(zastupne.data).slice(0, 120));
    const r = vyres(reg.data.ukol);
    const overUrl = `${BASE}/api/lite/verify?token=${reg.data.token}&a1=${r.soucet}&a2=${enc(r.otoc)}&a3=${enc(r.opis)}`;
    t("ověřovací adresa se vejde do limitu nástrojů chatu", overUrl.replace(BASE, "https://ainet-1e2y.onrender.com").length <= LIMIT_ADRESY, overUrl.length + " znaků");
    const spatne = await get(`/api/lite/verify?token=${reg.data.token}&a1=1&a2=x&a3=y`);
    t("špatné odpovědi ověření odmítne", spatne.status >= 400 || spatne.data.stav !== "verified");
    const over = await get(overUrl);
    t("správné odpovědi agenta ověří", over.data && over.data.stav === "verified", JSON.stringify(over.data).slice(0, 200));
    const seznam = await get("/api/lite/agents");
    t("agent je v seznamu /api/lite/agents", JSON.stringify(seznam.data).includes("ZkouskaGet"));
    const posl = await get(`/api/lite/send?token=${reg.data.token}&to=Fable&text=${enc("Ahoj Fable, tady test odkazu GET")}`);
    t("zpráva Fablovi odešla", posl.status < 300 && JSON.stringify(posl.data).includes("Fable"), JSON.stringify(posl.data).slice(0, 160));
    const fPosta = await get(`/posta/${fableKod}`);
    const dotaz = (fPosta.data.zpravy || []).find((m) => /test odkazu GET/.test(m.text));
    t("Fable zprávu ve své poště má", !!dotaz);
    await get(`/napis/${fableKod}/ZkouskaGet/${enc("Ahoj, odpoved dorazila")}`);
    const inbox = await get(`/api/lite/inbox?token=${reg.data.token}`);
    const odp = JSON.stringify(inbox.data);
    t("odpověď je v poště agenta", odp.includes("odpoved dorazila"), odp.slice(0, 200));
    const dotazPo = (await get(`/api/messages/${dotaz.id}?token=${reg.data.token}`)).data;
    t("odpověď je spárovaná s dotazem (answered)", dotazPo && dotazPo.zprava.stav === "answered" && dotazPo.odpoved && /dorazila/.test(dotazPo.odpoved.text));
    const resume = await get(`/api/lite/resume?code=${reg.data.obnovovaci_kod}`);
    t("návrat obnovovacím kódem vrátí tentýž token", resume.data && resume.data.token === reg.data.token);
    const mozek = (await get(`/api/agents/${reg.data.id}/mozek`)).data;
    t("mozek z registrace se uložil", JSON.stringify(mozek).includes("silny") && JSON.stringify(mozek).includes("vysoke"), JSON.stringify(mozek).slice(0, 160));

    console.log("\n3) Varianta bez otazníku (/pripoj, /overit, /posta, /napis…)");
    const reg2 = await get("/pripoj/ZkouskaCesta/Pavel/research,writing");
    t("/pripoj vrátí kód a úkoly", reg2.status === 200 && reg2.data.obnovovaci_kod && reg2.data.ukol);
    t("adresa pro ověření je bez tokenu (obnovovací kód)", reg2.data.odesli_odpovedi_na.includes(`/overit/${reg2.data.obnovovaci_kod}/`) && !hexToken.test(reg2.data.odesli_odpovedi_na), reg2.data.odesli_odpovedi_na);
    const ztracene = await get("/ukoly/ZkouskaCesta");
    t("ztracené úkoly jde vyzvednout znovu (/ukoly/JMENO)", ztracene.status === 200 && ztracene.data.ukol);
    const r2 = vyres(ztracene.data.ukol);
    const over2 = await get(`/overit/ZkouskaCesta/${r2.soucet}/${enc(r2.otoc)}/${enc(r2.opis)}`);
    t("/overit/JMENO/… agenta ověří", over2.data && over2.data.stav === "verified", JSON.stringify(over2.data).slice(0, 200));
    t("po ověření dostane adresy s kódem, ne s tokenem", over2.data.ctu_postu && !hexToken.test(over2.data.ctu_postu + over2.data.posilam_zpravu));
    const kod = reg2.data.obnovovaci_kod;
    const napis = await get(`/napis/${kod}/Fable/${enc("Druhy test bez otazniku")}`);
    t("/napis/KOD/Fable/TEXT pošle zprávu", napis.status < 300, JSON.stringify(napis.data).slice(0, 160));
    await get(`/napis/${fableKod}/ZkouskaCesta/${enc("Odpoved na druhy test")}`);
    const posta2 = await get(`/posta/${kod}`);
    t("/posta/KOD ukáže dotaz i odpověď", JSON.stringify(posta2.data).includes("Druhy test") && JSON.stringify(posta2.data).includes("Odpoved na druhy test"));
    const obnova = await get(`/obnova/${kod}`);
    t("/obnova/KOD naváže (vrátí agenta i token)", obnova.status === 200 && obnova.data.vitej_zpet === "ZkouskaCesta" && obnova.data.token);
    const zap = await get(`/zapamatuj/${kod}/${enc("Pavel chce testovat GET odkazy")}`);
    t("/zapamatuj/KOD/VETA uloží poznámku", zap.data && zap.data.ok);
    const usn = await get(`/usnuti/${kod}/${enc("otestovano")}/${enc("nic")}/${enc("dalsi test")}`);
    t("/usnuti/KOD/… zapíše deník", usn.status === 200 && !usn.data.error);
    const prob = await get(`/probuzeni/${kod}`);
    t("/probuzeni/KOD vrátí poznámku i deník", JSON.stringify(prob.data).includes("testovat GET") && JSON.stringify(prob.data).includes("otestovano"));
    const kratke = [`/pripoj/ZkouskaCesta/Pavel/research,writing`, `/overit/ZkouskaCesta/999/abcdefgh/0123456789abcdef`, `/posta/${kod}`, `/napis/${kod}/Fable/${enc("Ahoj, mas chvili na otazku o rybniku?")}`];
    t("všechny adresy bez otazníku se vejdou do limitu", kratke.every((u) => ("https://ainet-1e2y.onrender.com" + u).length <= LIMIT_ADRESY));
    const spatnyKod = await get("/posta/neexistujici-kod-11");
    t("neplatný kód v poště je 403 s nápovědou", spatnyKod.status === 403 && spatnyKod.data.napoveda);

    console.log("\n4) Co uvidí nástroj chatu, který chce HTML");
    const h1 = await html("/api/lite/register?name=ZkouskaHtml&owner=Pavel&skills=research");
    t("registrace přijde jako HTML stránka", h1.type.includes("text/html") && h1.text.startsWith("<!doctype html>"));
    t("v HTML není ani jedno „undefined“", !h1.text.includes("undefined"), (h1.text.match(/.{40}undefined.{40}/) || [""])[0]);
    t("HTML ukazuje obnovovací kód i tři úkoly", /Obnovovací kód/.test(h1.text) && (h1.text.match(/<li>/g) || []).length >= 3);
    t("HTML ukazuje další krok jako větu", /Další krok:/.test(h1.text));
    const h2 = await html("/pripoj/ZkouskaHtml2/Pavel/research");
    t("/pripoj v HTML je bez „undefined“", h2.text.startsWith("<!doctype html>") && !h2.text.includes("undefined"));
    const h3 = await html(`/posta/${kod}`);
    t("pošta v HTML ukazuje zprávy i odkaz Odpovědět", /Pošta:/.test(h3.text) && /Odpovědět:/.test(h3.text) && !h3.text.includes("undefined"));
    const h4 = await html(`/overit/ZkouskaCesta/1/x/y`);
    t("opakované ověření ověřeného agenta neskončí rozbitou stránkou", h4.text.startsWith("<!doctype html>") && !h4.text.includes("undefined"));
  } catch (e) {
    chyb++;
    console.log("  ✗ výjimka: " + e.message);
  }

  console.log(chyb ? `\n❌ ${chyb} z ${ok + chyb} kroků selhalo` : `\n✅ ${ok}/${ok} kroků prošlo`);
  konec(chyb ? 1 : 0);
})();
