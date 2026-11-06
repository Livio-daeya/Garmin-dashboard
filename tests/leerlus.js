/* Controles voor de leerlus, synchronisatie en modelvoorstellen. Draait
   geïsoleerd op de preview:
     const r = eval(await (await fetch("/leerlus.js")).text())  (async: await r)
   Technische testdata in een kopie; DATA, opslag en vervangen functies
   worden daarna teruggezet. */
(async () => {
  const uit = [];
  const opslag = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); opslag[k] = localStorage.getItem(k); }
  const echt = {historie: DATA.historie, hacts: DATA.historie_acts, acts: DATA.activities, vandaag: DATA.planbasis.vandaag};
  const stubs = [];
  const stub = (naam, f) => { stubs.push([naam, window[naam]]); window[naam] = f; };
  const herstel = () => { DATA.historie = echt.historie; DATA.historie_acts = echt.hacts; DATA.activities = echt.acts; DATA.planbasis.vandaag = echt.vandaag;
    while (stubs.length) { const [n, f] = stubs.pop(); window[n] = f; }
    HB_OVERRIDE = null;
    Object.keys(localStorage).forEach(k => { if (!(k in opslag)) localStorage.removeItem(k); });
    Object.entries(opslag).forEach(([k, v]) => { if (localStorage.getItem(k) !== v) localStorage.setItem(k, v); }); HB_CACHE.clear(); };
  const test = async (naam, f) => { HB_CACHE.clear(); try { const r = await f(); uit.push({naam, ...r}); } catch (e) { uit.push({naam, ok: false, detail: "fout: " + e.message}); } finally { herstel(); } };
  const V = "2026-11-05";
  const reeks = (f = () => ({}), n = 120) => Array.from({length: n}, (_, i) => { const d = isoPlus(V, -(n - 1 - i)), j = i % 7;
    return {date: d, toestel: 1, hrv: 100 + (j - 3) * 3, hrv_week: 100, hrv_band_laag: 85, hrv_band_hoog: 120, rhr: 45 + (j % 3) - 1, slaap_hr: 50,
      sleep_h: 7.5 + (j - 3) * 0.1, huidtemp_afw: (j - 3) * 0.05, resp_sleep: 13 + (j % 3) * 0.2, ...f(d, i, n)}; });
  const zet = (rijen, acts) => { DATA.historie = rijen; DATA.historie_acts = acts || []; DATA.activities = acts || []; DATA.planbasis.vandaag = V; HB_CACHE.clear(); };
  const schoon = () => { localStorage.removeItem(CHECK_KEY); localStorage.removeItem(LOG_KEY); localStorage.removeItem(LEER_KEY);
    const I = bewaardLees(INSTEL_KEY, {}); delete I.hbModel; delete I.hbVoorstellen; bewaardSchrijf(INSTEL_KEY, I); HB_CACHE.clear(); };

  await test("Telefoon- en browserinvoer worden per onderdeel samengevoegd", () => {
    const tel = {"2026-11-04": {gevoel: 4, lijf: {benen: 1}, sessies: [], _t: 100}};
    const brw = {"2026-11-04": {gevoel: null, sessies: [{sport: "Handbal", naam: "Training", minuten: 70, rpe: 7}], _t: 200}};
    const a = voegSamenCheck(brw, tel)["2026-11-04"], b = voegSamenCheck(tel, brw)["2026-11-04"];
    const ok = [a, b].every(x => x.gevoel === 4 && x.lijf.benen === 1 && x.sessies.length === 1);
    return {ok, detail: JSON.stringify(a)};
  });
  await test("Nieuwe gegevens veroorzaken geen dubbele sessies", () => {
    const een = {"2026-11-04": {sessies: [{sport: "Handbal", naam: "Training", minuten: 70, rpe: 7}], _t: 100}};
    const twee = {"2026-11-04": {sessies: [{sport: "Handbal", naam: "Training", minuten: 70, rpe: 8}], _t: 200}};
    const s = voegSamenCheck(een, twee)["2026-11-04"].sessies;
    return {ok: s.length === 1 && s[0].rpe === 8, detail: `${s.length} sessie, RPE ${s[0].rpe}`};
  });
  await test("Krachtlog van twee apparaten: beide sessies blijven bewaard", () => {
    const tel = {"2026-11-04-A-x1": {type: "A", datum: "2026-11-04", _t: 1}}, brw = {"2026-11-04-B-y2": {type: "B", datum: "2026-11-04", _t: 2}};
    const s = voegSamen(tel, brw);
    return {ok: Object.keys(s).length === 2, detail: Object.keys(s).join(", ")};
  });
  await test("Synchronisatie laat onbekende onderdelen in de gist staan", async () => {
    let geschreven = null;
    stub("gistHaal", async () => ({v: 1, toekomst: {x: 1}, check: {}}));
    stub("gistZet", async doc => { geschreven = doc; });
    const aan = SYNC.aan; SYNC.aan = true;
    localStorage.setItem(CHECK_KEY, JSON.stringify({"2026-11-01": {gevoel: 3, _t: 5}}));
    try { await syncRonde(false); } finally { SYNC.aan = aan; }
    return {ok: !!geschreven && geschreven.toekomst && geschreven.toekomst.x === 1 && geschreven.check["2026-11-01"], detail: geschreven ? Object.keys(geschreven).join(", ") : "niets geschreven"};
  });
  await test("Ontbrekende feedback wordt geen positieve uitkomst", () => {
    schoon(); zet(reeks());
    const rec = {datum: isoPlus(V, -5)};
    const a = hbEvalueer(rec, {k: "gevoel_terug", eval: isoPlus(V, -2)});
    const b = hbEvalueer(rec, {k: "sessie_passend", eval: isoPlus(V, -3), sessie: {datum: isoPlus(V, -4), id: "bestaatniet", soort: "handbal"}});
    return {ok: a.uitkomst === "onbekend" && b.uitkomst === "onbekend", detail: `${a.uitkomst} (${a.bron}); ${b.uitkomst} (${b.bron})`};
  });
  await test("Zeven check-ins geven geen betrouwbare referentie", () => {
    schoon(); zet(reeks());
    const c = {}; for (let i = 1; i <= 7; i++) c[isoPlus(V, -i)] = {gevoel: 4, _t: i}; c[V] = {gevoel: 4, _t: 9}; checkZet(c); HB_CACHE.clear();
    const o = herstelKern(V).ind.gevoel.opbouw;
    return {ok: o.n === 7 && o.status === "eerste referentie", detail: `${o.n} check-ins: ${o.status}`};
  });
  await test("Een actuele klacht telt direct, ook zonder referentie", () => {
    schoon(); zet(reeks()); checkZet({[V]: {gevoel: 4, lijf: {achilles: 2}, _t: 1}}); HB_CACHE.clear();
    const k = herstelKern(V);
    return {ok: k.niveau === "rood" && k.ind.gevoel.opbouw.status === "in opbouw", detail: `${k.niveau}, gevoel ${k.ind.gevoel.opbouw.status}`};
  });
  await test("Ziektedagen verschuiven je referentie niet", () => {
    schoon(); zet(reeks((d, i, n) => i >= n - 40 && i < n - 30 ? {rhr: 60} : {}));
    const c = {}; for (let i = 30; i < 40; i++) c[isoPlus(V, -i)] = {gevoel: 2, lijf: {ziek: 1}, _t: i}; checkZet(c); HB_CACHE.clear();
    const r = herstelKern(V).ind.hart.rhr.ref;
    return {ok: r.uitgeslotenZiek >= 10 && r.centraal < 47, detail: `${r.uitgeslotenZiek} uitgesloten; centraal ${hbRond(r.centraal, 1)}`};
  });
  const ronden = (pace, hr, n = 6) => Array.from({length: n}, (_, i) => ({start: i * pace * 1.609, duur: pace * 1.609, afstand: 1609, hr: i === 0 ? hr - 15 : hr}));
  const loop = (d, pace, hr, extra = {}) => ({id: d + pace, date: d, sport: "Hardlopen", toestel: 1, binnen: false, duration_s: 3000, distance_m: 9600, elev_gain: 30, avg_hr: hr, pace_s_per_km: pace, hard_frac: 0.05, load: 50, rondes: ronden(pace, hr), ...extra});
  await test("Onvergelijkbare inspanningen worden geen prestatieverlies", () => {
    schoon();
    zet(reeks(), [20, 30, 40, 50].map(n => loop(isoPlus(V, -n), 360, 140)).concat([loop(isoPlus(V, -1), 300, 168), loop(isoPlus(V, -2), 360, 170, {rondes: []}), loop(isoPlus(V, -3), 360, 170, {binnen: true})]));
    const p = herstelKern(V).ind.prestatie;
    return {ok: !p.punten.some(x => x.slechter) && p.beperkt.length >= 2, detail: `${p.punten.length} vergelijkingen; ${p.beperkt.join("; ")}`};
  });
  await test("Lagere hartslag bij zwaarder gevoel is een mogelijk signaal, geen achteruitgang", () => {
    schoon();
    const c = {}; [20, 30, 40, 50].forEach(n => { c[isoPlus(V, -n)] = {sessies: [{sport: "Hardlopen", rpe: 4, minuten: 50}], _t: n}; }); c[isoPlus(V, -1)] = {sessies: [{sport: "Hardlopen", rpe: 7, minuten: 50}], _t: 1}; checkZet(c);
    zet(reeks(), [20, 30, 40, 50].map(n => loop(isoPlus(V, -n), 360, 140)).concat([loop(isoPlus(V, -1), 360, 125)]));
    const pt = herstelKern(V).ind.prestatie.punten.find(x => x.soort === "lopen");
    return {ok: !!pt && pt.aandacht && !pt.slechter, detail: pt ? pt.tekst : "geen vergelijking"};
  });
  await test("Ontbrekende RIR verlaagt de zekerheid, de vergelijking blijft", () => {
    schoon(); zet(reeks());
    const k = (datum, reps, rir, id) => ({_id: id, type: "A", datum, plek: null, oefeningen: {bench: {kg: 100, reps, sets: 3, rir}}});
    logZet([k(isoPlus(V, -10), 6, null, "a"), k(isoPlus(V, -3), 5, 2, "b")]); HB_CACHE.clear();
    const pt = herstelKern(V).ind.prestatie.punten.find(x => x.soort === "kracht");
    return {ok: !!pt && pt.gewicht === 0.5 && pt.slechter, detail: pt ? `${pt.tekst} (${pt.noot})` : "geen vergelijking"};
  });
  await test("Een modelvoorstel verandert het actieve advies niet vóór goedkeuring; versies zijn terug te draaien", () => {
    schoon(); zet(reeks((d, i, n) => i >= n - 7 ? {rhr: 47.6} : {})); checkZet({[V]: {gevoel: 4, lijf: {benen: 0}, _t: 1}}); HB_CACHE.clear();
    const voor = herstelKern(V);
    const vs = {id: "vtest", params: {bandK: 1.0}, wat: "test", status: "open", toets: {n: 30, positief: 8, ba: 0.8, gemist: 1, zonderBevestiging: 2}, huidig: {ba: 0.6, gemist: 3, zonderBevestiging: 1}, zonderSlaap: {ba: 0.6}, nooit: {ba: 0.5}};
    hbVoorstelBewaar(vs); HB_CACHE.clear();
    const metVoorstel = herstelKern(V), schaduw = hbSchaduw(vs, V);
    hbVoorstelBesluit("vtest", "goedgekeurd"); const na = herstelKern(V);
    hbTerugdraaien(HB_VERSIE_BASIS); const terug = herstelKern(V);
    const ok = metVoorstel.niveau === voor.niveau && metVoorstel.versie === HB_VERSIE_BASIS && /voorstel/.test(schaduw.versie)
      && na.versie !== HB_VERSIE_BASIS && terug.versie === HB_VERSIE_BASIS && terug.niveau === voor.niveau;
    return {ok, detail: `voor ${voor.niveau}/${voor.versie}; open ${metVoorstel.niveau}/${metVoorstel.versie}; schaduw ${schaduw.niveau}/${schaduw.versie}; goedgekeurd ${na.niveau}/${na.versie}; terug ${terug.niveau}/${terug.versie}`};
  });
  await test("Een afgewezen voorstel blijft afgewezen tot er genoeg nieuwe gegevens zijn", () => {
    schoon(); zet(reeks());
    let n = 30;
    stub("hbControle", (p) => ({n, positief: 8, ba: p.bandK === 1.0 ? 0.8 : 0.6, gemist: 1, zonderBevestiging: 1, wissels: 0}));
    const eerste = hbVoorstelZoeken();
    if (!eerste.voorstel) return {ok: false, detail: "geen eerste voorstel: " + eerste.reden};
    hbVoorstelBewaar(eerste.voorstel); hbVoorstelBesluit(eerste.voorstel.id, "afgewezen");
    const tweede = hbVoorstelZoeken();
    n = 45; const derde = hbVoorstelZoeken();
    return {ok: !tweede.voorstel && /afgewezen/.test(tweede.reden) && !!derde.voorstel, detail: `${tweede.reden}; met meer gegevens: ${derde.voorstel ? "nieuw voorstel" : derde.reden}`};
  });
  await test("Beoordelingen zijn reproduceerbaar met de bewaarde versie", () => {
    schoon(); zet(reeks()); checkZet({[V]: {gevoel: 4, _t: 1}}); HB_CACHE.clear();
    const h = herstelStatus(V); herstelBewaar(h);
    const rec = leerLees()[V];
    HB_OVERRIDE = {...HB_BASIS, ...rec.params, _versie: rec.versie}; const opnieuw = herstelKern(V); HB_OVERRIDE = null;
    return {ok: !!rec && opnieuw.niveau === rec.niveau && opnieuw.regel === rec.regel && rec.versie === h.versie, detail: `bewaard ${rec && rec.niveau} (${rec && rec.versie}); opnieuw ${opnieuw.niveau}`};
  });
  await test("Een gevolgd advies is geen bewijs: de uitkomst komt alleen uit latere metingen", () => {
    schoon(); zet(reeks());
    const rec = {datum: isoPlus(V, -6), feedback: {gevolgd: "ja", klopte: "ja"}};
    const zonder = hbEvalueer(rec, {k: "gevoel_terug", eval: isoPlus(V, -3)});
    checkZet({[isoPlus(V, -5)]: {gevoel: 4, _t: 1}}); HB_CACHE.clear();
    const met = hbEvalueer(rec, {k: "gevoel_terug", eval: isoPlus(V, -3)});
    const orig = uiPaneel; let html = ""; window.uiPaneel = (t, h) => { html = h; };
    try { hbLeerPaneel(); } finally { window.uiPaneel = orig; }
    return {ok: zonder.uitkomst === "onbekend" && met.uitkomst === "bevestigd" && /bewijst niet/.test(html), detail: `zonder check-in ${zonder.uitkomst}, met check-in ${met.uitkomst}`};
  });
  await test("De weekscore volgt de specifieke planaanpassing", () => {
    schoon();
    const ma = maandagVan(V), d = isoPlus(ma, 2);
    const item = dagRoute(d, {alleenLezen: true}).items.find(i => i.soort === "hoog") || dagRoute(d, {alleenLezen: true}).items.find(i => i.soort !== "rust");
    if (!item) return {ok: false, detail: "geen sessie op woensdag"};
    const I = bewaardLees(INSTEL_KEY, {});
    bewaardSchrijf(INSTEL_KEY, {...I, wijzigingen: [...(I.wijzigingen || []), {datum: d, item: item.id, regel: "herstel", wat: `${item.titel} → rustige duur`, waarom: "test",
      nieuw: {soort: "laag", titel: "Rustige duur (in plaats van intervallen)", voorschrift: "test"}}]});
    planStatusZet(d, item.id, "gedaan"); HB_CACHE.clear();
    const w = weekScore(ma);
    const alles = Object.values(w.perDoel).flatMap(x => x.wat);
    return {ok: w.tel.aangepastGevolgd === 1 && alles.some(t => /aangepast \(herstel\)/.test(t)), detail: alles.join(" | ")};
  });
  await test("Compacte balk, plan, coach en detailpaneel tonen dezelfde beoordeling", () => {
    schoon(); zet(reeks()); checkZet({[V]: {gevoel: 2, lijf: {benen: 2}, _t: 1}, [isoPlus(V, -1)]: {gevoel: 2, lijf: {benen: 2}, _t: 2}}); HB_CACHE.clear();
    renderVermoeidheid();
    const balk = document.querySelector("#hsVermoeid .hb-balk-status").textContent.trim();
    const k = herstelKern(V), s = herstelSignalen(V), c = coachContext().herstel;
    return {ok: balk === HB_KORT_TITEL[k.niveau] && s.niveau === k.niveau && c.status === HB_NIVEAU[k.niveau].titel, detail: `balk "${balk}", kern ${k.niveau}, plan ${s.niveau}, coach "${c.status}"`};
  });
  herstel(); renderVermoeidheid();
  await test("Testgegevens blijven buiten je opslag", () => {
    const zelfde = Object.keys(opslag).every(k => localStorage.getItem(k) === opslag[k]) && localStorage.length === Object.keys(opslag).length;
    return {ok: zelfde && DATA.historie === echt.historie, detail: `opslag gelijk ${zelfde}`};
  });
  return uit;
})()
