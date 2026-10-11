"""
alpaca_client.py — jediná cesta TradeRadara k penězům. Server AInet na Alpacu nikdy nesahá.

Dva účty, dva páry klíčů (jen v prostředí Renderu):
  ALPACA_PAPER_KEY / ALPACA_PAPER_SECRET   papírový účet (etapa 3)
  ALPACA_LIVE_KEY  / ALPACA_LIVE_SECRET    živý účet — používá se JEN když RADAR_LIVE=1 (etapa 4)

Všechny příkazy jdou přes `Alpaca.prikaz(...)`, který před odesláním znovu
přečte limity (limity.json) a odmítne cokoli mimo ně. Čistý urllib, bez závislostí.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone


class AlpacaChyba(RuntimeError):
    pass


class Alpaca:
    DATA = "https://data.alpaca.markets"

    def __init__(self, zivy: bool = False, timeout: int = 20):
        self.zivy = zivy
        if zivy:
            if os.environ.get("RADAR_LIVE", "0") != "1":
                raise AlpacaChyba("Živý účet je vypnutý (RADAR_LIVE != 1).")
            self.key, self.secret = os.environ.get("ALPACA_LIVE_KEY", ""), os.environ.get("ALPACA_LIVE_SECRET", "")
            self.base = "https://api.alpaca.markets"
        else:
            self.key, self.secret = os.environ.get("ALPACA_PAPER_KEY", ""), os.environ.get("ALPACA_PAPER_SECRET", "")
            self.base = "https://paper-api.alpaca.markets"
        self.timeout = timeout

    @property
    def ma_klice(self) -> bool:
        return bool(self.key and self.secret)

    def _req(self, url: str, metoda: str = "GET", telo: dict | None = None) -> dict | list:
        if not self.ma_klice:
            raise AlpacaChyba("Chybí klíče Alpacy pro " + ("živý" if self.zivy else "papírový") + " účet.")
        hl = {"APCA-API-KEY-ID": self.key, "APCA-API-SECRET-KEY": self.secret, "Accept": "application/json"}
        data = None
        if telo is not None:
            data = json.dumps(telo).encode("utf-8"); hl["Content-Type"] = "application/json"
        r = urllib.request.Request(url, data=data, method=metoda, headers=hl)
        try:
            with urllib.request.urlopen(r, timeout=self.timeout) as odp:
                s = odp.read().decode("utf-8")
                return json.loads(s) if s else {}
        except urllib.error.HTTPError as e:
            raise AlpacaChyba(f"Alpaca {metoda} {url.split('.markets')[-1]}: HTTP {e.code} {e.read().decode('utf-8')[:200]}") from None
        except urllib.error.URLError as e:
            raise AlpacaChyba(f"Alpaca nedostupná: {e.reason}") from None

    # ---------- účet ----------
    def ucet(self) -> dict:
        return self._req(f"{self.base}/v2/account")

    def pozice(self) -> list:
        return self._req(f"{self.base}/v2/positions")

    def prikazy(self, stav: str = "open") -> list:
        return self._req(f"{self.base}/v2/orders?status={stav}&limit=100")

    def hodiny(self) -> dict:
        return self._req(f"{self.base}/v2/clock")

    # ---------- data (IEX zdarma; objem je jen část trhu, ceny platí) ----------
    def svicky(self, symbol: str, timeframe: str = "1Day", dni: int = 30, feed: str = "iex") -> list:
        start = (datetime.now(timezone.utc) - timedelta(days=dni)).strftime("%Y-%m-%dT%H:%M:%SZ")
        d = self._req(f"{self.DATA}/v2/stocks/{urllib.parse.quote(symbol)}/bars?timeframe={timeframe}&start={start}&limit=1000&feed={feed}&adjustment=raw")
        return d.get("bars") or []

    def posledni_cena(self, symbol: str, feed: str = "iex") -> float | None:
        d = self._req(f"{self.DATA}/v2/stocks/{urllib.parse.quote(symbol)}/trades/latest?feed={feed}")
        t = d.get("trade") or {}
        return float(t["p"]) if "p" in t else None

    def svicky_vic(self, symboly: list[str], start: str, end: str | None = None, timeframe: str = "1Day", feed: str = "sip", adjustment: str = "all") -> dict:
        """Denní svíčky pro víc titulů najednou (stránkuje next_page_token). Vrací {symbol: [bar, …]}."""
        out: dict[str, list] = {}
        if not symboly:
            return out
        zaklad = (f"{self.DATA}/v2/stocks/bars?symbols={','.join(urllib.parse.quote(s) for s in symboly)}&timeframe={timeframe}"
                  f"&start={urllib.parse.quote(start)}&limit=10000&feed={feed}&adjustment={adjustment}" + (f"&end={urllib.parse.quote(end)}" if end else ""))
        token = None
        for _ in range(500):
            d = self._req(zaklad + (f"&page_token={urllib.parse.quote(token)}" if token else ""))
            for sym, bary in ((d or {}).get("bars") or {}).items():
                out.setdefault(sym, []).extend(bary or [])
            token = (d or {}).get("next_page_token")
            if not token:
                break
        return out

    def snapshoty(self, symboly: list[str], feed: str = "iex") -> dict:
        if not symboly:
            return {}
        d = self._req(f"{self.DATA}/v2/stocks/snapshots?symbols={','.join(urllib.parse.quote(s) for s in symboly)}&feed={feed}")
        return d if isinstance(d, dict) else {}

    # ---------- příkazy — vždy přes limity ----------
    def prikaz(self, symbol: str, mnozstvi: int, strana: str, limity: dict, typ: str = "market", limit_cena: float | None = None, stop_cena: float | None = None, tif: str = "day", suché: bool = False) -> dict:
        """Jediné místo, odkud odchází příkaz. Limity se čtou ZNOVU před každým příkazem."""
        symbol = symbol.upper()
        if strana not in ("buy", "sell"):
            raise AlpacaChyba("strana musí být buy nebo sell")
        if mnozstvi <= 0:
            raise AlpacaChyba("množství musí být > 0")
        if strana == "buy":
            cena = limit_cena or self.posledni_cena(symbol) or 0
            if cena <= 0:
                raise AlpacaChyba(f"{symbol}: neznámá cena, nekupuji")
            if cena * mnozstvi > float(limity.get("pozice_usd", 400)) * 1.02:
                raise AlpacaChyba(f"{symbol}: {cena * mnozstvi:.0f} $ přesahuje limit pozice {limity.get('pozice_usd')} $")
            if len(self.pozice()) >= int(limity.get("max_pozic", 3)):
                raise AlpacaChyba(f"už držím {limity.get('max_pozic')} pozic — limit")
        telo = {"symbol": symbol, "qty": str(mnozstvi), "side": strana, "type": typ, "time_in_force": tif}
        if typ == "limit":
            telo["limit_price"] = str(limit_cena)
        if typ == "stop":
            telo["stop_price"] = str(stop_cena)
        if suché:
            return {"suche": True, "prikaz": telo}
        return self._req(f"{self.base}/v2/orders", "POST", telo)

    def prikaz_detail(self, order_id: str) -> dict:
        return self._req(f"{self.base}/v2/orders/{urllib.parse.quote(order_id)}")

    def zrus_prikaz(self, order_id: str) -> None:
        self._req(f"{self.base}/v2/orders/{order_id}", "DELETE")

    def prodej_vse(self, symbol: str, suché: bool = False) -> dict:
        if suché:
            return {"suche": True, "zavrit": symbol}
        return self._req(f"{self.base}/v2/positions/{urllib.parse.quote(symbol.upper())}", "DELETE")


class AlpacaProjekt(Alpaca):
    """Papírový účet PROJEKTŮ ROJE — vlastní pár klíčů, vždy paper-api, nikdy živý.

    ALPACA_PROJEKT_KEY / ALPACA_PROJEKT_SECRET vkládá vlastník sám do prostředí workeru. Musí to být
    JINÝ papírový účet než ten TradeRadarův (ALPACA_PAPER_KEY) — roj obchoduje odděleně a jeho
    výsledek jde poctivě změřit. Limity čte z projekt_limity.json (mění je jen vlastník)."""

    def __init__(self, timeout: int = 20):
        self.zivy = False
        self.key = os.environ.get("ALPACA_PROJEKT_KEY", "")
        self.secret = os.environ.get("ALPACA_PROJEKT_SECRET", "")
        self.base = "https://paper-api.alpaca.markets"
        self.timeout = timeout
        if self.key and self.key == os.environ.get("ALPACA_PAPER_KEY"):
            raise AlpacaChyba("Projekty roje potřebují SAMOSTATNÝ papírový účet — ALPACA_PROJEKT_KEY je stejný jako TradeRadarův ALPACA_PAPER_KEY.")
