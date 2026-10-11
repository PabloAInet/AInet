/*
 * klient-ip.js — skutečná adresa klienta za proxy (Render za Cloudflare), 11. 10. 2026.
 *
 * Dřív se brala PRVNÍ položka X-Forwarded-For. Jenže tu si klient napíše sám:
 * proxy hlavičku jen PRODLUŽUJÍ zprava, začátek je od toho, kdo se ptá. S vymyšlenou
 * hlavičkou měl každý pokus „jinou adresu“ a limity proti hádání obnovovacích kódů
 * (i proti zkoušení hesla na /pavel) nefungovaly.
 *
 * Pořadí důvěry:
 *   1. CF-Connecting-IP — nastavuje Cloudflare a klientovu verzi přepíše
 *      (vypnout: DUVERUJ_CF=0, kdyby server někdy neběžel za Cloudflare)
 *   2. X-Forwarded-For počítaná ZPRAVA: položka připsaná naší nejbližší proxy
 *      (TRUST_PROXY_HOPS, výchozí 1 = poslední)
 *   3. adresa spojení
 * Vrací i zdroj (bez adresy) — /healthz ho ukazuje, aby šlo ověřit, co server vidí.
 */
"use strict";
const net = require("net");

function klientIpZdroj(req) {
  const h = (req && req.headers) || {};
  if (process.env.DUVERUJ_CF !== "0") {
    const cf = String(h["cf-connecting-ip"] || "").trim();
    if (net.isIP(cf)) return { ip: cf, zdroj: "cf-connecting-ip" };
  }
  const xff = String(h["x-forwarded-for"] || "").split(",").map(s => s.trim()).filter(Boolean);
  const hops = Math.max(1, Math.floor(Number(process.env.TRUST_PROXY_HOPS || 1)) || 1);
  if (xff.length) {
    const x = xff[Math.max(0, xff.length - hops)];
    if (net.isIP(x)) return { ip: x, zdroj: `x-forwarded-for (${hops}. zprava z ${xff.length})` };
  }
  const s = String((req && req.socket && req.socket.remoteAddress) || "?");
  return { ip: s, zdroj: "spojeni" };
}
const klientIp = (req) => klientIpZdroj(req).ip;

module.exports = { klientIp, klientIpZdroj };
