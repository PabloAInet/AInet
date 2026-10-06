/**
 * pavel.js — soukromá sekce MUDr. Ditla na fb-most (/pavel). Node 18+, bez závislostí.
 *
 *   /pavel            přihlášení heslem (env PAVEL_HESLO); bez něj je sekce vypnutá
 *   Literatura        dotaz → shrnutí z PubMed / ClinicalTrials.gov s PMID (pro lékaře)
 *   Příspěvek         návrh FB příspěvku s 1–3 ověřenými zdroji
 *   Novinky           nové studie za posledních N dní k tématům
 *   (Operační program – připravujeme)
 */
const crypto = require("crypto");
const lit = require("./literatura.js");
const opravy = require("./opravy.js");
let zdroje = { chats: () => new Map() };      // most sem připojí paměť konverzací
function pripoj(z) { zdroje = { ...zdroje, ...z }; }

const HESLO = process.env.PAVEL_HESLO || "";
const { ANTHROPIC_API_KEY } = process.env;
const MODEL = process.env.PAVEL_MODEL || process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";
const SESE_H = Number(process.env.PAVEL_SESE_H || 24 * 90); // přihlášení vydrží 90 dní od poslední návštěvy
const PAVEL_PSID = process.env.PAVEL_PSID || "28903446015930142"; // Pavlův Messenger (PSID u stránky Pavel Ditl MD)
const BASE = (process.env.PUBLIC_URL || "https://fb-most.onrender.com").replace(/\/$/, "");
const log = (m) => console.log(`[pavel] ${new Date().toISOString()} ${m}`);

/* témata pro Novinky (lze přepsat env PAVEL_TEMATA, oddělovač |) */
const TEMATA = (process.env.PAVEL_TEMATA || [
  "laser hemorrhoidoplasty OR hemorrhoidal laser procedure",
  "pilonidal sinus laser OR SiLaC OR FiLaC OR pilonidal sinus surgery",
  "endovenous laser ablation varicose veins",
  "foam sclerotherapy OR telangiectasia laser treatment",
  "laparoscopic inguinal hernia repair",
  "laparoscopic cholecystectomy",
].join("|")).split("|").map((s) => s.trim()).filter(Boolean);

/* ---------- přihlášení ---------- */
const sign = (v) => crypto.createHmac("sha256", "pd|" + HESLO).update(String(v)).digest("hex");
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();
function prihlasen(req) {
  if (!HESLO) return false;
  const m = /(?:^|;\s*)pd=([^;]+)/.exec(req.headers.cookie || "");
  if (!m) return false;
  const [exp, sig] = decodeURIComponent(m[1]).split(".");
  if (!exp || !sig || Number(exp) < Date.now() || sig.length !== 64) return false;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(sign(exp)));
}
const pokusy = new Map(); // ip → { n, t }
const ipOf = (req) => String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim();
function zablokovano(ip) { const p = pokusy.get(ip); return p && p.n >= 5 && Date.now() - p.t < 15 * 60e3; }
function spatnyPokus(ip) { const p = pokusy.get(ip); const now = Date.now(); pokusy.set(ip, p && now - p.t < 15 * 60e3 ? { n: p.n + 1, t: p.t } : { n: 1, t: now }); }
function sessionCookie() { const exp = Date.now() + SESE_H * 3600e3; return `pd=${exp}.${sign(exp)}; Path=/pavel; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESE_H * 3600}`; }

/* přihlášení bez hesla: Pavel napíše stránce v Messengeru „přihlásit“ a dostane jednorázový odkaz (10 min) */
const odkazy = new Map(); // token → platí do
function messengerPrikaz(psid, text) {
  if (!HESLO || String(psid) !== PAVEL_PSID || !/^\s*(přihlásit|prihlasit|login|pavel)\s*[.!]?\s*$/i.test(text || "")) return null;
  for (const [t, exp] of odkazy) if (exp < Date.now()) odkazy.delete(t);
  const t = crypto.randomBytes(24).toString("base64url");
  odkazy.set(t, Date.now() + 10 * 60e3);
  return `Přihlašovací odkaz do soukromé sekce (platí 10 minut, jen jednou):\n${BASE}/pavel/odkaz?t=${t}`;
}

function readForm(req) {
  return new Promise((res) => { let d = ""; req.on("data", (c) => { d += c; if (d.length > 2e5) req.destroy(); }); req.on("end", () => res(new URLSearchParams(d))); });
}

/* ---------- HTML ---------- */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function md(text) {
  let h = esc(text);
  h = h.replace(/(https?:\/\/[^\s<)\]]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  h = h.replace(/PMID[:\s]*(\d{6,9})/g, 'PMID <a href="https://pubmed.ncbi.nlm.nih.gov/$1/" target="_blank" rel="noopener">$1</a>');
  h = h.replace(/\b(NCT\d{8})\b(?![^<]*<\/a>)/g, '<a href="https://clinicaltrials.gov/study/$1" target="_blank" rel="noopener">$1</a>');
  h = h.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  const out = []; let seznam = false;
  for (const l of h.split("\n")) {
    const li = /^\s*(?:[-•*]|\d+[.)])\s+/.test(l);
    if (li && !seznam) { out.push("<ul>"); seznam = true; }
    if (!li && seznam && l.trim()) { out.push("</ul>"); seznam = false; }
    if (li) out.push(`<li>${l.replace(/^\s*(?:[-•*]|\d+[.)])\s+/, "")}</li>`);
    else if (/^#{1,4}\s/.test(l)) out.push(`<h3>${l.replace(/^#+\s/, "")}</h3>`);
    else if (l.trim()) out.push(`<p>${l}</p>`);
  }
  if (seznam) out.push("</ul>");
  return out.join("\n");
}
const STYL = `body{margin:0;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;background:#0d2742;color:#f5f8fa;line-height:1.5}
main{max-width:860px;margin:0 auto;padding:24px 18px 60px}a{color:#5ec8b2}h1{font-size:24px;margin:0 0 4px}h3{margin:20px 0 6px;font-size:17px}
.sub{color:#b0c4d6;margin:0 0 20px}.card{background:#18385e;border-radius:14px;padding:18px;margin:14px 0}
textarea,input,select{width:100%;box-sizing:border-box;background:#0d2742;color:#f5f8fa;border:1px solid #2c4f78;border-radius:10px;padding:10px;font:inherit}
textarea{min-height:90px}label{display:block;margin:10px 0 4px;color:#b0c4d6;font-size:14px}
button{background:#5ec8b2;color:#0d2742;border:0;border-radius:10px;padding:11px 20px;font-weight:800;font:inherit;font-weight:800;cursor:pointer;margin-top:12px}
nav{display:flex;gap:14px;flex-wrap:wrap;margin:6px 0 18px;font-size:14px}nav span{color:#b0c4d6}.ans p{margin:6px 0}.muted{color:#b0c4d6;font-size:13px}
.row{display:grid;grid-template-columns:2fr 1fr;gap:12px}@media(max-width:600px){.row{grid-template-columns:1fr}}`;
const stranka = (titulek, telo) => `<!doctype html><html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(titulek)}</title><style>${STYL}</style></head><body><main>${telo}</main></body></html>`;
function posli(res, status, html, extra = {}) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer", ...extra });
  res.end(html);
}
const NAV = `<nav><a href="/pavel">Literatura</a><a href="/pavel?rezim=prispevek">Příspěvek na FB</a><a href="/pavel?rezim=novinky">Novinky</a><a href="/pavel/konverzace">Konverzace</a><a href="/pavel/opravy">Opravy AI</a><span>Operační program – připravujeme</span><a href="/pavel/odhlasit">Odhlásit</a></nav>`;

function formular(rezim = "lekar", otazka = "", dni = 30) {
  const ph = { lekar: "Např. Laser vs. excize u pilonidálního sinu – recidivy a hojení?", prispevek: "Téma příspěvku, např. Kdy po laserové operaci hemoroidů zpět do práce", novinky: "Téma (prázdné = všechna tvoje témata)" }[rezim];
  return `<form method="post" action="/pavel/dotaz" onsubmit="this.querySelector('button').disabled=true;this.querySelector('button').textContent='Hledám v PubMed… (až minuta)'">
<input type="hidden" name="rezim" value="${esc(rezim)}">
<label>${rezim === "lekar" ? "Odborná otázka" : rezim === "prispevek" ? "Téma příspěvku" : "Téma"}</label>
<textarea name="otazka" placeholder="${esc(ph)}">${esc(otazka)}</textarea>
${rezim === "novinky" ? `<label>Za posledních dní</label><input name="dni" type="number" min="1" max="365" value="${esc(dni)}">` : ""}
<button>${rezim === "lekar" ? "Prohledat literaturu" : rezim === "prispevek" ? "Navrhnout příspěvek" : "Ukázat novinky"}</button></form>`;
}
const NADPIS = { lekar: "Literatura", prispevek: "Příspěvek na FB se zdroji", novinky: "Novinky v literatuře" };

/* ---------- systémové prompty ---------- */
const SYS_LEKAR = `Jsi literární asistent MUDr. Pavla Ditla, chirurga (klasická a laparoskopická chirurgie, křečové žíly, proktologie, laserové metody; bývalý vedoucí oddělení klinických studií FN Bulovka). Odpovídáš česky, odborně a stručně, jako kolega.
- Vždy nejdřív vyhledej v literatuře (hledej_literaturu, klidně 2–3 dotazy; u otázek na probíhající výzkum i hledej_klinicke_studie). Upřednostni metaanalýzy, RCT a guidelines.
- Shrň důkazy: typ a velikost studií, hlavní výsledky s čísly, limity, síla důkazů, praktický závěr.
- Každé tvrzení z literatury podlož odkazem ve tvaru (PMID 12345678). Nic si nevymýšlej; když literatura neodpovídá nebo je slabá, řekni to.
- Na konec dej "Zdroje:" – odrážky ve tvaru: PMID – první autor et al., časopis rok, typ studie.`;
const SYS_PRISPEVEK = `Píšeš návrh facebookového příspěvku pro stránku Pavel Ditl MD. Hlas stránky je AI, kterou trénoval MUDr. Pavel Ditl; o Pavlovi mluví ve 3. osobě. Čtenáři jsou laici.
- Nejdřív ověř fakta v literatuře (hledej_literaturu, upřednostni přehledy a RCT).
- 120–200 slov, česky, lidsky, bez latiny (nebo ji hned vysvětli), bez strašení a bez bagatelizace. Žádné ceny, žádné sliby výsledku, žádné srovnávání s jinými lékaři.
- Konkrétní čísla jen pokud jsou ve zdroji.
- Na konec: "Zdroj:" a 1–3 zdroje ve tvaru Autor et al., Časopis rok (PMID …), pak větu: "Jsem AI, kterou trénoval MUDr. Pavel Ditl. Informační obsah, nenahrazuje vyšetření."
- Pod příspěvek odděleně (pro Pavla) napiš 1–2 věty, co ze zdrojů vyplývá a na co si dát pozor.`;
const SYS_NOVINKY = `Jsi literární asistent MUDr. Pavla Ditla (chirurg: laser u hemoroidů, pilonidálního sinu a varixů, sklerotizace, laparoskopie). Dostaneš seznam nových článků z PubMed. Napiš česky stručný přehled "Co je nového":
- vyber jen klinicky zajímavé práce (RCT, metaanalýzy, velké kohorty, guidelines, nové techniky); kazuistiky a slabé práce jen zmiň počtem;
- u každé vybrané: 1–2 věty, hlavní výsledek s čísly, typ studie, (PMID …);
- seskup podle témat; na konec 1 věta, co by mohlo změnit praxi. Nic si nevymýšlej.`;

async function novinkyData(tema, dni) {
  const od = new Date(Date.now() - dni * 864e5).toISOString().slice(0, 10);
  const temata = tema ? [tema] : TEMATA;
  const bloky = [];
  for (const t of temata) {
    try { const v = await lit.hledejClanky(t, { max: 8, odData: od, razeni: "nejnovejsi" }); bloky.push(`### ${t}\n${lit.textClanky(v)}`); }
    catch (e) { bloky.push(`### ${t}\nChyba: ${e.message}`); }
  }
  return bloky.join("\n\n");
}

async function odpoved(rezim, otazka, dni) {
  if (!ANTHROPIC_API_KEY) throw new Error("chybí ANTHROPIC_API_KEY");
  if (rezim === "novinky") {
    const data = await novinkyData(otazka.trim(), dni);
    const { text } = await lit.askWithTools({ apiKey: ANTHROPIC_API_KEY, model: MODEL, system: SYS_NOVINKY, tools: [], maxTokens: 2500,
      messages: [{ role: "user", content: `Nové články za posledních ${dni} dní:\n\n${data}` }] });
    return text;
  }
  const { text, pouzite } = await lit.askWithTools({ apiKey: ANTHROPIC_API_KEY, model: MODEL, system: rezim === "prispevek" ? SYS_PRISPEVEK : SYS_LEKAR,
    maxTokens: 2500, maxKol: 4, log, messages: [{ role: "user", content: otazka }] });
  return text + (pouzite.length ? `\n\n— hledáno: ${pouzite.map((p) => `${p.name === "hledej_klinicke_studie" ? "ClinicalTrials.gov" : "PubMed"} „${p.input.dotaz}“`).join(", ")}` : "");
}

/* ---------- router: vrací true, když požadavek vyřídil ---------- */
async function handle(req, res, url) {
  const p = url.pathname.replace(/\/+$/, "") || "/pavel";
  if (!HESLO) { posli(res, 503, stranka("Soukromá sekce", `<h1>Soukromá sekce je vypnutá</h1><p class="sub">Nastav na Renderu proměnnou PAVEL_HESLO.</p>`)); return true; }

  if (p === "/pavel/login" && req.method === "POST") {
    const ip = ipOf(req);
    if (zablokovano(ip)) { posli(res, 429, stranka("Přihlášení", `<h1>Příliš mnoho pokusů</h1><p class="sub">Zkus to za 15 minut.</p>`)); return true; }
    const f = await readForm(req);
    if (crypto.timingSafeEqual(sha(f.get("heslo") || ""), sha(HESLO))) {
      log(`přihlášení OK ${ip}`);
      res.writeHead(303, { Location: "/pavel", "Set-Cookie": sessionCookie(), "Cache-Control": "no-store" });
      res.end(); return true;
    }
    spatnyPokus(ip); log(`špatné heslo ${ip}`);
    posli(res, 401, stranka("Přihlášení", loginHtml("Špatné heslo."))); return true;
  }
  if (p === "/pavel/odkaz") {
    /* GET odkaz jen zobrazí (Facebook si odkazy ze zpráv sám stahuje kvůli náhledu), token spotřebuje až POST */
    const t = (req.method === "POST" ? (await readForm(req)).get("t") : url.searchParams.get("t")) || "";
    const exp = odkazy.get(t);
    if (!exp || exp < Date.now()) { posli(res, 401, stranka("Přihlášení", loginHtml("Odkaz už neplatí. Napiš stránce v Messengeru znovu „přihlásit“."))); return true; }
    if (req.method !== "POST") {
      posli(res, 200, stranka("Přihlášení", `<h1>Soukromá sekce</h1><div class="card"><form method="post" action="/pavel/odkaz" id="f"><input type="hidden" name="t" value="${esc(t)}"><p>Přihlašuji…</p><button>Přihlásit se</button></form></div><script>document.getElementById("f").submit()</script>`));
      return true;
    }
    odkazy.delete(t);
    log(`přihlášení odkazem z Messengeru ${ipOf(req)}`);
    res.writeHead(303, { Location: "/pavel", "Set-Cookie": sessionCookie(), "Cache-Control": "no-store" }); res.end(); return true;
  }
  if (p === "/pavel/odhlasit") { res.writeHead(303, { Location: "/pavel", "Set-Cookie": "pd=; Path=/pavel; Max-Age=0; HttpOnly; Secure; SameSite=Lax" }); res.end(); return true; }

  if (!prihlasen(req)) { posli(res, 200, stranka("Přihlášení", loginHtml())); return true; }
  res.setHeader("Set-Cookie", sessionCookie()); // klouzavé prodloužení: kdo sekci používá, zůstává přihlášený

  if (p === "/pavel/konverzace" && req.method === "GET") { posli(res, 200, stranka("Pavel – Konverzace", konverzaceHtml())); return true; }
  if (p === "/pavel/opravy" && req.method === "GET") {
    try { await opravy.nacti(); } catch (e) { log(`opravy: ${e.message}`); }
    posli(res, 200, stranka("Pavel – Opravy AI", opravyHtml(url.searchParams.get("ok")))); return true;
  }
  if (p === "/pavel/opravy/pridat" && req.method === "POST") {
    const f = await readForm(req);
    let ok = "1"; try { await opravy.pridej(f.get("text") || "", f.get("zdroj") || ""); } catch (e) { log(`přidání opravy: ${e.message}`); ok = "0"; }
    res.writeHead(303, { Location: `/pavel/opravy?ok=${ok}`, "Cache-Control": "no-store" }); res.end(); return true;
  }
  if (p === "/pavel/opravy/smazat" && req.method === "POST") {
    const f = await readForm(req);
    try { await opravy.smaz(f.get("id") || ""); } catch (e) { log(`smazání opravy: ${e.message}`); }
    res.writeHead(303, { Location: "/pavel/opravy", "Cache-Control": "no-store" }); res.end(); return true;
  }
  if (p === "/pavel" && req.method === "GET") {
    const rezim = ["lekar", "prispevek", "novinky"].includes(url.searchParams.get("rezim")) ? url.searchParams.get("rezim") : "lekar";
    posli(res, 200, stranka("Pavel – " + NADPIS[rezim], `<h1>${NADPIS[rezim]}</h1><p class="sub">Soukromá sekce · PubMed (Europe PMC) a ClinicalTrials.gov</p>${NAV}<div class="card">${formular(rezim, "", 30)}</div>`));
    return true;
  }
  if (p === "/pavel/dotaz" && req.method === "POST") {
    const f = await readForm(req);
    const rezim = ["lekar", "prispevek", "novinky"].includes(f.get("rezim")) ? f.get("rezim") : "lekar";
    const otazka = (f.get("otazka") || "").slice(0, 2000);
    const dni = Math.min(Math.max(Number(f.get("dni") || 7), 1), 365);
    if (!otazka.trim() && rezim !== "novinky") { res.writeHead(303, { Location: `/pavel?rezim=${rezim}` }); res.end(); return true; }
    let vysledek;
    try { vysledek = `<div class="card ans">${md(await odpoved(rezim, otazka, dni))}</div>`; }
    catch (e) { log(`dotaz: ${e.message}`); vysledek = `<div class="card"><b>Chyba:</b> ${esc(e.message)}</div>`; }
    posli(res, 200, stranka("Pavel – " + NADPIS[rezim], `<h1>${NADPIS[rezim]}</h1>${NAV}<div class="card">${formular(rezim, otazka, dni)}</div>${vysledek}<p class="muted">Shrnutí připravila AI z abstraktů; před použitím v praxi ověř v plném textu.</p>`));
    return true;
  }
  posli(res, 404, stranka("Nenalezeno", `<h1>Nenalezeno</h1>${NAV}`)); return true;
}
const kdy = (t) => new Date(t).toLocaleString("cs-CZ", { timeZone: "Europe/Prague" });
function konverzaceHtml() {
  const ted = Date.now();
  const list = [...zdroje.chats().entries()].filter(([, c]) => c && ted - c.t < 24 * 3600e3).sort((a, b) => b[1].t - a[1].t).slice(0, 50);
  const kanal = (id) => (String(id).startsWith("web_") ? "Chat na webu" : "Messenger");
  const maska = (id) => "…" + String(id).slice(-4);
  const cist = (t) => String(typeof t === "string" ? t : "").replace(/\n\n\[[^\]]*\]\s*$/, "").trim();
  const bloky = list.map(([id, c]) => {
    const turns = (c.turns || []).filter((x) => typeof x.content === "string");
    const items = turns.map((x, i) => x.role === "user"
      ? `<p><b>Pacient:</b> ${esc(cist(x.content))}</p>`
      : `<p><b>AI:</b> ${esc(x.content)}</p><details><summary class="muted">Opravit tuto odpověď</summary><form method="post" action="/pavel/opravy/pridat">
<input type="hidden" name="zdroj" value="${esc(`${kanal(id)} ${maska(id)}: ${cist(turns[i - 1]?.content || "")}`.slice(0, 190))}">
<label>Jak má AI příště odpovědět (pravidlo platí pro všechny pacienty)</label><textarea name="text" placeholder="Např. U krvácení po laserové operaci vždy doporuč kontrolu do týdne."></textarea><button>Uložit opravu</button></form></details>`).join("\n");
    return `<div class="card"><p class="muted">${kanal(id)} ${maska(id)} · ${kdy(c.t)} · ${turns.length} zpráv</p>${items}</div>`;
  }).join("\n");
  return `<h1>Konverzace</h1><p class="sub">Messenger a chat na webu za posledních 24 hodin (déle se neukládají). Hovory s hlasovým asistentem najdeš v ElevenLabs → Agents → Conversations.</p>${NAV}${bloky || `<div class="card">Zatím žádné konverzace.</div>`}`;
}
function opravyHtml(ok) {
  const s = opravy.seznam(), sync = opravy.stavSync();
  const zprava = ok === "1"
    ? `<div class="card">✅ Uloženo. V Messengeru a chatu na webu platí hned${sync && sync.ok ? " a hlasový asistent je taky aktualizovaný." : `; hlasového asistenta se nepodařilo aktualizovat (${esc((sync && sync.chyba) || "?")}).`}</div>`
    : ok === "0" ? `<div class="card">❌ Opravu se nepodařilo uložit. Zkus to prosím znovu.</div>` : "";
  const items = s.map((o) => `<li>${esc(o.text)}<br><span class="muted">${kdy(o.kdy)}${o.zdroj ? " · " + esc(o.zdroj) : ""}</span>
<form method="post" action="/pavel/opravy/smazat"><input type="hidden" name="id" value="${esc(o.id)}"><button style="margin:6px 0 10px;padding:5px 12px;font-size:13px;background:#aa5032;color:#fff">Smazat</button></form></li>`).join("\n");
  return `<h1>Opravy AI</h1><p class="sub">Pravidla, kterými AI doučuješ. Platí v Messengeru, v chatu na webu i v hlasovém asistentovi a mají přednost před výchozími instrukcemi.</p>${NAV}${zprava}
<div class="card"><form method="post" action="/pavel/opravy/pridat"><label>Nové pravidlo</label><textarea name="text" placeholder="Např. Pacientům po laseru hemoroidů doporučuj sedací koupele až od druhého dne."></textarea><button>Uložit pravidlo</button></form></div>
<div class="card"><h3>Platná pravidla (${s.length})</h3>${s.length ? `<ul>${items}</ul>` : `<p class="muted">Zatím žádná.</p>`}</div>`;
}
function loginHtml(chyba = "") {
  return `<h1>Soukromá sekce</h1><p class="sub">MUDr. Pavel Ditl</p><div class="card"><form method="post" action="/pavel/login">
<label>Heslo</label><input type="password" name="heslo" autocomplete="current-password" autofocus>${chyba ? `<p style="color:#ff8a7a">${esc(chyba)}</p>` : ""}<button>Přihlásit</button></form></div>
<div class="card"><b>Bez hesla:</b> napiš stránce Pavel Ditl MD v Messengeru slovo <b>přihlásit</b> – přijde ti odkaz, který tě rovnou přihlásí.</div>`;
}

module.exports = { handle, md, TEMATA, novinkyData, messengerPrikaz, pripoj };
