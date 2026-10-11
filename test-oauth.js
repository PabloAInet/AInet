#!/usr/bin/env node
/**
 * AInet — konektor přihlášený jako agent: OAuth 2.1 + PKCE na /mcp/agent (11. 10. 2026).
 * Celý tok, jak ho projde claude.ai: 401 → metadata → registrace klienta → stránka pro vlastníka
 * → kód → token (PKCE) → MCP jako agent (bez tokenu v argumentech) → obnova → odpojení.
 * Plus connect_agent přes MCP (dřív v tools/list, ale bez obsluhy).
 */
const { spawn } = require("child_process");
const fs = require("fs"); const os = require("os"); const path = require("path"); const net = require("net"); const crypto = require("crypto");

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ainet-oauth-"));
let server = null, BASE = "", kroku = 0, chyb = 0;
function ok(c, popis, detail) { kroku++; if (c) console.log(`  ✓ ${popis}`); else { chyb++; console.log(`  ✗ ${popis}${detail !== undefined ? "\n      " + JSON.stringify(detail).slice(0, 600) : ""}`); } }
const volnyPort = () => new Promise(r => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
async function get(c, h = {}) { const r = await fetch(BASE + c, { headers: { Accept: "application/json", ...h } }); return { status: r.status, headers: r.headers, data: await r.json().catch(() => ({})) }; }
async function post(c, b, h = {}) { const r = await fetch(BASE + c, { method: "POST", headers: { "Content-Type": "application/json", ...h }, body: JSON.stringify(b) }); return { status: r.status, headers: r.headers, data: await r.json().catch(() => ({})) }; }
async function form(c, b, h = {}) { const r = await fetch(BASE + c, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded", ...h }, body: new URLSearchParams(b).toString() }); return { status: r.status, headers: r.headers, text: await r.text() }; }
async function rpc(cesta, method, params, bearer) {
  const h = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  if (bearer) h.Authorization = `Bearer ${bearer}`;
  const r = await fetch(BASE + cesta, { method: "POST", headers: h, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return { status: r.status, headers: r.headers, data: await r.json().catch(() => ({})) };
}
async function nastroj(cesta, name, args, bearer) {
  const r = await rpc(cesta, "tools/call", { name, arguments: args }, bearer);
  const t = r.data.result && r.data.result.content && r.data.result.content[0];
  return t ? JSON.parse(t.text) : r.data;
}
async function startServer() {
  const port = await volnyPort(); BASE = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port), DATA_DIR: DIR, PUBLIC_URL: BASE, INDEXNOW: "0", KEEPALIVE_URL: "0", SEED_DOMACI: "1", PREHLED: "0", RADAR: "0" };
  delete env.ANTHROPIC_API_KEY; delete env.OPENAI_API_KEY; delete env.RADAR_NAME;
  server = spawn(process.execPath, [path.join(__dirname, "server.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
  server.stderr.on("data", d => process.stderr.write("[server] " + d));
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + "/healthz")).ok) return; } catch {} await new Promise(r => setTimeout(r, 100)); }
  throw new Error("server nenaběhl");
}
function stopServer() { return new Promise(r => { if (!server) return r(); server.on("exit", () => { server = null; r(); }); server.kill(); }); }
async function zalozLite(name) {
  const r = await get(`/api/lite/register?name=${encodeURIComponent(name)}&owner=Test&skills=chat`);
  const u = r.data.ukol; const a1 = u["1_soucet"].match(/\d+/g).map(Number).reduce((x, y) => x + y, 0);
  const a2 = u["2_otoc"].replace("Napiš pozpátku: ", "").split("").reverse().join(""); const a3 = u["3_opis"].replace("Opiš přesně: ", "");
  const v = await get(`/api/lite/verify?token=${r.data.token}&a1=${a1}&a2=${encodeURIComponent(a2)}&a3=${encodeURIComponent(a3)}`);
  if (v.data.stav !== "verified") throw new Error(`lite ověření ${name}: ${JSON.stringify(v.data)}`);
  return { id: r.data.id, tok: r.data.token, name };
}
const pkce = () => { const v = crypto.randomBytes(32).toString("base64url"); return { v, c: crypto.createHash("sha256").update(v).digest("base64url") }; };
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

(async () => {
  console.log("╔═══════════════════════════════════════════════════════════╗");
  console.log("║  AInet — konektor jako agent (OAuth 2.1 + PKCE)           ║");
  console.log("╚═══════════════════════════════════════════════════════════╝");
  await startServer();
  const ja = await zalozLite("Zakaznik");
  const db0 = JSON.parse(fs.readFileSync(path.join(DIR, "agents.json"), "utf8"));
  const tr = Object.values(db0.agents).find(a => a.card.name === "TradeRadar");
  const kodJa = db0.agents[ja.id].recoveryCode;      /* lidský kód slovo-slovo-číslo — slabý */

  /* 1) objevení */
  const n401 = await rpc("/mcp/agent", "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  const wa = n401.headers.get("www-authenticate") || "";
  ok(n401.status === 401 && wa.includes(`resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp/agent"`), "POST /mcp/agent bez tokenu → 401 s WWW-Authenticate a resource_metadata", wa);
  ok((n401.headers.get("access-control-expose-headers") || "").includes("WWW-Authenticate"), "CORS vystavuje WWW-Authenticate (webový klient ho přečte)");
  ok((await rpc("/mcp", "initialize", {})).status === 200, "anonymní /mcp funguje beze změny");
  const prm = await get("/.well-known/oauth-protected-resource/mcp/agent");
  ok(prm.status === 200 && prm.data.resource === `${BASE}/mcp/agent` && prm.data.authorization_servers[0] === BASE, "metadata chráněného zdroje (RFC 9728)", prm.data);
  const asm = await get("/.well-known/oauth-authorization-server");
  ok(asm.data.issuer === BASE && asm.data.registration_endpoint === `${BASE}/oauth/register` && asm.data.code_challenge_methods_supported.includes("S256"), "metadata autorizačního serveru (RFC 8414) s registrací a S256", asm.data);

  /* 2) dynamická registrace klienta */
  const spatna = await post("/oauth/register", { client_name: "Zlý", redirect_uris: ["http://evil.example/cb"] });
  ok(spatna.status === 400 && spatna.data.error === "invalid_redirect_uri", "registrace s http adresou mimo localhost odmítnuta");
  const reg = await post("/oauth/register", { client_name: "Claude", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"] });
  const cid = reg.data.client_id;
  ok(reg.status === 201 && /^ainet-/.test(cid) && !reg.data.client_secret, "veřejný klient zaregistrován (RFC 7591)", reg.data);
  const xss = await post("/oauth/register", { client_name: "<img src=x onerror=alert(1)>Zly", redirect_uris: [REDIRECT] });
  ok(xss.status === 201 && !/[<>=]/.test(xss.data.client_name), "jméno klienta jen z prostých znaků (jde do logu a na stránku)", xss.data.client_name);
  const logy = (await get("/api/log")).data;
  ok(!JSON.stringify(logy).includes("<img"), "do logu se HTML ze jména klienta nedostane");

  /* 3) stránka pro vlastníka */
  const p1 = pkce(), st = "stav-" + Date.now();
  const q = (extra = {}) => new URLSearchParams({ response_type: "code", client_id: cid, redirect_uri: REDIRECT, code_challenge: p1.c, code_challenge_method: "S256", state: st, scope: "agent", resource: `${BASE}/mcp/agent`, ...extra }).toString();
  const str = await fetch(`${BASE}/oauth/authorize?${q()}`, { redirect: "manual" });
  const html = await str.text();
  ok(str.status === 200 && html.includes("Claude") && html.includes('name="tajemstvi"') && html.includes('type="password"'), "GET /oauth/authorize → formulář pro vlastníka (token/kód jako heslo)");
  ok((str.headers.get("x-frame-options") || "") === "DENY", "stránka se nedá vložit do rámu (clickjacking)");
  const ciziNavrat = await fetch(`${BASE}/oauth/authorize?${q({ redirect_uri: "https://evil.example/cb" })}`, { redirect: "manual" });
  ok(ciziNavrat.status === 400 && !ciziNavrat.headers.get("location"), "neregistrovaná adresa návratu → chyba bez přesměrování");
  const bezPkce = await fetch(`${BASE}/oauth/authorize?${q({ code_challenge: "" })}`, { redirect: "manual" });
  ok(bezPkce.status === 400 && !bezPkce.headers.get("location"), "bez PKCE → chybová stránka, žádné automatické přesměrování (žádný otevřený přesměrovač)");
  const proto = await fetch(`${BASE}/oauth/authorize?${q({ client_id: "__proto__" })}`, { redirect: "manual" });
  ok(proto.status === 400, "client_id=__proto__ → 400, ne pád serveru");
  const cizi = await fetch(`${BASE}/oauth/authorize?${q({ resource: "https://jiny.example/mcp" })}`, { redirect: "manual" });
  ok(cizi.status === 400, "resource na cizí server odmítnut");
  ok(!html.includes("Tuhle adresu návratu AInet nezná"), "claude.ai jako adresa návratu bez varování");
  const regCizi = await post("/oauth/register", { client_name: "Cizi", redirect_uris: ["https://neznamy.example/cb"] });
  const htmlCizi = await (await fetch(`${BASE}/oauth/authorize?${q({ client_id: regCizi.data.client_id, redirect_uri: "https://neznamy.example/cb" })}`)).text();
  ok(htmlCizi.includes("Tuhle adresu návratu AInet nezná"), "neznámá adresa návratu → varování na formuláři");

  const zaklad = { response_type: "code", client_id: cid, redirect_uri: REDIRECT, code_challenge: p1.c, code_challenge_method: "S256", state: st, scope: "agent" };
  const spatnyTok = await form("/oauth/authorize", { ...zaklad, tajemstvi: "nic-takoveho", volba: "povolit" });
  ok(spatnyTok.status === 400 && spatnyTok.text.includes("nepatří") && !spatnyTok.headers.get("location"), "špatný token → zpět na formulář, žádný kód");
  const odm = await form("/oauth/authorize", { ...zaklad, volba: "odmitnout" });
  ok(odm.status === 302 && new URL(odm.headers.get("location")).searchParams.get("error") === "access_denied", "Odmítnout → error=access_denied");
  const povol = await form("/oauth/authorize", { ...zaklad, tajemstvi: ja.tok, volba: "povolit" });
  const loc = new URL(povol.headers.get("location") || "http://x/");
  const kod1 = loc.searchParams.get("code");
  ok(povol.status === 302 && loc.origin + loc.pathname === REDIRECT && kod1 && loc.searchParams.get("state") === st, "vlastník vložil token → 302 na claude.ai s kódem a state", povol.headers.get("location"));

  /* 4) výměna kódu (PKCE, jednorázově) */
  const tokenPost = (b) => form("/oauth/token", b).then(r => ({ status: r.status, data: JSON.parse(r.text || "{}"), headers: r.headers }));
  const spatnyVer = await tokenPost({ grant_type: "authorization_code", code: kod1, redirect_uri: REDIRECT, client_id: cid, code_verifier: pkce().v });
  ok(spatnyVer.status === 400 && spatnyVer.data.error === "invalid_grant", "špatný code_verifier → invalid_grant");
  const znovu = await tokenPost({ grant_type: "authorization_code", code: kod1, redirect_uri: REDIRECT, client_id: cid, code_verifier: p1.v });
  ok(znovu.status === 400, "kód platí jen jednou (po neúspěšné výměně je pryč)");
  const slaby = await form("/oauth/authorize", { ...zaklad, tajemstvi: kodJa, volba: "povolit" });
  ok(slaby.status === 400 && slaby.text.includes("Krátký obnovovací kód") && !slaby.headers.get("location"), "krátký lidský obnovovací kód (dá se uhodnout) neprojde");
  const pd = pkce();
  const dlouhy = await form("/oauth/authorize", { ...zaklad, code_challenge: pd.c, tajemstvi: tr.recoveryCode, volba: "povolit" });
  ok(dlouhy.status === 302 && new URL(dlouhy.headers.get("location")).searchParams.get("code"), "dlouhý kód domácího agenta (d-…) projde");
  const p2 = pkce();
  const povol2 = await form("/oauth/authorize", { ...zaklad, code_challenge: p2.c, tajemstvi: ja.tok, volba: "povolit" });
  const kod2 = new URL(povol2.headers.get("location")).searchParams.get("code");
  const ciziZdroj = await tokenPost({ grant_type: "authorization_code", code: "x", redirect_uri: REDIRECT, client_id: cid, code_verifier: p2.v, resource: "https://jiny.example/mcp" });
  ok(ciziZdroj.status === 400 && ciziZdroj.data.error === "invalid_target", "token s resource na cizí server → invalid_target");
  const tk = await tokenPost({ grant_type: "authorization_code", code: kod2, redirect_uri: REDIRECT, client_id: cid, code_verifier: p2.v, resource: `${BASE}/mcp/agent` });
  const AT = tk.data.access_token, RT = tk.data.refresh_token;
  ok(tk.status === 200 && tk.data.token_type === "Bearer" && /^ain_/.test(AT) && /^ainr_/.test(RT) && tk.data.expires_in > 3600, "kód + PKCE → access a refresh token", tk.data);
  ok(AT !== ja.tok && (tk.headers.get("cache-control") || "").includes("no-store"), "přístupový token není ownerToken a necachuje se");

  /* 5) MCP jako agent */
  const init = await rpc("/mcp/agent", "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } }, AT);
  ok(init.status === 200 && init.data.result.instructions.includes("„Zakaznik“"), "initialize s Bearer → ví, za koho mluví");
  const tl = await rpc("/mcp/agent", "tools/list", {}, AT);
  const rm = tl.data.result.tools.find(t => t.name === "read_messages");
  ok(rm && !rm.inputSchema.properties.token && !(rm.inputSchema.required || []).includes("token"), "tools/list přihlášeného: nástroje bez parametru token");
  const tlAnon = await rpc("/mcp", "tools/list", {});
  ok(tlAnon.data.result.tools.find(t => t.name === "read_messages").inputSchema.properties.token, "anonymní /mcp: token v nástrojích zůstává");
  const posta = await nastroj("/mcp/agent", "read_messages", {}, AT);
  ok(posta.agent === "Zakaznik" && !posta.error, "read_messages bez tokenu v argumentu → pošta agenta", posta.error);
  const prop = await nastroj("/mcp/agent", "connect_agent", { to_id: "TradeRadar", note: "test" }, AT);
  ok(prop.status === "accepted" && prop.automaticky === true, "connect_agent jménem → propojeno s TradeRadarem (AUTO)", prop);
  const spoj = await get("/api/connections");
  ok(spoj.data.some(c => c.pair === [ja.id, tr.id].sort().join("|") && c.status === "accepted"), "propojení je v /api/connections");
  const znovuProp = await nastroj("/mcp/agent", "connect_agent", { to_id: tr.id }, AT);
  ok(znovuProp.existuje && /Už jste propojeni/.test(znovuProp.zprava), "druhá žádost → „Už jste propojeni“");
  const ciziOd = await nastroj("/mcp/agent", "connect_agent", { from_id: tr.id, to_id: ja.id }, AT);
  ok(!!ciziOd.error, "connect_agent za cizího agenta (from_id) odmítnut");
  const anonProp = await nastroj("/mcp", "connect_agent", { to_id: "TradeRadar" });
  ok(!!anonProp.error, "anonymní connect_agent bez tokenu odmítnut");
  const pres = await nastroj("/mcp", "read_messages", {}, AT);
  ok(pres.agent === "Zakaznik", "OAuth Bearer funguje i na obyčejném /mcp");
  const spatnyBearer = await rpc("/mcp/agent", "tools/list", {}, "ain_neexistuje");
  ok(spatnyBearer.status === 401 && (spatnyBearer.headers.get("www-authenticate") || "").includes('error="invalid_token"'), "neplatný Bearer → 401 invalid_token");
  const get401 = await fetch(`${BASE}/mcp/agent`);
  ok(get401.status === 401, "GET /mcp/agent bez tokenu → 401 taky");

  /* 6) obnova tokenu (rotace) a trvanlivost */
  const ob = await tokenPost({ grant_type: "refresh_token", refresh_token: RT, client_id: cid });
  ok(ob.status === 200 && ob.data.access_token && ob.data.refresh_token !== RT, "refresh_token → nový pár", ob.data);
  const AT2 = ob.data.access_token, RT2 = ob.data.refresh_token;
  const surova = fs.readFileSync(path.join(DIR, "agents.json"), "utf8");
  ok(!surova.includes(AT2) && !surova.includes(RT2) && !surova.includes(kod2), "v databázi jsou jen otisky tokenů, ne tokeny");
  await stopServer(); await startServer();
  ok((await nastroj("/mcp/agent", "read_messages", {}, AT2)).agent === "Zakaznik", "přihlášení přežije restart serveru");

  /* 7) důvěrný klient */
  const regD = await post("/oauth/register", { client_name: "Důvěrný", redirect_uris: [REDIRECT], token_endpoint_auth_method: "client_secret_post" });
  ok(regD.status === 201 && regD.data.client_secret, "klient s client_secret_post dostane tajemství");
  const bezTaj = await tokenPost({ grant_type: "refresh_token", refresh_token: RT2, client_id: regD.data.client_id });
  ok(bezTaj.status === 401 && bezTaj.data.error === "invalid_client", "důvěrný klient bez tajemství → invalid_client");

  /* 8) vlastník vidí a odpojuje */
  const kon = await get("/api/oauth/konektory", { "X-Owner-Token": ja.tok });
  ok(kon.status === 200 && kon.data.konektory.length === 1 && kon.data.konektory[0].klient === "Claude", "vlastník vidí přihlášený konektor", kon.data);
  ok((await get("/api/oauth/konektory")).status === 403, "přehled konektorů jen s X-Owner-Token");
  const odp = await post("/api/oauth/odpojit", { vse: true }, { "X-Owner-Token": ja.tok });
  ok(odp.data.ok && odp.data.zruseno_tokenu >= 2 && odp.data.konektory.length === 0, "odpojit vše → tokeny zrušené", odp.data);
  ok((await rpc("/mcp/agent", "tools/list", {}, AT2)).status === 401, "po odpojení konektor dostane 401 (claude.ai vyzve k novému přihlášení)");

  /* 9) opakovaný refresh, revoke, ochrana proti hádání (až na konec — blokuje adresu na 10 min) */
  const prihlas = async () => { const pp = pkce();
    const k = new URL((await form("/oauth/authorize", { ...zaklad, code_challenge: pp.c, tajemstvi: ja.tok, volba: "povolit" })).headers.get("location")).searchParams.get("code");
    return (await tokenPost({ grant_type: "authorization_code", code: k, redirect_uri: REDIRECT, client_id: cid, code_verifier: pp.v })).data; };
  const t4 = await prihlas();
  const t4b = (await tokenPost({ grant_type: "refresh_token", refresh_token: t4.refresh_token, client_id: cid })).data;
  const znovuRT = await tokenPost({ grant_type: "refresh_token", refresh_token: t4.refresh_token, client_id: cid });
  ok(znovuRT.status === 400 && znovuRT.data.error === "invalid_grant", "vyměněný refresh token podruhé neplatí");
  ok((await rpc("/mcp/agent", "tools/list", {}, t4b.access_token)).status === 401, "…a jeho opakované použití zruší celé přihlášení (ochrana při úniku)");
  const tk3 = await prihlas();
  await form("/oauth/revoke", { token: tk3.refresh_token, client_id: regCizi.data.client_id });
  ok((await rpc("/mcp/agent", "tools/list", {}, tk3.access_token)).status === 200, "revoke od cizího klienta nic nezruší");
  await form("/oauth/revoke", { token: tk3.refresh_token, client_id: cid });
  ok((await rpc("/mcp/agent", "tools/list", {}, tk3.access_token)).status === 401, "revoke refresh tokenu vlastním klientem zruší i jeho access token");
  let posledni = null;
  for (let i = 0; i < 11; i++) posledni = await form("/oauth/authorize", { ...zaklad, tajemstvi: `zkousim-${i}`, volba: "povolit" });
  ok(posledni.text.includes("Příliš mnoho chybných pokusů"), "10 chybných pokusů → adresa zablokovaná");
  const iSpravny = await form("/oauth/authorize", { ...zaklad, tajemstvi: ja.tok, volba: "povolit" });
  ok(!iSpravny.headers.get("location"), "během blokace neprojde ani správný token");

  await stopServer();
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {}
  console.log(chyb ? `❌ ${chyb} z ${kroku} kroků selhalo` : `✅ ${kroku}/${kroku} kroků prošlo`);
  process.exit(chyb ? 1 : 0);
})().catch(async e => { console.error(e); await stopServer(); process.exit(1); });
