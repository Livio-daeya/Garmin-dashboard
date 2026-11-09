"""
garmin_fetch.py — ophalen + cachen van Garmin Connect data.

Gebruikt de gecachte OAuth-tokens uit ~/.garminconnect (gezet door
`garmin-mcp-auth` of door een eerdere handmatige login). Vraagt NOOIT om
een wachtwoord tenzij je expliciet --login meegeeft.

Onderdeel van het all-in-one sportdashboard. Zie dashboard.py.
"""

from __future__ import annotations

import json
import os
import sys
import time
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

TOKENSTORE = os.getenv("GARMINTOKENS", "~/.garminconnect")
CACHE_FILE = Path(__file__).resolve().parent / "garmin_cache.json"

# Kleine pauze tussen requests. Garmin rate-limit't (HTTP 429) als je te
# hard gaat. 0.35s is in de praktijk veilig voor ~100 dagen ophalen.
REQUEST_DELAY = 0.35


# --------------------------------------------------------------------------
# Cache
# --------------------------------------------------------------------------

def load_cache() -> dict[str, Any]:
    if CACHE_FILE.exists():
        try:
            with open(CACHE_FILE, encoding="utf-8") as fh:
                return json.load(fh)
        except (json.JSONDecodeError, OSError) as exc:
            print(f"  ! cache onleesbaar ({exc}); begin opnieuw", file=sys.stderr)
    return {"daily": {}, "activities": {}, "meta": {}}


def save_cache(cache: dict[str, Any]) -> None:
    cache.setdefault("meta", {})["last_run"] = datetime.now().isoformat(timespec="seconds")
    tmp = CACHE_FILE.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(cache, fh)
    tmp.replace(CACHE_FILE)


# --------------------------------------------------------------------------
# Verbinding
# --------------------------------------------------------------------------

def connect(allow_login: bool = False):
    """Maak een Garmin-client op basis van de gecachte tokens."""
    try:
        from garminconnect import Garmin
    except ImportError:
        sys.exit(
            "garminconnect ontbreekt. Installeer met:\n"
            "    python3 -m pip install --upgrade garminconnect"
        )

    store = Path(TOKENSTORE).expanduser()
    if store.exists():
        try:
            client = Garmin()
            client.login(str(store))
            print(f"  ✓ ingelogd via tokencache ({store})")
            return client
        except Exception as exc:  # noqa: BLE001 - we willen de echte reden tonen
            print(f"  ! tokencache werkte niet: {exc}", file=sys.stderr)
            if not allow_login:
                sys.exit(
                    "\nTokens zijn verlopen of ongeldig. Vernieuw ze met:\n"
                    "    uvx --python 3.12 --from git+https://github.com/Taxuspt/garmin_mcp garmin-mcp-auth\n"
                    "of draai dit script eenmalig met --login"
                )
    elif not allow_login:
        sys.exit(
            f"\nGeen tokencache gevonden in {store}.\n"
            "Log eerst eenmalig in met:\n"
            "    uvx --python 3.12 --from git+https://github.com/Taxuspt/garmin_mcp garmin-mcp-auth\n"
            "of draai dit script eenmalig met --login"
        )

    # Interactieve fallback (alleen met --login)
    import getpass

    email = os.getenv("GARMIN_EMAIL") or input("Garmin e-mail: ").strip()
    password = os.getenv("GARMIN_PASSWORD") or getpass.getpass("Garmin wachtwoord: ")
    client = Garmin(email, password, prompt_mfa=lambda: input("MFA-code: ").strip())
    client.login(str(store))
    print(f"  ✓ ingelogd en tokens opgeslagen in {store}")
    return client


# --------------------------------------------------------------------------
# Veilige call-wrapper
# --------------------------------------------------------------------------

class Fetcher:
    """Roept Garmin-methodes aan en houdt bij wat wel/niet lukt."""

    def __init__(self, client):
        self.client = client
        self.support: dict[str, str] = {}   # methodenaam -> ok | leeg | fout: ...
        self.calls = 0

    def call(self, method: str, *args, **kwargs):
        fn = getattr(self.client, method, None)
        if fn is None:
            self.support[method] = "bestaat niet in deze library-versie"
            return None
        try:
            self.calls += 1
            time.sleep(REQUEST_DELAY)
            result = fn(*args, **kwargs)
        except Exception as exc:  # noqa: BLE001
            msg = str(exc)
            if "429" in msg or "TooManyRequests" in type(exc).__name__:
                print("  ! Garmin rate-limit (429). Pauze van 60s...", file=sys.stderr)
                time.sleep(60)
                try:
                    result = fn(*args, **kwargs)
                except Exception as exc2:  # noqa: BLE001
                    self.support.setdefault(method, f"fout: {exc2}")
                    return None
            else:
                self.support.setdefault(method, f"fout: {msg[:120]}")
                return None
        if result in (None, {}, []):
            self.support.setdefault(method, "leeg")
        else:
            self.support[method] = "ok"
        return result


# --------------------------------------------------------------------------
# Probe: wat levert dit account eigenlijk op?
# --------------------------------------------------------------------------

PROBE_METHODS = [
    ("get_user_summary", "dagoverzicht (stappen, calorieën, intensiteitsminuten)"),
    ("get_stats", "dagstatistieken"),
    ("get_sleep_data", "slaap incl. fases"),
    ("get_hrv_data", "HRV (nachtelijk, alleen nieuwere toestellen)"),
    ("get_rhr_day", "rusthartslag"),
    ("get_heart_rates", "hartslag per meting door de dag"),
    ("get_max_metrics", "VO2max"),
    ("get_training_status", "trainingsstatus + acute/chronische belasting"),
    ("get_training_readiness", "training readiness score"),
    ("get_body_battery", "body battery"),
    ("get_stress_data", "stress"),
    ("get_race_predictions", "voorspelde wedstrijdtijden (hardlopen)"),
    ("get_endurance_score", "endurance score"),
    ("get_lactate_threshold", "lactaatdrempel"),
    ("get_activities", "activiteitenlijst"),
]


def probe(fetcher: Fetcher) -> dict[str, dict[str, str]]:
    """Test elk endpoint één keer en rapporteer wat er terugkomt."""
    yday = (date.today() - timedelta(days=1)).isoformat()
    week_ago = (date.today() - timedelta(days=7)).isoformat()
    report: dict[str, dict[str, str]] = {}

    for method, omschrijving in PROBE_METHODS:
        if method == "get_activities":
            res = fetcher.call(method, 0, 1)
        elif method == "get_body_battery":
            res = fetcher.call(method, week_ago, yday)
        elif method == "get_endurance_score":
            res = fetcher.call(method, week_ago, yday)
        elif method == "get_race_predictions":
            res = fetcher.call(method)
        elif method == "get_lactate_threshold":
            res = fetcher.call(method)
        else:
            res = fetcher.call(method, yday)

        status = fetcher.support.get(method, "onbekend")
        sample = ""
        if status == "ok":
            if isinstance(res, dict):
                sample = ", ".join(list(res.keys())[:8])
            elif isinstance(res, list) and res and isinstance(res[0], dict):
                sample = ", ".join(list(res[0].keys())[:8])
        report[method] = {
            "omschrijving": omschrijving,
            "status": status,
            "velden": sample,
        }
    return report


# --------------------------------------------------------------------------
# Ophalen
# --------------------------------------------------------------------------

DAILY_ENDPOINTS = {
    # sleutel in cache -> (methode, hoe aanroepen)
    "sleep": "get_sleep_data",
    "hrv": "get_hrv_data",
    "rhr": "get_rhr_day",
    "vo2max": "get_max_metrics",
    "training_status": "get_training_status",
    "readiness": "get_training_readiness",
    "summary": "get_user_summary",
}


def lap_start(act: dict[str, Any], lap: dict[str, Any]) -> int | None:
    """Begin van een ronde in seconden na de start van de activiteit."""
    try:
        a = datetime.fromisoformat(str(act.get("startTimeGMT")).replace(" ", "T").replace("Z", ""))
        b = datetime.fromisoformat(str(lap.get("startTimeGMT")).replace(" ", "T").replace("Z", "").split(".")[0])
        return max(0, round((b - a).total_seconds()))
    except (TypeError, ValueError):
        return None


def hartslagreeks(details: dict[str, Any], max_punten: int = 6000) -> dict[str, Any] | None:
    """De hartslag per meetpunt met de verstreken tijd in seconden, voor de
    grafiek. Ontbrekende meetpunten blijven null, zodat een meetgat in de
    grafiek een onderbreking is. Alleen bij heel lange registraties wordt
    voor de weergave elk n-de punt genomen; de berekeningen gebruiken de
    samenvatting, niet deze reeks."""
    ix = {m.get("key"): m.get("metricsIndex") for m in details.get("metricDescriptors") or []}
    rows = [r.get("metrics") for r in details.get("activityDetailMetrics") or []]
    if "directHeartRate" not in ix or "sumElapsedDuration" not in ix or not rows:
        return None
    t = [r[ix["sumElapsedDuration"]] if r else None for r in rows]
    h = [r[ix["directHeartRate"]] if r else None for r in rows]
    stap = max(1, -(-len(rows) // max_punten))
    paren = [(round(t[i]), round(h[i]) if h[i] is not None else None) for i in range(0, len(rows), stap) if t[i] is not None]
    return {"t": [p[0] for p in paren], "hr": [p[1] for p in paren], "stap": stap}


def samenvatting_reeks(details: dict[str, Any], floors: dict[int, int]) -> dict[str, Any] | None:
    """Blokken, pieken en versnellingen uit de reeks per seconde.

    Blok: aaneengesloten boven een zonegrens; dips tot 15 s (zone 3, minimaal
    2 min) of 10 s (zone 4, minimaal 1 min) breken een blok niet.
    Piek: je hartslag schiet zone 4 in en blijft er minstens 5 s.
    Versnelling: geschatte snelheid van minstens 3 m/s (11 km/u), 2 s of
    langer. Binnen schat het horloge snelheid uit de pols; dat is een
    indicatie, geen sprintmeting.
    """
    ix = {m.get("key"): m.get("metricsIndex") for m in details.get("metricDescriptors") or []}
    rows = [r.get("metrics") for r in details.get("activityDetailMetrics") or []]
    if "directHeartRate" not in ix or not rows:
        return None

    def kolom(k: str) -> list:
        return [r[ix[k]] if r and ix[k] < len(r) else None for r in rows] if k in ix else [None] * len(rows)

    def stukken(vlag: list[bool], min_len: int, max_gat: int) -> list[tuple[int, int]]:
        uit, start, gat = [], None, 0
        for i, f in enumerate(vlag + [False] * (max_gat + 1)):
            if f:
                start = i if start is None else start
                gat = 0
            elif start is not None:
                gat += 1
                if gat > max_gat:
                    eind = i - gat
                    if eind - start + 1 >= min_len:
                        uit.append((start, eind))
                    start, gat = None, 0
        return uit

    hr, sp = kolom("directHeartRate"), kolom("directSpeed")
    tijd = kolom("sumElapsedDuration")
    res: dict[str, Any] = {"n": len(rows)}
    z3, z4 = floors.get(3), floors.get(4)
    sec = lambda i: round(tijd[i]) if i < len(tijd) and tijd[i] is not None else i
    if z3:
        bl3 = stukken([h is not None and h >= z3 for h in hr], 120, 15)
        res["blokken_z3"] = [round((e - b + 1) / 60, 1) for b, e in bl3]
        res["blokken_z3_pos"] = [[sec(b), sec(e)] for b, e in bl3]
    if z4:
        boven4 = [h is not None and h >= z4 for h in hr]
        res["blokken_z4"] = [round((e - b + 1) / 60, 1) for b, e in stukken(boven4, 60, 10)]
        res["pieken_z4"] = len(stukken(boven4, 5, 20))
    snel = [v for v in sp if v is not None]
    if snel and max(snel) > 0.5:
        res["versnellingen"] = len(stukken([v is not None and v >= 3.0 for v in sp], 2, 1))
        res["snelheid_max"] = round(max(snel), 2)
    return res


def fetch_all(fetcher: Fetcher, weeks: int, cache: dict[str, Any],
              force: bool = False, activity_weeks: int | None = None, snel: bool = False) -> dict[str, Any]:
    """Haal activiteiten + dagelijkse metrics op. Gebruikt de cache waar mogelijk.

    activity_weeks mag groter zijn dan weeks: het dashboard heeft extra
    aanlooptijd nodig om CTL/ATL te laten inregelen.

    snel: alleen vandaag en gisteren, en activiteiten van de laatste drie
    dagen. Geen zone-instelling en geen steekproef op lege endpoints; dat doet
    de volledige ronde 's ochtends. Wat al in de cache staat, blijft staan.
    """
    today = date.today()
    start = today - timedelta(days=1) if snel else today - timedelta(weeks=weeks)
    act_start = today - timedelta(days=3) if snel else today - timedelta(weeks=activity_weeks or weeks)

    # ---- activiteiten -----------------------------------------------------
    print(f"  → activiteiten {act_start} t/m {today}")
    acts = fetcher.call("get_activities_by_date", act_start.isoformat(), today.isoformat()) or []
    for a in acts:
        aid = str(a.get("activityId"))
        if aid and aid != "None":
            cache["activities"][aid] = a
    print(f"    {len(acts)} activiteiten")

    # ---- hartslagzones per activiteit --------------------------------------
    # De grenzen van je zones (zoals ingesteld in Garmin) en de tijd per zone.
    # Eén call per nieuwe activiteit; daarna staan ze in de cache. Zonder
    # hartslag levert Garmin niets, en dan blijven de zones onbekend.
    zones = cache.setdefault("zones", {})
    nieuw = [aid for aid, a in cache["activities"].items()
             if aid not in zones and a.get("averageHR")]
    if nieuw:
        print(f"  → hartslagzones: {len(nieuw)} activiteiten")
    # De zone-instelling zelf: methode, gebruikte maximale hartslag, per sport.
    inst = None if snel else fetcher.call("connectapi", "/biometric-service/heartRateZones")
    if isinstance(inst, list) and inst:
        cache.setdefault("meta", {})["hr_instelling"] = inst
    for aid in nieuw[:200]:
        z = fetcher.call("get_activity_hr_in_timezones", int(aid))
        if isinstance(z, list) and z:
            zones[aid] = [{"zone": x.get("zoneNumber"), "sec": round(x.get("secsInZone") or 0),
                           "vanaf": x.get("zoneLowBoundary")} for x in z if isinstance(x, dict)]

    # ---- verloop per seconde: blokken, pieken, versnellingen ---------------
    # Uit de hartslag- en snelheidsreeks van een training: hoe lang je
    # aaneengesloten boven zone 3 en zone 4 zat, hoe vaak je hartslag zone 4
    # inschoot, en (als het horloge snelheid schatte) hoe vaak je versnelde.
    # Alleen de samenvatting gaat de cache in, niet de hele reeks.
    detail = cache.setdefault("hrdetail", {})
    grens = today - timedelta(weeks=weeks)
    kand = [aid for aid, a in cache["activities"].items()
            if aid not in detail and aid in zones and a.get("averageHR")
            and (a.get("duration") or 0) >= 30 * 60
            and str(a.get("startTimeLocal", ""))[:10] >= grens.isoformat()]
    if kand:
        print(f"  → verloop per seconde: {len(kand)} activiteiten")
    for aid in sorted(kand, reverse=True)[:60]:
        floors = {z["zone"]: z["vanaf"] for z in zones.get(aid, []) if z.get("vanaf")}
        d = fetcher.call("get_activity_details", int(aid), 10000)
        som = samenvatting_reeks(d, floors) if isinstance(d, dict) else None
        if som:
            detail[aid] = som

    # De laatste 28 dagen ook de hartslagreeks (voor de grafiek in de
    # workoutsamenvatting) en de rondes. Oudere activiteiten hebben alleen
    # de samenvatting; zo blijft de pagina klein.
    reeksen = cache.setdefault("hrreeks", {})
    rondes = cache.setdefault("rondes", {})
    recent = (today - timedelta(days=28)).isoformat()
    for aid in list(reeksen):
        if str((cache["activities"].get(aid) or {}).get("startTimeLocal", ""))[:10] < recent:
            reeksen.pop(aid, None); rondes.pop(aid, None)
    nieuw_r = [aid for aid, a in cache["activities"].items()
               if aid not in reeksen and a.get("averageHR") and str(a.get("startTimeLocal", ""))[:10] >= recent]
    if nieuw_r:
        print(f"  → hartslagreeks en rondes: {len(nieuw_r)} activiteiten")
    for aid in sorted(nieuw_r, reverse=True)[:30]:
        floors = {z["zone"]: z["vanaf"] for z in zones.get(aid, []) if z.get("vanaf")}
        d = fetcher.call("get_activity_details", int(aid), 10000)
        if not isinstance(d, dict):
            continue
        r = hartslagreeks(d)
        if r:
            reeksen[aid] = r
        som = samenvatting_reeks(d, floors)
        if som:
            detail[aid] = som
        sp = fetcher.call("get_activity_splits", int(aid))
        laps = (sp or {}).get("lapDTOs") if isinstance(sp, dict) else None
        if laps:
            rondes[aid] = [{"start": lap_start(cache["activities"][aid], l), "duur": round(l.get("duration") or 0),
                            "afstand": round(l.get("distance") or 0), "hr": l.get("averageHR"), "max": l.get("maxHR"),
                            "intensiteit": l.get("intensityType")} for l in laps]

    # ---- dode endpoints opsporen -----------------------------------------
    # Een endpoint dat gisteren leeg was, hoeft niet dood te zijn: VO2max
    # verschijnt bijvoorbeeld alleen op dagen met een kwalificerende training.
    # Daarom drie extra steekproefdagen voordat we hem 100+ keer voor niets
    # aanroepen.
    # Een endpoint dat ooit data gaf, wordt nooit overgeslagen. Slaap komt bij
    # een borstband met tussenpozen binnen; zou hij op vier steekproefdagen
    # toevallig leeg zijn, dan zouden we de nachten die er wél zijn missen.
    def ooit_data(sleutel: str) -> bool:
        return any((dag.get(sleutel) not in (None, {}, []))
                   for dag in (cache.get("daily") or {}).values())

    bewezen = {m for k, m in DAILY_ENDPOINTS.items() if ooit_data(k)}
    skip: set[str] = set()
    suspect = [m for m in DAILY_ENDPOINTS.values()
               if fetcher.support.get(m) == "leeg" and m not in bewezen]
    if bewezen:
        print(f"  → altijd ophalen (gaven eerder data): {', '.join(sorted(bewezen))}")
    if snel:
        suspect = []          # de steekproef hoort bij de volledige ronde
    if suspect:
        print("  → steekproef op endpoints die gisteren leeg waren")
        for method in suspect:
            for offset in (3, 10, 24):
                sample = (today - timedelta(days=offset)).isoformat()
                fetcher.support.pop(method, None)
                if fetcher.call(method, sample) not in (None, {}, []):
                    print(f"    ✓ {method}: wel data op {sample}")
                    break
            else:
                skip.add(method)
                print(f"    – {method}: op geen enkele steekproefdag data, wordt overgeslagen")

    # ---- dagelijkse metrics ----------------------------------------------
    days = [(start + timedelta(days=i)).isoformat()
            for i in range((today - start).days + 1)]
    # De laatste dagen altijd opnieuw ophalen. Garmin vult een dag soms pas
    # later aan (horloge dat laat synchroniseert, slaap die 's ochtends
    # binnenkomt). Vier dagen kost 16 extra calls en voorkomt dat een dag
    # half gevuld in de cache blijft staan.
    volatile = {(today - timedelta(days=n)).isoformat() for n in range(4)}

    todo = [d for d in days if force or d in volatile or d not in cache["daily"]]
    print(f"  → dagmetrics: {len(todo)} van {len(days)} dagen op te halen "
          f"({len(days) - len(todo)} uit cache)")

    for n, d in enumerate(todo, 1):
        entry: dict[str, Any] = cache["daily"].get(d, {})
        for key, method in DAILY_ENDPOINTS.items():
            # Sla endpoints over die structureel falen of leeg blijven.
            if method in skip or fetcher.support.get(method, "").startswith(("fout", "bestaat")):
                continue
            entry[key] = fetcher.call(method, d)
        cache["daily"][d] = entry
        if n % 10 == 0 or n == len(todo):
            print(f"    {n}/{len(todo)} dagen")
            save_cache(cache)

    # ---- losse extra's ----------------------------------------------------
    extras: dict[str, Any] = {}
    extras["race_predictions"] = fetcher.call("get_race_predictions")
    extras["endurance"] = fetcher.call(
        "get_endurance_score", (today - timedelta(days=28)).isoformat(), today.isoformat()
    )
    extras["body_battery"] = fetcher.call(
        "get_body_battery", (today - timedelta(days=28)).isoformat(), today.isoformat()
    )
    # Hartslag per meting door de dag. Alleen voor de laatste twee dagen: het
    # zijn honderden punten per dag, en het dashboard laat er maar één zien.
    # Gisteren zit erbij omdat vroeg in de ochtend nog nauwelijks metingen van
    # vandaag binnen zijn.
    extras["hr_dag"] = {
        d.isoformat(): fetcher.call("get_heart_rates", d.isoformat())
        for d in (today, today - timedelta(days=1))
    }
    cache["extras"] = extras
    cache["meta"]["support"] = fetcher.support
    save_cache(cache)
    return cache
