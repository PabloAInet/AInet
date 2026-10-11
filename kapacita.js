/*
 * kapacita.js — Sentinel hlídá, KOLIK TO STOJÍ a jestli STAČÍ KAPACITA AInetu (12. 10. 2026).
 *
 * Pavel: „Sentinel by měl kontrolovat, kolik to stojí a jestli stačí výpočetní kapacity AInetu.“
 *
 * NÁKLADY: každé volání modelu (odpovídač, škola, porady, projekty, radar, trh) se zapíše s tokeny, modelem,
 *   latencí a ÚČELEM (štítek: účel, agent, projekt). Cena podle ceníku (USD za milion tokenů, vstup/výstup;
 *   výchozí podle oficiálního ceníku Anthropicu k 10/2026, přepíše CENIK_JSON). Den, měsíc a ODHAD do konce
 *   měsíce; MĚSÍČNÍ LIMIT nastaví vlastník (web / POST /api/kapacita) — při 80 % odhadu varování, při 100 %
 *   skutečné útraty Sentinel POZASTAVÍ PROJEKTY ROJE (odpovídač a škola běží dál) a řekne to vlastníkovi.
 * KAPACITA: paměť procesu proti limitu instance, zpoždění smyčky událostí, CPU, fronta odpovídače, chyby
 *   a přetížení modelu (429/529), latence, velikost databáze a sandboxů, joby čekající na worker.
 *   Při přetížení nastaví „zpomalit“ → projekty rozdávají méně kroků a odkládají nepodstatné.
 * Varování chodí vlastníkovi do schránky Fabla, každý druh nejvýš jednou za 12 hodin.
 */
"use strict";

module.exports = function kapacitaModul(ctx) {
  const { db, save, logEvent, systemovaZprava, agentJmenem, fableName, DATA_DIR, fs, path } = ctx;
  const fronta = ctx.fronta || (() => ({ ceka: 0, nejstarsi_s: 0 }));
  const { monitorEventLoopDelay } = require("perf_hooks");

  /* ceník: USD za 1 milion tokenů [vstup, výstup] — oficiální ceník Anthropicu (platform.claude.com, 10/2026) */
  const CENIK_VYCHOZI = {
    "claude-opus-5-5": [4, 20], "claude-sonnet-5-5": [2, 10], "claude-haiku-5-5": [0.10, 0.50],
  };
  let CENIK = { ...CENIK_VYCHOZI };
  try { Object.assign(CENIK, JSON.parse(process.env.CENIK_JSON || "{}")); } catch { logEvent("KAPACITA: CENIK_JSON není platný JSON — beru výchozí ceník"); }
  const PAMET_LIMIT_MB = Number(process.env.PAMET_LIMIT_MB || 512);       /* Render Starter má 512 MB */
  const PRAH = { pamet_pct: 80, smycka_ms: 250, cpu_pct: 85, fronta: 12, fronta_s: 600, chyby_hodina: 10, pretizeni_hodina: 5, db_mb: 25, worker_h: 24, odhad_pct: 80 };
  const OPAKOVAT_H = 12;

  db.naklady = db.naklady || {};
  db.naklady.dny = db.naklady.dny || {};
  if (db.naklady.limit_usd === undefined) db.naklady.limit_usd = Number(process.env.MESICNI_LIMIT_USD) || null;
  db.kapacita = db.kapacita || { varovani: {}, pretizeno: false, posledni: null };
  db.kapacita.varovani = db.kapacita.varovani || {};

  const h = monitorEventLoopDelay({ resolution: 20 });
  h.enable();
  let cpuMinule = process.cpuUsage(), casMinule = Date.now();
  const nedavna = [];                   /* posledních ~60 minut volání: {t, ms, status} */

  const den = (d = new Date()) => d.toISOString().slice(0, 10);
  const mesic = (d = new Date()) => d.toISOString().slice(0, 7);
  const r4 = (x) => Math.round(x * 10000) / 10000;

  function cena(model, vstup, vystup) {
    const m = String(model || "");
    let c = CENIK[m];
    if (!c) { const k = Object.keys(CENIK).find(x => m.startsWith(x)); c = k ? CENIK[k] : null; }
    if (!c) return null;
    if (/haiku-5-5/.test(m) && vstup > 100000) c = [0.50, 2.50];            /* Haiku 5.5: dražší pásmo nad 100k tokenů vstupu */
    return (vstup * c[0] + vystup * c[1]) / 1e6;
  }
  function kos(objekt, klic) { return (objekt[klic] = objekt[klic] || { volani: 0, vstup: 0, vystup: 0, usd: 0 }); }

  /* zapis z zeptejSeModelu: jedno volání (i neúspěšné) */
  function zapisVolani({ model, vstup = 0, vystup = 0, ms = 0, status = 200, stitek = {} }) {
    const d = den(), D = db.naklady.dny[d] = db.naklady.dny[d] || { volani: 0, vstup: 0, vystup: 0, usd: 0, chyby: 0, pretizeni: 0, ms: 0, ucel: {}, agenti: {}, projekty: {}, modely: {}, bez_ceny: 0 };
    const usd = status === 200 ? cena(model, vstup, vystup) : 0;
    nedavna.push({ t: Date.now(), ms, status });
    while (nedavna.length && Date.now() - nedavna[0].t > 3600_000) nedavna.shift();
    if (status !== 200) { D.chyby++; if (status === 429 || status === 529 || status === 503) D.pretizeni++; return; }
    D.volani++; D.vstup += vstup; D.vystup += vystup; D.ms += ms;
    if (usd === null) D.bez_ceny++; else D.usd = r4(D.usd + usd);
    const plus = (b) => { b.volani++; b.vstup += vstup; b.vystup += vystup; if (usd) b.usd = r4(b.usd + usd); };
    plus(kos(D.ucel, stitek.ucel || "ostatní"));
    plus(kos(D.modely, model || "?"));
    if (stitek.agent) plus(kos(D.agenti, stitek.agent));
    if (stitek.projekt) plus(kos(D.projekty, stitek.projekt));
    const klice = Object.keys(db.naklady.dny).sort();
    for (const k of klice.slice(0, Math.max(0, klice.length - 70))) delete db.naklady.dny[k];
  }
  function strop(agent) {   /* odpovídač vyčerpal denní strop zpráv — znamení, že kapacita nestačí poptávce */
    const d = den(), D = db.naklady.dny[d] = db.naklady.dny[d] || { volani: 0, vstup: 0, vystup: 0, usd: 0, chyby: 0, pretizeni: 0, ms: 0, ucel: {}, agenti: {}, projekty: {}, modely: {}, bez_ceny: 0 };
    D.stropy = D.stropy || {}; D.stropy[agent] = (D.stropy[agent] || 0) + 1;
  }

  function soucetMesice(m = mesic()) {
    const out = { volani: 0, vstup: 0, vystup: 0, usd: 0, chyby: 0, pretizeni: 0, ucel: {}, projekty: {}, agenti: {}, dni: 0 };
    for (const [d, D] of Object.entries(db.naklady.dny)) {
      if (!d.startsWith(m)) continue;
      out.dni++;
      for (const k of ["volani", "vstup", "vystup", "chyby", "pretizeni"]) out[k] += D[k] || 0;
      out.usd = r4(out.usd + (D.usd || 0));
      for (const pole of ["ucel", "projekty", "agenti"]) for (const [k, v] of Object.entries(D[pole] || {})) {
        const b = kos(out[pole], k); b.volani += v.volani; b.vstup += v.vstup; b.vystup += v.vystup; b.usd = r4(b.usd + (v.usd || 0));
      }
    }
    return out;
  }
  function odhadMesice() {
    const ted = new Date(), M = soucetMesice();
    const dnu = new Date(Date.UTC(ted.getUTCFullYear(), ted.getUTCMonth() + 1, 0)).getUTCDate();
    const uplynulo = Math.max(1, ted.getUTCDate() - 1 + ted.getUTCHours() / 24);
    return { mesic: M, odhad_usd: r4(M.usd / uplynulo * dnu), dnu_v_mesici: dnu };
  }
  const projektUsd = (id) => { const M = soucetMesice(); const b = M.projekty[id]; return b ? { mesic_usd: b.usd, volani: b.volani, tokeny: b.vstup + b.vystup } : { mesic_usd: 0, volani: 0, tokeny: 0 }; };

  function velikostMB(cesta) {
    try {
      const st = fs.statSync(cesta);
      if (st.isFile()) return st.size / 1048576;
      let s = 0; for (const f of fs.readdirSync(cesta)) { try { const x = fs.statSync(path.join(cesta, f)); if (x.isFile()) s += x.size; } catch {} }
      return s / 1048576;
    } catch { return 0; }
  }
  function snimek() {
    const ted = Date.now();
    const cpu = process.cpuUsage(cpuMinule), dt = Math.max(1, ted - casMinule);
    cpuMinule = process.cpuUsage(); casMinule = ted;
    const rss = process.memoryUsage().rss / 1048576;
    const hodina = nedavna.filter(x => ted - x.t < 3600_000);
    const ok = hodina.filter(x => x.status === 200);
    const joby = (db.projektJoby || []).filter(j => j.stav === "ceka");
    const nejstarsiJob = joby.length ? (ted - Math.min(...joby.map(j => Date.parse(j.t)))) / 3600_000 : 0;
    const D = db.naklady.dny[den()] || {};
    const o = odhadMesice();
    const kap = {
      pamet_mb: Math.round(rss), pamet_limit_mb: PAMET_LIMIT_MB, pamet_pct: Math.round(rss / PAMET_LIMIT_MB * 100),
      smycka_p99_ms: Math.round(h.percentile(99) / 1e6), cpu_pct: Math.round((cpu.user + cpu.system) / 1000 / dt * 100),
      fronta: fronta(), volani_hodina: hodina.length, chyby_hodina: hodina.filter(x => x.status !== 200).length,
      pretizeni_hodina: hodina.filter(x => [429, 503, 529].includes(x.status)).length,
      latence_ms: ok.length ? Math.round(ok.reduce((s, x) => s + x.ms, 0) / ok.length) : null,
      db_mb: Math.round(velikostMB(path.join(DATA_DIR, "agents.json")) * 10) / 10, sandbox_mb: Math.round(velikostMB(path.join(DATA_DIR, "sandbox")) * 10) / 10,
      worker_joby: joby.length, worker_nejstarsi_h: Math.round(nejstarsiJob * 10) / 10, stropy_dnes: D.stropy || {},
    };
    h.reset();
    return {
      t: new Date().toISOString(),
      naklady: { dnes_usd: D.usd || 0, dnes_volani: D.volani || 0, dnes_tokeny: (D.vstup || 0) + (D.vystup || 0), mesic_usd: o.mesic.usd, mesic_volani: o.mesic.volani,
        odhad_mesic_usd: o.odhad_usd, limit_usd: db.naklady.limit_usd, podle_ucelu: o.mesic.ucel, podle_projektu: o.mesic.projekty, podle_agenta: o.mesic.agenti,
        bez_ceny_dnes: D.bez_ceny || 0, cenik: CENIK },
      kapacita: kap,
    };
  }

  /* Sentinel: porovnat s prahy, varovat vlastníka, nastavit „zpomalit“, říct, jestli zastavit projekty */
  function hlidej(findings) {
    const s = snimek(), k = s.kapacita, n = s.naklady, v = [];
    if (k.pamet_pct >= PRAH.pamet_pct) v.push(["pamet", `paměť ${k.pamet_mb} MB z ${k.pamet_limit_mb} MB (${k.pamet_pct} %)`]);
    if (k.smycka_p99_ms >= PRAH.smycka_ms) v.push(["smycka", `server se zadrhává (zpoždění smyčky p99 ${k.smycka_p99_ms} ms)`]);
    if (k.cpu_pct >= PRAH.cpu_pct) v.push(["cpu", `CPU ${k.cpu_pct} %`]);
    if (k.fronta.ceka >= PRAH.fronta || k.fronta.nejstarsi_s >= PRAH.fronta_s) v.push(["fronta", `fronta odpovídače ${k.fronta.ceka} zpráv (nejstarší ${Math.round(k.fronta.nejstarsi_s / 60)} min)`]);
    if (k.chyby_hodina >= PRAH.chyby_hodina) v.push(["chyby", `${k.chyby_hodina} chyb modelu za hodinu`]);
    if (k.pretizeni_hodina >= PRAH.pretizeni_hodina) v.push(["pretizeni", `model přetížený nebo limit API (${k.pretizeni_hodina}× 429/529 za hodinu)`]);
    if (k.db_mb >= PRAH.db_mb) v.push(["db", `databáze má ${k.db_mb} MB — ukládání zpomaluje`]);
    if (k.worker_joby && k.worker_nejstarsi_h >= PRAH.worker_h) v.push(["worker", `${k.worker_joby} jobů čeká na worker TradeRadara (nejstarší ${k.worker_nejstarsi_h} h) — běží worker na Macu?`]);
    if (Object.keys(k.stropy_dnes).length) v.push(["stropy", `odpovídač dnes vyčerpal denní strop: ${Object.entries(k.stropy_dnes).map(([a, x]) => `${a} (${x}× odmítnuto)`).join(", ")}`]);
    let zastavit = false;
    if (n.limit_usd) {
      if (n.mesic_usd >= n.limit_usd) { v.push(["limit", `měsíční útrata ${n.mesic_usd.toFixed(2)} $ dosáhla limitu ${n.limit_usd} $ — projekty roje pozastavuji`]); zastavit = true; }
      else if (n.odhad_mesic_usd >= n.limit_usd * PRAH.odhad_pct / 100) v.push(["odhad", `odhad útraty za měsíc ${n.odhad_mesic_usd.toFixed(2)} $ je ${Math.round(n.odhad_mesic_usd / n.limit_usd * 100)} % limitu ${n.limit_usd} $`]);
    }
    const pretizeno = v.some(([x]) => ["pamet", "smycka", "cpu", "fronta", "pretizeni", "odhad", "limit"].includes(x));
    if (pretizeno !== !!db.kapacita.pretizeno) logEvent(`KAPACITA: ${pretizeno ? "přetížení — roj zpomalí" : "kapacita v pořádku — roj jede naplno"}`);
    db.kapacita.pretizeno = pretizeno;
    db.kapacita.posledni = { t: s.t, varovani: v.map(x => x[1]) };
    const ted = Date.now();
    const nova = v.filter(([druh]) => !db.kapacita.varovani[druh] || ted - db.kapacita.varovani[druh] > OPAKOVAT_H * 3600_000);
    for (const [druh, text] of v) if (findings) findings.push({ typ: druh === "limit" || druh === "odhad" ? "náklady" : "kapacita", "pár": "AInet", detail: text, t: s.t });
    if (nova.length) {
      for (const [druh] of nova) db.kapacita.varovani[druh] = ted;
      const fable = agentJmenem(fableName());
      if (fable) systemovaZprava(fable.id, "Sentinel", `⚠️ Náklady a kapacita AInetu:\n${nova.map(x => "• " + x[1]).join("\n")}\nDnes ${n.dnes_usd.toFixed(2)} $ (${n.dnes_volani} volání), měsíc ${n.mesic_usd.toFixed(2)} $, odhad ${n.odhad_mesic_usd.toFixed(2)} $${n.limit_usd ? ` z limitu ${n.limit_usd} $` : " (limit není nastavený)"}. Podrobnosti: záložka Log → Náklady a kapacita.`);
      logEvent(`KAPACITA: ${nova.map(x => x[1]).join(" · ")}`);
    }
    return { zastavitProjekty: zastavit, pretizeno, snimek: s };
  }

  /* HTTP: GET /api/kapacita (domácí token), POST /api/kapacita {limit_usd} */
  async function obsluz(req, res, p, body, kdo, jeDomaci, json) {
    if (p !== "/api/kapacita") return false;
    if (!(kdo && jeDomaci(kdo))) return json(res, 403, { error: "Náklady a kapacitu vidí vlastník domácích agentů (token)." }), true;
    if (req.method === "GET") {
      const s = snimek();
      const historie = Object.entries(db.naklady.dny).sort().slice(-30).map(([d, D]) => ({ den: d, usd: D.usd || 0, volani: D.volani || 0, tokeny: (D.vstup || 0) + (D.vystup || 0), chyby: D.chyby || 0 }));
      return json(res, 200, { ...s, historie, pretizeno: !!db.kapacita.pretizeno, varovani: (db.kapacita.posledni || {}).varovani || [], prahy: PRAH }), true;
    }
    if (req.method === "POST") {
      const l = body && body.limit_usd;
      if (l === null || l === 0 || l === "") db.naklady.limit_usd = null;
      else if (Number(l) > 0) db.naklady.limit_usd = Math.round(Number(l) * 10000) / 10000;
      else return json(res, 400, { error: "limit_usd: kladné číslo (USD za měsíc), nebo null = bez limitu" }), true;
      save(); logEvent(`KAPACITA: měsíční limit ${db.naklady.limit_usd ? db.naklady.limit_usd + " $" : "zrušen"} (${kdo.card.name})`);
      return json(res, 200, { ok: true, limit_usd: db.naklady.limit_usd }), true;
    }
    return false;
  }

  return { zapisVolani, strop, snimek, hlidej, obsluz, projektUsd, cena, pretizeno: () => !!(db.kapacita && db.kapacita.pretizeno) };
};
