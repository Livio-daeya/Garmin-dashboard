#!/usr/bin/env python3
"""
cloud/bouw.py — het dashboard bouwen op GitHub in plaats van op je Mac.

Waarom dit bestaat: je Mac staat 's avonds dicht, en dan haalt hij niets op.
Deze versie draait bij GitHub, dus je hebt er geen computer voor nodig. Een
paar minuten na je training staat de nieuwe data online.

WAT WAAR STAAT, EN WAAROM DAAR
    Garmin-tokens   in een Actions-secret van deze repository. Nergens
                    anders. Ze staan niet in de pagina en niet in de gist,
                    zodat het token dat in je dashboard zit er niet bij kan.
                    Garmin draait het verversingstoken bij elk gebruik, dus
                    het secret wordt na afloop bijgewerkt -- gebeurt dat niet,
                    dan is de koppeling na een tijdje stuk.
    Cache           in een prive-gist, ingepakt en base64. Die is te groot
                    voor een secret en hoort niet in een publieke repository.
    index.html      in deze repository, versleuteld met je wachtwoordzin.
                    Dat is het enige wat publiek staat, en dat was het al.

Alles draait op wat er in de omgeving staat:
    GARMIN_TOKENS   de tokeninhoud (JSON)
    DASHBOARD_PW    je wachtwoordzin voor de versleutelde pagina
    MOTOR_GIST      gist-id waar de cache in staat
    GH_PAT          token met rechten op gists en op de secrets van deze repo
    SYNC_GIST       gist-id van je synchronisatie (gaat mee de pagina in)
    SYNC_TOKEN      token daarvoor (gaat mee de pagina in, versleuteld)
    GITHUB_REPOSITORY  wordt door Actions zelf gezet
"""

from __future__ import annotations

import base64
import gzip
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

HIER = Path(__file__).resolve().parent
WORTEL = HIER.parent
sys.path.insert(0, str(WORTEL))

TOKENMAP = WORTEL / "garmin_tokens"
os.environ.setdefault("GARMINTOKENS", str(TOKENMAP))

CACHE_BESTAND = "cache.json.gz.b64"
TOKEN_SECRET = "GARMIN_TOKENS"


def env(naam: str, verplicht: bool = True) -> str:
    waarde = os.environ.get(naam, "").strip()
    if verplicht and not waarde:
        sys.exit(f"De omgevingsvariabele {naam} is leeg. Zet hem als secret in de repository.")
    return waarde


# ==========================================================================
# GitHub
# ==========================================================================

def gh(pad: str, token: str, data: dict | None = None, methode: str = "GET") -> dict:
    verzoek = urllib.request.Request(
        f"https://api.github.com{pad}",
        data=json.dumps(data).encode("utf-8") if data is not None else None,
        method=methode,
        headers={"Authorization": f"Bearer {token}",
                 "Accept": "application/vnd.github+json",
                 "X-GitHub-Api-Version": "2022-11-28",
                 "Content-Type": "application/json",
                 "User-Agent": "sportdashboard"},
    )
    try:
        with urllib.request.urlopen(verzoek, timeout=60) as antwoord:
            rauw = antwoord.read().decode("utf-8")
            return json.loads(rauw) if rauw else {}
    except urllib.error.HTTPError as fout:
        tekst = fout.read().decode("utf-8", "replace")[:300]
        # Nooit het token zelf in de uitvoer: de logs van een publieke
        # repository kan iedereen lezen.
        raise SystemExit(f"GitHub gaf HTTP {fout.code} op {methode} {pad}.\n{tekst}")


def cache_ophalen(token: str, gist: str) -> dict:
    j = gh(f"/gists/{gist}", token)
    bestand = (j.get("files") or {}).get(CACHE_BESTAND)
    if not bestand:
        print("Nog geen cache in de gist; we beginnen met een lege.")
        return {"daily": {}, "activities": {}, "meta": {}}
    inhoud = bestand.get("content") or ""
    if bestand.get("truncated") and bestand.get("raw_url"):
        with urllib.request.urlopen(bestand["raw_url"], timeout=60) as a:
            inhoud = a.read().decode("utf-8")
    try:
        return json.loads(gzip.decompress(base64.b64decode(inhoud)).decode("utf-8"))
    except Exception as exc:  # noqa: BLE001 - liever opnieuw beginnen dan stoppen
        print(f"Cache onleesbaar ({exc}); we beginnen met een lege.")
        return {"daily": {}, "activities": {}, "meta": {}}


def cache_wegschrijven(token: str, gist: str, cache: dict) -> None:
    rauw = json.dumps(cache, separators=(",", ":")).encode("utf-8")
    ingepakt = base64.b64encode(gzip.compress(rauw, 9)).decode("ascii")
    print(f"  cache {len(rauw) / 1024:.0f} kB -> {len(ingepakt) / 1024:.0f} kB ingepakt")
    if len(ingepakt) > 900_000:
        print("  ! de cache wordt groot voor een gist; overweeg minder weken historie")
    gh(f"/gists/{gist}", token, methode="PATCH",
       data={"files": {CACHE_BESTAND: {"content": ingepakt}}})


def secret_bijwerken(token: str, repo: str, naam: str, waarde: str) -> None:
    """Zet een nieuw geheim. Garmin draait het verversingstoken bij elk
    gebruik; slaan we het niet op, dan werkt de koppeling de volgende keer
    niet meer."""
    try:
        from nacl import encoding, public
    except ImportError:
        sys.exit("PyNaCl ontbreekt. De workflow hoort 'pip install pynacl' te doen.")
    sleutel = gh(f"/repos/{repo}/actions/secrets/public-key", token)
    pk = public.PublicKey(sleutel["key"].encode("utf-8"), encoding.Base64Encoder())
    versleuteld = public.SealedBox(pk).encrypt(waarde.encode("utf-8"))
    gh(f"/repos/{repo}/actions/secrets/{naam}", token, methode="PUT",
       data={"encrypted_value": base64.b64encode(versleuteld).decode("utf-8"),
             "key_id": sleutel["key_id"]})
    print(f"  secret {naam} bijgewerkt")


# ==========================================================================
# Bouwen
# ==========================================================================

def main() -> None:
    token = env("GH_PAT")
    gist = env("MOTOR_GIST")
    repo = env("GITHUB_REPOSITORY")
    wachtwoordzin = env("DASHBOARD_PW")
    weken = int(os.environ.get("WEKEN") or 12)

    # ---- tokens klaarzetten ----------------------------------------------
    TOKENMAP.mkdir(parents=True, exist_ok=True)
    rauwe_tokens = env("GARMIN_TOKENS")
    try:
        json.loads(rauwe_tokens)
    except json.JSONDecodeError:
        sys.exit("GARMIN_TOKENS is geen geldige JSON. Draai cloud_instellen.py opnieuw.")
    (TOKENMAP / "garmin_tokens.json").write_text(rauwe_tokens, encoding="utf-8")

    # De synchronisatie-instellingen moeten mee de pagina in, anders raakt je
    # telefoon de koppeling met de gist kwijt zodra deze bouw de vorige
    # index.html vervangt.
    sync_gist = env("SYNC_GIST", verplicht=False)
    sync_token = env("SYNC_TOKEN", verplicht=False)
    if sync_gist and sync_token:
        (WORTEL / "sync.json").write_text(
            json.dumps({"gist": sync_gist, "token": sync_token, "repo": repo}),
            encoding="utf-8")
    else:
        print("! Geen SYNC_GIST/SYNC_TOKEN gezet: de gepubliceerde pagina gaat "
              "zonder synchronisatie de lucht in.")

    import dashboard as D          # noqa: E402 - pas na GARMINTOKENS
    import garmin_fetch as F       # noqa: E402

    # De cache hoort bij de plek waar garmin_fetch hem zoekt.
    cache = cache_ophalen(token, gist)
    F.CACHE_FILE.write_text(json.dumps(cache), encoding="utf-8")

    print("Verbinden met Garmin Connect...")
    try:
        client = F.connect(allow_login=False)
    except SystemExit as stop:
        # connect() stopt met een nette tekst; die willen we zien, maar met
        # een duidelijker vervolg erbij.
        sys.exit(f"{stop}\n\nDe tokens in het secret GARMIN_TOKENS werken niet meer.\n"
                 f"Draai op je Mac 'python3 cloud_instellen.py --tokens' om ze te vernieuwen.")

    fetcher = F.Fetcher(client)
    F.probe(fetcher)
    cache = F.fetch_all(fetcher, weken, cache, activity_weeks=weken + D.RAMP_WEEKS)

    print("Berekenen...")
    payload = D.build_payload(cache, weken)

    D.PUBLISH_DIR = WORTEL
    D.KEYFILE = WORTEL / ".geen-sleutelbestand"   # nooit wegschrijven op de runner
    D.publish(payload, passphrase=wachtwoordzin)
    (WORTEL / ".nojekyll").write_text("", encoding="utf-8")
    print(f"Klaar. {fetcher.calls} API-calls gedaan.")

    # ---- bewaren wat we volgende keer nodig hebben ------------------------
    cache_wegschrijven(token, gist, cache)

    vernieuwd = (TOKENMAP / "garmin_tokens.json")
    if vernieuwd.exists():
        nieuw = vernieuwd.read_text(encoding="utf-8").strip()
        if nieuw and nieuw != rauwe_tokens:
            secret_bijwerken(token, repo, TOKEN_SECRET, nieuw)
        else:
            print("  tokens ongewijzigd")


if __name__ == "__main__":
    main()
