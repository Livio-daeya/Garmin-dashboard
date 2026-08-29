# Je eigen kopie van dit dashboard

Deze handleiding is voor iemand die dit dashboard voor **zijn eigen Garmin-data**
wil draaien. Je krijgt je eigen pagina op je eigen GitHub-adres, die twee keer
per dag automatisch bijwerkt. Je data komt nooit bij iemand anders terecht.

Reken op een half uur, eenmalig.

**Wat je nodig hebt:** een GitHub-account, een Garmin Connect-account, en een
computer met Python 3 waarop je één keer inlogt bij Garmin.

---

## Waarom het zo werkt

Er is geen server. De pagina is één bestand dat GitHub Actions elke ochtend en
elke twintig minuten in het avondvenster opnieuw bouwt: hij haalt je data bij
Garmin op, rekent alles door, en zet er een versleutelde `index.html` neer.

Dat betekent dat jouw kopie volledig van jou is. Jouw Garmin-tokens staan in
jouw repository, jouw data in jouw gist, en de pagina is versleuteld met jouw
wachtwoordzin.

Het betekent ook dat je vier geheimen moet instellen. Daar gaat het meeste van
deze handleiding over.

---

## Stap 1 — Fork de repository

Klik op **Fork** rechtsboven op de repository. Je krijgt een eigen kopie.

De `index.html` uit de originele repo komt mee. Die is versleuteld met de
wachtwoordzin van de eigenaar, dus je kunt er niets mee, en hij wordt bij je
eerste eigen bouw overschreven. Wil je hem meteen weg, verwijder het bestand dan
en commit dat.

---

## Stap 2 — Je Garmin-tokens ophalen

Dit is de enige stap waarbij je Garmin-wachtwoord in beeld komt, en dat gebeurt
**op je eigen computer**. Er komt geen wachtwoord in GitHub te staan — alleen de
tokens die je hiermee krijgt.

Op je eigen machine:

```
uvx --python 3.12 --from git+https://github.com/Taxuspt/garmin_mcp garmin-mcp-auth
```

Hij vraagt om je e-mailadres, je wachtwoord en je MFA-code. Daarna staat er een
bestand:

```
~/.garminconnect/garmin_tokens.json
```

**De inhoud van dat bestand** heb je zo nodig. Open het en kopieer alles.

> Werkt `uvx` niet? Dan kan het ook met dit project zelf:
> `pip install garminconnect && python3 dashboard.py --login`
> Dat schrijft hetzelfde bestand.

---

## Stap 3 — Een gist voor de cache

De opgehaalde Garmin-data is te groot voor een GitHub-secret, dus die gaat
ingepakt in een privé-gist.

1. Ga naar **gist.github.com**
2. Maak een gist met één bestand, inhoud maakt niet uit (bijvoorbeeld `x`)
3. Kies **Create secret gist**
4. Uit de URL haal je het id: `gist.github.com/jouwnaam/<dit-stuk>`

Bewaar dat id.

---

## Stap 4 — Een personal access token

De bouw moet twee dingen kunnen: de cache in je gist bijwerken, en het
Garmin-secret opnieuw zetten.

Dat tweede is belangrijker dan het lijkt. **Garmin vernieuwt het
verversingstoken bij elk gebruik.** Wordt het secret daarna niet bijgewerkt, dan
werkt je koppeling na een paar dagen niet meer en snapt niemand waarom.

Ga naar **Settings → Developer settings → Personal access tokens**.

**Fine-grained token** (aanbevolen): geef toegang tot alleen je fork, met
- Repository permissions → **Secrets: Read and write**
- Repository permissions → **Metadata: Read-only**
- Account permissions → **Gists: Read and write**

**Classic token** kan ook: vink `repo` en `gist` aan.

Kopieer het token meteen — GitHub laat het maar één keer zien.

---

## Stap 5 — De geheimen instellen

In je fork: **Settings → Secrets and variables → Actions → New repository secret**.

| Secret | Wat erin gaat |
|---|---|
| `GARMIN_TOKENS` | de **inhoud** van `~/.garminconnect/garmin_tokens.json` |
| `DASHBOARD_PW` | je eigen wachtwoordzin, minimaal 12 tekens |
| `MOTOR_GIST` | het gist-id uit stap 3 |
| `GH_PAT` | het token uit stap 4 |

Deze vier zijn verplicht. Ontbreekt er een, dan stopt de bouw meteen met een
melding die zegt welke.

**Over `DASHBOARD_PW`:** hiermee wordt je pagina versleuteld, en je hebt hem
elke keer nodig om hem te openen. Vier willekeurige woorden werkt goed. Korter
dan twaalf tekens weigert het script.

**Optioneel:** `SYNC_GIST` en `SYNC_TOKEN` als je je planning en krachtlogboek
tussen je telefoon en laptop wilt synchroniseren. Zonder deze twee werkt alles,
maar blijft wat je invult op één apparaat staan.

---

## Stap 6 — Actions en Pages aanzetten

**Actions** — GitHub zet workflows bij een fork standaard uit. Ga naar het
tabblad **Actions** en bevestig dat je ze wilt inschakelen.

**Pages** — ga naar **Settings → Pages**, kies bij Source de branch `main` en de
map `/ (root)`.

---

## Stap 7 — Eén keer handmatig starten

**Actions → Dashboard bijwerken → Run workflow.**

De eerste keer duurt een paar minuten: hij haalt twaalf weken historie op. Daarna
draait hij vanzelf.

Je pagina staat op:

```
https://<jouwnaam>.github.io/<repositorynaam>/
```

Je krijgt eerst het slotscherm. Vul je wachtwoordzin uit stap 5 in.

---

## Als het misgaat

**"GARMIN_TOKENS is geen geldige JSON"** — je hebt het pad naar het bestand in
het secret gezet in plaats van de inhoud. Open het bestand en plak wat erin
staat.

**"Tokens zijn verlopen of ongeldig"** — draai stap 2 opnieuw en zet de nieuwe
inhoud in het secret. Dit hoort niet vaak te gebeuren; als het elke week
gebeurt, kan `GH_PAT` de secrets niet bijwerken (zie stap 4).

**De workflow draait niet vanzelf** — Actions staat uit, of GitHub heeft ze
gepauzeerd omdat er zestig dagen niets in de repository is gebeurd. Start hem
één keer handmatig.

**De pagina blijft leeg** — kijk in de Actions-log. Faalt de bouw, dan wordt er
geen nieuwe `index.html` gecommit en blijft de oude staan.

**Je hebt geen VO2max, Body Battery of Training Status** — dan meet je
opstelling die niet. Een borstband levert ze niet; daar is een horloge voor
nodig. Het dashboard laat die onderdelen dan weg in plaats van iets te schatten.

---

## Wat je verder moet weten

**Je pagina staat openbaar, maar versleuteld.** Iedereen kan de URL openen;
zonder je wachtwoordzin ziet niemand een cijfer. Kies dus een echte zin en geen
woord.

**Je tokens staan alleen in je eigen repository**, als secret. Ze gaan niet mee
in de gepubliceerde pagina.

**Werk je fork bij** om verbeteringen op te halen: GitHub laat op je fork een
knop **Sync fork** zien zodra de originele repo verder is. Je eigen secrets en
je gist blijven staan.

**De historie is standaard twaalf weken.** Wil je meer, zet dan een repository
variable `WEKEN` op bijvoorbeeld 52. Let op dat de cache dan groeit; boven de
900 kB waarschuwt de bouw dat een gist er krap voor wordt.
