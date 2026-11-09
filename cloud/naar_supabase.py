"""Garmin-gegevens naar Supabase, zodat de coach ze kan lezen.

Draait in GitHub Actions na het bouwen van de pagina. Gebruikt de secret
key (SUPABASE_SECRET_KEY): alleen deze stap mag Garmin-tabellen schrijven;
in de pagina en de coach zit hij nooit.

    SUPABASE_URL          https://<project>.supabase.co   (repository variable)
    SUPABASE_SECRET_KEY   sb_secret_...                    (repository secret)

Ontbreekt een van beide, dan slaat de stap zichzelf over; de pagina wordt
gewoon gebouwd zoals altijd.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any

# Wat de coach per dag ziet: alles behalve grote reeksen.
DAG_WEG = {"sleep_delen"}
# Per activiteit: de hartslagreeks is groot; we bewaren een ingedikte versie
# (één punt per 30 seconden) naast de zones, ronden en blokken.
ACT_WEG: set[str] = set()
OVERZICHT = ["generated", "max_hr", "rest_hr", "hr_instelling", "zones", "weekly", "fitness", "acwr",
             "belastingbasis", "plan", "planbasis", "hard", "gereedheid", "vandaag", "insights",
             "predictions", "coverage", "sleep_last", "basislijnen", "runs"]
BLOK = 200


def _dun(reeks: Any, stap: int = 30) -> Any:
    """Hartslagreeks {"t": [...], "hr": [...], ...} terugbrengen tot één punt per stap seconden."""
    if not isinstance(reeks, dict) or not isinstance(reeks.get("t"), list):
        return reeks
    tijden, houden, volgende = reeks["t"], [], None
    for i, sec in enumerate(tijden):
        if sec is None:
            continue
        if volgende is None or sec >= volgende:
            houden.append(i)
            volgende = sec + stap
    uit = {k: ([v[i] for i in houden] if isinstance(v, list) and len(v) == len(tijden) else v)
           for k, v in reeks.items()}
    if "stap" in uit:
        uit["stap"] = stap
    return uit


def dagen(payload: dict) -> list[dict]:
    per: dict[str, dict] = {}
    for bron in (payload.get("historie") or [], payload.get("daily") or []):
        for d in bron:
            if not d.get("date"):
                continue
            per.setdefault(d["date"], {}).update({k: v for k, v in d.items() if k not in DAG_WEG})
    return [{"datum": k, "data": v} for k, v in sorted(per.items())]


def activiteiten(payload: dict) -> list[dict]:
    per: dict[int, dict] = {}
    for bron in (payload.get("historie_acts") or [], payload.get("activities") or []):
        for a in bron:
            if a.get("id") is None or not a.get("date"):
                continue
            data = {k: v for k, v in a.items() if k not in ACT_WEG}
            if "hr_reeks" in data:
                data["hr_reeks"] = _dun(data["hr_reeks"])
            per.setdefault(int(a["id"]), {}).update(data)
    return [{"id": i, "datum": d["date"], "data": d} for i, d in sorted(per.items())]


def overzicht(payload: dict) -> list[dict]:
    return [{"sleutel": k, "data": payload[k]} for k in OVERZICHT if k in payload]


def _post(url: str, sleutel: str, tabel: str, rijen: list[dict]) -> None:
    for i in range(0, len(rijen), BLOK):
        deel = json.dumps(rijen[i:i + BLOK], default=str).encode("utf-8")
        req = urllib.request.Request(
            f"{url}/rest/v1/{tabel}", data=deel, method="POST",
            headers={"apikey": sleutel, "Authorization": f"Bearer {sleutel}",
                     "Content-Type": "application/json",
                     "Prefer": "resolution=merge-duplicates,return=minimal"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                r.read()
        except urllib.error.HTTPError as e:
            raise SystemExit(f"Supabase weigerde {tabel}: HTTP {e.code} {e.read()[:300]!r}") from None


# Wat nooit mee mag in het pakket: de synchronisatietoken en de koppeling
# zelf. Die staan al in de pagina en horen niet in een databaserij.
PAKKET_WEG = {"sync", "supabase", "demo"}


def pakket(payload: dict) -> tuple[list[dict], list[dict]]:
    """De hele berekende stand, zodat het dashboard nieuwe cijfers kan
    overnemen zonder een nieuwe pagina. Eerst het pakket, dan de stand: een
    apparaat dat de stand ziet, vindt het pakket dus altijd al klaar."""
    data = {k: v for k, v in payload.items() if k not in PAKKET_WEG}
    stand = {"pakket": payload.get("_pakket"), "generated": payload.get("generated")}
    return [{"sleutel": "pakket", "data": data}], [{"sleutel": "pakket_stand", "data": stand}]


def schrijf(payload: dict, url: str | None = None, sleutel: str | None = None, alleen_recent: bool = False) -> bool:
    url = (url or os.environ.get("SUPABASE_URL") or "").rstrip("/")
    sleutel = sleutel or os.environ.get("SUPABASE_SECRET_KEY") or ""
    if not url or not sleutel:
        print("  Supabase: niet ingesteld, overgeslagen.")
        return False
    d, a, o = dagen(payload), activiteiten(payload), overzicht(payload)
    if alleen_recent:
        # snelle ronde: alleen wat kan zijn veranderd
        from datetime import date, timedelta
        grens = (date.today() - timedelta(days=4)).isoformat()
        d = [x for x in d if x["datum"] >= grens]
        a = [x for x in a if x["datum"] >= grens]
    _post(url, sleutel, "garmin_dag", d)
    _post(url, sleutel, "garmin_activiteit", a)
    _post(url, sleutel, "garmin_overzicht", o)
    rij, stand = pakket(payload)
    _post(url, sleutel, "garmin_overzicht", rij)
    _post(url, sleutel, "garmin_overzicht", stand)
    kb = len(json.dumps(rij[0]["data"], default=str)) / 1024
    print(f"  Supabase: {len(d)} dagen, {len(a)} activiteiten, {len(o)} overzichten, pakket {kb:.0f} kB bijgewerkt.")
    return True
