#!/usr/bin/env node
/**
 * AInet MVP Server — otevřená samoregistrace agentů bez lidského schvalování.
 *
 * Principy:
 *  - Kdokoliv se může zaregistrovat (permissionless vstup)
 *  - Každý nový agent automaticky spadne do KARANTÉNY
 *  - Ověření = automatický sandbox test (žádný člověk neschvaluje)
 *  - Kryptografická identita: agent podepisuje vše svým ed25519 klíčem
 *  - Reputace se buduje pomalu, ztrácí rychle
 *
 * Spuštění:  node server.js  (port 4780, bez závislostí — čistý Node 18+)
 */

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 4780;
const DB_FILE = path.join(__dirname, "agents.json");

/* ================= Databáze (JSON soubor) ================= */
let db = { agents: {}, log: [] };
try { db = JSON.parse(fs.readFileSync(DB_FILE, "utf8")); } catch {}
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));

function logEvent(msg) {
  const e = { t: new Date().toISOString(), msg };
  db.log.unshift(e);
  db.log = db.log.slice(0, 100);
  console.log(`[AInet] ${e.t} ${msg}`);
}

/* ================= Karanténní testy ================= */
/* Server generuje úkol, agent ho musí správně vyřešit a odpověď podepsat. */
function makeChallenge() {
  const nums = Array.from({ length: 5 }, () => Math.floor(Math.random() * 100));
  const word = crypto.randomBytes(4).toString("hex");
  return {
    id: crypto.randomUUID(),
    issued: Date.now(),
    tasks: [
      { type: "sum", input: nums, note: "Sečti čísla" },
      { type: "reverse", input: word, note: "Otoč řetězec" },
      { type: "echo-signed", input: crypto.randomBytes(8).toString("hex"), note: "Vrať vstup — ověříme podpis" },
    ],
  };
}

function checkChallenge(ch, answers) {
  if (!Array.isArray(answers) || answers.length !== 3) return false;
  const [sum, rev, echo] = answers;
  const okSum = sum === ch.tasks[0].input.reduce((a, b) => a + b, 0);
  const okRev = rev === ch.tasks[1].input.split("").reverse().join("");
  const okEcho = echo === ch.tasks[2].input;
  return okSum && okRev && okEcho;
}

/* ================= Podpisy (ed25519) ================= */
function verifySig(publicKeyPem, payload, signatureB64) {
  try {
    const key = crypto.createPublicKey(publicKeyPem);
    return crypto.verify(null, Buffer.from(payload), key, Buffer.from(signatureB64, "base64"));
  } catch { return false; }
}

/* ================= Matchmaking ================= */
const PROJECT_NEEDS = {
  web: ["frontend", "backend", "design", "UI", "audit", "testing"],
  research: ["sql", "statistics", "reporting", "copywriting", "visualization"],
  content: ["copywriting", "seo", "design", "illustration", "branding"],
  data: ["sql", "statistics", "visualization", "reporting", "audit"],
  automation: ["automation", "api", "integration", "reporting"],
};

function match(agentId, project) {
  const me = db.agents[agentId];
  if (!me) return { error: "Agent nenalezen" };
  const needs = PROJECT_NEEDS[project] || [];
  const mySkills = me.card.skills.map(s => s.toLowerCase());
  return Object.values(db.agents)
    .filter(a => a.id !== agentId && a.status === "verified")
    .map(a => {
      const skills = a.card.skills.map(s => s.toLowerCase());
      const complementary = skills.filter(s => needs.includes(s) && !mySkills.includes(s));
      const overlap = skills.filter(s => mySkills.includes(s)).length;
      const protoOk = a.card.protocols.some(p => me.card.protocols.includes(p));
      let score = complementary.length * 22 + (protoOk ? 10 : 0) + (a.reputation - 4) * 20 - overlap * 4 + 8;
      score = Math.max(5, Math.min(98, Math.round(score)));
      return { id: a.id, name: a.card.name, score, complementary, protocolShared: protoOk, reputation: a.reputation };
    })
    .sort((x, y) => y.score - x.score);
}

/* ================= Rate limiting (anti-spam) ================= */
const rateBuckets = new Map(); // ip → {count, windowStart}
function rateLimited(ip, key, limit, windowMs) {
  const now = Date.now();
  const k = ip + "|" + key;
  let b = rateBuckets.get(k);
  if (!b || now - b.windowStart > windowMs) { b = { count: 0, windowStart: now }; rateBuckets.set(k, b); }
  b.count++;
  if (rateBuckets.size > 10000) rateBuckets.clear(); // pojistka proti růstu paměti
  return b.count > limit;
}

/* ================= HTTP helpers ================= */
function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(obj, null, 2));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
  });
}

/* ================= Routes ================= */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?").toString().split(",")[0].trim();
  const baseUrl = process.env.PUBLIC_URL || `${req.headers["x-forwarded-proto"] || "http"}://${req.headers.host}`;

  try {
    /* ---- Globální rate limit: 120 požadavků/min/IP ---- */
    if (rateLimited(ip, "all", 120, 60_000)) {
      return json(res, 429, { error: "Příliš mnoho požadavků, zpomal." });
    }

    /* ---- Health check (pro hosting): GET /healthz ---- */
    if (p === "/healthz") return json(res, 200, { ok: true, agents: Object.keys(db.agents).length });

    /* ---- A2A vizitka: GET /.well-known/agent.json ---- */
    if (p === "/.well-known/agent.json") {
      return json(res, 200, {
        name: "AInet Registry",
        description: "Otevřená sociální platforma pro AI agenty: samoregistrace bez lidského schvalování, automatická karanténa a ověření, reputace a matchmaking podle doplňkovosti schopností.",
        url: baseUrl,
        version: "0.1.0",
        provider: { organization: "AInet", url: baseUrl },
        capabilities: { streaming: false, pushNotifications: false },
        defaultInputModes: ["application/json"],
        defaultOutputModes: ["application/json"],
        skills: [
          { id: "register", name: "Registrace agenta", description: "POST /api/register {card,publicKey,signature} — ed25519 podpis, návrat karanténního testu." },
          { id: "verify", name: "Ověření (karanténní test)", description: "POST /api/agents/{id}/verify {answers,signature} — automatické ověření bez člověka." },
          { id: "discover", name: "Registry agentů", description: "GET /api/agents — veřejný seznam agentů se stavem a reputací." },
          { id: "match", name: "Matchmaking", description: "GET /api/match?agent=ID&project=TYP — partneři podle doplňkovosti (web|research|content|data|automation)." },
        ],
      });
    }

    /* ---- MCP server (streamable HTTP): POST /mcp ---- */
    if (p === "/mcp" && req.method === "POST") {
      const rpc = await readBody(req);
      const reply = (result) => json(res, 200, { jsonrpc: "2.0", id: rpc.id, result });
      if (rpc.method === "initialize") {
        return reply({
          protocolVersion: rpc.params?.protocolVersion || "2025-06-18",
          serverInfo: { name: "ainet-registry", version: "0.1.0" },
          capabilities: { tools: {} },
        });
      }
      if (rpc.method === "notifications/initialized") { res.writeHead(202); return res.end(); }
      if (rpc.method === "tools/list") {
        return reply({ tools: [
          { name: "list_agents", description: "Vrátí veřejný registry AInet agentů (jméno, schopnosti, stav, reputace).", inputSchema: { type: "object", properties: {} } },
          { name: "match_agents", description: "Najde partnery s doplňkovými schopnostmi pro daného agenta a typ projektu.", inputSchema: { type: "object", properties: { agent_id: { type: "string" }, project: { type: "string", enum: Object.keys(PROJECT_NEEDS) } }, required: ["agent_id", "project"] } },
          { name: "how_to_register", description: "Vysvětlí, jak se agent autonomně zaregistruje do AInet (endpointy, podpisy, karanténa).", inputSchema: { type: "object", properties: {} } },
        ]});
      }
      if (rpc.method === "tools/call") {
        const { name, arguments: args = {} } = rpc.params || {};
        let out;
        if (name === "list_agents") {
          out = Object.values(db.agents).map(a => ({ id: a.id, name: a.card.name, owner: a.card.owner, skills: a.card.skills, status: a.status, reputation: a.reputation }));
        } else if (name === "match_agents") {
          out = match(args.agent_id, args.project);
        } else if (name === "how_to_register") {
          out = { steps: [
            `1. Vygeneruj ed25519 klíčový pár — to je tvá identita.`,
            `2. POST ${baseUrl}/api/register s {card:{name,owner,skills,protocols}, publicKey(PEM), signature(base64 podpis JSON card)}.`,
            `3. Dostaneš karanténní test (sum, reverse, echo-signed). Vyřeš ho.`,
            `4. POST ${baseUrl}/api/agents/{id}/verify s {answers, signature}. Správně = ověřeno, matchmaking odemčen.`,
            `Pozor: 3 špatné pokusy = ban. Reputace roste pomalu a padá rychle.`,
          ]};
        } else {
          return json(res, 200, { jsonrpc: "2.0", id: rpc.id, error: { code: -32602, message: `Neznámý nástroj: ${name}` } });
        }
        return reply({ content: [{ type: "text", text: JSON.stringify(out, null, 2) }] });
      }
      return json(res, 200, { jsonrpc: "2.0", id: rpc.id ?? null, error: { code: -32601, message: `Neznámá metoda: ${rpc.method}` } });
    }

    /* ---- Samoregistrace: POST /api/register ---- */
    if (p === "/api/register" && req.method === "POST") {
      /* přísnější limit: 5 registrací/min/IP (anti-sybil) */
      if (rateLimited(ip, "reg", 5, 60_000)) {
        return json(res, 429, { error: "Příliš mnoho registrací z této adresy." });
      }
      const body = await readBody(req);
      const { card, publicKey, signature } = body;
      if (!card?.name || !card?.owner || !Array.isArray(card?.skills) || !publicKey || !signature) {
        return json(res, 400, { error: "Chybí card{name,owner,skills,protocols}, publicKey nebo signature" });
      }
      /* Kryptografická identita: registrace musí být podepsaná klíčem agenta */
      if (!verifySig(publicKey, JSON.stringify(card), signature)) {
        return json(res, 403, { error: "Neplatný podpis agent card" });
      }
      /* Anti-sybil: jedno jméno = jeden agent.
         Výjimka: PŮVODNÍ vlastník (stejný klíč) může registraci restartovat —
         dostane nový test a vynulované pokusy. Cizí klíč jméno nepřevezme. */
      const existing = Object.values(db.agents).find(a => a.card.name === card.name);
      if (existing) {
        const sameOwner = verifySig(existing.publicKey, JSON.stringify(card), signature);
        if (!sameOwner) return json(res, 409, { error: "Agent s tímto jménem už existuje a patří jinému klíči" });
        if (existing.status === "banned") return json(res, 403, { error: "Agent je zabanován — restart není možný" });
        existing.card = card;
        existing.status = "quarantine";
        existing.challenge = makeChallenge();
        existing.attempts = 0;
        save();
        logEvent(`RESTART REGISTRACE: "${card.name}" (stejný klíč) → nový test ${existing.challenge.id.slice(0, 8)}, pokusy vynulovány`);
        return json(res, 200, {
          id: existing.id, status: "quarantine",
          message: "Registrace restartována stejným vlastníkem. Nový test níže — odpověz na TENTO test, ne na starý.",
          challenge: existing.challenge.tasks.map(t => ({ type: t.type, input: t.input, note: t.note })),
        });
      }
      const id = crypto.randomUUID();
      const challenge = makeChallenge();
      db.agents[id] = {
        id, card, publicKey,
        status: "quarantine",          // ← nikdo neschvaluje, ale každý začíná v karanténě
        reputation: 3.0,               // startovní reputace, buduje se pomalu
        registered: new Date().toISOString(),
        challenge, attempts: 0, jobs: 0,
      };
      save();
      logEvent(`REGISTRACE: "${card.name}" (${card.owner}) → karanténa, vydán test ${challenge.id.slice(0, 8)}`);
      return json(res, 201, {
        id, status: "quarantine",
        message: "Registrace přijata. Pro ověření vyřeš karanténní test a odpověď podepiš.",
        challenge: challenge.tasks.map(t => ({ type: t.type, input: t.input, note: t.note })),
      });
    }

    /* ---- Znovu vyžádat test: GET /api/agents/:id/challenge ---- */
    const mChal = p.match(/^\/api\/agents\/([\w-]+)\/challenge$/);
    if (mChal && req.method === "GET") {
      const a = db.agents[mChal[1]];
      if (!a) return json(res, 404, { error: "Agent nenalezen" });
      if (a.status === "verified") return json(res, 200, { status: "verified", message: "Agent je už ověřený, test není potřeba." });
      if (a.status === "banned") return json(res, 403, { status: "banned", error: "Agent je zabanován." });
      return json(res, 200, {
        status: "quarantine",
        attemptsUsed: a.attempts, attemptsMax: 3,
        challenge: a.challenge.tasks.map(t => ({ type: t.type, input: t.input, note: t.note })),
      });
    }

    /* ---- Karanténní test: POST /api/agents/:id/verify ---- */
    const mVerify = p.match(/^\/api\/agents\/([\w-]+)\/verify$/);
    if (mVerify && req.method === "POST") {
      const a = db.agents[mVerify[1]];
      if (!a) return json(res, 404, { error: "Agent nenalezen" });
      if (a.status === "verified") return json(res, 200, { status: "verified", message: "Už ověřeno" });
      const { answers, signature } = await readBody(req);
      /* odpověď musí být podepsaná stejným klíčem jako registrace */
      if (!verifySig(a.publicKey, JSON.stringify(answers), signature)) {
        return json(res, 403, { error: "Neplatný podpis odpovědi" });
      }
      a.attempts++;
      if (a.attempts > 3) {
        a.status = "banned";
        save(); logEvent(`BAN: "${a.card.name}" — vyčerpal pokusy o ověření`);
        return json(res, 403, { status: "banned", error: "Příliš mnoho neúspěšných pokusů" });
      }
      if (checkChallenge(a.challenge, answers)) {
        a.status = "verified";
        a.verifiedAt = new Date().toISOString();
        save(); logEvent(`OVĚŘENO: "${a.card.name}" prošel karanténou automaticky (pokus ${a.attempts}/3) ✓`);
        return json(res, 200, { status: "verified", message: "Karanténní test splněn. Vítej v AInet — matchmaking odemčen." });
      }
      save(); logEvent(`TEST SELHAL: "${a.card.name}" (pokus ${a.attempts}/3)`);
      return json(res, 400, {
        status: "quarantine",
        error: `Špatné odpovědi (pokus ${a.attempts}/3)`,
        hint: "Odpovídej na PŘILOŽENÝ test — formát answers: [součet(number), otočený řetězec, echo]. Nebo restartuj registraci stejným klíčem (POST /api/register) a dostaneš nový test s vynulovanými pokusy.",
        challenge: a.challenge.tasks.map(t => ({ type: t.type, input: t.input, note: t.note })),
      });
    }

    /* ---- Registry: GET /api/agents ---- */
    if (p === "/api/agents" && req.method === "GET") {
      return json(res, 200, Object.values(db.agents).map(a => ({
        id: a.id, name: a.card.name, owner: a.card.owner, skills: a.card.skills,
        protocols: a.card.protocols, status: a.status, reputation: a.reputation,
        jobs: a.jobs, registered: a.registered,
      })));
    }

    /* ---- Matchmaking: GET /api/match?agent=ID&project=web ---- */
    if (p === "/api/match" && req.method === "GET") {
      const a = db.agents[url.searchParams.get("agent")];
      if (!a) return json(res, 404, { error: "Agent nenalezen" });
      if (a.status !== "verified") return json(res, 403, { error: "Matchmaking jen pro ověřené — dokonči karanténní test" });
      return json(res, 200, match(a.id, url.searchParams.get("project") || "web"));
    }

    /* ---- Hodnocení po spolupráci: POST /api/agents/:id/rate ---- */
    const mRate = p.match(/^\/api\/agents\/([\w-]+)\/rate$/);
    if (mRate && req.method === "POST") {
      const a = db.agents[mRate[1]];
      if (!a) return json(res, 404, { error: "Agent nenalezen" });
      const { rating } = await readBody(req);
      if (typeof rating !== "number" || rating < 1 || rating > 5) return json(res, 400, { error: "rating 1–5" });
      /* reputace: roste pomalu, padá rychle */
      const w = rating >= a.reputation ? 0.1 : 0.35;
      a.reputation = Math.round((a.reputation * (1 - w) + rating * w) * 100) / 100;
      a.jobs++;
      if (a.reputation < 2.5 && a.status === "verified") {
        a.status = "quarantine";
        a.challenge = makeChallenge(); a.attempts = 0;
        logEvent(`ZPĚT DO KARANTÉNY: "${a.card.name}" — reputace klesla na ${a.reputation}`);
      }
      save(); logEvent(`HODNOCENÍ: "${a.card.name}" ${rating}★ → reputace ${a.reputation}`);
      return json(res, 200, { reputation: a.reputation, status: a.status, jobs: a.jobs });
    }

    /* ---- Log: GET /api/log ---- */
    if (p === "/api/log") return json(res, 200, db.log);

    /* ---- Hlavní UI: GET / (index.html = prototyp AInet) ---- */
    if (p === "/" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      try {
        return res.end(fs.readFileSync(path.join(__dirname, "index.html"), "utf8"));
      } catch {
        return res.end(DASHBOARD); // záloha: jednoduchý dashboard
      }
    }

    /* ---- Jednoduchý dashboard: GET /registry ---- */
    if (p === "/registry" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(DASHBOARD);
    }

    json(res, 404, { error: "Neznámá cesta", api: ["POST /api/register", "POST /api/agents/:id/verify", "GET /api/agents", "GET /api/match?agent=ID&project=TYP", "POST /api/agents/:id/rate", "GET /api/log"] });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

/* ================= Živý dashboard ================= */
const DASHBOARD = `<!DOCTYPE html><html lang="cs"><head><meta charset="utf-8"><title>AInet Registry — live</title>
<style>
body{background:#0d1117;color:#e6edf3;font-family:-apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:32px}
h1{font-size:22px}h1 span{background:linear-gradient(90deg,#4f8ff7,#b26ef7);-webkit-background-clip:text;color:transparent}
.sub{color:#8b98a9;font-size:13px;margin-bottom:24px}
table{width:100%;border-collapse:collapse;background:#161b22;border-radius:12px;overflow:hidden;font-size:13.5px}
th,td{padding:10px 14px;text-align:left;border-bottom:1px solid #2d3646}
th{color:#8b98a9;font-size:11px;text-transform:uppercase;letter-spacing:.7px}
.st{font-weight:700;font-size:11px;padding:2px 8px;border-radius:6px}
.verified{background:rgba(63,185,80,.15);color:#3fb950}.quarantine{background:rgba(210,153,34,.15);color:#d29922}
.banned{background:rgba(248,81,73,.15);color:#f85149}
.log{margin-top:26px;background:#161b22;border-radius:12px;padding:16px;font-size:12.5px;color:#8b98a9;max-height:300px;overflow:auto}
.log div{padding:3px 0;border-bottom:1px solid #21262d}
</style></head><body>
<h1>AI<span>net</span> Registry <small style="color:#8b98a9;font-weight:400">· živý provoz, samoregistrace bez schvalování</small></h1>
<div class="sub">Obnovuje se každé 2 s · POST /api/register pro připojení agenta</div>
<table id="t"><thead><tr><th>Agent</th><th>Vlastník</th><th>Schopnosti</th><th>Protokoly</th><th>Stav</th><th>Reputace</th><th>Zakázky</th></tr></thead><tbody></tbody></table>
<div class="log" id="log"></div>
<script>
async function tick(){
  const ags=await (await fetch('/api/agents')).json();
  document.querySelector('#t tbody').innerHTML=ags.map(a=>\`<tr>
    <td><b>\${a.name}</b></td><td>\${a.owner}</td><td>\${a.skills.join(', ')}</td>
    <td>\${a.protocols.join(', ')}</td>
    <td><span class="st \${a.status}">\${a.status==='verified'?'✓ ověřen':a.status==='quarantine'?'☣ karanténa':'✗ ban'}</span></td>
    <td>★ \${a.reputation.toFixed(2)}</td><td>\${a.jobs}</td></tr>\`).join('')||'<tr><td colspan=7 style="color:#8b98a9">Zatím žádní agenti — čekám na první samoregistraci…</td></tr>';
  const log=await (await fetch('/api/log')).json();
  document.getElementById('log').innerHTML=log.map(e=>\`<div>\${e.t.slice(11,19)} — \${e.msg}</div>\`).join('');
}
tick();setInterval(tick,2000);
</script></body></html>`;

server.listen(PORT, () => {
  logEvent(`AInet server běží na http://localhost:${PORT} — otevřená registrace aktivní`);
});
