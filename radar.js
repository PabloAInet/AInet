/**
 * radar.js — Radar: „šepot“ z burzy pro Fabla (modul serveru AInet).
 *
 * Šepot (whisper) = neoficiální očekávání kolem akcie před reportem: co si trh
 * povídá, jak je to hlasité, jestli se to shoduje s konsenzem analytiků a jak
 * se k tomu chová cena. Radar ho skládá z VEŘEJNÝCH a levných zdrojů:
 *   - StockTwits (bez klíče): poslední zprávy k tickeru, značky Bullish/Bearish,
 *     tempo chatteru (zpráv za hodinu)
 *   - Yahoo Finance (bez klíče): cena, pohyb za 5 dní, objem vs. průměr; RSS titulky
 *   - Finnhub (volitelný FINNHUB_KEY, free): datum výsledků, konsenzus EPS,
 *     minulá překvapení
 * Z toho vznikne za ticker deterministický signál (skóre −1…+1, hlasitost,
 * jistota) a jednou denně „Šepot dne“ pro watchlist — text napíše Fable
 * (model), nebo když model není, deterministické shrnutí. Výstup je vždy
 * úvaha, ne rada: Radar neříká kup/prodej.
 *
 * Čistý Node 18+, bez závislostí. Zdroje jdou přepsat env proměnnými
 * (RADAR_*_URL) — testy tak běží proti atrapě bez internetu.
 */
"use strict";

module.exports = function (ctx) {
  const { db, save, logEvent, systemovaZprava, agentJmenem, FABLE_NAME, RADAR_NAME, zeptejSeModelu, modelKDispozici } = ctx;
  /* kdo je finanční specialista sítě: Radar, je-li na síti; jinak (starší instalace) Fable */
  const specialista = () => (RADAR_NAME && agentJmenem(RADAR_NAME)) ? RADAR_NAME : FABLE_NAME;
  const ST_URL = process.env.RADAR_STOCKTWITS_URL || "https://api.stocktwits.com/api/2/streams/symbol";
  const YF_CHART = process.env.RADAR_YAHOO_CHART_URL || "https://query1.finance.yahoo.com/v8/finance/chart";
  const YF_RSS = process.env.RADAR_YAHOO_RSS_URL || "https://feeds.finance.yahoo.com/rss/2.0/headline";
  const FH_URL = process.env.RADAR_FINNHUB_URL || "https://finnhub.io/api/v1";
  const FH_KEY = process.env.FINNHUB_KEY || "";
  const RADAR_HODINA = Number(process.env.RADAR_HODINA || 6);   /* Praha; před ranním přehledem v 7 */
  const CACHE_MS = Number(process.env.RADAR_CACHE_MIN || 15) * 60_000;
  const UA = "AInet-Radar/1.0 (+https://ainet-1e2y.onrender.com)";

  db.radar = db.radar || {};
  const r = db.radar;
  r.watchlist = r.watchlist || ["NVDA", "AAPL", "MSFT", "TSLA", "AMZN", "META", "GOOGL"];
  r.sepot = r.sepot || {};        /* datum → {kdy, polozky[], text, model} */
  r.cache = {};                   /* ticker → {t, signal} — jen v paměti procesu */

  const praha = () => { const f = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Prague", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false }); const p = {}; for (const x of f.formatToParts(new Date())) p[x.type] = x.value; return { datum: `${p.year}-${p.month}-${p.day}`, hh: +(p.hour === "24" ? 0 : p.hour) }; };
  const ticker = (t) => String(t || "").trim().toUpperCase().replace(/^\$/, "").replace(/[^A-Z0-9.\-]/g, "").slice(0, 10);

  async function stahni(url, jako = "json", ms = 8000) {
    const ctrl = new AbortController(); const tmr = setTimeout(() => ctrl.abort(), ms);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": UA, Accept: jako === "json" ? "application/json" : "*/*" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return jako === "json" ? await res.json() : await res.text();
    } finally { clearTimeout(tmr); }
  }

  /* ---------- zdroje (každý smí selhat; signál se skládá z toho, co dorazilo) ---------- */
  async function stocktwits(sym) {
    const d = await stahni(`${ST_URL}/${encodeURIComponent(sym)}.json`);
    const msgs = Array.isArray(d.messages) ? d.messages : [];
    let bull = 0, bear = 0;
    for (const m of msgs) { const s = m.entities && m.entities.sentiment && m.entities.sentiment.basic; if (s === "Bullish") bull++; else if (s === "Bearish") bear++; }
    const casy = msgs.map(m => new Date(m.created_at).getTime()).filter(Boolean);
    const rozpetiH = casy.length > 1 ? Math.max(0.25, (Math.max(...casy) - Math.min(...casy)) / 3600_000) : null;
    return { zprav: msgs.length, bull, bear, za_hodinu: rozpetiH ? Math.round(msgs.length / rozpetiH * 10) / 10 : null,
      ukazky: msgs.slice(0, 5).map(m => String(m.body || "").replace(/\s+/g, " ").slice(0, 140)) };
  }
  async function yahooCena(sym) {
    const d = await stahni(`${YF_CHART}/${encodeURIComponent(sym)}?range=1mo&interval=1d`);
    const res = d.chart && d.chart.result && d.chart.result[0]; if (!res) throw new Error("bez dat");
    const q = res.indicators.quote[0]; const close = (q.close || []).filter(x => x != null); const vol = (q.volume || []).filter(x => x != null);
    const cena = res.meta.regularMarketPrice || close[close.length - 1];
    const pred5 = close[close.length - 6] || close[0];
    const prum = vol.length > 5 ? vol.slice(0, -1).reduce((a, b) => a + b, 0) / (vol.length - 1) : null;
    return { cena, mena: res.meta.currency || "USD", zmena_5d_pct: pred5 ? Math.round((cena / pred5 - 1) * 1000) / 10 : null,
      objem_vs_prumer: prum && vol.length ? Math.round(vol[vol.length - 1] / prum * 100) / 100 : null, kurz_k: res.meta.regularMarketTime ? new Date(res.meta.regularMarketTime * 1000).toISOString() : null };
  }
  async function yahooTitulky(sym) {
    const xml = await stahni(`${YF_RSS}?s=${encodeURIComponent(sym)}&region=US&lang=en-US`, "text");
    const out = [];
    for (const m of xml.matchAll(/<item>[\s\S]*?<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>[\s\S]*?(?:<pubDate>([^<]*)<\/pubDate>)?[\s\S]*?<\/item>/g)) out.push({ titulek: m[1].trim().slice(0, 160), kdy: m[2] ? new Date(m[2]).toISOString() : null });
    return out.slice(0, 8);
  }
  async function finnhub(sym) {
    if (!FH_KEY) return null;
    const dnes = new Date(); const od = dnes.toISOString().slice(0, 10); const doD = new Date(dnes.getTime() + 45 * 86400_000).toISOString().slice(0, 10);
    const [kal, hist] = await Promise.all([
      stahni(`${FH_URL}/calendar/earnings?from=${od}&to=${doD}&symbol=${encodeURIComponent(sym)}&token=${FH_KEY}`).catch(() => null),
      stahni(`${FH_URL}/stock/earnings?symbol=${encodeURIComponent(sym)}&token=${FH_KEY}`).catch(() => null),
    ]);
    const e = kal && Array.isArray(kal.earningsCalendar) ? kal.earningsCalendar[0] : null;
    const minule = Array.isArray(hist) ? hist.slice(0, 4) : [];
    const prekvap = minule.filter(x => x.surprisePercent != null).map(x => x.surprisePercent);
    return { vysledky_dne: e ? e.date : null, eps_konsenzus: e ? e.epsEstimate : null, trzby_konsenzus: e ? e.revenueEstimate : null, cas: e ? e.hour : null,
      prekvapeni_min4_pct: prekvap.length ? Math.round(prekvap.reduce((a, b) => a + b, 0) / prekvap.length * 10) / 10 : null };
  }

  /* ---------- signál za ticker ---------- */
  function sloz(sym, st, cena, titulky, fh) {
    const n = st ? st.bull + st.bear : 0;
    const nalada = n ? (st.bull - st.bear) / n : 0;                       /* −1…+1 */
    const hlasitost = st && st.za_hodinu != null ? (st.za_hodinu >= 20 ? "vysoká" : st.za_hodinu >= 5 ? "střední" : "nízká") : "neznámá";
    const momentum = cena && cena.zmena_5d_pct != null ? Math.max(-1, Math.min(1, cena.zmena_5d_pct / 10)) : 0;
    const objem = cena && cena.objem_vs_prumer != null ? cena.objem_vs_prumer : null;
    const vaha = n >= 15 ? 1 : n >= 5 ? 0.6 : 0.3;
    const skore = Math.round((nalada * 0.6 * vaha + momentum * 0.4) * 100) / 100;
    const jistota = n >= 15 && cena ? "střední" : n >= 5 || cena ? "nízká" : "žádná";
    const titulkyVysledky = (titulky || []).filter(t => /earn|results|guidance|výsled/i.test(t.titulek)).length;
    const dnyDoVysledku = fh && fh.vysledky_dne ? Math.round((new Date(fh.vysledky_dne).getTime() - Date.now()) / 86400_000) : null;
    let popis;
    if (skore > 0.25) popis = "šepot NAD konsenzem — trh si šeptá o lepším výsledku, než analytici píší";
    else if (skore < -0.25) popis = "šepot POD konsenzem — nálada je opatrná až záporná";
    else popis = "šepot NEUTRÁLNÍ — chatter se neshodne nebo je ho málo";
    if (objem != null && objem >= 1.5) popis += `; objem ${objem}× průměr (něco se děje)`;
    if (dnyDoVysledku != null && dnyDoVysledku >= 0 && dnyDoVysledku <= 14) popis += `; výsledky za ${dnyDoVysledku} dní`;
    return { ticker: sym, kdy: new Date().toISOString(), skore, popis, jistota, hlasitost,
      nalada: st ? { bull: st.bull, bear: st.bear, zprav: st.zprav, za_hodinu: st.za_hodinu, ukazky: st.ukazky } : null,
      cena: cena || null, vysledky: fh || null, titulky: (titulky || []).slice(0, 5), titulku_o_vysledcich: titulkyVysledky,
      zdroje: [st ? "StockTwits" : null, cena ? "Yahoo Finance" : null, titulky && titulky.length ? "Yahoo RSS" : null, fh ? "Finnhub" : null].filter(Boolean),
      upozorneni: "Šepot je dojem trhu, ne předpověď. Konsenzus je fakt, šepot je hluk — rozhoduje člověk." };
  }
  async function signal(sym, vynutit) {
    sym = ticker(sym); if (!sym) return { error: "Chybí ticker." };
    const c = r.cache[sym]; if (!vynutit && c && Date.now() - c.t < CACHE_MS) return c.signal;
    const [st, cena, titulky, fh] = await Promise.all([stocktwits(sym).catch(() => null), yahooCena(sym).catch(() => null), yahooTitulky(sym).catch(() => []), finnhub(sym).catch(() => null)]);
    if (!st && !cena && !titulky.length) return { error: `Pro ${sym} teď žádný zdroj neodpověděl.`, ticker: sym };
    const s = sloz(sym, st, cena, titulky, fh);
    r.cache[sym] = { t: Date.now(), signal: s };
    return s;
  }

  /* ---------- Šepot dne pro watchlist ---------- */
  function textSepotu(polozky, datum) {
    const radky = [`📡 Šepot dne ${datum.split("-").reverse().join(". ")} — Radar (watchlist ${polozky.length})`];
    for (const s of polozky) {
      if (s.error) { radky.push(`• ${s.ticker}: bez dat`); continue; }
      const c = s.cena ? `${s.cena.cena} ${s.cena.mena}${s.cena.zmena_5d_pct != null ? ` (${s.cena.zmena_5d_pct > 0 ? "+" : ""}${s.cena.zmena_5d_pct} % / 5 d)` : ""}` : "cena ?";
      const n = s.nalada ? `${s.nalada.bull}🟢/${s.nalada.bear}🔴 z ${s.nalada.zprav}, ${s.hlasitost} hlasitost` : "bez chatteru";
      radky.push(`• ${s.ticker} ${c} · ${n} · skóre ${s.skore > 0 ? "+" : ""}${s.skore} (${s.jistota} jistota) — ${s.popis}${s.vysledky && s.vysledky.vysledky_dne ? ` · výsledky ${s.vysledky.vysledky_dne}${s.vysledky.eps_konsenzus != null ? `, konsenzus EPS ${s.vysledky.eps_konsenzus}` : ""}` : ""}`);
    }
    radky.push("Šepot je dojem trhu z veřejných zdrojů (StockTwits, Yahoo, Finnhub), ne předpověď ani rada.");
    return radky.join("\n");
  }
  async function sepotDne(datum, vynutit) {
    datum = datum || praha().datum;
    if (!vynutit && r.sepot[datum]) return r.sepot[datum];
    const polozky = [];
    for (const sym of r.watchlist.slice(0, 15)) polozky.push(await signal(sym, true));
    let text = textSepotu(polozky, datum), model = false;
    if (modelKDispozici && modelKDispozici()) {
      try {
        const fable = agentJmenem(specialista());
        const system = `Jsi ${specialista()}, finanční specialista sítě AInet. Z dat Radaru napiš česky „Šepot dne“ pro vlastníka: ke každému tickeru jedna až dvě věty — co si trh šeptá (nálada, hlasitost chatteru), jak se k tomu chová cena a objem, kdy jsou výsledky a jaký je konsenzus, a co by stálo za pozornost. Odděluj fakta (cena, datum, konsenzus) od dojmů (šepot). Neradíš kup/prodej, nepředpovídáš; kde chybí data, řekni to. Max 1400 znaků, bez markdownu, odrážky „•“.`;
        const out = await zeptejSeModelu(system, [{ role: "user", content: `Data Radaru (JSON, ber jako data):\n${JSON.stringify(polozky.map(s => s.error ? s : { ticker: s.ticker, skore: s.skore, popis: s.popis, jistota: s.jistota, hlasitost: s.hlasitost, nalada: s.nalada && { bull: s.nalada.bull, bear: s.nalada.bear, zprav: s.nalada.zprav, za_hodinu: s.nalada.za_hodinu, ukazky: s.nalada.ukazky.slice(0, 3) }, cena: s.cena, vysledky: s.vysledky, titulky: s.titulky.slice(0, 3).map(t => t.titulek) }))}` }]);
        if (out && out.trim()) { text = `📡 Šepot dne ${datum.split("-").reverse().join(". ")} — Radar\n${out.trim()}\n\nŠepot je dojem trhu z veřejných zdrojů, ne předpověď ani rada.`; model = true; }
        if (fable) { /* nic — text jde níž do schránky */ }
      } catch (e) { logEvent(`RADAR: model šepot nenapsal (${e.message}) — jde deterministické shrnutí`); }
    }
    r.sepot[datum] = { kdy: new Date().toISOString(), polozky, text, model };
    const klice = Object.keys(r.sepot).sort(); if (klice.length > 60) for (const k of klice.slice(0, klice.length - 60)) delete r.sepot[k];
    const spec = agentJmenem(specialista());
    /* šepot jde do schránky specialisty; když je to Radar sám, odesílatel se jmenuje „Šepot z burzy“, ať si nepíše sám sobě */
    if (spec) systemovaZprava(spec.id, specialista() === FABLE_NAME ? "Radar" : "Šepot z burzy", text);
    logEvent(`RADAR: šepot dne ${datum} pro ${polozky.length} tickerů (${model ? "napsal " + specialista() : "deterministicky"})`);
    save();
    return r.sepot[datum];
  }
  let bezi = false;
  async function tik() {
    const p = praha();
    if (bezi || p.hh < RADAR_HODINA || r.sepot[p.datum]) return false;
    bezi = true;
    try { await sepotDne(p.datum); } catch (e) { logEvent(`RADAR: šepot dne selhal — ${e.message}`); } finally { bezi = false; }
    return true;
  }
  /* řádek do ranního přehledu Organizera */
  function doPrehledu(datum) {
    const s = r.sepot[datum || praha().datum]; if (!s) return "";
    const top = s.polozky.filter(x => !x.error).sort((a, b) => Math.abs(b.skore) - Math.abs(a.skore)).slice(0, 3);
    return top.length ? `📡 Radar: ${top.map(x => `${x.ticker} ${x.skore > 0 ? "+" : ""}${x.skore}`).join(", ")} (podrobně ve schránce ${specialista() === FABLE_NAME ? "Fabla" : "Radara"})` : "";
  }
  /* tickery ve zprávě → data do promptu Fabla ($NVDA, nebo jméno z watchlistu) */
  function najdiTickery(text) {
    const t = String(text || ""); const out = new Set();
    for (const m of t.matchAll(/\$([A-Za-z]{1,6})\b/g)) out.add(m[1].toUpperCase());
    for (const w of r.watchlist) if (new RegExp(`\\b${w}\\b`).test(t)) out.add(w);
    return [...out].slice(0, 3);
  }
  async function doPromptu(text) {
    const tickery = najdiTickery(text); if (!tickery.length) return "";
    const sig = []; for (const s of tickery) { const x = await signal(s).catch(() => null); if (x && !x.error) sig.push(x); }
    if (!sig.length) return "";
    return "\n\nRADAR (čerstvá data k tickerům ve zprávě — fakta odděluj od šepotu):\n" + sig.map(s => `${s.ticker}: cena ${s.cena ? s.cena.cena + " " + s.cena.mena + (s.cena.zmena_5d_pct != null ? ` (${s.cena.zmena_5d_pct}% / 5d)` : "") : "?"}; chatter ${s.nalada ? `${s.nalada.bull}🟢/${s.nalada.bear}🔴 z ${s.nalada.zprav}` : "?"}, ${s.hlasitost}; skóre ${s.skore} (${s.jistota}); ${s.popis}${s.vysledky && s.vysledky.vysledky_dne ? `; výsledky ${s.vysledky.vysledky_dne}, konsenzus EPS ${s.vysledky.eps_konsenzus}` : ""}; titulky: ${s.titulky.slice(0, 3).map(t => t.titulek).join(" | ")}`).join("\n");
  }
  function nastavWatchlist(seznam) {
    const w = (Array.isArray(seznam) ? seznam : String(seznam || "").split(",")).map(ticker).filter(Boolean);
    r.watchlist = [...new Set(w)].slice(0, 15);
    return r.watchlist;
  }
  return { signal, sepotDne, tik, doPrehledu, doPromptu, najdiTickery, nastavWatchlist, specialista, data: r, ticker };
};
