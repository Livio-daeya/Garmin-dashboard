#!/usr/bin/env python3
"""
dashboard.py — all-in-one sportdashboard uit Garmin Connect.

Handbal + kracht + hardlopen in één pagina: belasting, herstel, tempo-analyse.

Gebruik
-------
    python3 dashboard.py            # data ophalen (cache) en index.html bouwen
    python3 dashboard.py --probe    # kijk eerst welke metrics jouw account teruggeeft
    python3 dashboard.py --weeks 16 # langere historie
    python3 dashboard.py --refresh  # negeer de cache, haal alles opnieuw op
    python3 dashboard.py --login    # eenmalig interactief inloggen (met MFA)
    python3 dashboard.py --demo     # bouw de pagina met verzonnen data (om te testen)

Werkt standalone. Claude hoeft niet open te staan.
"""

from __future__ import annotations

import argparse
import json
import os
import math
import random
import sys
import webbrowser
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

import garmin_analyse as A  # noqa: E402
import garmin_fetch as F  # noqa: E402

HERE = Path(__file__).resolve().parent
OUTPUT = HERE / "index.html"
TEMPLATE = HERE / "template.html"

# --------------------------------------------------------------------------
# Persoonlijke instellingen — pas deze aan
# --------------------------------------------------------------------------
MAX_HR = 187          # hoogste gemeten hartslag (shuttlerun-test, 17-8-2026)
REST_HR_FALLBACK = 50  # alleen gebruikt als Garmin geen rusthartslag levert
WEEKS_DEFAULT = 12
RAMP_WEEKS = 8      # extra aanlooptijd voor CTL/ATL (niet getoond)

# Waar de versleutelde kopie voor GitHub heen gaat. Dit is de map die
# GitHub Desktop heeft aangemaakt. Verplaats je de repository, pas dit aan.
PUBLISH_TARGET = "~/Documents/GitHub/Garmin dashboard"

# Je vaste weekritme. 0 = maandag ... 6 = zondag.
# "load" leeg laten = het dashboard schat hem uit je eigen historie (mediaan
# van eerdere sessies van die sport). Wil je een dag zwaarder of lichter
# inschatten, vul dan zelf een getal in.
# "doel": True markeert de dag waar je fris voor wilt zijn.
WEEKPLAN = {
    0: {"sport": "Handbal", "label": "Handbaltraining", "min_minuten": 75},
    1: {"sport": "Handbal", "label": "Handbaltraining", "min_minuten": 75},
    3: {"sport": "Handbal", "label": "Handbaltraining", "min_minuten": 75},
    4: {"sport": "Handbal", "label": "Handbaltraining", "min_minuten": 75},
    5: {"sport": "Handbal", "label": "Wedstrijd", "doel": True},
}
PLAN_HORIZON = 14   # dagen vooruit kijken


# ==========================================================================
# Databundel bouwen
# ==========================================================================

# ==========================================================================
# Synchronisatie tussen apparaten
# ==========================================================================

SYNCFILE = HERE / "sync.json"


def sync_config() -> dict[str, str]:
    """Gist-id en token voor de synchronisatie, als je die hebt ingesteld.

    Deze twee gaan mee in de databundel, want de pagina op je telefoon moet
    ze ook hebben. In de gepubliceerde kopie zit die bundel binnen de
    versleuteling: wie het bestand downloadt heeft er niets aan zonder je
    wachtwoordzin. Geef het token alleen het recht "gists", dan kan het bij
    niets anders van je account.

    sync.json staat in .gitignore en hoort nergens anders heen.
    """
    if not SYNCFILE.exists():
        return {}
    try:
        cfg = json.loads(SYNCFILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}
    gist, token = cfg.get("gist"), cfg.get("token")
    if not (gist and token):
        return {}
    uit = {"gist": gist, "token": token}
    # Staat het ophalen bij GitHub, dan mag de verversknop op je telefoon de
    # bouw daar starten. Daarvoor moet de pagina weten welke repository dat is.
    if cfg.get("repo"):
        uit["repo"] = cfg["repo"]
    return uit


def build_payload(cache: dict[str, Any], weeks: int) -> dict[str, Any]:
    today = date.today()
    start = today - timedelta(weeks=weeks)
    days = [(start + timedelta(days=i)).isoformat() for i in range((today - start).days + 1)]

    # CTL/ATL zijn voortschrijdende gemiddelden en beginnen op nul. Zou je ze
    # precies op de eerste dag van de grafiek laten starten, dan zie je weken
    # lang een kunstmatig diep negatieve TSB. Daarom rekenen we RAMP_WEEKS
    # weken eerder in en tonen we alleen het laatste stuk.
    calc_start = start - timedelta(weeks=RAMP_WEEKS)
    calc_days = [(calc_start + timedelta(days=i)).isoformat()
                 for i in range((today - calc_start).days + 1)]

    daily = A.extract_daily(cache, days)

    rhr_vals = [daily[d].get("rhr") for d in days if daily[d].get("rhr")]
    rest_hr = (sum(rhr_vals) / len(rhr_vals)) if rhr_vals else REST_HR_FALLBACK

    acts_all = A.prepare_activities(cache, rest_hr, MAX_HR, calc_start, today)
    for a in acts_all:
        a["grade"] = A.effort_grade(a, MAX_HR)
    acts = [a for a in acts_all if a["date"] >= start.isoformat()]

    daily_load: dict[str, float] = {}
    for a in acts_all:
        daily_load[a["date"]] = daily_load.get(a["date"], 0.0) + a["load"]

    fitness_full = A.ewma_series(daily_load, calc_days)
    acwr_full = A.acwr(daily_load, calc_days)
    cut = len(calc_days) - len(days)
    fitness = fitness_full[cut:]
    acwr_series = acwr_full[cut:]
    advice = A.build_advice(fitness, acwr_series, daily, days, acts, MAX_HR)

    # ---- weekaggregaties ----
    weeks_km = A.weekly_by_sport([a for a in acts if a["sport"] == "Hardlopen"], "distance_m")
    weeks_load = A.weekly_by_sport(acts, "load")
    weeks_time = A.weekly_by_sport(acts, "duration_s")
    week_labels = sorted(set(A.week_key(d) for d in days))

    # minuten per hartslagzone, per kalenderweek
    weeks_zones: dict[str, list[float]] = {}
    for a in acts:
        wk = A.week_key(a["date"])
        bak = weeks_zones.setdefault(wk, [0.0] * 6)
        for z in range(1, 6):
            bak[z] += (a.get(f"z{z}_s") or 0) / 60.0

    weekly = []
    for w in week_labels:
        zb = weeks_zones.get(w, [0.0] * 6)
        weekly.append({
            "week": w,
            "km": round(sum(weeks_km.get(w, {}).values()) / 1000, 1),
            "load": {s: round(weeks_load.get(w, {}).get(s, 0), 1) for s in A.SPORT_ORDER},
            "hours": {s: round(weeks_time.get(w, {}).get(s, 0) / 3600, 2) for s in A.SPORT_ORDER},
            "zones": {f"z{z}": round(zb[z], 1) for z in range(1, 6)},
        })

    # trendlijn over weekkilometers
    km_vals = [w["km"] for w in weekly]
    trend = A.linear_trend(list(range(len(km_vals))), km_vals)
    if trend:
        slope, intercept = trend
        for i, w in enumerate(weekly):
            w["km_trend"] = round(max(0.0, slope * i + intercept), 1)

    # ---- deze week ----
    monday = today - timedelta(days=today.weekday())
    week_days = []
    for i in range(7):
        d = (monday + timedelta(days=i)).isoformat()
        day_acts = [a for a in acts if a["date"] == d]
        week_days.append({
            "date": d,
            "weekday": ["ma", "di", "wo", "do", "vr", "za", "zo"][i],
            "future": d > today.isoformat(),
            "activities": [{"sport": a["sport"], "name": a["name"], "grade": a["grade"],
                            "minutes": round((a["duration_s"] or 0) / 60),
                            "km": round((a["distance_m"] or 0) / 1000, 1)} for a in day_acts],
            "load": round(sum(a["load"] for a in day_acts), 1),
            "sleep_h": daily.get(d, {}).get("sleep_h"),
            "hrv": daily.get(d, {}).get("hrv"),
        })

    # ---- hardloopanalyse ----
    runs = [a for a in acts if a["sport"] == "Hardlopen" and a["pace_s_per_km"]]
    grade_counts: dict[str, float] = {"Rustig": 0.0, "Gemiddeld": 0.0, "Zwaar": 0.0, "Onbekend": 0.0}
    for a in acts:
        if a["date"] >= (today - timedelta(days=28)).isoformat():
            grade_counts[a["grade"]] += (a["duration_s"] or 0) / 3600

    # ---- werkelijke tijd per hartslagzone (laatste 28 dagen) ----
    cut28 = (today - timedelta(days=28)).isoformat()
    zones28 = A.zone_minutes(acts, since=cut28)

    # ---- laatste bekende waardes voor de tegels ----
    def last_of(field: str):
        for d in reversed(days):
            v = daily.get(d, {}).get(field)
            if v is not None:
                return v
        return None

    def series_of(field):
        return [daily[d].get(field) for d in days]

    def fill(field):
        return sum(1 for d in days if daily[d].get(field) is not None)

    # Tegels worden pas samengesteld als bekend is wat er daadwerkelijk in de
    # data zit. Een tegel met een streepje erin is verspilde ruimte; die wordt
    # vervangen door iets waar wél cijfers voor zijn.
    last7 = days[-7:]
    acts7 = [a for a in acts if a["date"] in last7]
    hours7 = sum((a["duration_s"] or 0) for a in acts7) / 3600
    easy_hr = [a["avg_hr"] for a in acts if a["grade"] == "Rustig" and a["avg_hr"]]

    def fmt(v, d=0):
        return "–" if v is None else f"{v:.{d}f}"

    def schaal(waarde, laag, hoog, band=None, bijschrift=""):
        """Positie van een getal op een betekenisvolle schaal.

        band = (van, tot): het gebied waar je wilt zitten. Zonder band toont
        de balk alleen waar je staat binnen je eigen bereik.
        """
        if waarde is None:
            return None
        span = (hoog - laag) or 1
        pos = max(0.0, min(1.0, (waarde - laag) / span))
        out = {"pos": round(pos * 100, 1), "laag": round(laag), "hoog": round(hoog),
               "bijschrift": bijschrift}
        if band:
            out["band"] = [round(max(0.0, min(1.0, (band[0] - laag) / span)) * 100, 1),
                           round(max(0.0, min(1.0, (band[1] - laag) / span)) * 100, 1)]
        return out

    # ---- vooruitkijken -------------------------------------------------
    plan = A.maak_plan(today, PLAN_HORIZON, WEEKPLAN, acts_all)
    projectie = A.projecteer(daily_load, calc_days, plan)
    doel = next((p for p in projectie if p.get("doel")), None)
    opties = A.scenarios(daily_load, calc_days, plan, doel["date"]) if doel else []
    plan_tip = A.plan_advies(projectie, opties, doel)

    # ---- gereedheid, basislijnen, harde minuten -------------------------
    hard_dag = A.harde_minuten_per_dag(acts_all, calc_days)
    hard_reeks_full = A.harde_minuten_verhouding(hard_dag, calc_days)
    hard_reeks = hard_reeks_full[len(calc_days) - len(days):]
    hard7 = sum(hard_dag.get(d, 0) for d in days[-7:])
    hard28 = sum(hard_dag.get(d, 0) for d in days[-28:]) / 4 if len(days) >= 28 else None
    hard_ratio = (hard7 / hard28) if hard28 else None

    basis_hrv = A.basislijn(series_of("hrv"), last_of("hrv"), "HRV", "ms", omlaag_is_slecht=True)
    basis_slaap = A.basislijn(series_of("sleep_h"), last_of("sleep_h"), "Slaap", "uur",
                              omlaag_is_slecht=True)
    basis_rhr = A.basislijn(series_of("rhr"), last_of("rhr"), "Rusthartslag", "bpm",
                            omlaag_is_slecht=False)
    basislijnen = [b for b in (basis_hrv, basis_slaap, basis_rhr) if b]
    uitschieters = [b for b in basislijnen if b.get("genoeg") and b.get("uitschieter")]

    regelmaat = A.slaapregelmaat([daily[d].get("sleep_start") for d in days],
                                 [daily[d].get("sleep_end") for d in days])

    ready = A.gereedheid(last_of("hrv"), basis_hrv, last_of("sleep_h"),
                         last_of("sleep_score"), fitness[-1]["tsb"] if fitness else None)

    # ---- status en richting per tegel -----------------------------------
    # Elke drempel hieronder is een vuistregel, geen natuurwet. Ze staan
    # bewust op één plek zodat je ze kunt bijstellen als je merkt dat ze
    # niet bij jouw sport passen.

    def trend_of(series, back=28):
        """Vergelijk nu met ~4 weken geleden. Geeft (richting, tekst)."""
        vals = [v for v in series if v is not None]
        if len(vals) < back + 1:
            return None, None
        now, then = vals[-1], vals[-1 - back]
        if then in (None, 0):
            return None, None
        pct = (now - then) / abs(then) * 100
        if abs(pct) < 5:
            return "flat", "gelijk aan 4 weken terug"
        return ("up" if pct > 0 else "down"), f"{pct:+.0f}% t.o.v. 4 weken terug"

    def mean(xs):
        xs = [x for x in xs if x is not None]
        return sum(xs) / len(xs) if xs else None

    ctl_reeks = [x["ctl"] for x in fitness]
    ctl_laag, ctl_max = (min(ctl_reeks), max(ctl_reeks)) if ctl_reeks else (0, 1)
    ctl_hoog = max(ctl_max * 1.15, 1)
    load7 = sum(daily_load.get(d, 0) for d in last7)
    load28 = sum(daily_load.get(d, 0) for d in days[-28:]) / 4 if len(days) >= 28 else None
    ratio7 = (load7 / load28) if load28 else None

    ctl = fitness[-1]["ctl"] if fitness else None
    atl = fitness[-1]["atl"] if fitness else None
    tsb = fitness[-1]["tsb"] if fitness else None

    # Vorm — standaardinterpretatie van het impuls-responsmodel
    if tsb is None:
        tsb_st, tsb_tx, tsb_wat = "neutral", "onbekend", ""
    elif tsb < -25:
        tsb_st, tsb_tx = "serious", "zwaar belast"
        tsb_wat = "Je vermoeidheid ligt ver boven je fitheid. Twee rustige dagen inlassen."
    elif tsb < -10:
        tsb_st, tsb_tx = "warning", "belast"
        tsb_wat = "Normaal tijdens een opbouwblok, maar niet weken achtereen."
    elif tsb <= 15:
        tsb_st, tsb_tx = "good", "in balans"
        tsb_wat = "Je bouwt op zonder je vermoeidheid te laten oplopen."
    else:
        tsb_st, tsb_tx = "good", "fris"
        tsb_wat = "Goed moment voor een zware sessie of wedstrijd. Blijft dit lang zo hoog, dan zakt je fitheid."

    # Fitheid — richting telt, niet de absolute waarde
    ctl_dir, ctl_trend = trend_of([x["ctl"] for x in fitness])
    if ctl_dir == "up":
        ctl_st, ctl_tx, ctl_wat = "good", "stijgend", "Je bouwt conditie op."
    elif ctl_dir == "down":
        ctl_st, ctl_tx, ctl_wat = "warning", "dalend", "Je traint minder dan je gewend was; conditie loopt terug."
    else:
        ctl_st, ctl_tx, ctl_wat = "neutral", "stabiel", "Je houdt je niveau vast."

    # Vermoeidheid — alleen betekenisvol t.o.v. je fitheid
    fr = (atl / ctl) if (ctl and atl) else None
    if fr is None:
        atl_st, atl_tx, atl_wat = "neutral", "onbekend", ""
    elif fr > 1.5:
        atl_st, atl_tx = "warning", "hoog"
        atl_wat = f"Je vermoeidheid is {fr:.1f}x je fitheid. Kortdurend prima, langer niet."
    elif fr < 0.8:
        atl_st, atl_tx = "neutral", "laag"
        atl_wat = "Je hebt het rustig gehad de afgelopen week."
    else:
        atl_st, atl_tx, atl_wat = "good", "normaal", "Vermoeidheid past bij je fitheid."

    # Belasting 7 dagen — dit is in feite je ACWR
    if ratio7 is None:
        l_st, l_tx, l_wat = "neutral", "", ""
    elif ratio7 > 1.5:
        l_st, l_tx = "serious", "sterke sprong"
        l_wat = f"Deze week is {ratio7:.1f}x je maandgemiddelde. Grote sprongen hangen samen met blessurerisico."
    elif ratio7 >= 1.3:
        l_st, l_tx = "warning", "flinke toename"
        l_wat = f"{ratio7:.1f}x je maandgemiddelde. Nog acceptabel, maar niet verder opvoeren."
    elif ratio7 >= 0.8:
        l_st, l_tx, l_wat = "good", "stabiel", "Je belasting past bij wat je gewend bent."
    else:
        l_st, l_tx = "warning", "zakt weg"
        l_wat = f"{ratio7:.1f}x je maandgemiddelde. Prima als het bewust is, anders verlies je conditie."

    # Uren — zelfde logica, maar in tijd
    hours28 = sum((a["duration_s"] or 0) for a in acts
                  if a["date"] >= days[-28]) / 3600 / 4 if len(days) >= 28 else None
    hr_ratio = (hours7 / hours28) if hours28 else None
    if hr_ratio is None:
        u_st, u_tx, u_wat = "neutral", "", ""
    elif hr_ratio >= 1.3:
        u_st, u_tx, u_wat = "warning", "meer dan normaal", f"{hr_ratio:.1f}x je gemiddelde weekuren."
    elif hr_ratio >= 0.8:
        u_st, u_tx, u_wat = "good", "normale week", "Vergelijkbaar met je gemiddelde weekuren."
    else:
        u_st, u_tx, u_wat = "neutral", "rustige week", f"{hr_ratio:.1f}x je gemiddelde weekuren."

    # Rusthartslag — eerst kijken of de meting überhaupt betrouwbaar is.
    # Een borstband die alleen tijdens het sporten om gaat, levert geen echte
    # rusthartslag maar "laagste hartslag die die dag toevallig gezien is".
    # Dat schommelt enorm en verdient geen groen vinkje.
    def median(xs):
        xs = sorted(x for x in xs if x is not None)
        if not xs:
            return None
        n = len(xs)
        return xs[n // 2] if n % 2 else (xs[n // 2 - 1] + xs[n // 2]) / 2

    rhr_all = [daily[d].get("rhr") for d in days]
    rhr_vals_sorted = sorted(x for x in rhr_all if x is not None)
    rhr_med = median(rhr_all)
    if len(rhr_vals_sorted) >= 8:
        q1 = rhr_vals_sorted[len(rhr_vals_sorted) // 4]
        q3 = rhr_vals_sorted[3 * len(rhr_vals_sorted) // 4]
        spread = q3 - q1
    else:
        spread = None

    rhr_recent = median([daily[d].get("rhr") for d in days[-21:]])
    rhr_base = median([daily[d].get("rhr") for d in days[:-21]])

    if rhr_med is None or spread is None:
        r_st, r_tx = "neutral", "te weinig metingen"
        r_wat = "Draag je hartslagband vaker, ook buiten het sporten, om hier iets aan te hebben."
    elif spread > 12:
        r_st, r_tx = "neutral", "meting onbetrouwbaar"
        r_wat = (f"Je metingen lopen van {rhr_vals_sorted[0]:.0f} tot {rhr_vals_sorted[-1]:.0f} bpm. "
                 f"Dat is geen echte rusthartslag maar de laagste waarde die je band die dag zag. "
                 f"Zonder nachtelijke meting valt hier geen conclusie aan te verbinden.")
    elif rhr_recent is None or rhr_base is None:
        r_st, r_tx, r_wat = "neutral", "te weinig historie", "Nog niet genoeg dagen om een basislijn te bepalen."
    elif rhr_recent - rhr_base >= 3:
        r_st, r_tx = "warning", "verhoogd"
        r_wat = f"{rhr_recent - rhr_base:+.0f} bpm boven je basislijn van {rhr_base:.0f}. Kan wijzen op onvoldoende herstel of een opkomende infectie."
    elif rhr_base - rhr_recent >= 3:
        r_st, r_tx = "good", "verlaagd"
        r_wat = f"{rhr_recent - rhr_base:+.0f} bpm onder je basislijn van {rhr_base:.0f}. Meestal een teken dat je conditie verbetert."
    else:
        r_st, r_tx, r_wat = "good", "normaal", f"Rond je eigen basislijn van {rhr_base:.0f} bpm."

    # Hartslag op rustige sessies — percentage van je maximum
    ehr = mean(easy_hr)
    epct = (ehr / MAX_HR * 100) if ehr else None
    if epct is None:
        e_st, e_tx, e_wat = "neutral", "", ""
    elif epct > 80:
        e_st, e_tx = "serious", "te hard"
        e_wat = f"{epct:.0f}% van je maximum. Je rustige sessies zijn geen rustige sessies."
    elif epct > 70:
        e_st, e_tx = "warning", "aan de hoge kant"
        e_wat = f"{epct:.0f}% van je maximum. Mag rustiger; onder de 70% doet meer voor je basis."
    else:
        e_st, e_tx = "good", "echt rustig"
        e_wat = f"{epct:.0f}% van je maximum ({MAX_HR} bpm). Precies waar rustige training hoort te liggen."

    # ---- "hoe komt dit getal tot stand" ---------------------------------
    n_zones = sum(1 for a in acts if any(a.get(f"z{z}_s") for z in range(1, 6)))
    n_garmin = sum(1 for a in acts if a.get("load_source") == "garmin")
    BASIS = (f"<strong>Alleen je trainingen tellen mee.</strong> Slaap, rusthartslag en HRV zitten "
             f"<em>niet</em> in fitheid, vermoeidheid of vorm — die staan apart op het tabblad Herstel. "
             f"<strong>Sessiebelasting</strong> is de bouwsteen onder bijna alles hier. "
             f"Per activiteit: Garmin's eigen <code>activityTrainingLoad</code> als die er is "
             f"({n_garmin} van je {len(acts)} sessies), anders Edwards' zone-TRIMP = "
             f"minuten in zone 1 t/m 5, elk vermenigvuldigd met het zonenummer "
             f"({n_zones} sessies hebben zonedata).")

    HOW = {
        "Vorm (TSB)":
            BASIS + " Die sessiebelastingen worden per dag opgeteld. <strong>Fitheid</strong> is daar "
            "een traag gemiddelde van (42 dagen), <strong>vermoeidheid</strong> een snel gemiddelde "
            "(7 dagen). Eén zware training tilt je vermoeidheid dus veel harder omhoog dan je fitheid; "
            "een rustdag laat je vermoeidheid ook veel sneller zakken. <strong>Vorm</strong> is het "
            "verschil tussen die twee.",
        "Belasting 7 dagen":
            BASIS + f" Hier simpelweg opgeteld over de laatste 7 kalenderdagen "
            f"({days[-7]} t/m {days[-1]}). De status vergelijkt dat met je 28-daags weekgemiddelde.",
        "Fitheid (CTL)":
            BASIS + " <strong>Fitheid</strong> is daar een exponentieel voortschrijdend gemiddelde "
            "over 42 dagen van. Elke dag schuift hij een 42ste deel op richting de belasting van die dag, "
            "dus hij reageert traag — precies de bedoeling.",
        "Vermoeidheid (ATL)":
            BASIS + " <strong>Vermoeidheid</strong> is hetzelfde gemiddelde maar over 7 dagen, "
            "dus veel gevoeliger. De status kijkt naar de verhouding vermoeidheid ÷ fitheid.",
        "Uren 7 dagen":
            f"Optelsom van de duur van alle {len(acts7)} activiteiten in de laatste 7 dagen, "
            f"zoals Garmin ze registreert. Let op: dat is de totale sessieduur, inclusief stilstaan. "
            f"Een handbaltraining van 170 minuten telt hier volledig mee.",
        "Rusthartslag":
            f"Rechtstreeks uit Garmin (<code>get_rhr_day</code>), {fill('rhr')} metingen in "
            f"{len(days)} dagen. Getoond is de mediaan, niet de laatste meting — die is bij losse "
            f"metingen te gevoelig voor uitschieters. Is het verschil tussen je 25e en 75e percentiel "
            f"groter dan 12 bpm, dan noemt het dashboard de meting onbetrouwbaar in plaats van er "
            f"een oordeel aan te hangen.",
        "HS rustige sessies":
            f"Gemiddelde hartslag over de {len(easy_hr)} sessies die als rustig zijn ingedeeld "
            f"(minder dan 8% van de tijd in zone 4-5). Het percentage is ten opzichte van je "
            f"maximale hartslag van {MAX_HR}, uit je shuttlerun-test. Klopt die 187 niet meer, "
            f"pas 'm dan aan bovenin dashboard.py — dit getal hangt er volledig aan.",
        "VO2max": "Rechtstreeks uit Garmin, ongewijzigd. Wordt door Garmin geschat op basis van "
                  "hartslag tegen snelheid tijdens hardlopen.",
        "HRV": "Rechtstreeks uit Garmin: het nachtelijk gemiddelde van je hartslagvariabiliteit.",
        "Slaap": "Rechtstreeks uit Garmin, ongewijzigd overgenomen.",
    }

    EXPLAIN = {
        "chFitness": BASIS + " Beide lijnen zijn exponentieel voortschrijdende gemiddelden van je "
            "dagelijkse belasting: blauw over 42 dagen, oranje over 7. Er wordt 8 weken extra "
            "teruggerekend vóór het begin van de grafiek, zodat de gemiddelden al ingeregeld zijn.",
        "chTsb": "Per dag: fitheid van gisteren min vermoeidheid van gisteren. Blauw is boven nul, "
            "rood eronder. De duiding telt hoeveel van de laatste 28 dagen onder nul en onder -25 lagen.",
        "chWeekLoad": BASIS + " Opgeteld per kalenderweek (maandag t/m zondag). Met de knop "
            "rechtsboven wissel je tussen twee manieren van kijken: <strong>per sport</strong> toont "
            "waar je belasting vandaan komt, <strong>per zone</strong> toont hoeveel minuten je per week "
            "in elke hartslagzone doorbracht — dus hoe hard je die week hebt gewerkt in plaats van waarmee. "
            "De sportindeling gaat op Garmin's activiteittype, waarbij <code>basketball</code> bij jou "
            "als handbal telt omdat Garmin geen handbalprofiel heeft.",
        "chHard": "Minuten in hartslagzone 4 en 5, opgeteld over een voortschrijdend venster van "
            "7 dagen. Losstaand van de gewone belastinggrafiek, omdat die twee dingen niet "
            "samenvallen: eind juli verdrievoudigden je harde minuten terwijl je totale volume "
            "vlak bleef. De zonegrenzen komen van Garmin.",
        "chAcwr": "Je gemiddelde dagbelasting over de laatste 7 dagen, gedeeld door die over de "
            "laatste 28 dagen. Boven 1 doe je meer dan je gewend bent, onder 1 minder. De 0,8-1,3-band "
            "komt uit Gabbett (2016); dat model is later bekritiseerd, dus lees het als signaal.",
        "chZones": f"Werkelijke tijd per hartslagzone, opgeteld over alle sessies van de laatste 28 dagen "
            f"({n_zones} sessies met zonedata). De zonegrenzen komen van Garmin zelf, niet van mij. "
            f"Dit is tijd, geen sessies: een training van twee uur waarvan de helft in zone 1 valt, "
            f"telt die helft ook echt als zone 1.",
        "chKm": "Som van de afstand van alle als hardlopen ingedeelde activiteiten, per kalenderweek. "
            "De trendlijn is een kleinste-kwadraten regressie over de getoonde weken.",
        "chScatter": "Elke stip is één hardloopsessie: gemiddeld tempo tegen gemiddelde hartslag. "
            "De kleur is de zwaarte-indeling op basis van tijd in zone 4-5.",
        "chEasy": "Alleen de hardloopsessies die als rustig zijn ingedeeld, op chronologische volgorde. "
            "De duiding vergelijkt de eerste helft van die sessies met de tweede helft.",
        "chHrv": "Rechtstreeks uit Garmin. De stippellijn is een 7-daags voortschrijdend gemiddelde "
            "over de dagen waarop gemeten is.",
        "chRhr": "Rechtstreeks uit Garmin (<code>get_rhr_day</code>). Stippellijn is het 7-daags gemiddelde.",
        "chSleep": "Slaapfases zoals Garmin ze rapporteert, gestapeld per nacht. Laatste 28 nachten; "
            "de tabelknop toont de volledige periode.",
        "chVo2": "Garmin's eigen schatting, ongewijzigd overgenomen.",
    }

    # Slaap — richtlijn voor een sporter met 8-9 sessies per week is 7,5 tot 9 uur
    # (National Sleep Foundation adviseert 7-9 uur voor volwassenen; bij hoge
    # trainingsbelasting zit je aan de bovenkant daarvan).
    hrv_vals = [v for v in series_of("hrv") if v is not None]
    hrv_base = (sum(hrv_vals) / len(hrv_vals)) if hrv_vals else 0
    # HRV: het absolute getal zegt niets, de afwijking van je eigen normaal wel
    hrv_nu = last_of("hrv")
    if hrv_nu is None:
        hrv_st, hrv_tx, hrv_wat = "neutral", "niet gemeten", "Draag je band 's nachts."
    elif not (basis_hrv and basis_hrv.get("genoeg")):
        n = basis_hrv["n"] if basis_hrv else 0
        hrv_st, hrv_tx = "neutral", "basislijn in opbouw"
        hrv_wat = (f"Pas {n} van de {A.MIN_METINGEN_BASISLIJN} nachten die nodig zijn om je eigen "
                   f"normale bereik te bepalen. Tot die tijd is {hrv_nu:.0f} ms een getal zonder ijkpunt.")
    elif basis_hrv["uitschieter"] and basis_hrv["ongunstig"]:
        hrv_st, hrv_tx = "warning", "onder je normaal"
        hrv_wat = (f"{hrv_nu:.0f} ms tegen een mediaan van {basis_hrv['mediaan']:.0f}. "
                   f"Eén nacht zegt weinig; let op of het aanhoudt.")
    elif basis_hrv["uitschieter"]:
        hrv_st, hrv_tx = "good", "boven je normaal"
        hrv_wat = f"{hrv_nu:.0f} ms tegen een mediaan van {basis_hrv['mediaan']:.0f}. Goed teken."
    else:
        hrv_st, hrv_tx = "good", "binnen je normaal"
        hrv_wat = (f"Je normale bereik ligt tussen {basis_hrv['onder']:.0f} en "
                   f"{basis_hrv['boven']:.0f} ms.")

    slp_h = last_of("sleep_h")
    slp_score = last_of("sleep_score")
    slp_n = fill("sleep_h")
    if slp_h is None:
        slp_st, slp_tx = "neutral", "niet gemeten"
        slp_wat = "Draag je band 's nachts om je slaap te meten."
    elif slp_h >= 7.5:
        slp_st, slp_tx = "good", "voldoende"
        slp_wat = f"Richtlijn bij 8-9 trainingen per week is 7,5 tot 9 uur."
    elif slp_h >= 6.5:
        slp_st, slp_tx = "warning", "krap"
        slp_wat = f"Onder de 7,5 uur bij jouw trainingsvolume. Eén nacht is geen probleem, een patroon wel."
    else:
        slp_st, slp_tx = "serious", "te kort"
        slp_wat = f"Ruim onder de richtlijn. Slaap is de enige hersteltool met een groter effect dan wat je kunt slikken."
    if slp_score is not None:
        slp_wat += f" Garmin gaf deze nacht een slaapscore van {slp_score:.0f}."
    if slp_n < 5:
        slp_wat += f" Pas {slp_n} {'nacht' if slp_n == 1 else 'nachten'} gemeten — nog geen trend."

    # Zes tegels, elk met een eigen vraag. Fitheid, vermoeidheid,
    # rusthartslag, weekuren en de hartslag op rustige sessies zijn bewust
    # naar hun tabbladen verhuisd: het zijn geen dagelijkse beslissingen.
    hard_st, hard_tx, hard_wat = "neutral", "", ""
    if hard_ratio is not None:
        if hard_ratio > 1.5:
            hard_st, hard_tx = "serious", "sterke sprong"
            hard_wat = (f"{hard7:.0f} minuten in zone 4-5 deze week tegen een gemiddelde van "
                        f"{hard28:.0f}. Grote sprongen in hoge intensiteit zijn het signaal dat "
                        f"volume niet oppikt.")
        elif hard_ratio >= 1.3:
            hard_st, hard_tx = "warning", "flinke toename"
            hard_wat = f"{hard_ratio:.1f}x je normale hoeveelheid hard werk. Niet verder opvoeren."
        elif hard_ratio >= 0.8:
            hard_st, hard_tx = "good", "stabiel"
            hard_wat = f"{hard7:.0f} minuten hard werk, in lijn met je gemiddelde van {hard28:.0f}."
        else:
            hard_st, hard_tx = "neutral", "rustige week"
            hard_wat = f"{hard7:.0f} minuten in zone 4-5, minder dan je gemiddelde van {hard28:.0f}."

    doel_st, doel_tx, doel_wat, doel_val = "neutral", "", "", None
    if doel:
        doel_val = (date.fromisoformat(doel["date"]) - today).days
        beste = max(opties, key=lambda o: o["tsb"]) if opties else None
        if doel["tsb"] >= -5:
            doel_st, doel_tx = "good", "je komt fris aan"
            doel_wat = f"Verwachte vorm op {doel['label'].lower()}: {doel['tsb']:+.0f}. Niets aanpassen nodig."
        else:
            doel_st, doel_tx = "warning", "aanpassing nodig"
            doel_wat = (f"Verwachte vorm {doel['tsb']:+.0f} als je je volle week draait. "
                        + (f"Met '{beste['naam'].lower()}' word dat {beste['tsb']:+.0f}." if beste else ""))

    candidates = [
        {"label": "Slaap", "value": fmt(slp_h, 1), "unit": "uur",
         "status": slp_st, "status_text": slp_tx, "meaning": slp_wat,
         "trend": f"{fill('sleep_h')} van {len(days)} "
                  f"{'nacht' if len(days) == 1 else 'nachten'} gemeten",
         "series": series_of("sleep_h"), "color": "--s4", "keep": fill("sleep_h") >= 1,
         "scale": schaal(slp_h, 4, 10, (7.5, 9),
                         "richtlijn voor een sporter met jouw volume: 7,5 tot 9 uur")},

        {"label": "HRV", "value": fmt(last_of("hrv")), "unit": "ms",
         "status": hrv_st, "status_text": hrv_tx, "meaning": hrv_wat,
         "trend": f"{fill('hrv')} {'nacht' if fill('hrv') == 1 else 'nachten'} gemeten",
         "series": series_of("hrv"), "color": "--s3", "keep": fill("hrv") >= 1,
         "scale": (schaal(last_of("hrv"), basis_hrv["onder"] * 0.9, basis_hrv["boven"] * 1.1,
                          (basis_hrv["onder"], basis_hrv["boven"]),
                          f"jouw normale bereik ligt tussen {basis_hrv['onder']:.0f} en "
                          f"{basis_hrv['boven']:.0f} ms, mediaan {basis_hrv['mediaan']:.0f}")
                   if basis_hrv and basis_hrv.get("genoeg") else None)},

        {"label": "Vorm (TSB)",
         "value": ("+" if (tsb and tsb > 0) else "") + fmt(tsb),
         "status": tsb_st, "status_text": tsb_tx, "meaning": tsb_wat,
         "series": [x["tsb"] for x in fitness], "color": "--s1", "keep": True,
         "trend": f"fitheid {ctl:.0f} · vermoeidheid {atl:.0f}",
         "scale": schaal(tsb, -40, 30, (-5, 10),
                         "onder -30 overbelast · -30 tot -5 opbouwzone · "
                         "-5 tot +10 wedstrijdklaar · boven +15 zakt je conditie weg")},

        {"label": "Belasting deze week",
         "value": (f"{load7/load28:.1f}\u00d7" if load28 else fmt(load7)),
         "unit": ("normaal" if load28 else ""),
         "status": l_st, "status_text": l_tx, "meaning": l_wat,
         "trend": f"{len(acts7)} sessies · ruwe score {load7:.0f}",
         "series": [x["load"] for x in fitness[-42:]], "color": "--s4", "keep": True,
         "scale": (schaal(load7, 0, max(load28 * 2, load7 * 1.15, 1),
                          (load28 * 0.8, load28 * 1.3),
                          f"je gemiddelde week is {load28:.0f} · de band is 0,8 tot 1,3 keer dat")
                   if load28 else None)},

        {"label": "Harde minuten", "value": fmt(hard7), "unit": "min",
         "status": hard_st, "status_text": hard_tx, "meaning": hard_wat,
         "trend": "zone 4 en 5, laatste 7 dagen",
         "series": [x["minuten"] for x in hard_reeks],
         "color": "--s2", "keep": hard28 is not None,
         "scale": (schaal(hard7, 0, max(hard28 * 2.5, hard7 * 1.15, 1),
                          (hard28 * 0.8, hard28 * 1.3),
                          f"je gemiddelde week is {hard28:.0f} minuten hard werk")
                   if hard28 else None)},

        {"label": "Volgende doel",
         "value": (str(doel_val) if doel_val is not None else "\u2013"),
         "unit": ("dag" if doel_val == 1 else "dagen"),
         "status": doel_st, "status_text": doel_tx, "meaning": doel_wat,
         "trend": (f"{doel['label']} op {doel['weekday']} "
                   f"{int(doel['date'][8:])}/{int(doel['date'][5:7])}" if doel else ""),
         "series": [x["tsb"] for x in projectie] if doel else [],
         "color": "--s3", "keep": doel is not None},

        {"label": "VO2max", "value": fmt(last_of("vo2max"), 1), "unit": "ml/kg/min",
         "status": "neutral", "status_text": "", "meaning": "Garmin-schatting.",
         "series": series_of("vo2max"), "color": "--s1", "keep": fill("vo2max") >= 2},
    ]

    # Vaste volgorde: belasting eerst, dan herstel. Slaap en HRV staan bewust
    # hoog omdat ze pas net binnenkomen en het meest sturend zijn.
    TILE_ORDER = ["Slaap", "HRV", "Vorm (TSB)", "Belasting deze week",
                  "Harde minuten", "Volgende doel", "VO2max"]
    kept = [t for t in candidates if t.pop("keep")]
    kept.sort(key=lambda t: TILE_ORDER.index(t["label"]) if t["label"] in TILE_ORDER else 99)
    tiles = kept[:6]
    for t in tiles:
        t["how"] = HOW.get(t["label"], "")

    extras = cache.get("extras") or {}
    race = extras.get("race_predictions")
    predictions = None
    if isinstance(race, dict):
        predictions = {k: race.get(k) for k in
                       ("time5K", "time10K", "timeHalfMarathon", "timeMarathon") if race.get(k)}
    elif isinstance(race, list) and race and isinstance(race[0], dict):
        r0 = race[-1]
        predictions = {k: r0.get(k) for k in
                       ("time5K", "time10K", "timeHalfMarathon", "timeMarathon") if r0.get(k)}

    # ---- wat staat er vandaag op het programma ----
    vandaag_item = WEEKPLAN.get(today.weekday())
    dagen_tot_doel = ((date.fromisoformat(doel["date"]) - today).days) if doel else None
    vandaag = {
        "weekdag": A.WEEKDAG[today.weekday()],
        "label": vandaag_item["label"] if vandaag_item else "geen training gepland",
        "traint": bool(vandaag_item),
        "dagen_tot_doel": dagen_tot_doel,
        "doel_label": doel["label"] if doel else None,
        "doel_tsb": doel["tsb"] if doel else None,
    }

    return {
        "gereedheid": ready,
        "vandaag": vandaag,
        "basislijnen": basislijnen,
        "uitschieters": len(uitschieters),
        "regelmaat": regelmaat,
        "hard": {"reeks": hard_reeks, "week": round(hard7), "gemiddeld": round(hard28) if hard28 else None,
                 "ratio": round(hard_ratio, 2) if hard_ratio else None},
        "plan": {"dagen": projectie, "doel": doel, "opties": opties, "advies": plan_tip,
                 "horizon": PLAN_HORIZON},
        # Alles wat de browser nodig heeft om de belasting opnieuw door te
        # rekenen zodra jij een sessie toevoegt die Garmin miste. Zonder
        # toevoeging hoort de uitkomst identiek te zijn aan wat hierboven al
        # is uitgerekend; de browser controleert dat en klaagt in de console
        # als het uit elkaar loopt.
        "belastingbasis": {
            "calc_days": calc_days,
            "dagen": days,
            "daily_load": {d: round(v, 1) for d, v in daily_load.items() if v},
            "ctl_tc": 42, "atl_tc": 7,
            # Voor het omrekenen van sessie-RPE naar dezelfde schaal: per
            # activiteit de gemeten belasting en de duur, zodat de browser
            # een eigen ijking kan maken zodra jij sessies van een RPE
            # voorziet.
            "gemeten": [{"date": a["date"], "sport": a["sport"],
                         "minuten": round((a["duration_s"] or 0) / 60),
                         "load": round(a["load"], 1)}
                        for a in acts_all if a.get("load")],
        },
        # Alles wat de browser nodig heeft om de projectie zelf opnieuw door te
        # rekenen zodra jij iets in je planning wijzigt. De stand van vandaag
        # plus je eigen weekritme is genoeg; de historie hoeft niet mee.
        "planbasis": {
            "vandaag": today.isoformat(),
            "seed": A.ewma_state(daily_load, calc_days),
            "weekplan": {str(k): v for k, v in WEEKPLAN.items()},
            # Per weekdag precies wat maak_plan() zou uitrekenen, zodat de
            # browser voor een ongewijzigde week op exact hetzelfde uitkomt
            # als het Python-script. Wijkt dat af, dan klaagt de console.
            "standaard": {
                str(wd): {
                    "sport": item["sport"], "label": item["label"],
                    "doel": bool(item.get("doel")),
                    "min_minuten": item.get("min_minuten"),
                    "load": round(item.get("load") if item.get("load") is not None
                                  else (A.typische_belasting(acts_all, item["sport"],
                                                             item.get("min_minuten")) or 0.0), 1),
                    "bron": ("handmatig ingesteld" if item.get("load") is not None
                             else f"mediaan van je eerdere {item['sport'].lower()}sessies"
                             + (f" van 75 minuten of langer" if item.get("min_minuten") else "")),
                }
                for wd, item in WEEKPLAN.items()
            },
            "normen": A.sport_normen(acts_all),
            "horizon": PLAN_HORIZON,
            "sporten": A.SPORT_ORDER,
        },
        "generated": datetime.now().isoformat(timespec="minutes"),
        "sync": sync_config(),
        "weeks": weeks,
        "max_hr": MAX_HR,
        "rest_hr": round(rest_hr),
        "days": days,
        "daily": [daily[d] for d in days],
        "fitness": fitness,
        "acwr": acwr_series,
        "weekly": weekly,
        "week_days": week_days,
        "activities": acts,
        "runs": runs,
        "grade_hours": {k: round(v, 2) for k, v in grade_counts.items()},
        "zones": [round(z, 1) for z in zones28],
        "advice": advice,
        "tiles": tiles,
        "predictions": predictions,
        "insights": A.build_insights(fitness, acwr_series, daily, days, acts, weekly,
                                     {k: round(v, 2) for k, v in grade_counts.items()},
                                     runs, MAX_HR,
                                     {f: fill(f) for f in
                                      ("sleep_h", "rhr", "hrv", "vo2max")},
                                     zones=zones28),
        "sleep_last": next(
            ({"date": d, **{k: daily[d].get(k) for k in
                            ("sleep_h", "sleep_deep_h", "sleep_light_h", "sleep_rem_h",
                             "sleep_awake_h", "sleep_score", "sleep_quality",
                             "sleep_awakenings", "sleep_stress", "hrv",
                             "sleep_start", "sleep_end", "rhr",
                             "bb_wake", "bb_now", "bb_charged", "bb_drained",
                             "resp_waking", "resp_sleep",
                             "readiness", "readiness_level", "readiness_feedback")}}
             for d in reversed(days) if daily[d].get("sleep_h") is not None), None),
        "sleep_nights": fill("sleep_h"),
        "explain": EXPLAIN,
        "sport_order": A.SPORT_ORDER,
        "coverage": {f: fill(f) for f in
                     ("sleep_h", "rhr", "hrv", "vo2max", "stress_avg",
                      "body_battery_high", "bb_now", "resp_waking", "readiness")},
        "support": (cache.get("meta") or {}).get("support", {}),
    }


# ==========================================================================
# Demo-data (om de pagina te testen zonder Garmin)
# ==========================================================================

def demo_cache(weeks: int) -> dict[str, Any]:
    random.seed(7)
    today = date.today()
    start = today - timedelta(weeks=weeks)
    cache: dict[str, Any] = {"daily": {}, "activities": {}, "meta": {}, "extras": {}}

    aid = 1
    for i in range((today - start).days + 1):
        d = start + timedelta(days=i)
        ds = d.isoformat()
        wd = d.weekday()

        cache["daily"][ds] = {
            "sleep": {"dailySleepDTO": {
                "sleepTimeSeconds": int((6.6 + random.random() * 1.8) * 3600),
                "deepSleepSeconds": int((0.9 + random.random() * 0.7) * 3600),
                "lightSleepSeconds": int((3.5 + random.random()) * 3600),
                "remSleepSeconds": int((1.1 + random.random() * 0.6) * 3600),
                "awakeSleepSeconds": int(random.random() * 0.5 * 3600),
                "sleepScores": {"overall": {"value": random.randint(62, 91)}}}},
            "hrv": {"hrvSummary": {"lastNightAvg": round(58 + 9 * math.sin(i / 9) + random.uniform(-5, 5)),
                                   "baseline": {"lowUpper": 52, "balancedUpper": 68},
                                   "status": "BALANCED"}},
            "rhr": {"allMetrics": {"metricsMap": {"WELLNESS_RESTING_HEART_RATE": [
                {"value": round(48 + 2 * math.sin(i / 11) + random.uniform(-1.5, 1.5))}]}}},
            "vo2max": [{"generic": {"vo2MaxPreciseValue": round(52.5 + i * 0.012, 1)}}],
            "training_status": {"mostRecentTrainingStatus": {"latestTrainingStatusData": {
                "x": {"trainingStatusFeedbackPhrase": "PRODUCTIVE_1"}}}},
            "readiness": [{"score": random.randint(45, 90)}],
            "summary": {"totalSteps": random.randint(7000, 16000),
                        "totalKilocalories": random.randint(2600, 4100),
                        "moderateIntensityMinutes": random.randint(10, 60),
                        "vigorousIntensityMinutes": random.randint(5, 70),
                        "averageStressLevel": random.randint(20, 45)},
        }

        def add(name, type_key, dur_min, dist_km, avg_hr, hard_frac):
            nonlocal aid
            dur = dur_min * 60
            cache["activities"][str(aid)] = {
                "activityId": aid,
                "activityName": name,
                "activityType": {"typeKey": type_key},
                "startTimeLocal": f"{ds} 19:00:00",
                "distance": dist_km * 1000,
                "duration": dur,
                "averageHR": avg_hr,
                "maxHR": avg_hr + random.randint(12, 28),
                "calories": int(dur_min * 11),
                "hrTimeInZone_4": dur * hard_frac * 0.7,
                "hrTimeInZone_5": dur * hard_frac * 0.3,
                "aerobicTrainingEffect": round(random.uniform(2.0, 4.4), 1),
                "elevationGain": random.randint(0, 60),
            }
            aid += 1

        if wd in (0, 1, 3, 4) and random.random() > 0.15:
            add("Handbaltraining", "team_sports", random.randint(75, 105), 0,
                random.randint(138, 158), random.uniform(0.15, 0.4))
        if wd == 5 and random.random() > 0.25:
            add("Handbalwedstrijd", "team_sports", 60, 0, random.randint(150, 168),
                random.uniform(0.3, 0.55))
        if wd in (1, 4) and random.random() > 0.3:
            add("Kracht — push", "strength_training", random.randint(50, 80), 0,
                random.randint(105, 125), random.uniform(0.0, 0.06))
        if wd in (2, 6) and random.random() > 0.25:
            easy = random.random() > 0.35
            km = random.uniform(7, 14) if easy else random.uniform(5, 9)
            add("Duurloop" if easy else "Intervaltraining", "running",
                int(km * (5.4 if easy else 4.6)), round(km, 1),
                random.randint(128, 141) if easy else random.randint(155, 172),
                random.uniform(0.0, 0.05) if easy else random.uniform(0.3, 0.55))

    cache["extras"] = {"race_predictions": {"time5K": 1180, "time10K": 2480,
                                            "timeHalfMarathon": 5520, "timeMarathon": 11700}}
    cache["meta"]["support"] = {"demo": "ok"}
    return cache


# ==========================================================================
# Rendering
# ==========================================================================

PBKDF2_ITER = 310_000   # OWASP-richtlijn voor PBKDF2-HMAC-SHA256 (2023)


def encrypt_payload(blob: str, passphrase: str) -> str:
    """Versleutel de databundel met AES-256-GCM.

    Sleutel via PBKDF2-HMAC-SHA256 met een willekeurige salt. Zo kan de pagina
    publiek staan zonder dat je data leesbaar is: zonder wachtwoord is het
    bestand alleen ruis. Let wel: de versleutelde tekst is voor iedereen te
    downloaden, dus de sterkte hangt volledig aan je wachtwoord. Neem een
    wachtwoordzin van minstens vier woorden.
    """
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    except ImportError:
        sys.exit("Voor --encrypt is de cryptography-library nodig:\n"
                 "    python3 -m pip install cryptography")
    import base64
    import hashlib
    import os

    salt = os.urandom(16)
    nonce = os.urandom(12)
    key = hashlib.pbkdf2_hmac("sha256", passphrase.encode("utf-8"), salt, PBKDF2_ITER, 32)
    ct = AESGCM(key).encrypt(nonce, blob.encode("utf-8"), None)
    b64 = lambda b: base64.b64encode(b).decode("ascii")  # noqa: E731
    return json.dumps({"__enc": True, "iter": PBKDF2_ITER,
                       "salt": b64(salt), "nonce": b64(nonce), "ct": b64(ct)})


def render(payload: dict[str, Any], passphrase: str | None = None,
           out: Path | None = None) -> None:
    if not TEMPLATE.exists():
        sys.exit(f"template.html ontbreekt naast {Path(__file__).name}")
    html = TEMPLATE.read_text(encoding="utf-8")
    blob = json.dumps(payload, ensure_ascii=False, allow_nan=False, default=str)
    if passphrase:
        blob = encrypt_payload(blob, passphrase)
    html = html.replace("/*__DATA__*/null", blob)
    (out or OUTPUT).write_text(html, encoding="utf-8")


# ==========================================================================
# Publiceren
# ==========================================================================

PUBLISH_DIR = Path(PUBLISH_TARGET).expanduser() if PUBLISH_TARGET else HERE / "publiceren"
KEYFILE = HERE / "publish.key"


def publish(payload: dict[str, Any], passphrase: str | None = None) -> Path:
    """Schrijf een versleutelde kopie die veilig publiek mag staan.

    De wachtwoordzin komt in deze volgorde: meegegeven door de aanroeper (zo
    doet de bouw bij GitHub het, met de zin uit een secret), anders uit
    publish.key naast dit script, anders uit DASHBOARD_PW, anders wordt hij
    gevraagd. publish.key hoort NOOIT mee de repository in — er staat een
    .gitignore voor klaar.

    Wordt de zin meegegeven, dan schrijven we hem niet weg. Op een bouwmachine
    van iemand anders hoort je wachtwoordzin niet op schijf te belanden.
    """
    import getpass

    meegegeven = bool((passphrase or "").strip())
    pw = (passphrase or "").strip()
    if not pw and KEYFILE.exists():
        pw = KEYFILE.read_text(encoding="utf-8").strip()
    if not pw:
        pw = os.environ.get("DASHBOARD_PW", "").strip()
    if not pw:
        pw = getpass.getpass("Wachtwoordzin voor de gepubliceerde pagina: ").strip()
        if len(pw) >= 12:
            KEYFILE.write_text(pw + "\n", encoding="utf-8")
            KEYFILE.chmod(0o600)
            print(f"  wachtwoordzin opgeslagen in {KEYFILE.name} (alleen voor jou leesbaar)")

    if len(pw) < 12:
        sys.exit("De wachtwoordzin is korter dan 12 tekens. Te zwak voor een pagina die "
                 "publiek staat; neem een zin van vier woorden.")

    PUBLISH_DIR.mkdir(parents=True, exist_ok=True)
    doel = PUBLISH_DIR / "index.html"
    render(payload, passphrase=pw, out=doel)
    (PUBLISH_DIR / ".nojekyll").write_text("", encoding="utf-8")
    print(f"✓ {doel}  ({doel.stat().st_size / 1024:.0f} kB, versleuteld)"
          + ("  [zin uit een secret, niet opgeslagen]" if meegegeven else ""))
    return doel


# ==========================================================================
# CLI
# ==========================================================================

def main() -> None:
    ap = argparse.ArgumentParser(description="Garmin sportdashboard")
    ap.add_argument("--weeks", type=int, default=WEEKS_DEFAULT, help="historie in weken")
    ap.add_argument("--probe", action="store_true", help="alleen testen welke metrics beschikbaar zijn")
    ap.add_argument("--refresh", action="store_true", help="cache negeren, alles opnieuw ophalen")
    ap.add_argument("--login", action="store_true", help="interactief inloggen (met MFA)")
    ap.add_argument("--demo", action="store_true", help="bouw met verzonnen data")
    ap.add_argument("--open", action="store_true", help="open index.html na afloop")
    ap.add_argument("--publish", action="store_true",
                    help="maak ook een versleutelde kopie in publiceren/ voor GitHub Pages")
    args = ap.parse_args()

    if args.demo:
        print("Demo-modus: verzonnen data, geen Garmin-verbinding.")
        cache = demo_cache(args.weeks + RAMP_WEEKS)
        payload = build_payload(cache, args.weeks)
        payload["demo"] = True
        render(payload)
        print(f"✓ {OUTPUT}")
        if args.publish:
            publish(payload)
        return

    print("Verbinden met Garmin Connect...")
    client = F.connect(allow_login=args.login)
    fetcher = F.Fetcher(client)

    if args.probe:
        print("\nBeschikbaarheid van metrics op dit account:\n")
        report = F.probe(fetcher)
        width = max(len(k) for k in report)
        for method, info in report.items():
            mark = {"ok": "✓", "leeg": "–"}.get(info["status"], "✗")
            print(f"  {mark} {method.ljust(width)}  {info['omschrijving']}")
            if info["status"] not in ("ok", "leeg"):
                print(f"      {info['status']}")
            elif info["velden"]:
                print(f"      velden: {info['velden']}")
        print(f"\n{fetcher.calls} API-calls gedaan.")
        print("Legenda: ✓ data  – endpoint werkt maar is leeg  ✗ niet beschikbaar")
        return

    cache = F.load_cache()
    # Eén snelle probe zodat fetch_all endpoints kan overslaan die toch falen.
    F.probe(fetcher)
    cache = F.fetch_all(fetcher, args.weeks, cache, force=args.refresh,
                        activity_weeks=args.weeks + RAMP_WEEKS)

    print("Berekenen...")
    payload = build_payload(cache, args.weeks)
    render(payload)
    print(f"✓ {OUTPUT}  ({fetcher.calls} API-calls)")
    print(f"  Open met:  open {OUTPUT}")

    if args.publish:
        publish(payload)

    if args.open:
        webbrowser.open(OUTPUT.as_uri())


if __name__ == "__main__":
    main()
