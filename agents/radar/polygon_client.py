"""
polygon_client.py — premarket data (minutové svíčky, gainers/losers) z Polygonu.
Volitelné: bez POLYGON_KEY Radar jede jen z Alpacy (IEX) a skener je slabší.
Čistý urllib, bez závislostí.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone


class PolygonChyba(RuntimeError):
    pass


class Polygon:
    BASE = "https://api.polygon.io"

    def __init__(self, key: str | None = None, timeout: int = 20):
        self.key = key if key is not None else os.environ.get("POLYGON_KEY", "")
        self.timeout = timeout

    @property
    def zapnuto(self) -> bool:
        return bool(self.key)

    def _req(self, cesta: str, params: dict | None = None) -> dict:
        if not self.key:
            raise PolygonChyba("Chybí POLYGON_KEY.")
        q = dict(params or {}); q["apiKey"] = self.key
        url = f"{self.BASE}{cesta}?{urllib.parse.urlencode(q)}"
        r = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "AInet-Radar-worker/1.0"})
        try:
            with urllib.request.urlopen(r, timeout=self.timeout) as odp:
                return json.loads(odp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            raise PolygonChyba(f"Polygon {cesta}: HTTP {e.code}") from None
        except urllib.error.URLError as e:
            raise PolygonChyba(f"Polygon nedostupný: {e.reason}") from None

    def gainers(self, smer: str = "gainers", include_otc: bool = False) -> list:
        """Premarket/denní top pohyby (Snapshot API). smer = gainers | losers."""
        d = self._req(f"/v2/snapshot/locale/us/markets/stocks/{smer}", {"include_otc": str(include_otc).lower()})
        return d.get("tickers") or []

    def predchozi_den(self, symbol: str) -> dict:
        d = self._req(f"/v2/aggs/ticker/{urllib.parse.quote(symbol.upper())}/prev", {"adjusted": "true"})
        res = d.get("results") or []
        return res[0] if res else {}

    def minutove(self, symbol: str, datum: str | None = None, limit: int = 500) -> list:
        """Minutové svíčky dne (včetně premarketu 4:00–9:30 ET), datum YYYY-MM-DD (výchozí dnes UTC)."""
        datum = datum or datetime.now(timezone.utc).strftime("%Y-%m-%d")
        d = self._req(f"/v2/aggs/ticker/{urllib.parse.quote(symbol.upper())}/range/1/minute/{datum}/{datum}", {"adjusted": "true", "sort": "asc", "limit": limit})
        return d.get("results") or []

    def premarket_gap(self, symbol: str) -> dict | None:
        """Gap posledního premarketového obchodu proti předchozímu závěru (v %)."""
        prev = self.predchozi_den(symbol)
        if not prev or not prev.get("c"):
            return None
        mins = self.minutove(symbol)
        if not mins:
            return {"symbol": symbol.upper(), "zavreni": prev["c"], "premarket": None, "gap_pct": None, "objem_premarket": 0}
        posledni = mins[-1]
        objem = sum(int(m.get("v") or 0) for m in mins)
        return {"symbol": symbol.upper(), "zavreni": prev["c"], "premarket": posledni.get("c"), "gap_pct": round((posledni["c"] / prev["c"] - 1) * 100, 2), "objem_premarket": objem}
