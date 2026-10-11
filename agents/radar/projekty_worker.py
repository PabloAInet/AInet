"""
projekty_worker.py — RUCE PROJEKTŮ ROJE v TradeRadarově workeru (12. 10. 2026).

Server AInet drží projekty, registrace strategií a brány vlastníka; tady se jen MĚŘÍ a (po bráně) obchoduje na papíře:
  joby()      každých 10 min: zadání od roje (backtest zapsané strategie, výpis událostí EDGAR, výtah registrací ERP)
  vecer()     18:30 NY: doplní panel, dopočte STÍN všech strategií, které prošly backtestem, naplánuje papírové vstupy
  rano()      9:00 NY: papír — výstupy na otevření a nové vstupy (příkazy OPG), jen v limitech a bez STOPu
  kontrola()  9:45 NY: plnění vstupů → pozice + stop příkaz; plnění výstupů a stopů → uzavřené obchody
  zavreni()   15:30 NY: výstupy na zavření (příkazy CLS)

Pravidla, která tady nejdou obejít:
  • papír jen pro strategie, které vlastník schválil bránou na serveru (stín ≥ 20 dní, ≥ 30 obchodů, Ø alfa > 0)
  • papír jen na SAMOSTATNÉM účtu projektů (AlpacaProjekt, paper-api) a v limitech z projekt_limity.json
  • STOP projektu nebo globální STOP TradeRadara = žádné nové vstupy (výstupy podle pravidel doběhnou)
  • papír zatím jen long se vstupem na otevření (open_D1); ostatní strategie běží jen ve stínu
  • živý účet tu neexistuje
Čistá standardní knihovna.
"""
from __future__ import annotations

import csv
import json
import math
import threading
import traceback
import uuid
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import strategie_dsl as S
from panel import Panel

NY = ZoneInfo("America/New_York")
SLOZKA = Path(__file__).resolve().parent


def log(m: str) -> None:
    print(f"[projekty] {datetime.now(NY).strftime('%Y-%m-%d %H:%M')} {m}", flush=True)


class ProjektyWorker:
    def __init__(self, ainet, alpaca_data=None, papir=None, panel: Panel | None = None, suche: bool = False):
        self.ainet = ainet
        self.alpaca_data = alpaca_data          # data API (stačí jakékoli klíče Alpacy)
        self.papir = papir                      # AlpacaProjekt nebo None (bez klíčů projektů = bez papíru)
        self.panel = panel or Panel()
        self.suche = suche
        self.zamek_data = threading.Lock()
        self.zamek_papir = threading.Lock()
        self._vlakno: threading.Thread | None = None
        self.stav_soubor = self.panel.dir / "papir_stav.json"

    # ---------------------------------------------------------------- pomocné
    def dnes(self) -> str:
        return datetime.now(NY).strftime("%Y-%m-%d")

    def limity(self) -> dict:
        try:
            return json.loads((SLOZKA / "projekt_limity.json").read_text("utf-8"))
        except Exception:
            return {"pozice_usd": 300, "max_pozic": 6, "vstupu_za_den": 4, "denni_ztrata_pct": 2.0}

    def data(self, znovu: bool = False) -> S.Data:
        return self.panel.nacti(znovu)

    def cti_stav(self) -> dict:
        try:
            return json.loads(self.stav_soubor.read_text("utf-8"))
        except Exception:
            return {"planovane": [], "otevrene": [], "uzavrene": [], "cekajici_vstupy": [], "cekajici_vystupy": [], "odpocet": None}

    def pis_stav(self, st: dict) -> None:
        self.stav_soubor.parent.mkdir(parents=True, exist_ok=True)
        st["uzavrene"] = st.get("uzavrene", [])[-500:]
        tmp = self.stav_soubor.with_suffix(".tmp")
        tmp.write_text(json.dumps(st, ensure_ascii=False, indent=1), "utf-8")
        tmp.replace(self.stav_soubor)

    def stav_serveru(self) -> dict:
        try:
            return self.ainet.projekty_worker() or {}
        except Exception as e:
            log(f"server: {e}")
            return {}

    def manifest(self) -> dict:
        try:
            d = self.data()
        except Exception:
            d = None
        m = S.manifest(d)
        m["zdroj_dat"] = getattr(d, "zdroj", None) if d else None
        m["papir"] = {"ucet": bool(self.papir and getattr(self.papir, "ma_klice", False)), "limity": self.limity()}
        return m

    def ohlas(self) -> None:
        try:
            self.ainet.projekty_manifest(self.manifest())
        except Exception as e:
            log(f"manifest: {e}")

    def na_pozadi(self, fn) -> bool:
        """Dlouhé věci (backtesty, večer) běží ve vlákně, ať nezdrží časově citlivé smyčky TradeRadara."""
        if self._vlakno and self._vlakno.is_alive():
            return False

        def beh():
            try:
                fn()
            except Exception as e:
                log(f"✗ {getattr(fn, '__name__', 'úloha')}: {e}\n{traceback.format_exc()[-600:]}")
        self._vlakno = threading.Thread(target=beh, daemon=True)
        self._vlakno.start()
        return True

    # ---------------------------------------------------------------- joby od roje
    def joby(self) -> str:
        st = self.stav_serveru()
        hotovo = 0
        for job in st.get("joby") or []:
            try:
                self.ainet.projekty_job(job["id"], "bezi")
            except Exception as e:
                log(f"job {job.get('id', '')[:8]}: nelze převzít ({e})"); continue
            try:
                with self.zamek_data:
                    vysledek = self.spust_job(job)
                self.ainet.projekty_job(job["id"], "hotovo", vysledek=vysledek)
                hotovo += 1
            except Exception as e:
                log(f"job {job.get('typ')} {job['id'][:8]}: {e}")
                try:
                    self.ainet.projekty_job(job["id"], "chyba", chyba=str(e)[:500])
                except Exception:
                    pass
        return f"joby: hotovo {hotovo}"

    def spust_job(self, job: dict) -> dict:
        typ, par = job.get("typ"), job.get("parametry") or {}
        if typ == "backtest":
            data = self.data()
            spec, chyby = S.validuj(par.get("strategie") or {}, data.zdroje())
            if chyby:
                raise ValueError("strategie neprošla kontrolou formátu: " + "; ".join(chyby[:6]))
            k = S.kriterium_s_podlahou(par.get("kriterium"), int((par.get("kriterium") or {}).get("pokus") or 1))
            r = S.mer(data, spec, k, par.get("registrovano") or datetime.utcnow().isoformat())
            r["stin"].pop("obchody", None)
            return r
        if typ == "udalosti":
            return self.job_udalosti(par)
        if typ == "erp_registrace":
            return self.job_erp_registrace()
        raise ValueError(f"neznámý typ jobu „{typ}“ — umím backtest, udalosti, erp_registrace")

    def job_udalosti(self, par: dict) -> dict:
        data = self.data()
        if data.udalosti is None:
            raise ValueError("kniha podání EDGAR tu není (research/laborator_vah/edgar_ledger.json)")
        kat = [str(k).upper() for k in (par.get("kategorie") or ["B1"]) if str(k).upper() in S.UDALOSTI]
        od, do = str(par.get("od") or "2021-01-01")[:10], str(par.get("do") or "2100-01-01")[:10]
        tik = {str(t).upper() for t in (par.get("tickery") or [])}
        radky = []
        for t, kk in data.udalosti.items():
            if tik and t not in tik:
                continue
            for k in kat:
                for d in kk.get(k) or []:
                    if od <= d <= do:
                        radky.append({"t": t, "d": d, "kategorie": k})
        radky.sort(key=lambda r: (r["d"], r["t"]))
        po = {k: sum(1 for r in radky if r["kategorie"] == k) for k in kat}
        return {"kategorie": {k: S.UDALOSTI[k] for k in kat}, "od": od, "do": do, "celkem": len(radky), "po_kategoriich": po,
                "radky": radky[-300:], "pokryti_do": data.udalosti_do, "zdroj": "kniha podání EDGAR (Earnings Radar, jen čtení)"}

    def job_erp_registrace(self) -> dict:
        p = self.panel.erp / "registrace_kriterii.csv"
        if not p.exists():
            raise ValueError("registrace Earnings Radaru tu nejsou")
        radky = []
        with open(p, encoding="utf-8") as f:
            for r in csv.DictReader(f):
                radky.append(f"- {r.get('klic')} [{r.get('typ')}] ({r.get('vetev')}): {str(r.get('metrika') or '')[:160]} — {str(r.get('poznamka') or '')[:200]}")
        text = ("Výtah z registrací Earnings Radaru (Pavlův výzkum; jen pro účastníky projektu). Typ: uzavreno = změřeno a uzavřeno, "
                "stin = běží ve stínu, test = čeká na čtení, brzda = pojistka, princip = pravidlo.\n" + "\n".join(radky))
        return {"dokument": {"nazev": "Registrace Earnings Radaru — co už bylo testováno", "text": text[:90000], "stitky": ["erp", "registrace"]},
                "radku": len(radky)}

    # ---------------------------------------------------------------- večer: panel, stín, plán papíru
    def vecer(self) -> str:
        with self.zamek_data:
            akt = self.panel.aktualizuj(self.alpaca_data) if self.alpaca_data else {"ok": False, "duvod": "bez dat Alpacy"}
            data = self.data(znovu=True)
            st = self.stav_serveru()
            stiny = 0
            for reg in st.get("strategie") or []:
                if not reg.get("stin"):
                    continue
                spec, chyby = S.validuj(reg.get("strategie") or {}, data.zdroje())
                if chyby:
                    continue
                k = S.kriterium_s_podlahou(reg.get("kriterium"), int((reg.get("kriterium") or {}).get("pokus") or 1))
                s = S.stin(data, spec, k["naklad_pct"], reg.get("registrovano") or "")
                obchody = s.pop("obchody", [])
                try:
                    self.ainet.projekty_metriky(reg["id"], "stin", s, obchody[-30:])
                    stiny += 1
                except Exception as e:
                    log(f"stín {reg.get('nazev')}: {e}")
        plan = self.planuj_papir(data, st)
        self.ohlas()
        return f"večer: panel {'+' + str(akt.get('novych_baru', 0)) + ' barů' if akt.get('ok') else akt.get('duvod') or akt.get('chyby')}, stín {stiny} strategií, {plan}"

    def planuj_papir(self, data: S.Data, st: dict) -> str:
        if not self.papir or not getattr(self.papir, "ma_klice", False):
            return "papír: bez klíčů účtu projektů"
        dnes = self.dnes()
        with self.zamek_papir:
            ps = self.cti_stav()
            self.uzavri_obchody(ps, data)
            ps["planovane"] = []
            if data.do != dnes:
                self.pis_stav(ps)
                return f"papír: data dne {dnes} chybí (panel do {data.do}) — nic se neplánuje"
            nove = 0
            for reg in st.get("strategie") or []:
                if not reg.get("papir") or reg.get("stop"):
                    continue
                spec, chyby = S.validuj(reg.get("strategie") or {}, data.zdroje())
                if chyby or spec["smer"] != "long" or spec["vstup"] != "open_D1":
                    continue
                sig = S.signaly_dne(data, spec, dnes)
                for s in sig["signaly"]:
                    ps["planovane"].append({"id": uuid.uuid4().hex[:10], "reg": reg["id"], "projekt": reg.get("projekt"), "t": s["t"],
                                            "signal_den": dnes, "vstup_den": data.dalsi_den(dnes), "drzet_dni": spec["vystup"]["dni"],
                                            "vystup_cena": spec["vystup"]["cena"], "stop_pct": spec["stop_pct"], "cena_signal": s["cena"]})
                    nove += 1
            self.pis_stav(ps)
        return f"papír: naplánováno {nove} vstupů na zítřejší otevření"

    # ---------------------------------------------------------------- papír během dne
    def _smi_vstupovat(self, st: dict, reg_id: str) -> tuple[bool, str]:
        if st.get("stop"):
            return False, "globální STOP TradeRadara"
        reg = next((r for r in st.get("strategie") or [] if r["id"] == reg_id), None)
        if not reg or not reg.get("papir"):
            return False, "strategie už nemá schválený papír"
        if reg.get("stop"):
            return False, "projekt je zastavený"
        return True, ""

    def rano(self) -> str:
        if not self.papir or not getattr(self.papir, "ma_klice", False):
            return "papír: bez klíčů účtu projektů"
        dnes = self.dnes()
        try:
            hod = self.papir.hodiny()
            if str(hod.get("next_open") or "")[:10] != dnes and not hod.get("is_open"):
                return "papír: dnes se neobchoduje"
        except Exception as e:
            return f"papír: hodiny burzy nedostupné ({e})"
        st = self.stav_serveru()
        lim = self.limity()
        with self.zamek_papir:
            ps = self.cti_stav()
            # odpočet dní držení (jednou denně) a výstupy na otevření
            if ps.get("odpocet") != dnes:
                for p in ps["otevrene"]:
                    if p["vstup_den"] < dnes and p["zbyva_dni"] > 0:
                        p["zbyva_dni"] -= 1
                ps["odpocet"] = dnes
            vystupu = 0
            for p in ps["otevrene"]:
                if p["zbyva_dni"] == 0 and p["vystup_cena"] == "open" and not p.get("vystup_prikaz"):
                    self._zrus_stop(p)
                    try:
                        o = self.papir.prikaz(p["t"], p["qty"], "sell", lim, tif="opg", suché=self.suche)
                        p["vystup_prikaz"] = o.get("id") or "suche"; vystupu += 1
                    except Exception as e:
                        log(f"výstup {p['t']}: {e}")
            # vstupy
            ok_den, proc = True, ""
            try:
                u = self.papir.ucet()
                eq, last = float(u.get("equity") or 0), float(u.get("last_equity") or 0)
                if last > 0 and (eq / last - 1) * 100 <= -float(lim.get("denni_ztrata_pct", 2.0)):
                    ok_den, proc = False, f"denní ztráta účtu {(eq / last - 1) * 100:.2f} %"
            except Exception as e:
                ok_den, proc = False, f"účet nedostupný ({e})"
            vstupu, preskoceno = 0, []
            drzim = len(ps["otevrene"]) + len(ps.get("cekajici_vstupy") or [])
            for v in [x for x in ps["planovane"] if x["vstup_den"] == dnes]:
                smi, duvod = self._smi_vstupovat(st, v["reg"])
                if not ok_den or not smi:
                    preskoceno.append(f"{v['t']} ({proc or duvod})"); continue
                if vstupu >= int(lim.get("vstupu_za_den", 4)) or drzim >= int(lim.get("max_pozic", 6)):
                    preskoceno.append(f"{v['t']} (limit)"); continue
                if any(p["t"] == v["t"] for p in ps["otevrene"]) or any(c["t"] == v["t"] for c in ps.get("cekajici_vstupy") or []):
                    preskoceno.append(f"{v['t']} (už drží)"); continue
                try:
                    cena = self.papir.posledni_cena(v["t"]) or v["cena_signal"]
                except Exception:
                    cena = v["cena_signal"]
                qty = int(float(lim.get("pozice_usd", 300)) // max(cena, 0.01))
                if qty < 1:
                    preskoceno.append(f"{v['t']} (cena nad limit pozice)"); continue
                try:
                    o = self.papir.prikaz(v["t"], qty, "buy", lim, tif="opg", suché=self.suche)
                except Exception as e:
                    preskoceno.append(f"{v['t']} ({e})"); continue
                ps.setdefault("cekajici_vstupy", []).append({**v, "qty": qty, "prikaz": o.get("id") or "suche", "zadano": dnes})
                vstupu += 1; drzim += 1
            ps["planovane"] = [x for x in ps["planovane"] if x["vstup_den"] > dnes]
            self.pis_stav(ps)
        return f"papír ráno: {vstupu} vstupů, {vystupu} výstupů na otevření" + (f"; vynecháno: {', '.join(preskoceno[:8])}" if preskoceno else "")

    def _zrus_stop(self, p: dict) -> None:
        if p.get("stop_prikaz") and p["stop_prikaz"] != "suche":
            try:
                self.papir.zrus_prikaz(p["stop_prikaz"])
            except Exception as e:
                log(f"zrušení stopu {p['t']}: {e}")
        p["stop_prikaz"] = None

    def _plneni(self, oid: str) -> tuple[str, float, int]:
        if oid == "suche":
            return "suche", 0.0, 0
        d = self.papir.prikaz_detail(oid)
        return str(d.get("status") or ""), float(d.get("filled_avg_price") or 0), int(float(d.get("filled_qty") or 0))

    def kontrola(self) -> str:
        if not self.papir or not getattr(self.papir, "ma_klice", False):
            return "papír: bez klíčů účtu projektů"
        dnes = self.dnes()
        lim = self.limity()
        with self.zamek_papir:
            ps = self.cti_stav()
            nove, nevyplneno = 0, []
            zbyle = []
            for c in ps.get("cekajici_vstupy") or []:
                try:
                    stav, cena, qty = self._plneni(c["prikaz"])
                except Exception as e:
                    log(f"plnění {c['t']}: {e}"); zbyle.append(c); continue
                if stav == "filled" and qty > 0:
                    p = {"id": c["id"], "reg": c["reg"], "projekt": c.get("projekt"), "t": c["t"], "qty": qty, "vstup_den": dnes, "vstup_cena": cena,
                         "zbyva_dni": c["drzet_dni"], "vystup_cena": c["vystup_cena"], "stop_pct": c.get("stop_pct"), "stop_prikaz": None, "vystup_prikaz": None}
                    if p["stop_pct"]:
                        try:
                            o = self.papir.prikaz(p["t"], qty, "sell", lim, typ="stop", stop_cena=round(cena * (1 - p["stop_pct"] / 100), 2), tif="gtc", suché=self.suche)
                            p["stop_prikaz"] = o.get("id") or "suche"
                        except Exception as e:
                            log(f"stop {p['t']}: {e}")
                    ps["otevrene"].append(p); nove += 1
                elif stav in ("new", "accepted", "pending_new", "partially_filled"):
                    zbyle.append(c)
                else:
                    nevyplneno.append(f"{c['t']} ({stav or 'neznámo'})")
            ps["cekajici_vstupy"] = zbyle
            zav = self._zkontroluj_vystupy(ps)
            self.pis_stav(ps)
        return f"papír kontrola: {nove} nových pozic, {zav} uzavřeno" + (f"; nevyplněno: {', '.join(nevyplneno)}" if nevyplneno else "")

    def _zkontroluj_vystupy(self, ps: dict) -> int:
        dnes = self.dnes()
        zbyle, zav = [], 0
        for p in ps["otevrene"]:
            hotovo = None
            for klic, jak in (("vystup_prikaz", "plán"), ("stop_prikaz", "stop")):
                oid = p.get(klic)
                if not oid or oid == "suche":
                    continue
                try:
                    stav, cena, qty = self._plneni(oid)
                except Exception:
                    continue
                if stav == "filled":
                    hotovo = (cena, jak); break
            if hotovo:
                if hotovo[1] == "plán":
                    self._zrus_stop(p)
                ps["uzavrene"].append({**p, "vystup_den": dnes, "vystup_fill": hotovo[0], "jak": hotovo[1]})
                zav += 1
            else:
                zbyle.append(p)
        ps["otevrene"] = zbyle
        return zav

    def zavreni(self) -> str:
        if not self.papir or not getattr(self.papir, "ma_klice", False):
            return "papír: bez klíčů účtu projektů"
        lim = self.limity()
        with self.zamek_papir:
            ps = self.cti_stav()
            n = 0
            for p in ps["otevrene"]:
                if p["zbyva_dni"] == 0 and p["vystup_cena"] == "close" and not p.get("vystup_prikaz"):
                    self._zrus_stop(p)
                    try:
                        o = self.papir.prikaz(p["t"], p["qty"], "sell", lim, tif="cls", suché=self.suche)
                        p["vystup_prikaz"] = o.get("id") or "suche"; n += 1
                    except Exception as e:
                        log(f"výstup na zavření {p['t']}: {e}")
            self.pis_stav(ps)
        return f"papír zavření: {n} výstupů na close"

    def uzavri_obchody(self, ps: dict, data: S.Data) -> None:
        """Večer: plnění výstupů → výsledky proti SPY; metriky papíru za každou strategii na server."""
        if self.papir and getattr(self.papir, "ma_klice", False):
            self._zkontroluj_vystupy(ps)
        po_reg: dict[str, list] = {}
        for u in ps.get("uzavrene") or []:
            if "a" not in u and u.get("vystup_fill"):
                ke, kx = data.ix.get(u["vstup_den"]), data.ix.get(u["vystup_den"])
                if ke is None or kx is None:
                    continue
                s_in = data.so[ke]
                s_out = data.so[kx] if (u["jak"] == "plán" and u["vystup_cena"] == "open") else data.sc[kx]
                r = (u["vystup_fill"] / u["vstup_cena"] - 1) * 100
                rs = (s_out / s_in - 1) * 100
                u.update({"r": round(r, 4), "rs": round(rs, 4), "a": round(r - rs, 4), "pl_usd": round((u["vystup_fill"] - u["vstup_cena"]) * u["qty"], 2), "d": u["vstup_den"]})
            if "a" in u:
                po_reg.setdefault(u["reg"], []).append(u)
        for reg, tr in po_reg.items():
            s = S.souhrn(tr)
            s.update({"pl_usd": round(sum(x.get("pl_usd", 0) for x in tr), 2),
                      "otevrenych": sum(1 for p in ps["otevrene"] if p["reg"] == reg)})
            try:
                self.ainet.projekty_metriky(reg, "papir", s, [{k: x.get(k) for k in ("t", "vstup_den", "vystup_den", "vstup_cena", "vystup_fill", "qty", "jak", "r", "rs", "a", "pl_usd")} for x in tr[-30:]])
            except Exception as e:
                log(f"metriky papíru {reg[:8]}: {e}")
