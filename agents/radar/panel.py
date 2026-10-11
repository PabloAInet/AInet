"""
panel.py — data pro měření strategií roje (Projekty roje, 12. 10. 2026).

Worker si drží VLASTNÍ panel denních svíček (Alpaca, adjustment=all, feed SIP — na zdarma účtu
je SIP historie dostupná se zpožděním 15 min, večer to stačí). Earnings Radaru do složek nikdy
nezapisuje — od něj jen ČTE (když worker běží na Macu vedle něj):
  vesmír titulů      research/Tickers DATA/data5y_alpaca/*.json (jen názvy souborů)
  výsledky (earnings) research/Tickers DATA/earnings_edgar_5y.csv + research/earnings_kalendar.csv (denně ho obnovuje ERP)
  události EDGAR      research/laborator_vah/edgar_ledger.json (kniha podání)
Když vlastní panel ještě není (bez klíčů Alpacy), měří se na panelu ERP (jen čtení) — bez dalších dní, takže bez stínu.

Prostředí: PROJEKT_DATA_DIR (vlastní data workeru, výchozí agents/radar/projekt_data — neverzuje se),
           PROJEKT_ERP_DIR (výchozí ~/Documents/Investements/research), PROJEKT_VESMIR (čárkami, přebije vesmír z ERP),
           PROJEKT_FEED (sip | iex, výchozí sip).
Čistá standardní knihovna.
"""
from __future__ import annotations

import csv
import json
import os
import pickle
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from strategie_dsl import Data, kategorie

SLOZKA = Path(__file__).resolve().parent


def _cesta(env: str, vychozi: Path) -> Path:
    return Path(os.path.expanduser(os.environ.get(env, str(vychozi))))


class Panel:
    def __init__(self, data_dir: Path | None = None, erp_dir: Path | None = None):
        self.dir = data_dir or _cesta("PROJEKT_DATA_DIR", SLOZKA / "projekt_data")
        self.erp = erp_dir or _cesta("PROJEKT_ERP_DIR", Path.home() / "Documents" / "Investements" / "research")
        self.bary_dir = self.dir / "panel"
        self.feed = os.environ.get("PROJEKT_FEED", "sip")
        self._data: Data | None = None
        self._podpis = None

    # ---------------------------------------------------------------- vesmír a zdroje
    def vesmir(self) -> list[str]:
        if os.environ.get("PROJEKT_VESMIR"):
            return sorted({t.strip().upper() for t in os.environ["PROJEKT_VESMIR"].split(",") if t.strip()} - {"SPY"})
        erp = self.erp / "Tickers DATA" / "data5y_alpaca"
        if erp.is_dir():
            return sorted(p.stem for p in erp.glob("*.json") if p.stem != "SPY")
        if self.bary_dir.is_dir():
            return sorted(p.stem for p in self.bary_dir.glob("*.json") if p.stem != "SPY")
        return []

    def _zdroj_bary(self) -> tuple[Path, str]:
        if self.bary_dir.is_dir() and (self.bary_dir / "SPY.json").exists():
            return self.bary_dir, "worker"
        return self.erp / "Tickers DATA" / "data5y_alpaca", "erp"

    def _vysledky(self) -> tuple[dict | None, str | None]:
        e = self.erp / "Tickers DATA" / "earnings_edgar_5y.csv"
        k = self.erp / "earnings_kalendar.csv"
        if not e.exists() and not k.exists():
            return None, None
        out: dict[str, set] = {}
        do = ""
        if e.exists():
            with open(e, encoding="utf-8") as f:
                for r in csv.DictReader(f):
                    s = r.get("session")
                    if s in ("A", "B") and r.get("ticker") and r.get("datum"):
                        out.setdefault(r["ticker"], set()).add((r["datum"], s))
                        do = max(do, r["datum"])
        if k.exists():
            with open(k, encoding="utf-8") as f:
                for r in csv.DictReader(f):
                    t = r.get("symbol")
                    if not t:
                        continue
                    if r.get("datum_edgar") and r.get("session_edgar") in ("A", "B"):
                        out.setdefault(t, set()).add((r["datum_edgar"], r["session_edgar"]))
                    elif r.get("datum_tvrzene") and r.get("session_nasdaq") in ("A", "B"):
                        out.setdefault(t, set()).add((r["datum_tvrzene"], r["session_nasdaq"]))
            # kalendář obnovuje ERP každý den — pokrývá výsledky do dne poslední obnovy (pak už je „neznámo“)
            obnova = datetime.fromtimestamp(k.stat().st_mtime).date()
            if (date.today() - obnova).days <= 4:
                do = max(do, obnova.isoformat())
        return out, (do or None)

    def _udalosti(self) -> tuple[dict | None, str | None]:
        led = self.erp / "laborator_vah" / "edgar_ledger.json"
        if not led.exists():
            return None, None
        cache = self.dir / "udalosti_cache.pkl"
        podpis = (led.stat().st_size, int(led.stat().st_mtime))
        try:
            with open(cache, "rb") as f:
                c = pickle.load(f)
            if c.get("podpis") == podpis:
                return c["udalosti"], c["do"]
        except Exception:
            pass
        L = json.loads(led.read_text("utf-8"))
        out: dict[str, dict[str, list[str]]] = {}
        do = ""
        for t, v in L.items():
            kat: dict[str, list[str]] = {}
            for row in (v.get("f") or []):
                d, forma, it = row[0], row[1], row[2] if len(row) > 2 else ""
                do = max(do, d)
                for k in kategorie(forma, it):
                    kat.setdefault(k, []).append(d)
            out[t] = {k: sorted(x) for k, x in kat.items()}
        try:
            self.dir.mkdir(parents=True, exist_ok=True)
            with open(cache, "wb") as f:
                pickle.dump({"podpis": podpis, "udalosti": out, "do": do or None}, f)
        except Exception:
            pass
        return out, (do or None)

    # ---------------------------------------------------------------- načtení
    def nacti(self, znovu: bool = False) -> Data:
        zdroj, jak = self._zdroj_bary()
        soubory = sorted(zdroj.glob("*.json")) if zdroj.is_dir() else []
        podpis = (str(zdroj), len(soubory), max((p.stat().st_mtime for p in soubory), default=0))
        if self._data is not None and not znovu and podpis == self._podpis:
            return self._data
        vesmir = set(self.vesmir()) | {"SPY"}
        bary: dict[str, list] = {}
        for p in soubory:
            if p.stem not in vesmir:
                continue
            try:
                bary[p.stem] = json.loads(p.read_text("utf-8")).get("bary") or []
            except Exception:
                continue
        spy = bary.pop("SPY", [])
        vys, vys_do = self._vysledky()
        uda, uda_do = self._udalosti()
        self._data = Data(bary, spy, vys, vys_do, uda, uda_do)
        self._data.zdroj = jak                      # type: ignore[attr-defined]
        self._podpis = podpis
        return self._data

    # ---------------------------------------------------------------- aktualizace z Alpacy
    def _zapis(self, t: str, bary: list[dict], feed: str) -> None:
        self.bary_dir.mkdir(parents=True, exist_ok=True)
        tmp = self.bary_dir / f"{t}.json.tmp"
        tmp.write_text(json.dumps({"symbol": t, "zdroj": "alpaca", "adjustment": "all", "feed": feed, "bary": bary}), "utf-8")
        tmp.replace(self.bary_dir / f"{t}.json")

    def _cti(self, t: str) -> dict | None:
        p = self.bary_dir / f"{t}.json"
        if not p.exists():
            return None
        try:
            return json.loads(p.read_text("utf-8"))
        except Exception:
            return None

    @staticmethod
    def _bar(b: dict) -> dict:
        return {"d": str(b.get("t") or b.get("d"))[:10], "o": float(b["o"]), "h": float(b["h"]), "l": float(b["l"]), "c": float(b["c"]), "v": float(b.get("v") or 0)}

    def aktualizuj(self, alpaca, dnes: str | None = None, max_davka: int = 100) -> dict:
        """Doplní vlastní panel o chybějící dny. Nový titul = celých 5 let. Po splitu/dividendě (nesedí překryv) se titul stáhne znovu."""
        if alpaca is None or not getattr(alpaca, "ma_klice", False):
            return {"ok": False, "duvod": "bez klíčů Alpacy — panel se neaktualizuje (měří se na datech ERP bez stínu)"}
        dnes = dnes or date.today().isoformat()
        konec = (datetime.now(timezone.utc) - timedelta(minutes=16)).strftime("%Y-%m-%dT%H:%M:%SZ")
        tituly = self.vesmir() + ["SPY"]
        stav = {t: self._cti(t) for t in tituly}
        feed = next((s.get("feed") for s in stav.values() if s and s.get("feed")), None) or self.feed
        plne = [t for t in tituly if not stav[t] or not stav[t].get("bary")]
        podle_dne: dict[str, list[str]] = {}
        for t in tituly:
            if t not in plne:
                podle_dne.setdefault(stav[t]["bary"][-1]["d"], []).append(t)
        nove = znovu = 0
        chyby: list[str] = []

        def stahni(skupina: list[str], start: str) -> dict[str, list]:
            nonlocal feed
            try:
                return alpaca.svicky_vic(skupina, start, konec, feed=feed, adjustment="all")
            except Exception as e:      # zdarma účet bez SIP → jen když panel ještě nemá vlastní data, začne na IEX
                if feed == "sip" and not any(stav.get(x) for x in tituly if x not in plne) and "sip" in str(e).lower():
                    feed = "iex"
                    return alpaca.svicky_vic(skupina, start, konec, feed=feed, adjustment="all")
                raise

        start5 = (date.fromisoformat(dnes) - timedelta(days=5 * 365 + 10)).isoformat()
        for posledni, skupina in sorted(podle_dne.items()):
            if posledni >= dnes:
                continue
            for k in range(0, len(skupina), max_davka):
                davka = skupina[k:k + max_davka]
                try:
                    odp = stahni(davka, posledni)
                except Exception as e:
                    chyby.append(f"{posledni}: {e}"[:200]); continue
                for t in davka:
                    nb = [self._bar(b) for b in (odp.get(t) or [])]
                    stary = stav[t]["bary"]
                    prekryv = next((b for b in nb if b["d"] == posledni), None)
                    if prekryv and abs(prekryv["c"] / stary[-1]["c"] - 1) > 0.002:
                        plne.append(t); znovu += 1           # split/dividenda: celá historie znovu (jednotná úprava cen)
                        continue
                    pridat = [b for b in nb if b["d"] > posledni]
                    if pridat:
                        self._zapis(t, stary + pridat, feed); nove += len(pridat)
        for k in range(0, len(plne), max_davka):
            davka = plne[k:k + max_davka]
            try:
                odp = stahni(davka, start5)
            except Exception as e:
                chyby.append(f"plné stažení: {e}"[:200]); continue
            for t in davka:
                nb = [self._bar(b) for b in (odp.get(t) or [])]
                if nb:
                    self._zapis(t, nb, feed); nove += len(nb)
        self.dir.mkdir(parents=True, exist_ok=True)
        (self.dir / "panel_stav.json").write_text(json.dumps({"aktualizace": datetime.now(timezone.utc).isoformat(), "feed": feed,
                                                               "novych_baru": nove, "znovu_stazeno": znovu, "chyby": chyby[:20]}, ensure_ascii=False), "utf-8")
        self._podpis = None
        return {"ok": not chyby, "feed": feed, "novych_baru": nove, "znovu_stazeno": znovu, "chyby": chyby[:5]}
