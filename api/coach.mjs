/* =======================================================================
   De coach, op de server
   -----------------------------------------------------------------------
   Draait als Vercel Function op /api/coach. Het dashboard stuurt je vraag
   met je Supabase-inlogtoken; deze functie
     1. controleert bij Supabase wie je bent,
     2. leest met JOUW token (dus binnen de RLS-regels) je stand, je
        Garmin-gegevens en je invoer,
     3. laat Claude antwoorden, met gereedschap om gericht na te kijken
        (een workout, je zones, je planning, je belasting),
     4. legt vast wat je vertelt (zwaarte, klachten, notities), met herkomst
        "coach-chat", zodat het in je dashboard terugkomt,
     5. bewaart het gesprek, zodat het op al je apparaten hetzelfde is.
   Planwijzigingen en een workout voor je krachtlog blijven een voorstel dat
   je in het dashboard overneemt.

   Omgevingsvariabelen in Vercel:
     SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, ANTHROPIC_API_KEY
     COACH_HERKOMST (optioneel): extra toegestane herkomst, bv. je GitHub
     Pages-adres, kommagescheiden.
   De secret key van Supabase is hier niet nodig en hoort hier niet.
   ======================================================================= */
import Anthropic from "@anthropic-ai/sdk";

export const MODEL = "claude-opus-5-5";
const MAX_RONDES = 8;
const BRON = "coach-chat";

/* ---- Supabase via REST, met het token van de gebruiker ---- */
export function supabase(url, sleutel, token, doeFetch = fetch) {
  const kop = {apikey: sleutel, Authorization: `Bearer ${token}`, "Content-Type": "application/json"};
  const vraag = async (pad, opties = {}) => {
    const r = await doeFetch(`${url}${pad}`, {...opties, headers: {...kop, ...(opties.headers || {})}});
    if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const t = await r.text();
    return t ? JSON.parse(t) : null;
  };
  return {
    gebruiker: () => vraag("/auth/v1/user"),
    lees: (tabel, query) => vraag(`/rest/v1/${tabel}?${query}`),
    schrijf: (tabel, rijen) => vraag(`/rest/v1/${tabel}`, {method: "POST", body: JSON.stringify(rijen),
      headers: {Prefer: "resolution=merge-duplicates,return=representation"}}),
  };
}

const isDatum = s => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const plusDagen = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const VAKKEN = ["check", "log", "plan", "explos", "zesmin", "wkaan", "notitie", "leer"];
const OVERZICHTEN = ["weekly", "fitness", "acwr", "belastingbasis", "plan", "planbasis", "hard", "gereedheid",
  "zones", "hr_instelling", "insights", "sleep_last", "runs", "coverage", "predictions"];
const LIJF = ["benen", "herstel", "energie", "stress", "slaap", "achilles", "rug", "ziek"];

/* ---- gereedschap ---- */
export const GEREEDSCHAP = [
  {name: "lees_activiteiten", description: "Lijst van Garmin-activiteiten in een periode: datum, sport, naam, duur, afstand, gemiddelde en maximale hartslag, minuten per hartslagzone, aerobe en anaerobe Training Effect, belasting. Gebruik dit om een workout te vinden waar hij het over heeft.",
    input_schema: {type: "object", properties: {van: {type: "string", description: "YYYY-MM-DD"}, tot: {type: "string", description: "YYYY-MM-DD"}, sport: {type: "string", description: "optioneel, bv. Hardlopen, Handbal, Kracht"}}, required: ["van", "tot"], additionalProperties: false}},
  {name: "lees_activiteit", description: "Alle details van één activiteit: ronden, zones, hartslagblokken, ingedikte hartslagreeks (per 30 s), tempo, hoogtemeters.",
    input_schema: {type: "object", properties: {id: {type: "string"}}, required: ["id"], additionalProperties: false}},
  {name: "lees_dagen", description: "Dagwaarden van Garmin per dag: slaap, HRV en HRV-band, rusthartslag, Body Battery, stress, trainingsgereedheid, hersteltijd, huidtemperatuur, ademhaling, belasting 7 dagen.",
    input_schema: {type: "object", properties: {van: {type: "string"}, tot: {type: "string"}}, required: ["van", "tot"], additionalProperties: false}},
  {name: "lees_overzicht", description: "Afgeleide reeksen van het dashboard: weekly (belasting per week), fitness (fitheid/vermoeidheid/vorm per dag), acwr, belastingbasis, plan, planbasis, hard, gereedheid, zones (hartslaggrenzen), hr_instelling, insights, sleep_last, runs, coverage, predictions.",
    input_schema: {type: "object", properties: {sleutel: {type: "string", enum: OVERZICHTEN}}, required: ["sleutel"], additionalProperties: false}},
  {name: "lees_invoer", description: "Wat hij zelf heeft ingevoerd: check (check-ins met gevoel, lijf, sessies met zwaarte), log (krachtlog), plan (eigen planning), explos, zesmin, wkaan (workoutaanpassingen), notitie (wat jij eerder vastlegde), leer (herstelbeoordelingen).",
    input_schema: {type: "object", properties: {vak: {type: "string", enum: VAKKEN}, van: {type: "string"}, tot: {type: "string"}}, required: ["vak"], additionalProperties: false}},
  {name: "bewaar_sessie", description: "Leg vast hoe zwaar een sessie voelde (RPE 1-10) en eventueel duur en een notitie, op de dag van die sessie. Alleen wat hij zelf zegt; nooit afleiden uit Garmin.",
    input_schema: {type: "object", properties: {datum: {type: "string"}, sport: {type: "string", description: "Hardlopen, Handbal, Kracht, Fietsen, ..."}, rpe: {type: "integer", minimum: 1, maximum: 10}, minuten: {type: "integer", minimum: 1, maximum: 400}, notitie: {type: "string"}}, required: ["datum", "sport"], additionalProperties: false}},
  {name: "bewaar_checkin", description: "Leg zijn eigen gevoel vast voor een dag: gevoel 1-5 en lijf-onderdelen (0 = goed, 1 = matig, 2 = slecht; ziek 0/1). Alleen wat hij zelf zegt.",
    input_schema: {type: "object", properties: {datum: {type: "string"}, gevoel: {type: "integer", minimum: 1, maximum: 5},
      lijf: {type: "object", properties: Object.fromEntries(LIJF.map(k => [k, {type: "integer", minimum: 0, maximum: 2}])), additionalProperties: false}}, required: ["datum"], additionalProperties: false}},
  {name: "bewaar_notitie", description: "Bewaar een afspraak, inzicht of besluit uit dit gesprek in zijn dashboard (bv. 'na dinsdagtraining geen extra beenwerk', 'achilles gevoelig na sprints').",
    input_schema: {type: "object", properties: {datum: {type: "string"}, onderwerp: {type: "string"}, tekst: {type: "string"}}, required: ["datum", "tekst"], additionalProperties: false}},
  {name: "stel_workout_voor", description: "Een krachtworkout die hij beschrijft klaarzetten voor zijn krachtlog. Hij bevestigt hem zelf in het dashboard; dit schrijft nog niets weg.",
    input_schema: {type: "object", properties: {date: {type: "string"}, type: {type: "string", enum: ["kracht", "conditie"]}, workout: {type: ["string", "null"]},
      exercises: {type: "array", items: {type: "object", properties: {name: {type: "string"}, sets: {type: "array", items: {type: "object", properties: {reps: {type: "integer"}, weight_kg: {type: ["number", "null"]}, rir: {type: "integer", minimum: 0, maximum: 10, description: "alleen als hij het noemde; anders weglaten"}}, required: ["reps"], additionalProperties: false}}}, required: ["name", "sets"], additionalProperties: false}}},
      required: ["date", "type", "exercises"], additionalProperties: false}},
];

export const WERKWIJZE = `WERKWIJZE MET GEREEDSCHAP
- Je hebt directe toegang tot zijn Garmin-gegevens en zijn eigen invoer. Kijk het na in plaats van te gokken: vraagt hij naar een workout, zoek die op (lees_activiteiten, daarna lees_activiteit) en gebruik ronden, zones en Training Effect.
- Vraagt hij of er nog iets bij kan (bv. extra kracht na een training): bekijk wat hij vandaag deed, zijn planning van vandaag en morgen, zijn belasting van de afgelopen week tegenover gewoonlijk en zijn herstelbeoordeling. Zeg welke gegevens je gebruikte.
- Ontbrekende gegevens zijn onbekend, geen nul. Verzin geen waarden.
- Vertelt hij hoe zwaar iets was, of hoe hij zich voelt: leg het vast met bewaar_sessie of bewaar_checkin. Een afspraak of besluit: bewaar_notitie. Zeg kort wat je hebt vastgelegd.
- Planwijzigingen en doelen: geef ze als voorstel-blok zoals beschreven; hij neemt ze zelf over. Een beschreven krachtworkout: stel_workout_voor.
- Antwoord in het Nederlands, kort: eerst de conclusie en de actie, daarna de onderbouwing.`;

/* ---- uitvoeren ---- */
const kortAct = a => {
  const d = a.data || {};
  const zones = ["z1_s", "z2_s", "z3_s", "z4_s", "z5_s"].map(k => d[k] != null ? Math.round(d[k] / 60) : null);
  return {id: String(a.id), datum: a.datum, tijd: d.datetime || null, sport: d.sport, naam: d.name, minuten: d.duration_s ? Math.round(d.duration_s / 60) : null,
    km: d.distance_m ? Math.round(d.distance_m / 100) / 10 : null, gem_hs: d.avg_hr ?? null, max_hs: d.max_hr ?? null,
    zone_minuten_1_5: zones, aeroob_te: d.aerobic_te ?? null, anaeroob_te: d.anaerobic_te ?? null, te_label: d.te_label ?? null,
    belasting: d.load != null ? Math.round(d.load) : null, belasting_bron: d.load_source ?? null, zwaarte: d.grade ?? null, binnen: d.binnen ?? null};
};

function recordInPeriode(r, van, tot) {
  const d = (r.data && (r.data.datum || r.data.date)) || (isDatum(String(r.sleutel).slice(0, 10)) ? String(r.sleutel).slice(0, 10) : null);
  if (!d) return true;
  return (!van || d >= van) && (!tot || d <= tot);
}

/* Een nieuwe versie van een record, net als in de app: herkomst, moment en
   de versie waarop hij voortbouwt. Zo voegt het dashboard hem zonder
   verlies samen met wat op je telefoon of laptop staat. */
export function nieuweVersie(oud, data, nu = Date.now()) {
  const meta = oud && oud.data ? oud.data : null;
  const uit = {...data, _t: nu, _bron: BRON, _basis: meta ? (meta._t ?? null) : null};
  delete uit._ongesync; delete uit._weg;
  if (meta && meta._conflicten) uit._conflicten = meta._conflicten;
  return uit;
}

/* registraties die hij in het dashboard verwijderde, laat de coach weg */
async function verborgen(db) {
  try { const [r] = await db.lees("records", "select=data&vak=eq.instel&sleutel=eq._");
    return new Set(((r && r.data && r.data.verborgenActs) || []).map(String)); } catch (e) { return new Set(); }
}
export async function voerUit(db, naam, invoer, nu = Date.now()) {
  if (naam === "lees_activiteiten") {
    if (!isDatum(invoer.van) || !isDatum(invoer.tot)) return {fout: "van en tot als YYYY-MM-DD"};
    const rijen = await db.lees("garmin_activiteit", `select=id,datum,data&datum=gte.${invoer.van}&datum=lte.${invoer.tot}&order=datum.asc`);
    const weg = await verborgen(db);
    const lijst = rijen.filter(a => !weg.has(String(a.id))).map(kortAct).filter(a => !invoer.sport || String(a.sport || "").toLowerCase() === invoer.sport.toLowerCase());
    return {aantal: lijst.length, activiteiten: lijst};
  }
  if (naam === "lees_activiteit") {
    if (!/^\d+$/.test(String(invoer.id))) return {fout: "onbekend id"};
    const [a] = await db.lees("garmin_activiteit", `select=id,datum,data&id=eq.${invoer.id}`);
    if (!a || (await verborgen(db)).has(String(a.id))) return {fout: "activiteit niet gevonden of door hem verwijderd"};
    return {...kortAct(a), details: a.data};
  }
  if (naam === "lees_dagen") {
    if (!isDatum(invoer.van) || !isDatum(invoer.tot)) return {fout: "van en tot als YYYY-MM-DD"};
    const rijen = await db.lees("garmin_dag", `select=datum,data&datum=gte.${invoer.van}&datum=lte.${invoer.tot}&order=datum.asc`);
    return {aantal: rijen.length, dagen: rijen.map(r => ({datum: r.datum, ...r.data}))};
  }
  if (naam === "lees_overzicht") {
    if (!OVERZICHTEN.includes(invoer.sleutel)) return {fout: "onbekend overzicht"};
    const [r] = await db.lees("garmin_overzicht", `select=data,bijgewerkt&sleutel=eq.${invoer.sleutel}`);
    return r ? {bijgewerkt: r.bijgewerkt, data: r.data} : {fout: "niet beschikbaar"};
  }
  if (naam === "lees_invoer") {
    if (!VAKKEN.includes(invoer.vak)) return {fout: "onbekend vak"};
    const rijen = await db.lees("records", `select=sleutel,data&vak=eq.${invoer.vak}&order=sleutel.asc`);
    const lijst = rijen.filter(r => !(r.data && r.data._weg) && recordInPeriode(r, invoer.van, invoer.tot))
      .map(r => { const d = {...r.data}; ["_basis", "_conflicten", "_ongesync"].forEach(k => delete d[k]);
        /* oude coachinvoer kreeg standaard RIR 2: onzeker, niet als bevestigd behandelen */
        if (invoer.vak === "log" && d.bron === "coach" && !d.rirBron) d.rir_onzeker = "RIR van vóór 7-11-2026 mogelijk een standaardwaarde, niet door hem genoemd";
        return {sleutel: r.sleutel, ...d}; });
    return {aantal: lijst.length, records: lijst.slice(-60)};
  }
  if (naam === "bewaar_sessie" || naam === "bewaar_checkin") {
    if (!isDatum(invoer.datum)) return {fout: "datum als YYYY-MM-DD"};
    const [oud] = await db.lees("records", `select=sleutel,data&vak=eq.check&sleutel=eq.${invoer.datum}`);
    const huidig = oud && !oud.data._weg ? {...oud.data} : {gevoel: null, sessies: []};
    ["_t", "_bron", "_basis", "_conflicten", "_ongesync"].forEach(k => delete huidig[k]);
    if (naam === "bewaar_sessie") {
      const sessies = [...(huidig.sessies || [])];
      const i = sessies.findIndex(s => String(s.sport).toLowerCase() === invoer.sport.toLowerCase());
      const oudS = i >= 0 ? sessies[i] : {};
      const s = {...oudS, sport: invoer.sport, naam: oudS.naam || invoer.sport, minuten: invoer.minuten ?? oudS.minuten ?? null,
        ...(invoer.rpe != null ? {rpe: invoer.rpe} : {}), ...(invoer.notitie ? {notitie: invoer.notitie} : {}), handmatig: oudS.handmatig ?? true, via: BRON};
      if (i >= 0) sessies[i] = s; else sessies.push(s);
      huidig.sessies = sessies;
    } else {
      if (invoer.gevoel != null) huidig.gevoel = invoer.gevoel;
      if (invoer.lijf) huidig.lijf = {...(huidig.lijf || {}), ...invoer.lijf};
    }
    await db.schrijf("records", [{vak: "check", sleutel: invoer.datum, data: nieuweVersie(oud, huidig, nu)}]);
    return {opgeslagen: true, datum: invoer.datum, check: huidig};
  }
  if (naam === "bewaar_notitie") {
    if (!isDatum(invoer.datum) || !invoer.tekst) return {fout: "datum en tekst nodig"};
    const sleutel = `${invoer.datum}-${nu.toString(36)}`;
    const data = nieuweVersie(null, {datum: invoer.datum, onderwerp: invoer.onderwerp || null, tekst: String(invoer.tekst).slice(0, 1000)}, nu);
    await db.schrijf("records", [{vak: "notitie", sleutel, data}]);
    return {opgeslagen: true, sleutel};
  }
  if (naam === "stel_workout_voor") {
    return {klaargezet: true, uitleg: "Het dashboard toont deze workout ter bevestiging; pas daarna staat hij in het krachtlog."};
  }
  return {fout: `onbekend gereedschap ${naam}`};
}

/* ---- het gesprek ---- */
export async function coachRonde({client, db, vraag, over, nu = Date.now(), model = MODEL}) {
  const [ctx] = await db.lees("records", "select=data&vak=eq.context&sleutel=eq.actueel");
  const stand = ctx ? ctx.data : null;
  const eerder = (await db.lees("coach_berichten", "select=rol,tekst&order=id.desc&limit=30")).reverse();
  /* de vraag zelf staat al opgeslagen; niet dubbel meesturen */
  if (eerder.length && eerder[eerder.length - 1].rol === "user" && eerder[eerder.length - 1].tekst === vraag) eerder.pop();
  const vandaag = (stand && stand.vandaag) || new Date(nu).toISOString().slice(0, 10);
  const systeem = [
    {type: "text", text: `${(stand && stand.systeem) || "Je bent zijn trainingscoach."}\n\n${WERKWIJZE}`, cache_control: {type: "ephemeral"}},
    {type: "text", text: `Vandaag is ${vandaag}.\n\nZIJN STAND VOLGENS HET DASHBOARD (bijgewerkt ${stand ? new Date(stand._t || nu).toISOString() : "onbekend"}):\n${stand ? JSON.stringify(stand.context) : "niet beschikbaar: het dashboard heeft nog geen stand gedeeld"}`
      + (over ? `\n\nHIJ VRAAGT OVER DEZE TRAINING:\n${over.titel}: ${over.tekst}` : "")},
  ];
  const berichten = [...eerder.map(b => ({role: b.rol, content: b.tekst})), {role: "user", content: vraag}];
  /* opeenvolgende berichten met dezelfde rol samenvoegen; de API wil om en om */
  const gesprek = berichten.reduce((acc, b) => { const l = acc[acc.length - 1];
    if (l && l.role === b.role && typeof l.content === "string") l.content += `\n\n${b.content}`; else acc.push({...b}); return acc; }, []);
  while (gesprek.length && gesprek[0].role !== "user") gesprek.shift();

  const acties = [];
  let antwoord = null;
  for (let ronde = 0; ronde < MAX_RONDES; ronde++) {
    antwoord = await client.beta.messages.create({
      model, max_tokens: 16000, system: systeem, tools: GEREEDSCHAP, messages: gesprek,
      output_config: {effort: "medium"},
      betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
    });
    if (antwoord.stop_reason === "refusal" || antwoord.stop_reason === "max_tokens") break;
    if (antwoord.stop_reason === "pause_turn") { gesprek.push({role: "assistant", content: antwoord.content}); continue; }
    if (antwoord.stop_reason !== "tool_use") break;
    gesprek.push({role: "assistant", content: antwoord.content});
    const resultaten = [];
    for (const blok of antwoord.content.filter(b => b.type === "tool_use")) {
      let uit;
      try { uit = await voerUit(db, blok.name, blok.input || {}, nu); }
      catch (e) { uit = {fout: e.message}; }
      acties.push({gereedschap: blok.name, invoer: blok.input, ...(uit && uit.fout ? {fout: uit.fout} : {}),
        ...(blok.name.startsWith("bewaar_") && uit && uit.opgeslagen ? {opgeslagen: true} : {}),
        ...(blok.name === "stel_workout_voor" ? {workout: blok.input} : {})});
      resultaten.push({type: "tool_result", tool_use_id: blok.id, content: JSON.stringify(uit).slice(0, 60000), ...(uit && uit.fout ? {is_error: true} : {})});
    }
    gesprek.push({role: "user", content: resultaten});
  }
  let tekst = (antwoord ? antwoord.content : []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
  if (antwoord && antwoord.stop_reason === "refusal") tekst = tekst || "Hier kan ik niet op antwoorden.";
  if (!tekst) tekst = "Ik kwam niet tot een antwoord. Probeer het iets anders te vragen.";
  return {tekst, acties, model: antwoord ? antwoord.model : model, gebruik: antwoord ? antwoord.usage : null};
}

/* ---- HTTP ---- */
function herkomstOk(herkomst, eigen) {
  if (!herkomst) return true;
  const extra = (process.env.COACH_HERKOMST || "").split(",").map(s => s.trim()).filter(Boolean);
  return herkomst === eigen || extra.includes(herkomst);
}
function koppen(request) {
  const herkomst = request.headers.get("origin");
  const eigen = new URL(request.url).origin;
  const k = {"Content-Type": "application/json", "Cache-Control": "no-store", Vary: "Origin"};
  if (herkomst && herkomstOk(herkomst, eigen)) Object.assign(k, {"Access-Control-Allow-Origin": herkomst,
    "Access-Control-Allow-Headers": "authorization, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS"});
  return k;
}
const antwoordJson = (request, status, body) => new Response(JSON.stringify(body), {status, headers: koppen(request)});

export function OPTIONS(request) { return new Response(null, {status: 204, headers: koppen(request)}); }

export async function POST(request) {
  const herkomst = request.headers.get("origin");
  if (!herkomstOk(herkomst, new URL(request.url).origin)) return antwoordJson(request, 403, {fout: "herkomst niet toegestaan"});
  const {SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, ANTHROPIC_API_KEY} = process.env;
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY || !ANTHROPIC_API_KEY) return antwoordJson(request, 500, {fout: "server niet ingesteld"});
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return antwoordJson(request, 401, {fout: "niet ingelogd"});
  const db = supabase(SUPABASE_URL.replace(/\/$/, ""), SUPABASE_PUBLISHABLE_KEY, token);
  try { await db.gebruiker(); } catch (e) { return antwoordJson(request, 401, {fout: "inlog verlopen of ongeldig"}); }

  let body;
  try { body = await request.json(); } catch (e) { return antwoordJson(request, 400, {fout: "geen geldige JSON"}); }
  const vraag = String(body.vraag || "").trim().slice(0, 4000);
  if (!vraag) return antwoordJson(request, 400, {fout: "lege vraag"});
  const over = body.over && body.over.titel ? {titel: String(body.over.titel).slice(0, 200), tekst: String(body.over.tekst || "").slice(0, 2000)} : null;
  const apparaat = String(body.apparaat || "").slice(0, 40) || null;

  try {
    await db.schrijf("coach_berichten", [{rol: "user", tekst: vraag, bron: apparaat}]);
    const client = new Anthropic({apiKey: ANTHROPIC_API_KEY});
    const uit = await coachRonde({client, db, vraag, over});
    const [opgeslagen] = await db.schrijf("coach_berichten", [{rol: "assistant", tekst: uit.tekst, acties: uit.acties, bron: apparaat}]);
    return antwoordJson(request, 200, {...uit, id: opgeslagen ? opgeslagen.id : null});
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return antwoordJson(request, 429, {fout: "Even te veel verzoeken bij Anthropic; probeer het zo opnieuw."});
    if (e instanceof Anthropic.AuthenticationError) return antwoordJson(request, 500, {fout: "De Anthropic-sleutel op de server werkt niet."});
    if (e instanceof Anthropic.APIError) return antwoordJson(request, 502, {fout: `Anthropic: ${e.message}`});
    return antwoordJson(request, 500, {fout: e.message || String(e)});
  }
}
