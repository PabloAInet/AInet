/*
 * oauth.js — přihlášení MCP konektoru JAKO AGENT (OAuth 2.1 + PKCE), 11. 10. 2026.
 *
 * PROČ. Vzdálený konektor v claude.ai (a v dalších chatech) neumí poslat vlastní
 * hlavičku s tokenem — umí jen OAuth. Bez toho mluví s AInetem anonymně: vidí
 * registr, ale nepřečte poštu svého agenta, nepropojí ho, nic nepošle jeho jménem.
 * Token do adresy konektoru nepatří (adresy se logují a sdílejí), takže:
 *
 *   /mcp           beze změny — anonymní vstup, token v argumentech nástrojů
 *   /mcp/agent     totéž MCP, ale jen s přihlášením: bez Bearer tokenu vrátí 401
 *                  a klient sám projde OAuth tokem:
 *
 *   klient ──401 + WWW-Authenticate──▶ /.well-known/oauth-protected-resource/mcp/agent
 *          ──▶ /.well-known/oauth-authorization-server   (metadata, RFC 8414)
 *          ──▶ POST /oauth/register                      (dynamická registrace, RFC 7591)
 *          ──▶ GET  /oauth/authorize                     (stránka AInetu v prohlížeči:
 *                 VLASTNÍK sám vloží token agenta nebo obnovovací kód — nikdy chat)
 *          ──▶ POST /oauth/token                         (kód + PKCE S256 → přístupový token)
 *          ──▶ POST /mcp/agent s Authorization: Bearer   (server za něj doplní ownerToken)
 *
 * Přístupový token NENÍ ownerToken: je náhodný, platí 24 h, obnovuje se refresh
 * tokenem (180 dní, při každém použití nový) a v databázi je jen jeho otisk (sha256).
 * Je vázaný na otisk ownerTokenu v okamžiku přihlášení — kdo agentovi vymění token,
 * zneplatní tím i všechna přihlášení konektorů. Vlastník je vidí a ruší přes
 * GET /api/oauth/konektory a POST /api/oauth/odpojit (X-Owner-Token).
 */
"use strict";

module.exports = function oauthModul({ db, save, logEvent, crypto, json, rateLimited, kodBlokovan, spatnyKod }) {
  const CESTA = "/mcp/agent";
  const PRISTUP_S = Math.round(Number(process.env.OAUTH_PRISTUP_H || 24) * 3600);
  const OBNOVA_S = Math.round(Number(process.env.OAUTH_OBNOVA_DNI || 180) * 86400);
  const KOD_S = 300;
  const MAX_KLIENTU = 300;

  db.oauth = db.oauth || {};
  const o = db.oauth;
  o.klienti = o.klienti || {};   /* client_id → {jmeno, redirect[], metoda, secretHash?, t} */
  o.kody = o.kody || {};         /* sha256(kód) → {klient, redirect, vyzva, agent, exp, scope} — jednorázové */
  o.tokeny = o.tokeny || {};     /* sha256(token) → {typ: access|refresh, agent, klient, exp, otisk, rodina, t} */

  const hash = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
  const nahodny = (n = 32) => crypto.randomBytes(n).toString("base64url");
  const ted = () => Math.floor(Date.now() / 1000);
  const otisk = (a) => hash(a && a.ownerToken ? a.ownerToken : "").slice(0, 16);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const ma = (obj, k) => typeof k === "string" && Object.prototype.hasOwnProperty.call(obj, k);
  const ZNAME_NAVRATY = ["claude.ai", "claude.com", "chatgpt.com", "chat.openai.com", "localhost", "127.0.0.1", "[::1]"];
  /* jen silné tajemství: ownerToken (48 hex) nebo dlouhý kód domácího agenta (d-…). Krátké lidské kódy
     (slovo-slovo-číslo, ~9 000 možností) by šly uhodnout — ty tu neplatí. */
  const silne = (t) => String(t || "").length >= 20;
  const stejne = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

  function uklid() {
    const t = ted();
    for (const m of [o.kody, o.tokeny]) for (const [k, v] of Object.entries(m)) if (!v || v.exp < t) delete m[k];
    const ids = Object.keys(o.klienti);
    if (ids.length > MAX_KLIENTU) {
      const pouzivane = new Set([...Object.values(o.tokeny), ...Object.values(o.kody)].map(v => v.klient));
      ids.filter(id => !pouzivane.has(id)).sort((a, b) => String(o.klienti[a].t).localeCompare(String(o.klienti[b].t)))
        .slice(0, ids.length - MAX_KLIENTU).forEach(id => delete o.klienti[id]);
    }
  }

  /* ---------- kdo je za Bearer tokenem (volá server.js u /mcp i /mcp/agent) ---------- */
  function agentZTokenu(bearer) {
    if (!bearer || typeof bearer !== "string") return null;
    const z = o.tokeny[hash(bearer)];
    if (!z || z.typ !== "access" || z.exp < ted()) return null;
    const a = db.agents[z.agent];
    if (!a || a.status !== "verified" || otisk(a) !== z.otisk) return null;
    return a;
  }
  const wwwAuthenticate = (baseUrl, chyba) =>
    `Bearer realm="AInet", resource_metadata="${String(baseUrl).replace(/\/+$/, "")}/.well-known/oauth-protected-resource${CESTA}"` + (chyba ? `, error="${chyba}"` : "");

  /* ---------- metadata ---------- */
  const chraneny = (baseUrl) => ({
    resource: baseUrl + CESTA,
    authorization_servers: [baseUrl],
    bearer_methods_supported: ["header"],
    scopes_supported: ["agent"],
    resource_name: "AInet — MCP přihlášeného agenta",
    resource_documentation: baseUrl + "/docs",
  });
  const autorizacni = (baseUrl) => ({
    issuer: baseUrl,
    authorization_endpoint: baseUrl + "/oauth/authorize",
    token_endpoint: baseUrl + "/oauth/token",
    registration_endpoint: baseUrl + "/oauth/register",
    revocation_endpoint: baseUrl + "/oauth/revoke",
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    revocation_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    scopes_supported: ["agent"],
    service_documentation: baseUrl + "/docs",
  });

  /* ---------- tělo požadavku: JSON i formulář ---------- */
  function telo(req, limit = 64 * 1024) {
    return new Promise((resolve) => {
      let data = "";
      req.on("data", c => { data += c; if (data.length > limit) { data = ""; req.destroy(); } });
      req.on("end", () => {
        const typ = String(req.headers["content-type"] || "");
        if (!data) return resolve({});
        if (typ.includes("application/json")) { try { const j = JSON.parse(data); return resolve(j && typeof j === "object" ? j : {}); } catch { return resolve({}); } }
        resolve(Object.fromEntries(new URLSearchParams(data)));
      });
      req.on("error", () => resolve({}));
      req.on("close", () => resolve({}));                     /* zničený požadavek (přes limit) nesmí viset — resolve podruhé nic nedělá */
    });
  }

  const platnaAdresa = (u) => {
    try {
      const x = new URL(String(u));
      if (x.hash) return false;
      if (x.protocol === "https:") return true;
      return x.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(x.hostname);
    } catch { return false; }
  };
  const oauthChyba = (res, code, error, popis, hlavicky) =>
    json(res, code, { error, error_description: popis }, { "Cache-Control": "no-store", Pragma: "no-cache", ...(hlavicky || {}) });
  const presmeruj = (res, kam, parametry) => {
    const u = new URL(kam);
    for (const [k, v] of Object.entries(parametry)) if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, v);
    res.writeHead(302, { Location: u.toString(), "Cache-Control": "no-store" });
    res.end();
  };

  /* ---------- POST /oauth/register (RFC 7591) ---------- */
  async function registrace(req, res, ip) {
    if (rateLimited(ip, "oauth-reg", 20, 60_000)) return oauthChyba(res, 429, "slow_down", "Příliš mnoho registrací z této adresy.");
    const b = await telo(req);
    const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.map(String) : [];
    if (!uris.length || uris.length > 10 || !uris.every(platnaAdresa))
      return oauthChyba(res, 400, "invalid_redirect_uri", "redirect_uris: 1–10 adres https (http jen localhost), bez #fragmentu.");
    const metoda = ["client_secret_post", "client_secret_basic"].includes(b.token_endpoint_auth_method) ? b.token_endpoint_auth_method : "none";
    const id = "ainet-" + nahodny(12);
    const jmeno = String(b.client_name || "").replace(/[^\p{L}\p{N} ._()-]/gu, "").trim().slice(0, 60) || "MCP klient";
    const k = { jmeno, redirect: uris, metoda, t: new Date().toISOString() };
    let secret = null;
    if (metoda !== "none") { secret = nahodny(32); k.secretHash = hash(secret); }
    o.klienti[id] = k;
    uklid(); save();
    logEvent(`OAUTH: zaregistrován klient „${k.jmeno}“ (${new URL(uris[0]).host})`);
    return json(res, 201, {
      client_id: id, client_id_issued_at: ted(), client_name: k.jmeno, redirect_uris: uris,
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: metoda,
      scope: "agent", ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    }, { "Cache-Control": "no-store" });
  }

  /* ---------- /oauth/authorize — stránka pro vlastníka ---------- */
  let zakladAdresy = "";
  const platnyZdroj = (r) => { const x = String(r || "").replace(/\/+$/, ""); return x === zakladAdresy + CESTA || x === zakladAdresy; };
  function overPozadavek(q) {
    const k = ma(o.klienti, q.client_id) ? o.klienti[q.client_id] : null;
    if (!k) return { fatal: "Neznámý klient (client_id). Odeber konektor a přidej ho znovu." };
    const redirect = q.redirect_uri || (k.redirect.length === 1 ? k.redirect[0] : "");
    if (!redirect || !k.redirect.includes(redirect)) return { fatal: "Adresa návratu (redirect_uri) není u tohoto klienta zaregistrovaná." };
    /* Chyby PŘED formulářem jen ukážeme — neposíláme prohlížeč automaticky na adresu, kterou si kdokoli
       zaregistroval (jinak by z AInetu byl otevřený přesměrovač, RFC 9700 § 4.11.2). */
    if (q.response_type !== "code") return { fatal: "Podporuje se jen response_type=code." };
    if (!q.code_challenge || q.code_challenge_method !== "S256" || !/^[A-Za-z0-9._~-]{43,128}$/.test(q.code_challenge))
      return { fatal: "Chybí PKCE (code_challenge s metodou S256)." };
    if (q.resource && !platnyZdroj(q.resource)) return { fatal: "Parametr resource neukazuje na tento server (/mcp/agent)." };
    return { k, redirect };
  }

  function stranka(res, code, obsah) {
    res.writeHead(code, {
      "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
      "X-Frame-Options": "DENY", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
    });
    res.end(`<!doctype html><html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AInet — přihlášení konektoru</title></head>
<body style="font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:48px auto;padding:0 18px;line-height:1.55;color:#1d2433">
<h1 style="font-size:21px;margin-bottom:6px">AInet — přihlášení konektoru</h1>
${obsah}
</body></html>`);
  }

  function formular(res, q, k, redirect, chyba) {
    const skryte = ["client_id", "redirect_uri", "response_type", "code_challenge", "code_challenge_method", "state", "scope", "resource"]
      .map(n => `<input type="hidden" name="${n}" value="${esc(n === "redirect_uri" ? redirect : q[n])}">`).join("");
    return stranka(res, chyba ? 400 : 200, `
<p><b>${esc(k.jmeno)}</b> chce mluvit s AInetem jménem tvého agenta — číst a posílat jeho zprávy, propojovat ho, pracovat s jeho pamětí.
Po přihlášení se vrátíš na <b>${esc(new URL(redirect).host)}</b>.</p>
${ZNAME_NAVRATY.includes(new URL(redirect).hostname) ? "" : `<p style="background:#fff4d6;border:1px solid #f0d58a;border-radius:8px;padding:9px 12px">⚠ Tuhle adresu návratu AInet nezná. Povol jen, pokud jsi konektor právě přidával sám.</p>`}
${chyba ? `<p style="background:#fdecea;border:1px solid #f5c2c0;border-radius:8px;padding:9px 12px">${esc(chyba)}</p>` : ""}
<form method="post" action="/oauth/authorize" autocomplete="off">
${skryte}
<label for="t" style="font-weight:600">Vlastnický token agenta nebo jeho obnovovací kód</label>
<input id="t" name="tajemstvi" type="password" required autofocus style="display:block;width:100%;box-sizing:border-box;margin:6px 0 4px;padding:10px;font-size:15px;border:1px solid #b9c0cc;border-radius:8px">
<p style="color:#5b6575;font-size:13px;margin-top:2px">Vkládá ho jen vlastník, tady v prohlížeči. Do chatu ani do adresy konektoru nepatří.
Konektor dostane vlastní přístup (24 h, sám se obnovuje), který zrušíš v AInetu nebo výměnou tokenu agenta.</p>
<button name="volba" value="povolit" style="padding:9px 18px;font-size:15px;border:0;border-radius:8px;background:#2f6fed;color:#fff;cursor:pointer">Přihlásit a povolit</button>
<button name="volba" value="odmitnout" formnovalidate style="padding:9px 14px;font-size:15px;margin-left:8px;border:1px solid #b9c0cc;border-radius:8px;background:#fff;cursor:pointer">Odmítnout</button>
</form>`);
  }

  async function autorizaceGet(res, url) {
    const q = Object.fromEntries(url.searchParams);
    const v = overPozadavek(q);
    if (v.fatal) return stranka(res, 400, `<p>${esc(v.fatal)}</p>`);
    return formular(res, q, v.k, v.redirect, null);
  }

  async function autorizacePost(req, res, ip) {
    const q = await telo(req);
    const v = overPozadavek(q);
    if (v.fatal) return stranka(res, 400, `<p>${esc(v.fatal)}</p>`);
    if (q.volba === "odmitnout") return presmeruj(res, v.redirect, { error: "access_denied", error_description: "Vlastník přihlášení odmítl.", state: q.state });
    if (kodBlokovan(ip)) return formular(res, q, v.k, v.redirect, "Příliš mnoho chybných pokusů z této adresy. Zkus to za 10 minut.");
    const t = String(q.tajemstvi || "").trim();
    if (t && !silne(t)) { spatnyKod(ip); return formular(res, q, v.k, v.redirect, "Krátký obnovovací kód (slovo-slovo-číslo) tu nestačí — vlož vlastnický token agenta."); }
    const a = silne(t) ? Object.values(db.agents).find(x => (x.ownerToken && stejne(x.ownerToken, t)) ||
      (x.recoveryCode && String(x.recoveryCode).toLowerCase() === t.toLowerCase())) : null;
    if (!a) { spatnyKod(ip); return formular(res, q, v.k, v.redirect, "Token ani obnovovací kód nepatří žádnému agentovi."); }
    if (a.status !== "verified") return formular(res, q, v.k, v.redirect, `Agent „${a.card.name}“ ještě není ověřený — přihlásit se může až po ověření.`);
    const kod = nahodny(32);
    o.kody[hash(kod)] = { klient: q.client_id, redirect: v.redirect, vyzva: q.code_challenge, agent: a.id, exp: ted() + KOD_S, scope: "agent" };
    uklid(); save();
    logEvent(`OAUTH: „${v.k.jmeno}“ přihlášen jako agent „${a.card.name}“ (vlastník potvrdil v prohlížeči)`);
    return presmeruj(res, v.redirect, { code: kod, state: q.state });
  }

  /* ---------- POST /oauth/token ---------- */
  function overKlienta(req, b) {
    let id = b.client_id, secret = b.client_secret;
    const basic = String(req.headers.authorization || "").match(/^Basic\s+(.+)$/i);
    if (basic) {
      try { const [i, s] = Buffer.from(basic[1], "base64").toString("utf8").split(":"); id = decodeURIComponent(i); secret = decodeURIComponent(s || ""); } catch {}
    }
    const k = ma(o.klienti, id) ? o.klienti[id] : null;
    if (!k) return null;
    if (k.metoda !== "none" && !(secret && k.secretHash && stejne(hash(secret), k.secretHash))) return null;
    return { id, k };
  }

  function vydej(res, a, klientId, rodina) {
    const access = "ain_" + nahodny(32), refresh = "ainr_" + nahodny(32);
    const t = ted(), r = rodina || nahodny(9);
    o.tokeny[hash(access)] = { typ: "access", agent: a.id, klient: klientId, exp: t + PRISTUP_S, otisk: otisk(a), rodina: r, t: new Date().toISOString() };
    o.tokeny[hash(refresh)] = { typ: "refresh", agent: a.id, klient: klientId, exp: t + OBNOVA_S, otisk: otisk(a), rodina: r, t: new Date().toISOString() };
    uklid(); save();
    return json(res, 200, { access_token: access, token_type: "Bearer", expires_in: PRISTUP_S, refresh_token: refresh, scope: "agent" },
      { "Cache-Control": "no-store", Pragma: "no-cache" });
  }

  async function token(req, res, ip) {
    if (rateLimited(ip, "oauth-token", 60, 60_000)) return oauthChyba(res, 429, "slow_down", "Příliš mnoho požadavků.");
    const b = await telo(req);
    const kl = overKlienta(req, b);
    if (!kl) return oauthChyba(res, 401, "invalid_client", "Neznámý klient nebo špatné client_secret.");
    if (b.resource && !platnyZdroj(b.resource)) return oauthChyba(res, 400, "invalid_target", "resource neukazuje na tento server (/mcp/agent).");
    if (b.grant_type === "authorization_code") {
      const klic = hash(b.code || "");
      const z = o.kody[klic];
      delete o.kody[klic];                                   /* kód platí jednou, i když se výměna nepovede */
      if (!z || z.exp < ted() || z.klient !== kl.id) { save(); return oauthChyba(res, 400, "invalid_grant", "Kód je neplatný, použitý nebo propadlý."); }
      if (b.redirect_uri && b.redirect_uri !== z.redirect) { save(); return oauthChyba(res, 400, "invalid_grant", "redirect_uri nesouhlasí s autorizací."); }
      const overovac = String(b.code_verifier || "");
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(overovac) || crypto.createHash("sha256").update(overovac).digest("base64url") !== z.vyzva) {
        save(); return oauthChyba(res, 400, "invalid_grant", "PKCE: code_verifier nesedí.");
      }
      const a = db.agents[z.agent];
      if (!a || a.status !== "verified") { save(); return oauthChyba(res, 400, "invalid_grant", "Agent už neexistuje nebo není ověřený."); }
      return vydej(res, a, kl.id, null);
    }
    if (b.grant_type === "refresh_token") {
      const klic = hash(b.refresh_token || "");
      const z = o.tokeny[klic];
      if (z && z.typ === "pouzity") {                         /* už vyměněný refresh token se vrátil = únik → celá rodina končí */
        const n = zrusRodinu(z.rodina); save();
        logEvent(`OAUTH: opakované použití vyměněného refresh tokenu — přihlášení konektoru zrušeno (${n} tokenů)`);
        return oauthChyba(res, 400, "invalid_grant", "Refresh token už byl použit — přihlášení zrušeno, přihlas konektor znovu.");
      }
      if (!z || z.typ !== "refresh" || z.exp < ted() || z.klient !== kl.id) return oauthChyba(res, 400, "invalid_grant", "Refresh token je neplatný nebo propadlý — přihlas konektor znovu.");
      const a = db.agents[z.agent];
      if (!a || a.status !== "verified" || otisk(a) !== z.otisk) {
        delete o.tokeny[klic]; save();
        return oauthChyba(res, 400, "invalid_grant", "Token agenta se mezitím změnil — přihlas konektor znovu.");
      }
      o.tokeny[klic] = { typ: "pouzity", agent: z.agent, klient: z.klient, exp: z.exp, rodina: z.rodina, t: z.t };   /* rotace: starý končí, ale pamatujeme si ho */
      return vydej(res, a, kl.id, z.rodina);
    }
    return oauthChyba(res, 400, "unsupported_grant_type", "Podporuje se authorization_code a refresh_token.");
  }

  function zrusRodinu(rodina) {
    let n = 0;
    for (const [k, v] of Object.entries(o.tokeny)) if (v.rodina === rodina) { delete o.tokeny[k]; n++; }
    return n;
  }

  /* ---------- POST /oauth/revoke (RFC 7009) — odpověď je vždy 200 ---------- */
  async function zruseni(req, res) {
    const b = await telo(req);
    const z = o.tokeny[hash(b.token || "")];
    const kl = overKlienta(req, b);
    if (z && kl && kl.id === z.klient) { zrusRodinu(z.rodina); save(); logEvent("OAUTH: klient sám zrušil své přihlášení"); }
    return json(res, 200, {}, { "Cache-Control": "no-store" });
  }

  /* ---------- přehled a odpojení pro vlastníka (X-Owner-Token) ---------- */
  const vlastnik = (req) => {
    const tok = req.headers["x-owner-token"];
    return tok ? Object.values(db.agents).find(x => x.ownerToken && stejne(x.ownerToken, tok)) : null;
  };
  function konektory(agentId) {
    const t = ted(), rodiny = new Map();
    for (const v of Object.values(o.tokeny)) {
      if (v.agent !== agentId || v.exp < t) continue;
      const r = rodiny.get(v.rodina) || { rodina: v.rodina, klient: (o.klienti[v.klient] || {}).jmeno || "?", od: v.t, plati_do: null };
      if (v.typ === "refresh") r.plati_do = new Date(v.exp * 1000).toISOString();
      if (v.t < r.od) r.od = v.t;
      rodiny.set(v.rodina, r);
    }
    return [...rodiny.values()];
  }

  /* ---------- směrovač: vrací true, když požadavek obsloužil ---------- */
  async function obsluz(req, res, p, url, baseUrl, ip) {
    baseUrl = String(baseUrl).replace(/\/+$/, "");
    zakladAdresy = baseUrl;
    const m = req.method;
    if (m === "GET" && (p === "/.well-known/oauth-protected-resource" || p === "/.well-known/oauth-protected-resource" + CESTA)) { json(res, 200, chraneny(baseUrl)); return true; }
    if (m === "GET" && (p === "/.well-known/oauth-authorization-server" || p === "/.well-known/oauth-authorization-server" + CESTA)) { json(res, 200, autorizacni(baseUrl)); return true; }
    if (p === "/oauth/register" && m === "POST") { await registrace(req, res, ip); return true; }
    if (p === "/oauth/authorize" && m === "GET") { await autorizaceGet(res, url); return true; }
    if (p === "/oauth/authorize" && m === "POST") { await autorizacePost(req, res, ip); return true; }
    if (p === "/oauth/token" && m === "POST") { await token(req, res, ip); return true; }
    if (p === "/oauth/revoke" && m === "POST") { await zruseni(req, res); return true; }
    if (p === "/api/oauth/konektory" && m === "GET") {
      const a = vlastnik(req);
      if (!a) { json(res, 403, { error: "Potřebuješ X-Owner-Token agenta." }); return true; }
      json(res, 200, { agent: a.card.name, konektory: konektory(a.id) }); return true;
    }
    if (p === "/api/oauth/odpojit" && m === "POST") {
      const a = vlastnik(req);
      if (!a) { json(res, 403, { error: "Potřebuješ X-Owner-Token agenta." }); return true; }
      const b = await telo(req);
      let n = 0;
      for (const r of konektory(a.id)) if (b.vse === true || b.vse === "1" || r.rodina === b.rodina) n += zrusRodinu(r.rodina);
      save(); logEvent(`OAUTH: vlastník agenta „${a.card.name}“ odpojil konektory (${n} tokenů)`);
      json(res, 200, { ok: true, zruseno_tokenu: n, konektory: konektory(a.id) }); return true;
    }
    return false;
  }

  return { CESTA, obsluz, agentZTokenu, wwwAuthenticate, chraneny, autorizacni };
};
