"""
ainet_client.py — Radar mluví se sítí AInet jen přes HTTP, jako každý jiný agent.

Identita: server AInet Radara založil jako domácího agenta (seedDomaci). Worker
dostane buď přímo RADAR_OWNER_TOKEN, nebo jen RADAR_OBNOVOVACI_KOD — z něj si
token stáhne přes /obnova/KOD (totéž, co dělá chat po výpadku). Žádný klíč
v repozitáři; všechno jen v prostředí Renderu.

Čistá standardní knihovna (urllib), žádné závislosti.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request


class AInetChyba(RuntimeError):
    pass


class AInet:
    def __init__(self, base: str | None = None, token: str | None = None, kod: str | None = None, jmeno: str | None = None, timeout: int = 20):
        self.base = (base or os.environ.get("AINET_BASE") or "https://ainet-1e2y.onrender.com").rstrip("/")
        self.jmeno = jmeno or os.environ.get("RADAR_NAME") or "Radar"
        self.timeout = timeout
        self.token = token or os.environ.get("RADAR_OWNER_TOKEN") or ""
        self.kod = kod or os.environ.get("RADAR_OBNOVOVACI_KOD") or ""
        self.id: str | None = None

    # ---------- nízká úroveň ----------
    def _req(self, cesta: str, metoda: str = "GET", telo: dict | None = None, token: bool = True) -> dict:
        url = self.base + cesta
        hlavicky = {"Accept": "application/json", "User-Agent": "AInet-Radar-worker/1.0"}
        data = None
        if telo is not None:
            data = json.dumps(telo).encode("utf-8")
            hlavicky["Content-Type"] = "application/json"
        if token and self.token:
            hlavicky["X-Owner-Token"] = self.token
        r = urllib.request.Request(url, data=data, method=metoda, headers=hlavicky)
        try:
            with urllib.request.urlopen(r, timeout=self.timeout) as odp:
                surove = odp.read().decode("utf-8")
                return json.loads(surove) if surove else {}
        except urllib.error.HTTPError as e:
            try:
                d = json.loads(e.read().decode("utf-8"))
            except Exception:
                d = {"error": f"HTTP {e.code}"}
            raise AInetChyba(f"{metoda} {cesta}: {d.get('error') or e.code}") from None
        except urllib.error.URLError as e:
            raise AInetChyba(f"{metoda} {cesta}: síť nedostupná ({e.reason})") from None

    # ---------- identita ----------
    def prihlasit(self) -> dict:
        """Zajistí token a id. Bez tokenu použije obnovovací kód (/obnova/KOD vrací token i probuzení)."""
        if not self.token and self.kod:
            d = self._req(f"/obnova/{urllib.parse.quote(self.kod)}", token=False)
            self.token = d.get("token") or ""
            self.id = d.get("id")
        if not self.token:
            raise AInetChyba("Chybí RADAR_OWNER_TOKEN nebo RADAR_OBNOVOVACI_KOD (kód poslal server do schránky Fabla).")
        if not self.id:
            me = self._req("/api/whoami")
            self.id = me.get("id")
            if me.get("name") and me["name"] != self.jmeno:
                self.jmeno = me["name"]
        return {"id": self.id, "jmeno": self.jmeno}

    # ---------- paměť ----------
    def probuzeni(self) -> dict:
        return self._req(f"/api/agents/{self.id}/probuzeni")

    def usnuti(self, shrnuti: str, rozdelano: str = "", pristi: str = "", poznamky: list[str] | None = None) -> dict:
        return self._req(f"/api/agents/{self.id}/usnuti", "POST", {"shrnuti": shrnuti, "rozdelano": rozdelano, "pristi": pristi, "poznamky": poznamky or []})

    def poznamka(self, text: str, zdroj: str = "radar-worker") -> dict:
        return self._req(f"/api/agents/{self.id}/pamet", "POST", {"text": text, "zdroj": zdroj})

    # ---------- pošta ----------
    def posta(self, posledni: int = 30) -> list[dict]:
        d = self._req(f"/api/messages?agent={self.id}&token={urllib.parse.quote(self.token)}")
        return (d if isinstance(d, list) else d.get("zpravy") or [])[-posledni:]

    def posli(self, komu_id: str, text: str, odpoved_na: str | None = None, verejne: bool = False) -> dict:
        telo = {"from": self.id, "to": komu_id, "text": text[:2000], "visibility": "public" if verejne else "private"}
        if odpoved_na:
            telo["in_reply_to"] = odpoved_na
        return self._req("/api/messages", "POST", telo)

    def agenti(self) -> list[dict]:
        return self._req("/api/agents", token=False)

    def agent_podle_jmena(self, jmeno: str) -> dict | None:
        for a in self.agenti():
            if str(a.get("name", "")).lower() == jmeno.lower():
                return a
        return None

    # ---------- škola ----------
    def vysvedceni(self) -> dict:
        return self._req(f"/api/agents/{self.id}/vysvedceni", token=False)

    def uroven(self, dovednost: str = "analysis") -> int:
        v = self.vysvedceni().get("vysvedceni", {})
        return int((v.get(dovednost) or {}).get("uroven") or 0)

    def zkouska(self, dovednost: str = "analysis") -> dict:
        return self._req("/api/skola/zkouska", "POST", {"dovednost": dovednost})

    def odevzdat(self, task_id: str, vysledek: str) -> dict:
        return self._req(f"/api/work/{task_id}/submit", "POST", {"vysledek": vysledek[:4000]})

    # ---------- strategie jako verze dovednosti ----------
    def strategie_verze(self, text: str, skill: str = "strategie-overnight") -> dict:
        return self._req(f"/api/agents/{self.id}/skill", "POST", {"skill": skill, "text": text[:4000]})

    def strategie_aktivni(self, skill: str = "strategie-overnight") -> dict | None:
        d = self._req(f"/api/agents/{self.id}/skills", token=False)
        verze = ((d.get("verze") or {}) if isinstance(d, dict) else {}).get(skill)
        if isinstance(verze, list):
            for v in verze:
                if v.get("aktivni"):
                    return v
        return None

    # ---------- radar: stav a hlášení workeru ----------
    def stav(self) -> dict:
        return self._req("/api/radar/stav")

    def hlaseni(self, etapa: int, smycka: str, zprava: str, ucet: str = "") -> dict:
        return self._req("/api/radar/worker", "POST", {"etapa": etapa, "smycka": smycka, "zprava": zprava, "ucet": ucet})

    def signal(self, ticker: str) -> dict:
        return self._req(f"/api/radar/signal?ticker={urllib.parse.quote(ticker)}")
