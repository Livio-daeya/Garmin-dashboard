"""
garmin_analyse.py — rekenwerk voor het sportdashboard.

Alle formules staan expliciet in de code met bronvermelding in de docstring,
zodat je elk getal in het dashboard kunt terugrekenen.
"""

from __future__ import annotations

import math
import re
from collections import defaultdict
from datetime import date, datetime, timedelta
from typing import Any

# --------------------------------------------------------------------------
# Sportindeling
# --------------------------------------------------------------------------
# Garmin's typeKey is leidend; de naam van de activiteit is de tiebreaker.
# Pas dit aan als jij je handbaltrainingen anders vastlegt.

# LET OP — "basketball" staat hier bewust onder Handbal.
# Garmin-horloges hebben geen handbalprofiel; Livio's handbaltrainingen komen
# binnen als typeKey "basketball" (indoor, 90-170 min, 2-4 km loopafstand).
# Speel je echt basketbal en wil je dat apart zien: haal "basketball" hier weg
# en zet het in een eigen regel.
SPORT_RULES = [
    ("Handbal", ["handball", "team_sports", "indoor_team", "basketball"],
     ["handbal", "handball", "basketbal", "wedstrijd"]),
    ("Hardlopen", ["running", "treadmill_running", "trail_running", "track_running"],
     ["hardlopen", "duurloop", "interval"]),
    ("Kracht", ["strength_training", "fitness_equipment", "hiit", "pilates", "yoga"],
     ["kracht", "gym", "fitness", "lifting"]),
    ("Fietsen", ["cycling", "biking", "indoor_cycling", "virtual_ride"],
     ["fietsen", "spinning", "wielrennen"]),
]
DEFAULT_SPORT = "Overig"

SPORT_ORDER = ["Hardlopen", "Handbal", "Kracht", "Fietsen", "Overig"]


def classify(activity: dict[str, Any]) -> str:
    type_key = ((activity.get("activityType") or {}).get("typeKey") or "").lower()
    name = (activity.get("activityName") or "").lower()
    for label, keys, names in SPORT_RULES:
        if any(k in type_key for k in keys):
            return label
        if any(n in name for n in names):
            return label
    return DEFAULT_SPORT


# --------------------------------------------------------------------------
# Trainingsbelasting
# --------------------------------------------------------------------------

def trimp(duration_s: float, avg_hr: float, rest_hr: float, max_hr: float) -> float:
    """Banister TRIMP (mannen).

    TRIMP = duur_min x HRr x 0.64 x e^(1.92 x HRr),  HRr = (HRgem - HRrust) / (HRmax - HRrust)

    Bron: Banister EW, "Modeling elite athletic performance", in: Physiological
    Testing of Elite Athletes (1991); de exponentiele weegfactor 0.64/1.92 voor
    mannen komt uit Morton, Fitz-Clarke & Banister, J Appl Physiol 69(3):1171-77
    (1990). Breed toegepast in de sportfysiologie.
    """
    if not duration_s or not avg_hr or max_hr <= rest_hr:
        return 0.0
    hrr = (avg_hr - rest_hr) / (max_hr - rest_hr)
    hrr = max(0.0, min(1.0, hrr))
    return (duration_s / 60.0) * hrr * 0.64 * math.exp(1.92 * hrr)


def edwards_trimp(activity: dict[str, Any]) -> float:
    """Edwards' zone-TRIMP: minuten per hartslagzone maal het zonenummer.

        TRIMP = 1*min(z1) + 2*min(z2) + 3*min(z3) + 4*min(z4) + 5*min(z5)

    Bron: Edwards S, "The Heart Rate Monitor Book" (1993); breed gebruikt als
    zone-gewogen belastingmaat, o.a. gevalideerd tegen andere TRIMP-varianten
    door Sanders et al., Int J Sports Physiol Perform 12(5):668-75 (2017).

    Dit is de juiste maat voor zaalsport. Een handbaltraining van 170 minuten
    bestaat voor bijna de helft uit stilstaan (uitleg, oefeningen afwachten);
    die tijd valt in zone 1 en telt hier licht mee, terwijl een berekening op
    de totale duur hem even zwaar zou wegen als 170 minuten hardlopen.
    """
    total = 0.0
    for z in range(1, 6):
        secs = activity.get(f"hrTimeInZone_{z}")
        if isinstance(secs, (int, float)) and secs > 0:
            total += (secs / 60.0) * z
    return total


def activity_load(activity: dict[str, Any], rest_hr: float, max_hr: float) -> tuple[float, str]:
    """Belasting van één activiteit. Geeft (waarde, herkomst) terug."""
    garmin_load = activity.get("activityTrainingLoad")
    if isinstance(garmin_load, (int, float)) and garmin_load > 0:
        return float(garmin_load), "garmin"
    val = edwards_trimp(activity)
    if val > 0:
        return val, "zones"
    val = trimp(activity.get("duration") or 0, activity.get("averageHR") or 0, rest_hr, max_hr)
    if val > 0:
        return val, "trimp"
    # Laatste redmiddel: duur x vaste factor, zodat krachttraining zonder
    # hartslagmeting niet volledig uit de belasting verdwijnt.
    dur = activity.get("duration") or 0
    return (dur / 60.0) * 0.8, "duur"


def ewma_series(daily_load: dict[str, float], days: list[str],
                ctl_tc: int = 42, atl_tc: int = 7) -> list[dict[str, Any]]:
    """CTL / ATL / TSB volgens het impuls-responsmodel (Banister; in de
    populaire vorm van TrainingPeaks' Performance Management Chart).

        CTL_vandaag = CTL_gisteren + (belasting_vandaag - CTL_gisteren) / 42
        ATL_vandaag = ATL_gisteren + (belasting_vandaag - ATL_gisteren) / 7
        TSB_vandaag = CTL_gisteren - ATL_gisteren

    LET OP: dit zijn afgeleide getallen uit jouw activiteiten, niet Garmin's
    eigen 'Acute Load' / 'Training Status'. Die staan apart in het dashboard.
    """
    ctl = atl = 0.0
    out = []
    for d in days:
        load = daily_load.get(d, 0.0)
        tsb = ctl - atl                      # vorm van vandaag = saldo van gisteren
        ctl += (load - ctl) / ctl_tc
        atl += (load - atl) / atl_tc
        out.append({"date": d, "load": round(load, 1), "ctl": round(ctl, 1),
                    "atl": round(atl, 1), "tsb": round(tsb, 1)})
    return out


def ewma_state(daily_load: dict[str, float], days: list[str],
               ctl_tc: int = 42, atl_tc: int = 7) -> dict[str, float]:
    """De onafgeronde CTL/ATL-stand na de laatste dag uit `days`.

    Het dashboard laat de planning in de browser doorrekenen. Die hoeft
    daarvoor niet de hele historie mee te krijgen: als je de stand van vandaag
    kent, is elke volgende dag een kwestie van dezelfde twee regels. Bewust
    ONAFGEROND, want ewma_series rondt alleen zijn uitvoer af en rekent
    intern door met de volle waarde -- zou je de afgeronde waarde als
    startpunt nemen, dan loopt de projectie langzaam uit de pas.
    """
    ctl = atl = 0.0
    for d in days:
        load = daily_load.get(d, 0.0)
        ctl += (load - ctl) / ctl_tc
        atl += (load - atl) / atl_tc
    return {"ctl": ctl, "atl": atl, "ctl_tc": ctl_tc, "atl_tc": atl_tc}


def acwr(daily_load: dict[str, float], days: list[str]) -> list[dict[str, Any]]:
    """Acute:Chronic Workload Ratio, voortschrijdend gemiddelde (7d / 28d).

    Bron: Gabbett TJ, Br J Sports Med 50(5):273-80 (2016). De 'sweet spot'
    0.8-1.3 en het verhoogde blessurerisico boven ~1.5 zijn uit datzelfde
    werk; het model is later bekritiseerd (o.a. Impellizzeri et al., Int J
    Sports Physiol Perform 15(6):907-13, 2020) - lees het als signaal, niet
    als wet.
    """
    idx = {d: i for i, d in enumerate(days)}
    loads = [daily_load.get(d, 0.0) for d in days]
    out = []
    for d in days:
        i = idx[d]
        acute = sum(loads[max(0, i - 6):i + 1]) / 7.0
        chronic = sum(loads[max(0, i - 27):i + 1]) / min(28, i + 1)
        ratio = (acute / chronic) if chronic > 0 else 0.0
        out.append({"date": d, "acwr": round(ratio, 2)})
    return out


# --------------------------------------------------------------------------
# Uitpakken van de ruwe Garmin-respons
# --------------------------------------------------------------------------

def _num(value):
    return value if isinstance(value, (int, float)) else None


def nacht_hrv_reeks(raw: dict[str, Any]) -> list[list] | None:
    """De losse HRV-metingen van een nacht, als [["23:50", 77], ...].

    Het dashboard toont per nacht normaal één getal: het gemiddelde uit
    avgOvernightHrv. Dat is de juiste samenvatting, maar het verbergt hoe die
    nacht verliep -- en juist daar zit informatie. Een enkele uitschieter van
    198 tussen waarden rond de 100 is meetruis; datzelfde gemiddelde met een
    vlakke lijn eronder is iets heel anders.

    Twee bronnen, in volgorde van beschikbaarheid:
      1. get_sleep_data -> hrvData: [{value, startGMT}, ...]
      2. get_hrv_data -> hrvReadings: [{hrvValue, readingTimeLocal}, ...]

    De tweede is bij een opstelling zonder horloge meestal leeg; de eerste
    hoeft er ook niet te zijn. Geeft geen van beide iets, dan levert deze
    functie None en laat het dashboard het blok weg -- net als bij VO2max.
    Een lege grafiek tonen zou suggereren dat er niets te meten viel, terwijl
    het apparaat het simpelweg niet levert.
    """
    def klok(tekst: str) -> str:
        # "2026-08-27T23:50:00.0" of "2026-08-27 23:50:00" -> "23:50"
        t = str(tekst or "")
        for scheider in ("T", " "):
            if scheider in t:
                return t.split(scheider)[1][:5]
        return t[:5]

    bronnen = [
        ((raw.get("sleep") or {}).get("hrvData") or [], "value", "startGMT"),
        ((raw.get("hrv") or {}).get("hrvReadings") or [], "hrvValue", "readingTimeLocal"),
    ]
    for lijst, waardeveld, tijdveld in bronnen:
        punten = []
        for item in lijst:
            if not isinstance(item, dict):
                continue
            waarde = _num(item.get(waardeveld))
            tijd = item.get(tijdveld)
            if waarde is None or not tijd:
                continue
            punten.append([klok(tijd), round(waarde, 1)])
        # Onder de acht metingen valt er geen curve te tekenen, alleen ruis.
        if len(punten) >= 8:
            return punten
    return None


def extract_daily(cache: dict[str, Any], days: list[str]) -> dict[str, dict[str, Any]]:
    """Trek uit de ruwe dagresponses de velden die het dashboard gebruikt."""
    out: dict[str, dict[str, Any]] = {}
    for d in days:
        raw = cache.get("daily", {}).get(d) or {}
        row: dict[str, Any] = {"date": d}

        # --- slaap ---
        sleep = raw.get("sleep") or {}
        dto = sleep.get("dailySleepDTO") or {}
        secs = _num(dto.get("sleepTimeSeconds"))
        row["sleep_h"] = round(secs / 3600, 2) if secs else None
        row["sleep_deep_h"] = round((dto.get("deepSleepSeconds") or 0) / 3600, 2) if dto.get("deepSleepSeconds") else None
        row["sleep_light_h"] = round((dto.get("lightSleepSeconds") or 0) / 3600, 2) if dto.get("lightSleepSeconds") else None
        row["sleep_rem_h"] = round((dto.get("remSleepSeconds") or 0) / 3600, 2) if dto.get("remSleepSeconds") else None
        row["sleep_awake_h"] = round((dto.get("awakeSleepSeconds") or 0) / 3600, 2) if dto.get("awakeSleepSeconds") else None
        scores = dto.get("sleepScores") or {}
        overall = scores.get("overall") or {}
        row["sleep_score"] = _num(overall.get("value"))
        row["sleep_quality"] = overall.get("qualifierKey")
        row["sleep_start"] = dto.get("sleepStartTimestampLocal")
        row["sleep_end"] = dto.get("sleepEndTimestampLocal")
        row["sleep_awakenings"] = _num(dto.get("awakeCount"))
        row["sleep_stress"] = _num(dto.get("avgSleepStress"))

        # --- HRV ---
        # get_hrv_data is leeg zonder Garmin-horloge. De nachtelijke HRV zit
        # dan alsnog in de slaaprespons, op het hoogste niveau als
        # avgOvernightHrv. Geverifieerd tegen de bron van de MCP-server.
        hrv = raw.get("hrv") or {}
        summary = hrv.get("hrvSummary") or {}
        row["hrv"] = _num(summary.get("lastNightAvg"))
        if row["hrv"] is None:
            row["hrv"] = _num(sleep.get("avgOvernightHrv"))
        row["hrv_baseline_low"] = _num((summary.get("baseline") or {}).get("lowUpper"))
        row["hrv_baseline_high"] = _num((summary.get("baseline") or {}).get("balancedUpper"))
        row["hrv_status"] = summary.get("status")

        # --- rusthartslag ---
        rhr = raw.get("rhr") or {}
        metrics = (rhr.get("allMetrics") or {}).get("metricsMap") or {}
        rhr_list = metrics.get("WELLNESS_RESTING_HEART_RATE") or []
        if rhr_list and isinstance(rhr_list[0], dict):
            row["rhr"] = _num(rhr_list[0].get("value"))
        else:
            row["rhr"] = _num((raw.get("summary") or {}).get("restingHeartRate"))

        # --- VO2max ---
        # get_max_metrics is op veel accounts leeg; get_training_status draagt
        # dezelfde waarde onder mostRecentVO2Max. Beide hebben de 'generic'-vorm.
        def _vo2_from(node):
            if isinstance(node, list) and node:
                node = node[0]
            if not isinstance(node, dict):
                return None
            gen = node.get("generic") or {}
            return _num(gen.get("vo2MaxPreciseValue")) or _num(gen.get("vo2MaxValue"))

        vo2_val = _vo2_from(raw.get("vo2max"))
        if vo2_val is None:
            vo2_val = _vo2_from((raw.get("training_status") or {}).get("mostRecentVO2Max"))
        row["vo2max"] = round(vo2_val, 1) if vo2_val else None

        # --- Garmin's eigen trainingsbelasting ---
        ts = raw.get("training_status") or {}
        balance = ts.get("mostRecentTrainingLoadBalance") or {}
        vals = list((balance.get("metricsTrainingLoadBalanceDTOMap") or {}).values())
        if vals and isinstance(vals[0], dict):
            row["garmin_load_7d"] = (_num(vals[0].get("trainingLoadAcute"))
                                     or _num(vals[0].get("trainingLoadChronic")))
        status_map = ts.get("mostRecentTrainingStatus") or {}
        smap = list((status_map.get("latestTrainingStatusData") or {}).values())
        if smap and isinstance(smap[0], dict):
            row["garmin_training_status"] = smap[0].get("trainingStatusFeedbackPhrase")

        # --- readiness ---
        rd = raw.get("readiness")
        if isinstance(rd, list) and rd and isinstance(rd[0], dict):
            row["readiness"] = _num(rd[0].get("score"))
        elif isinstance(rd, dict):
            row["readiness"] = _num(rd.get("score"))

        # --- dagoverzicht ---
        summ = raw.get("summary") or {}
        row["steps"] = _num(summ.get("totalSteps"))
        row["calories"] = _num(summ.get("totalKilocalories"))
        row["intensity_min"] = (_num(summ.get("moderateIntensityMinutes")) or 0) + \
                               2 * (_num(summ.get("vigorousIntensityMinutes")) or 0)
        row["body_battery_high"] = _num(summ.get("bodyBatteryHighestValue"))
        row["body_battery_low"] = _num(summ.get("bodyBatteryLowestValue"))
        row["stress_avg"] = _num(summ.get("averageStressLevel"))

        # Body Battery is het enige gemeten dagcijfer dat op- en ontlaadt. Twee
        # waardes zijn los bruikbaar: waar je mee wakker werd, en waar je nu
        # staat. Die eerste zegt iets over je nacht, die tweede over wat er nog
        # in zit. Ze door elkaar halen levert 's avonds een veel te rooskleurig
        # getal op -- 96 bij het ontwaken is om negen uur 's avonds vaak 26.
        row["bb_wake"] = _num(summ.get("bodyBatteryAtWakeTime"))
        row["bb_now"] = _num(summ.get("bodyBatteryMostRecentValue"))
        row["bb_charged"] = _num(summ.get("bodyBatteryChargedValue"))
        row["bb_drained"] = _num(summ.get("bodyBatteryDrainedValue"))

        # Ademhaling overdag. Een stijgende nachtwaarde is een vroeg signaal
        # van ziekte of onvoldoende herstel; los gelezen zegt hij weinig.
        row["resp_waking"] = _num(summ.get("avgWakingRespirationValue"))
        row["resp_sleep"] = _num(dto.get("averageRespirationValue"))

        # Garmin's eigen readiness. Anders dan VO2max en trainingsstatus komt
        # deze op dit account wel binnen. Het is een gemeten cijfer van Garmin,
        # naast -- niet in plaats van -- de eigen gereedheidsscore.
        if isinstance(rd, list) and rd and isinstance(rd[0], dict):
            row["readiness_level"] = rd[0].get("level")
            row["readiness_feedback"] = rd[0].get("feedbackShort")

        out[d] = row
    return out


# --------------------------------------------------------------------------
# Activiteiten
# --------------------------------------------------------------------------

def prepare_activities(cache: dict[str, Any], rest_hr: float, max_hr: float,
                       start: date, end: date) -> list[dict[str, Any]]:
    acts = []
    for raw in (cache.get("activities") or {}).values():
        stamp = raw.get("startTimeLocal") or raw.get("startTimeGMT")
        if not stamp:
            continue
        try:
            dt = datetime.fromisoformat(str(stamp).replace("Z", ""))
        except ValueError:
            continue
        if not (start <= dt.date() <= end):
            continue

        load, load_src = activity_load(raw, rest_hr, max_hr)
        dist_m = raw.get("distance") or 0
        dur_s = raw.get("duration") or 0
        z4 = raw.get("hrTimeInZone_4") or 0
        z5 = raw.get("hrTimeInZone_5") or 0
        hard_frac = ((z4 + z5) / dur_s) if dur_s else None

        acts.append({
            "id": str(raw.get("activityId")),
            "date": dt.date().isoformat(),
            "datetime": dt.isoformat(timespec="minutes"),
            "name": raw.get("activityName") or "",
            "type_key": ((raw.get("activityType") or {}).get("typeKey") or ""),
            "sport": classify(raw),
            "distance_m": dist_m,
            "duration_s": dur_s,
            "avg_hr": raw.get("averageHR"),
            "max_hr": raw.get("maxHR"),
            "calories": raw.get("calories"),
            "load": round(load, 1),
            "load_source": load_src,
            "aerobic_te": raw.get("aerobicTrainingEffect"),
            "anaerobic_te": raw.get("anaerobicTrainingEffect"),
            "hard_frac": round(hard_frac, 3) if hard_frac is not None else None,
            **{f"z{z}_s": raw.get(f"hrTimeInZone_{z}") or 0 for z in range(1, 6)},
            "pace_s_per_km": round(dur_s / (dist_m / 1000), 1) if dist_m and dist_m > 400 and dur_s else None,
            "elev_gain": raw.get("elevationGain"),
        })
    acts.sort(key=lambda a: a["datetime"], reverse=True)
    return acts


def effort_grade(a: dict[str, Any], max_hr: float) -> str:
    """Zwaarte-indeling van een sessie.

    Primair op tijd in zone 4+5 (Garmin's eigen zone-indeling):
      < 8%  -> Rustig | 8-25% -> Gemiddeld | > 25% -> Zwaar
    Zonder zonedata valt hij terug op gemiddelde hartslag t.o.v. HRmax
    (< 75% rustig, 75-85% gemiddeld, > 85% zwaar) - dat is de klassieke
    drie-zone-indeling zoals gebruikt in polarised-training onderzoek
    (o.a. Seiler S, Int J Sports Physiol Perform 5(3):276-91, 2010).
    """
    if a.get("hard_frac") is not None:
        if a["hard_frac"] > 0.25:
            return "Zwaar"
        if a["hard_frac"] >= 0.08:
            return "Gemiddeld"
        return "Rustig"
    if a.get("avg_hr") and max_hr:
        pct = a["avg_hr"] / max_hr
        if pct > 0.85:
            return "Zwaar"
        if pct >= 0.75:
            return "Gemiddeld"
        return "Rustig"
    return "Onbekend"


# --------------------------------------------------------------------------
# Aggregaties
# --------------------------------------------------------------------------

def week_key(d: str) -> str:
    dt = date.fromisoformat(d)
    monday = dt - timedelta(days=dt.weekday())
    return monday.isoformat()


def weekly_by_sport(acts: list[dict[str, Any]], field: str) -> dict[str, dict[str, float]]:
    out: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    for a in acts:
        out[week_key(a["date"])][a["sport"]] += a.get(field) or 0
    return {w: dict(v) for w, v in out.items()}


def moving_avg(values: list[float | None], window: int) -> list[float | None]:
    out: list[float | None] = []
    for i in range(len(values)):
        chunk = [v for v in values[max(0, i - window + 1):i + 1] if v is not None]
        out.append(round(sum(chunk) / len(chunk), 1) if chunk else None)
    return out


def linear_trend(xs: list[float], ys: list[float]) -> tuple[float, float] | None:
    """Kleinste-kwadraten regressie. Geeft (helling, intercept)."""
    n = len(xs)
    if n < 2:
        return None
    mx = sum(xs) / n
    my = sum(ys) / n
    denom = sum((x - mx) ** 2 for x in xs)
    if denom == 0:
        return None
    slope = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / denom
    return slope, my - slope * mx


# --------------------------------------------------------------------------
# Adviezen
# --------------------------------------------------------------------------

def build_advice(fitness: list[dict[str, Any]], acwr_series: list[dict[str, Any]],
                 daily: dict[str, dict[str, Any]], days: list[str],
                 acts: list[dict[str, Any]], max_hr: float) -> list[dict[str, str]]:
    """Genereer adviezen met het getal erbij. Elk advies is herleidbaar."""
    advice: list[dict[str, str]] = []
    if not fitness:
        return advice

    last = fitness[-1]
    ctl, atl, tsb = last["ctl"], last["atl"], last["tsb"]

    # --- vorm / TSB ---
    if tsb < -25:
        advice.append({
            "level": "critical",
            "title": "Je vermoeidheid loopt ver voor op je fitheid",
            "body": f"Vorm (TSB) staat op {tsb:.0f}: vermoeidheid ({atl:.0f}) ligt fors boven "
                    f"fitheid ({ctl:.0f}). Twee tot drie rustige dagen of een halve week terugschakelen "
                    f"is hier de standaardreactie in het impuls-responsmodel.",
        })
    elif tsb < -10:
        advice.append({
            "level": "warning",
            "title": "Stevige belastingsfase",
            "body": f"TSB {tsb:.0f}. Prima tijdens een opbouwblok, maar niet iets om weken "
                    f"vol te houden. Plan een lichte dag binnen 3-4 dagen.",
        })
    elif tsb > 15:
        advice.append({
            "level": "good",
            "title": "Je bent fris",
            "body": f"TSB {tsb:+.0f}. Goed moment voor een zware sessie, een test of een wedstrijd. "
                    f"Blijft dit lang zo hoog, dan zakt je fitheid ({ctl:.0f}) langzaam weg.",
        })

    # --- ACWR ---
    if acwr_series:
        ratio = acwr_series[-1]["acwr"]
        if ratio > 1.5:
            advice.append({
                "level": "critical",
                "title": f"Belastingssprong: ACWR {ratio:.2f}",
                "body": "Je 7-daagse belasting ligt meer dan 1,5x je 28-daagse gemiddelde. "
                        "In Gabbett's data hangt dat samen met een verhoogd blessurerisico. "
                        "Bouw komende week af richting 1,0-1,3.",
            })
        elif ratio < 0.8 and ratio > 0:
            advice.append({
                "level": "warning",
                "title": f"Belasting zakt weg: ACWR {ratio:.2f}",
                "body": "Je doet deze week duidelijk minder dan je maandgemiddelde. Prima als "
                        "het bewust is (herstelweek, blessure); anders verlies je conditie.",
            })

    # --- HRV vs eigen baseline ---
    hrv_vals = [daily[d].get("hrv") for d in days if daily.get(d)]
    recent_hrv = [v for v in hrv_vals[-7:] if v]
    base_hrv = [v for v in hrv_vals[-60:-7] if v]
    if len(recent_hrv) >= 3 and len(base_hrv) >= 10:
        r = sum(recent_hrv) / len(recent_hrv)
        b = sum(base_hrv) / len(base_hrv)
        delta = (r - b) / b * 100
        if delta < -8:
            advice.append({
                "level": "serious",
                "title": f"HRV {delta:.0f}% onder je eigen baseline",
                "body": f"7-daags gemiddelde {r:.0f} ms tegen een baseline van {b:.0f} ms. "
                        f"Een aanhoudende daling wijst op onvoldoende herstel, maar kan net zo goed "
                        f"door slaaptekort, alcohol of ziekte komen. Kijk of het samenvalt met je RHR.",
            })
        elif delta > 8:
            advice.append({
                "level": "good",
                "title": f"HRV {delta:+.0f}% boven baseline",
                "body": f"7-daags gemiddelde {r:.0f} ms tegen baseline {b:.0f} ms. Je herstelt goed.",
            })

    # --- rusthartslag ---
    rhr_vals = [daily[d].get("rhr") for d in days if daily.get(d)]
    recent_rhr = [v for v in rhr_vals[-7:] if v]
    base_rhr = [v for v in rhr_vals[-60:-7] if v]
    if len(recent_rhr) >= 3 and len(base_rhr) >= 10:
        r = sum(recent_rhr) / len(recent_rhr)
        b = sum(base_rhr) / len(base_rhr)
        if r - b >= 3:
            advice.append({
                "level": "warning",
                "title": f"Rusthartslag {r - b:.0f} slagen boven je baseline",
                "body": f"7-daags gemiddelde {r:.0f} bpm tegen {b:.0f} bpm. Samen met een lage HRV "
                        f"is dat het klassieke beeld van te weinig herstel of een opkomende infectie.",
            })

    # --- slaap ---
    sleep_vals = [daily[d].get("sleep_h") for d in days[-14:] if daily.get(d)]
    sleep_ok = [v for v in sleep_vals if v]
    if len(sleep_ok) >= 5:
        avg_sleep = sum(sleep_ok) / len(sleep_ok)
        if avg_sleep < 7:
            advice.append({
                "level": "warning",
                "title": f"Gemiddeld {avg_sleep:.1f} uur slaap over 14 dagen",
                "body": "Onder de 7 uur bij 8-9 trainingen per week is krap. Slaap is de enige "
                        "hersteltool met een groter effect dan alles wat je kunt slikken.",
            })

    # --- verdeling rustig/zwaar ---
    cutoff = days[-28] if len(days) >= 28 else days[0]
    graded = [effort_grade(a, max_hr) for a in acts if a["date"] >= cutoff]
    if len(graded) >= 8:
        easy = graded.count("Rustig")
        pct_easy = easy / len(graded) * 100
        if pct_easy < 55:
            advice.append({
                "level": "serious",
                "title": f"Maar {pct_easy:.0f}% van je sessies is echt rustig",
                "body": f"{easy} van {len(graded)} sessies in de laatste 4 weken viel in de rustige "
                        f"categorie. Met 5 handbalavonden erbij is het risico dat alles 'middelmatig zwaar' "
                        f"wordt. Polarised-training onderzoek wijst richting ~75-80% rustig.",
            })

    if not advice:
        advice.append({
            "level": "good",
            "title": "Niets bijzonders",
            "body": "Belasting, herstel en slaap zitten binnen je normale marges. Doorgaan.",
        })
    return advice


# --------------------------------------------------------------------------
# Duiding per grafiek
# --------------------------------------------------------------------------

def zone_minutes(acts: list[dict[str, Any]], since: str | None = None) -> list[float]:
    """Minuten per hartslagzone, opgeteld over de sessies. Index 1 t/m 5."""
    out = [0.0] * 6
    for a in acts:
        if since and a["date"] < since:
            continue
        for z in range(1, 6):
            out[z] += (a.get(f"z{z}_s") or 0) / 60.0
    return out


def build_insights(fitness, acwr_series, daily, days, acts, weekly,
                   grade_hours, runs, max_hr, coverage, zones=None):
    """Eén korte duiding per grafiek, altijd met het getal erbij.

    Elke drempel is een vuistregel. Ze staan hier bij elkaar zodat je ze
    kunt bijstellen zonder door de rest van de code te hoeven.
    """
    out = {}
    if not fitness:
        return out

    def add(key, status, title, body):
        out[key] = {"status": status, "title": title, "body": body}

    last28 = fitness[-28:] if len(fitness) >= 28 else fitness
    ctl, atl, tsb = fitness[-1]["ctl"], fitness[-1]["atl"], fitness[-1]["tsb"]

    # ---- fitheid vs vermoeidheid ----
    dagen_atl_boven = sum(1 for x in last28 if x["atl"] > x["ctl"])
    if dagen_atl_boven > len(last28) * 0.7:
        add("chFitness", "warning",
            f"Je vermoeidheid ligt al {dagen_atl_boven} van de laatste {len(last28)} dagen boven je fitheid",
            f"ATL staat op {atl:.0f}, CTL op {ctl:.0f}. Dat is het patroon van een opbouwfase: je stopt er meer "
            f"in dan je verwerkt. Prima voor een blok van drie tot vier weken, maar het hoort af te wisselen met "
            f"een lichtere week waarin de oranje lijn onder de blauwe zakt. Zie je dat nooit gebeuren, plan het dan.")
    elif ctl > last28[0]["ctl"] * 1.05:
        add("chFitness", "good", "Je bouwt op",
            f"CTL is gestegen van {last28[0]['ctl']:.0f} naar {ctl:.0f} over deze periode, terwijl je vermoeidheid "
            f"({atl:.0f}) daar niet ver bovenuit schiet. Dit is precies hoe opbouw eruit hoort te zien.")
    else:
        add("chFitness", "neutral", "Je houdt je niveau vast",
            f"CTL {ctl:.0f}, ATL {atl:.0f}. Geen duidelijke op- of afbouw. Prima in een onderhoudsfase; "
            f"wil je vooruit, dan moet de blauwe lijn omhoog.")

    # ---- vorm ----
    onder = sum(1 for x in last28 if x["tsb"] < 0)
    diep = sum(1 for x in last28 if x["tsb"] < -25)
    boven = len(last28) - onder
    if diep >= 7:
        add("chTsb", "serious",
            f"{diep} van de laatste {len(last28)} dagen stond je diep in de min",
            f"Onder de -25 betekent dat je vermoeidheid je fitheid ver voorbij is. Nu staat hij op {tsb:.0f}. "
            f"Zoveel diepe dagen zonder herstelmomenten ertussen is het patroon waarop mensen vastlopen. "
            f"Plan twee opeenvolgende rustige dagen in — geen volledige rust, wel zone 1 en 2.")
    elif onder > len(last28) * 0.85:
        add("chTsb", "warning",
            f"Je stond {onder} van de laatste {len(last28)} dagen onder nul",
            f"Vorm staat nu op {tsb:.0f}. Continu onder nul is normaal in het seizoen, maar zonder pieken boven "
            f"nul kom je nooit fris aan de start van een wedstrijd. Waar zie je in de grafiek blauw? Als dat "
            f"alleen in je rustperiode was, mis je herstelmomenten in je huidige blok.")
    elif boven > len(last28) * 0.5:
        add("chTsb", "good", "Je bent overwegend fris",
            f"{boven} van de {len(last28)} dagen boven nul, nu {tsb:.0f}. Goed voor wedstrijden. "
            f"Blijft dit weken zo, dan zakt je fitheid langzaam weg — dan mag er weer belasting bij.")
    else:
        add("chTsb", "good", "Gezonde afwisseling",
            f"{onder} dagen belast, {boven} dagen fris, nu {tsb:.0f}. Zo hoort het eruit te zien: "
            f"belasting afgewisseld met herstel.")

    # ---- weekbelasting per sport ----
    if weekly:
        vol = [(w["week"], sum(w["load"].values())) for w in weekly if sum(w["load"].values()) > 0]
        if len(vol) >= 3:
            sporten = {}
            for w in weekly[-4:]:
                for sp, v in w["load"].items():
                    sporten[sp] = sporten.get(sp, 0) + v
            tot = sum(sporten.values()) or 1
            top = max(sporten, key=sporten.get)
            aandeel = sporten[top] / tot * 100
            ontbreekt = [sp for sp, v in sporten.items() if v == 0]
            body = (f"In de laatste 4 weken komt {aandeel:.0f}% van je belasting uit {top.lower()}. ")
            if ontbreekt:
                body += (f"Niets geregistreerd voor: {', '.join(s.lower() for s in ontbreekt)}. "
                         f"Doe je dat wel maar neem je het niet op, dan rekent dit dashboard met een "
                         f"onvolledig beeld van je week.")
            else:
                body += "Een gemengde verdeling is gunstig: verschillende sporten belasten verschillende weefsels."
            add("chWeekLoad", "warning" if aandeel > 75 else "neutral",
                f"{top} is je zwaarste blok" if aandeel > 40 else "Gemengde belasting", body)

    # ---- ACWR ----
    if acwr_series:
        nu = acwr_series[-1]["acwr"]
        hoog = sum(1 for x in acwr_series[-28:] if x["acwr"] > 1.5)
        if nu > 1.5:
            add("chAcwr", "serious", f"Je zit nu op {nu:.2f}",
                "Je week ligt meer dan anderhalf keer boven je maandgemiddelde. Bouw de komende week af "
                "richting 1,0 tot 1,3 in plaats van door te stapelen.")
        elif hoog >= 5:
            add("chAcwr", "warning", f"{hoog} dagen boven 1,5 in de laatste 4 weken",
                f"Nu {nu:.2f}. Losse pieken zijn niet erg, maar herhaalde sprongen zijn precies waar "
                "de blessurestatistiek ongunstig wordt. Kijk of je die pieken kunt spreiden.")
        elif nu < 0.8:
            add("chAcwr", "warning", f"Je zakt weg: {nu:.2f}",
                "Je doet deze week duidelijk minder dan je maandgemiddelde. Bewust na een zware periode is "
                "prima; onbewust betekent het conditieverlies.")
        else:
            add("chAcwr", "good", f"Stabiel op {nu:.2f}",
                "Je week past bij je maandgemiddelde. Dit is de zone waarin je veilig kunt opbouwen.")

    # ---- weekkilometers ----
    kms = [w["km"] for w in weekly]
    if any(kms):
        leeg = sum(1 for k in kms[-4:] if k == 0)
        if leeg >= 3:
            add("chKm", "warning", f"Je hebt {leeg} van de laatste 4 weken niet hardgelopen",
                "Hardlopen onderhoudt de aerobe basis waarop je herstel tussen sprints draait. Twee rustige "
                "duurlopen per week van 30 tot 45 minuten kosten weinig en houden vast wat je eerder opbouwde.")
        elif kms[-1] > 0 and len(kms) >= 5 and kms[-1] > sum(kms[-5:-1]) / 4 * 1.3:
            add("chKm", "warning", "Je kilometers lopen snel op",
                f"Deze week {kms[-1]:.0f} km tegen een gemiddelde van {sum(kms[-5:-1])/4:.0f} km. "
                "De vuistregel is niet meer dan ongeveer 10% per week erbij.")
        else:
            add("chKm", "good", "Stabiel loopvolume", "Geen grote sprongen in je weekkilometers.")

    # ---- intensiteitsverdeling, op werkelijke tijd per hartslagzone ----
    # Niet op sessieniveau: een handbaltraining van twee uur waarvan 45% in
    # zone 1 valt, is geen "zware sessie" ook al zitten er pieken in.
    if zones and sum(zones) > 60:
        tot = sum(zones)
        laag = (zones[1] + zones[2]) / tot * 100
        matig = zones[3] / tot * 100
        hoog = (zones[4] + zones[5]) / tot * 100
        basis = (f"Van de {tot/60:.0f} gemeten uren zit {laag:.0f}% laag (zone 1-2), "
                 f"{matig:.0f}% matig (zone 3) en {hoog:.0f}% hoog (zone 4-5). ")
        if laag < 55:
            add("chZones", "serious", f"Maar {laag:.0f}% van je tijd is echt laag",
                basis + "Onderzoek naar intensiteitsverdeling wijst richting ongeveer 75-80% laag "
                        "(Seiler, 2010). Te veel middenwerk is te hard om van te herstellen en te zacht "
                        "om van te verbeteren.")
        elif matig > 30:
            add("chZones", "warning", f"{matig:.0f}% van je tijd zit in het middengebied",
                basis + "Dat middengebied is de klassieke valkuil. Maak je rustige werk echt rustig, "
                        "dan kun je je harde werk ook echt hard maken.")
        elif laag < 70:
            add("chZones", "neutral", f"{laag:.0f}% laag, {hoog:.0f}% hoog",
                basis + "Redelijke verdeling. Bij een polarised opzet zou het lage deel richting 75-80% gaan.")
        else:
            add("chZones", "good", f"Gezonde verdeling: {laag:.0f}% laag, {hoog:.0f}% hoog",
                basis + "Dit lijkt op de verdeling die bij goed getrainde duursporters wordt gezien: "
                        "veel laag, een beetje hoog, weinig ertussenin.")

    # ---- hartslag rustige duurlopen ----
    easy = [r for r in runs if r.get("grade") == "Rustig" and r.get("avg_hr")]
    if len(easy) >= 4:
        asc = sorted(easy, key=lambda r: r["date"])
        half = len(asc) // 2
        vroeg = sum(r["avg_hr"] for r in asc[:half]) / half
        laat = sum(r["avg_hr"] for r in asc[half:]) / (len(asc) - half)
        d = laat - vroeg
        if d <= -3:
            add("chEasy", "good", f"Je hartslag op rustige lopen is {abs(d):.0f} slagen gezakt",
                f"Van gemiddeld {vroeg:.0f} naar {laat:.0f} bpm. Bij vergelijkbaar tempo betekent dat een "
                f"betere aerobe basis. Controleer wel even in de tabel of je tempo gelijk bleef.")
        elif d >= 3:
            add("chEasy", "warning", f"Je hartslag op rustige lopen is {d:.0f} slagen gestegen",
                f"Van {vroeg:.0f} naar {laat:.0f} bpm. Dat kan liggen aan hitte, vermoeidheid of een hoger tempo. "
                f"Blijft het weken zo bij gelijk tempo, dan is het een teken van opgestapelde vermoeidheid.")
        else:
            add("chEasy", "neutral", "Stabiele hartslag op rustige lopen",
                f"Gemiddeld {laat:.0f} bpm, nauwelijks verschil met eerder in de periode.")

    # ---- herstelpanelen: eerlijk over dekking ----
    n = len(days)
    for key, veld, naam in (("chHrv", "hrv", "HRV"), ("chRhr", "rhr", "rusthartslag"),
                            ("chSleep", "sleep_h", "slaap"), ("chVo2", "vo2max", "VO2max")):
        c = coverage.get(veld, 0)
        if c == 0:
            continue
        if c < n * 0.5:
            add(key, "neutral", f"Gebaseerd op {c} van {n} dagen",
                f"Te weinig metingen om een trend op te baseren. Draag je band vaker, ook 's nachts, "
                f"dan wordt dit paneel bruikbaar.")
    return out


# --------------------------------------------------------------------------
# Vooruitkijken: weekplan, projectie en scenario's
# --------------------------------------------------------------------------

WEEKDAG = ["maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag", "zondag"]
WEEKDAG_KORT = ["ma", "di", "wo", "do", "vr", "za", "zo"]


def typische_belasting(acts: list[dict[str, Any]], sport: str,
                       min_minuten: float | None = None) -> float | None:
    """Mediaan van de belasting van eerdere sessies van deze sport.

    De mediaan en niet het gemiddelde, omdat één uitschieter (een afgebroken
    training van negen minuten) het gemiddelde onbruikbaar maakt.
    """
    v = [a["load"] for a in acts
         if a["sport"] == sport
         and (min_minuten is None or (a["duration_s"] or 0) >= min_minuten * 60)]
    if not v:
        return None
    v.sort()
    n = len(v)
    return v[n // 2] if n % 2 else (v[n // 2 - 1] + v[n // 2]) / 2


def sport_normen(acts: list[dict[str, Any]]) -> dict[str, dict[str, float]]:
    """Per sport de mediane belasting en mediane duur van je eerdere sessies.

    Dit is wat de browser nodig heeft om een geplande sessie in te schatten:
    plan je 90 minuten kracht terwijl je mediane krachtsessie 60 minuten is,
    dan schaalt de schatting mee. Lineair -- dat is een versimpeling (het
    tweede uur van een training is zelden even zwaar als het eerste), maar
    zonder hartslagdata van een sessie die nog moet plaatsvinden is er geen
    betere schatter beschikbaar.
    """
    per: dict[str, list[tuple[float, float]]] = {}
    for a in acts:
        minuten = (a.get("duration_s") or 0) / 60
        if minuten <= 0 or not a.get("load"):
            continue
        per.setdefault(a["sport"], []).append((a["load"], minuten))
    uit: dict[str, dict[str, float]] = {}
    for sport, paren in per.items():
        lasten = sorted(p[0] for p in paren)
        duren = sorted(p[1] for p in paren)
        n = len(lasten)
        med = lambda xs: xs[len(xs) // 2] if len(xs) % 2 else (xs[len(xs) // 2 - 1] + xs[len(xs) // 2]) / 2
        uit[sport] = {"load": round(med(lasten), 1),
                      "minuten": round(med(duren)),
                      "n": n}
    return uit


def maak_plan(today: date, horizon: int, weekplan: dict[int, dict[str, Any]],
              acts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Zet het vaste weekritme om in concrete dagen met een geschatte belasting."""
    out = []
    for i in range(1, horizon + 1):
        d = today + timedelta(days=i)
        item = weekplan.get(d.weekday())
        if not item:
            out.append({"date": d.isoformat(), "weekday": WEEKDAG_KORT[d.weekday()],
                        "label": "rust", "sport": None, "load": 0.0, "bron": "rustdag"})
            continue
        load = item.get("load")
        bron = "handmatig ingesteld"
        if load is None:
            load = typische_belasting(acts, item["sport"], item.get("min_minuten"))
            bron = f"mediaan van je eerdere {item['sport'].lower()}sessies"
        if load is None:
            load, bron = 0.0, "geen historie"
        out.append({"date": d.isoformat(), "weekday": WEEKDAG_KORT[d.weekday()],
                    "label": item["label"], "sport": item["sport"],
                    "load": round(load, 1), "bron": bron,
                    "doel": bool(item.get("doel"))})
    return out


def projecteer(daily_load: dict[str, float], calc_days: list[str],
               plan: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Zet fitheid, vermoeidheid en vorm door in de toekomst.

    Zelfde formules als voor het verleden — alleen de belasting is nu een
    schatting in plaats van een meting. Daarom is dit een projectie, geen
    voorspelling: wijkt je week af, dan wijkt de uitkomst mee.
    """
    loads = dict(daily_load)
    for p in plan:
        loads[p["date"]] = p["load"]
    alle = calc_days + [p["date"] for p in plan]
    reeks = ewma_series(loads, alle)
    idx = {r["date"]: r for r in reeks}
    return [{**p, **{k: idx[p["date"]][k] for k in ("ctl", "atl", "tsb")}} for p in plan]


def scenarios(daily_load: dict[str, float], calc_days: list[str],
              plan: list[dict[str, Any]], doeldatum: str) -> list[dict[str, Any]]:
    """Wat gebeurt er met je vorm op de doeldag bij verschillende keuzes?"""
    def met(aanpassing) -> float | None:
        gewijzigd = [dict(p) for p in plan]
        for p in gewijzigd:
            aanpassing(p)
        rij = projecteer(daily_load, calc_days, gewijzigd)
        treffer = next((r for r in rij if r["date"] == doeldatum), None)
        return treffer["tsb"] if treffer else None

    vrijdag = (date.fromisoformat(doeldatum) - timedelta(days=1)).isoformat()
    donderdag = (date.fromisoformat(doeldatum) - timedelta(days=2)).isoformat()

    def halveer(datums):
        def f(p):
            if p["date"] in datums and p["load"]:
                p["load"] = round(p["load"] * 0.5, 1)
        return f

    def rust(datums):
        def f(p):
            if p["date"] in datums:
                p["load"] = 0.0
        return f

    opties = [
        ("Zoals gepland", "Je vaste week, niets aangepast.", lambda p: None),
        ("Vrijdag half", "Vrijdag korter of rustiger meedoen.", halveer({vrijdag})),
        ("Vrijdag rust", "Vrijdag helemaal overslaan.", rust({vrijdag})),
        ("Do + vr rustig", "Beide laatste trainingen op halve kracht.",
         halveer({donderdag, vrijdag})),
    ]
    uit = []
    for naam, uitleg, f in opties:
        tsb = met(f)
        if tsb is not None:
            uit.append({"naam": naam, "uitleg": uitleg, "tsb": tsb})
    return uit


def plan_advies(projectie: list[dict[str, Any]], opties: list[dict[str, Any]],
                doel: dict[str, Any] | None) -> dict[str, str]:
    """Kies het scenario dat je het dichtst bij een frisse wedstrijddag brengt.

    Streefwaarde: vorm tussen -5 en +10 op de wedstrijddag. Dat is de band die
    in het impuls-responsmodel als 'uitgerust maar niet afgetraind' geldt. Voor
    een teamsporter midden in het seizoen is +25 onhaalbaar en ook niet nodig.
    """
    if not doel or not opties:
        return {}
    gepland = next((o for o in opties if o["naam"] == "Zoals gepland"), opties[0])
    if gepland["tsb"] >= -5:
        return {"status": "good",
                "titel": f"Je staat er goed voor: vorm {gepland['tsb']:+.0f} op {doel['weekday']}",
                "body": "Je hoeft niets aan te passen. Je vaste week brengt je fris genoeg aan de start."}
    # zoek de lichtste ingreep die binnen de band komt
    for o in opties[1:]:
        if o["tsb"] >= -5:
            return {"status": "warning",
                    "titel": f"Zonder aanpassing sta je op vorm {gepland['tsb']:+.0f}",
                    "body": f"Kies je '{o['naam'].lower()}', dan kom je uit op {o['tsb']:+.0f} — "
                            f"binnen de band waarin je uitgerust aan de start staat. {o['uitleg']}"}
    beste = max(opties, key=lambda o: o["tsb"])
    return {"status": "serious",
            "titel": f"Ook met rust haal je maar vorm {beste['tsb']:+.0f}",
            "body": "Je vaste week is zwaar genoeg dat je met deze opzet niet fris op de wedstrijddag "
                    "komt. Dat hoeft geen probleem te zijn in een opbouwfase, maar wil je piekend aan "
                    "de start staan, dan moet er eerder in de week belasting af."}


# --------------------------------------------------------------------------
# Basislijn: wat is normaal voor JOU
# --------------------------------------------------------------------------
# Model overgenomen van Apple's Vitals-app: leer per meting het eigen bereik,
# label afwijkingen als uitschieter, en signaleer pas als er twee tegelijk
# afwijken. Dat laatste voorkomt vals alarm op een enkele slechte nacht.

MIN_METINGEN_BASISLIJN = 7      # Apple hanteert zeven nachten
UITSCHIETER_FACTOR = 1.5        # afwijking t.o.v. de spreiding


def _mediaan(xs: list[float]) -> float | None:
    xs = sorted(x for x in xs if x is not None)
    if not xs:
        return None
    n = len(xs)
    return xs[n // 2] if n % 2 else (xs[n // 2 - 1] + xs[n // 2]) / 2


def _spreiding(xs: list[float]) -> float | None:
    """Halve interkwartielafstand: robuuster dan een standaarddeviatie."""
    xs = sorted(x for x in xs if x is not None)
    if len(xs) < 4:
        return None
    q1 = xs[len(xs) // 4]
    q3 = xs[3 * len(xs) // 4]
    return max((q3 - q1) / 2, 1e-9)


def basislijn(waarden: list[float | None], laatste: float | None,
              naam: str, eenheid: str, omlaag_is_slecht: bool = True) -> dict[str, Any] | None:
    """Bepaal of de laatste meting binnen je eigen normale bereik valt."""
    beschikbaar = [v for v in waarden if v is not None]
    if laatste is None or len(beschikbaar) < MIN_METINGEN_BASISLIJN:
        return {"naam": naam, "genoeg": False, "n": len(beschikbaar),
                "nodig": MIN_METINGEN_BASISLIJN}
    med = _mediaan(beschikbaar)
    spr = _spreiding(beschikbaar)
    if med is None or spr is None:
        return {"naam": naam, "genoeg": False, "n": len(beschikbaar),
                "nodig": MIN_METINGEN_BASISLIJN}
    afwijking = laatste - med
    grens = UITSCHIETER_FACTOR * spr
    uitschieter = abs(afwijking) > grens
    richting = "hoger" if afwijking > 0 else "lager"
    slecht = uitschieter and ((afwijking < 0) == omlaag_is_slecht)
    return {"naam": naam, "genoeg": True, "n": len(beschikbaar),
            "waarde": round(laatste, 1), "mediaan": round(med, 1),
            "onder": round(med - grens, 1), "boven": round(med + grens, 1),
            "uitschieter": uitschieter, "richting": richting, "ongunstig": slecht,
            "eenheid": eenheid}


def slaapregelmaat(starts: list[str | None], eindes: list[str | None]) -> dict[str, Any] | None:
    """Hoe constant zijn je bed- en opstatijd?

    Onregelmatige slaaptijden zijn een eigen signaal naast slaapduur; bij een
    sporter met avondtrainingen tot elf uur is dat een reeel aandachtspunt.
    Gerapporteerd als de gemiddelde afwijking in minuten t.o.v. je eigen
    mediane tijdstip.
    """
    def minuten(ts):
        if not ts:
            return None
        try:
            t = datetime.fromisoformat(str(ts).replace("Z", "").split(".")[0])
        except ValueError:
            return None
        m = t.hour * 60 + t.minute
        return m - 1440 if m > 1080 else m      # na 18:00 telt als "vorige dag"

    bed = [m for m in (minuten(x) for x in starts) if m is not None]
    op = [m for m in (minuten(x) for x in eindes) if m is not None]
    if len(bed) < 5:
        return {"genoeg": False, "n": len(bed)}

    def spreiding_min(xs):
        med = _mediaan(xs)
        return sum(abs(x - med) for x in xs) / len(xs), med

    bed_sp, bed_med = spreiding_min(bed)
    op_sp, op_med = spreiding_min(op) if len(op) >= 5 else (None, None)

    def klok(m):
        m = int(round(m)) % 1440
        return f"{m // 60:02d}:{m % 60:02d}"

    return {"genoeg": True, "n": len(bed),
            "bed_spreiding": round(bed_sp), "bed_mediaan": klok(bed_med),
            "op_spreiding": round(op_sp) if op_sp is not None else None,
            "op_mediaan": klok(op_med) if op_med is not None else None}


# --------------------------------------------------------------------------
# Harde minuten: het signaal dat volume mist
# --------------------------------------------------------------------------

def harde_minuten_per_dag(acts: list[dict[str, Any]], days: list[str]) -> dict[str, float]:
    """Minuten in zone 4 en 5 per dag."""
    uit: dict[str, float] = {d: 0.0 for d in days}
    for a in acts:
        if a["date"] in uit:
            uit[a["date"]] += ((a.get("z4_s") or 0) + (a.get("z5_s") or 0)) / 60.0
    return uit


def harde_minuten_verhouding(per_dag: dict[str, float], days: list[str]) -> list[dict[str, Any]]:
    """Zelfde acuut-chronischlogica als ACWR, maar op harde minuten.

    Reden voor een eigen maat: eind juli verdrievoudigden Livio's minuten in
    zone 4-5 terwijl het totale volume vlak bleef. Een verhouding op totale
    belasting ziet dat niet; deze wel.
    """
    idx = {d: i for i, d in enumerate(days)}
    v = [per_dag.get(d, 0.0) for d in days]
    uit = []
    for d in days:
        i = idx[d]
        acuut = sum(v[max(0, i - 6):i + 1])
        chronisch = sum(v[max(0, i - 27):i + 1]) / min(4, (i + 7) // 7 or 1)
        ratio = (acuut / chronisch) if chronisch > 0 else 0.0
        uit.append({"date": d, "minuten": round(acuut, 1), "ratio": round(ratio, 2)})
    return uit


# --------------------------------------------------------------------------
# Gereedheid: het antwoord op "kan ik vandaag vol gaan"
# --------------------------------------------------------------------------

def gereedheid(hrv_nu: float | None, hrv_basis: dict[str, Any] | None,
               slaap_h: float | None, slaap_score: float | None,
               tsb: float | None) -> dict[str, Any]:
    """Samengestelde gereedheidsscore van 0 tot 100.

    Drie bouwstenen, elk met een gewicht: je nachtelijk herstel (0,50), je
    belasting (0,30) en hoe je je voelt (0,20). Ontbreekt er een, dan worden
    de gewichten van de overige herverdeeld en zegt het dashboard erbij
    waarop de score dan stoelt -- een score die doet alsof hij drie signalen
    weegt terwijl hij er een heeft, is misleidend.

    Over dat gewicht van het gevoel: het stond eerst op 0,40, met een beroep
    op Saw, Main & Gastin (BJSM 2016), waar subjectieve maten in een review
    van 56 studies de belasting gevoeliger volgden dan objectieve metingen.
    Dat onderzoek staat nog steeds, maar het gaat over gestructureerde,
    gevalideerde vragenlijsten die dagelijks worden afgenomen -- niet over
    een schuifje van 1 tot 5 dat je zelf invult als je eraan denkt. Bij deze
    invoer weegt de meting zwaarder dan de indruk, en daarom staat het gevoel
    nu op 0,20: het telt mee, maar het kan de gemeten nacht niet overstemmen.

    Dit deel van de score wordt in de BROWSER opnieuw doorgerekend zodra je
    de dagelijkse check hebt ingevuld; Python levert alleen de objectieve
    componenten aan.

    Opzet geinspireerd op Garmin's Training Readiness (zes factoren) en
    WHOOP's herstelpercentage (vier signalen). Met een borstband zijn er
    hooguit drie meetbaar; dat is een beperking van de apparatuur, geen
    tekortkoming van het model.
    """
    def klem(x):
        return max(0.0, min(1.0, x))

    delen = []

    # HRV en slaap gaan SAMEN in een component. Ze los meewegen betekent
    # dezelfde nachtelijke toestand twee keer straffen -- multicollineariteit,
    # in Doherty e.a. (2025) expliciet als probleem van commerciele
    # herstelscores benoemd. Een slechte nacht werd daardoor kunstmatig
    # catastrofaal. Nu leveren ze samen een cijfer.
    herstel = []
    if hrv_nu is not None and hrv_basis and hrv_basis.get("genoeg"):
        ratio = hrv_nu / hrv_basis["mediaan"] if hrv_basis["mediaan"] else 1.0
        herstel.append(klem((ratio - 0.75) / 0.25))
    if slaap_h is not None:
        herstel.append(klem((slaap_h - 5.5) / 2.5))
    if slaap_score is not None:
        herstel.append(klem(slaap_score / 100))
    if herstel:
        delen.append(("Herstel", 0.50, sum(herstel) / len(herstel)))

    # Vorm: hoe ver loopt je vermoeidheid voor op je fitheid
    if tsb is not None:
        delen.append(("Belasting", 0.30, klem((tsb + 35) / 40)))

    if not delen:
        return {"score": None, "band": "onbekend", "gebruikt": [], "ruw": [],
                "uitleg": "Geen van de drie bouwstenen is beschikbaar."}

    totaal_gewicht = sum(g for _, g, _ in delen)
    score = round(sum(g * w for _, g, w in delen) / totaal_gewicht * 100)

    if score >= 75:
        band, woord = "good", "goed hersteld"
    elif score >= 50:
        band, woord = "good", "voldoende hersteld"
    elif score >= 30:
        band, woord = "warning", "beperkt hersteld"
    else:
        band, woord = "serious", "slecht hersteld"

    return {"score": score, "band": band, "woord": woord,
            "gebruikt": [{"naam": n, "gewicht": round(g / totaal_gewicht * 100),
                          "deel": round(w * 100)} for n, g, w in delen],
            # De onafgeronde onderdelen met hun oorspronkelijke gewicht, zodat
            # de browser het gevoel eraan kan toevoegen en opnieuw kan wegen.
            "ruw": [{"naam": n, "gewicht": g, "deel": w} for n, g, w in delen],
            "volledig": False}
