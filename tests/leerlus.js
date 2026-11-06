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
    const I = bewaardLees(INSTEL_KEY, {}); delete I.hbModel; delete I.hbVoorstellen; delete I.hbToetsGebruikt; bewaardSchrijf(INSTEL_KEY, I); HB_CACHE.clear(); };

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
  await test("Ontbrekende RIR: beperkte vergelijkbaarheid, de vergelijking blijft", () => {
    schoon(); zet(reeks());
    const k = (datum, reps, rir, id) => ({_id: id, type: "A", datum, plek: null, oefeningen: {bench: {kg: 100, reps, sets: 3, rir}}});
    logZet([k(isoPlus(V, -10), 6, null, "a"), k(isoPlus(V, -3), 5, 2, "b")]); HB_CACHE.clear();
    const pt = herstelKern(V).ind.prestatie.punten.find(x => x.soort === "kracht");
    return {ok: !!pt && pt.gewicht === 0.5 && pt.slechter && /beperkte vergelijkbaarheid: RIR ontbreekt/.test(pt.noot), detail: pt ? `${pt.tekst} (${pt.noot})` : "geen vergelijking"};
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
    stub("hbControle", (p) => ({n, positief: 8, periodes: 6, ba: p.bandK === 1.0 ? 0.8 : 0.6, gemist: 1, zonderBevestiging: 1, wissels: 0}));
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
    return {ok: zonder.uitkomst === "onbekend" && met.uitkomst === "waargenomen" && /bewijst niet/.test(html), detail: `zonder check-in ${zonder.uitkomst}, met check-in ${met.uitkomst} (${met.waarneming})`};
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

  /* ---- synchronisatie: conflicten en verwijderingen ---- */
  const syncMet = async (gist, opties = {}) => {
    let geschreven = null;
    stub("gistHaal", async () => JSON.parse(JSON.stringify(gist)));
    stub("gistZet", opties.faalt ? async () => { throw new Error("netwerk weg"); } : async doc => { geschreven = doc; });
    const aan = SYNC.aan; SYNC.aan = true;
    try { await syncRonde(false); } finally { SYNC.aan = aan; }
    return geschreven;
  };
  const D = "2026-11-03";
  await test("Echt conflict: beide versies blijven bewaard met moment en herkomst", async () => {
    schoon();
    /* beide kanten veranderden sinds versie t=100 */
    localStorage.setItem(CHECK_KEY, JSON.stringify({[D]: {gevoel: 2, _t: 300, _bron: "browser-aaaa", _basis: 100, _ongesync: true}}));
    const g = await syncMet({v: 1, check: {[D]: {gevoel: 4, _t: 200, _bron: "telefoon-bbbb", _basis: 100}}});
    const r = checkLees()[D], c = (r._conflicten || [])[0];
    const ok = r.gevoel === 2 && c && c.gevoel === 4 && c._bron === "telefoon-bbbb" && c._t === 200 && g.check[D]._conflicten.length === 1 && syncConflicten().length === 1;
    return {ok, detail: `actief ${r.gevoel} (${r._bron}); bewaard ${c ? `${c.gevoel} van ${c._bron} t=${c._t}` : "niets"}`};
  });
  await test("Opvolger zonder conflict: een later gewijzigd record vervangt de vorige versie", async () => {
    schoon();
    localStorage.setItem(CHECK_KEY, JSON.stringify({[D]: {gevoel: 3, _t: 300, _bron: "browser-aaaa", _basis: 200, _ongesync: true}}));
    await syncMet({v: 1, check: {[D]: {gevoel: 4, _t: 200, _bron: "telefoon-bbbb", _basis: 100}}});
    const r = checkLees()[D];
    return {ok: r.gevoel === 3 && !r._conflicten && !r._ongesync, detail: JSON.stringify(r)};
  });
  await test("Een gewist veld komt niet terug van het andere apparaat", async () => {
    schoon();
    localStorage.setItem(CHECK_KEY, JSON.stringify({[D]: {gevoel: 3, _t: 300, _bron: "browser-aaaa", _basis: 200, _ongesync: true}}));
    await syncMet({v: 1, check: {[D]: {gevoel: 3, lijf: {benen: 2}, _t: 200, _bron: "telefoon-bbbb"}}});
    const r = checkLees()[D];
    return {ok: !r.lijf, detail: JSON.stringify(r)};
  });
  await test("Verwijderen gaat mee naar het andere apparaat, en komt niet terug", async () => {
    schoon();
    /* hier verwijderd, in de gist nog de oude versie */
    localStorage.setItem(CHECK_KEY, JSON.stringify({[D]: {gevoel: 3, _t: 100, _bron: "telefoon-bbbb"}}));
    const c = checkLees(); delete c[D]; checkZet(c);
    const g = await syncMet({v: 1, check: {[D]: {gevoel: 3, _t: 100, _bron: "telefoon-bbbb"}}});
    const weg1 = g && g.check[D]._weg && !checkLees()[D];
    /* andersom: op het andere apparaat verwijderd, hier ongewijzigd */
    schoon();
    localStorage.setItem(CHECK_KEY, JSON.stringify({[D]: {gevoel: 3, _t: 100, _bron: "telefoon-bbbb"}}));
    await syncMet({v: 1, check: {[D]: {_weg: true, _t: 400, _bron: "browser-aaaa", _basis: 100}}});
    const weg2 = !checkLees()[D] && JSON.parse(localStorage.getItem(CHECK_KEY))[D]._weg;
    return {ok: !!weg1 && !!weg2, detail: `hier verwijderd → gist ${weg1 ? "grafsteen" : "nog aanwezig"}; elders verwijderd → hier ${weg2 ? "weg (grafsteen bewaard)" : "nog aanwezig"}`};
  });
  await test("Verwijderen tegelijk met een wijziging elders: de wijziging blijft bewaard", async () => {
    schoon();
    localStorage.setItem(CHECK_KEY, JSON.stringify({[D]: {_weg: true, _t: 500, _bron: "browser-aaaa", _basis: 100, _ongesync: true}}));
    await syncMet({v: 1, check: {[D]: {gevoel: 1, _t: 300, _bron: "telefoon-bbbb", _basis: 100}}});
    const rauw = JSON.parse(localStorage.getItem(CHECK_KEY))[D];
    return {ok: rauw._weg && (rauw._conflicten || []).some(x => x.gevoel === 1), detail: JSON.stringify(rauw)};
  });
  await test("Mislukt opslaan bij GitHub: lokale wijziging blijft 'nog te synchroniseren'", async () => {
    schoon();
    localStorage.setItem(CHECK_KEY, JSON.stringify({[D]: {gevoel: 2, _t: 300, _bron: "browser-aaaa", _basis: null, _ongesync: true}}));
    await syncMet({v: 1, check: {}}, {faalt: true});
    const r = JSON.parse(localStorage.getItem(CHECK_KEY))[D];
    return {ok: r._ongesync === true && !!SYNC.fout, detail: `ongesync ${r._ongesync}; fout "${SYNC.fout}"`};
  });
  await test("Invoer tijdens het synchroniseren wordt niet overschreven", async () => {
    schoon();
    localStorage.setItem(CHECK_KEY, JSON.stringify({[D]: {gevoel: 2, _t: 300, _bron: "browser-aaaa", _ongesync: true}}));
    stub("gistHaal", async () => { checkZet({...checkLees(), "2026-11-04": {gevoel: 5}}); return {v: 1, check: {}}; });
    stub("gistZet", async () => {});
    const aan = SYNC.aan; SYNC.aan = true; try { await syncRonde(false); } finally { SYNC.aan = aan; clearTimeout(SYNC_TIMER); }
    const c = checkLees();
    return {ok: c["2026-11-04"] && c["2026-11-04"].gevoel === 5 && c[D].gevoel === 2, detail: Object.keys(c).join(", ")};
  });

  /* ---- beoordelingen: origineel en herberekening ---- */
  await test("Het oorspronkelijke oordeel blijft; een herberekening wordt een nieuwe versie", () => {
    schoon(); zet(reeks());
    const v = vandaagIso();
    herstelBewaar(herstelStatus(v));
    const eerst = JSON.parse(JSON.stringify(leerLees()[v]));
    checkZet({[v]: {gevoel: 1, lijf: {benen: 2}}}); HB_CACHE.clear();
    herstelBewaar(herstelStatus(v));
    const na = leerLees()[v];
    const ok = na.oorspronkelijk.niveau === eerst.niveau && na.oorspronkelijk.berekend === eerst.berekend && na.herberekeningen.length === 1
      && na.nr === 2 && /check-in/.test(na.herberekeningen[0].aanleiding) && na.oorspronkelijk.bekend.checkin === false;
    return {ok, detail: `origineel ${na.oorspronkelijk.niveau} (check-in bekend: ${na.oorspronkelijk.bekend.checkin}); versie 2 ${na.niveau}: ${na.herberekeningen[0] && na.herberekeningen[0].aanleiding}`};
  });
  await test("Controles zijn een evaluatiemoment, geen voorspelde hersteltermijn", () => {
    schoon(); zet(reeks((d, i, n) => i >= n - 7 ? {hrv_week: 70} : {}));
    const v = vandaagIso(); checkZet({[v]: {gevoel: 1, lijf: {benen: 2}}, [isoPlus(v, -1)]: {gevoel: 1}}); HB_CACHE.clear();
    const w = hbVerwachtingen(herstelStatus(v));
    const ctrl = w.filter(hbIsControle);
    const ok = ctrl.length >= 1 && ctrl.every(x => x.soort === "controle" && /geen voorspel/.test(x.tekst)) && !w.some(x => /binnen 3 dagen|weer zoals je eigen normaal|over 2 nachten weer/.test(x.tekst));
    return {ok, detail: w.map(x => `${x.soort}: ${x.tekst}`).join(" | ")};
  });

  /* ---- historische controle: onafhankelijke toetsing ---- */
  await test("Keuze- en toetsdeel delen geen meet- of uitkomstvensters; toetsdagen worden niet hergebruikt", () => {
    schoon(); zet(reeks());
    const gezien = [];
    stub("hbControle", (p, dagen) => { gezien.push(dagen.slice()); return {n: 40, positief: 8, periodes: 6, ba: p.bandK === 1.0 ? 0.9 : 0.6, gemist: 1, zonderBevestiging: 1, wissels: 0}; });
    const a = hbVoorstelZoeken({zonderBoekhouding: false});
    const keus = gezien[1] || [], toets = gezien[0] || [];
    const gat = keus.length && toets.length ? dagVerschil(keus[keus.length - 1], toets[0]) : 0;
    const b = hbVoorstelZoeken();
    return {ok: gat > HB_EMBARGO && a.gebruikt === null && b.toetsVan > toets[toets.length - 1], detail: `gat ${gat} dagen (embargo ${HB_EMBARGO}); tweede toets vanaf ${b.toetsVan}, eerste liep t/m ${toets[toets.length - 1]}`};
  });
  await test("Opeenvolgende slechte dagen tellen als één herstelperiode", () => {
    schoon(); zet(reeks());
    const c = {};
    for (let i = 60; i >= 10; i--) c[isoPlus(V, -i)] = {gevoel: 4};
    for (let i = 30; i >= 26; i--) c[isoPlus(V, -i)] = {gevoel: 1};     // één slechte periode van 5 dagen
    checkZet(c); HB_CACHE.clear();
    const dagen = Array.from({length: 40}, (_, i) => isoPlus(V, -50 + i));
    const t = hbControle(hbModel().params, dagen);
    return {ok: t.periodes === 1, detail: `${t.n} beoordeelbare dagen, ${t.positief} ongunstige uitkomstdagen, ${t.periodes} periode(s)`};
  });

  /* ---- HRV: grootheid en referentie ---- */
  await test("Zonder Garmin-band wordt het weekgemiddelde vergeleken met eerdere weekgemiddelden", () => {
    schoon(); zet(reeks((d, i, n) => ({hrv_week: null, hrv_band_laag: null, hrv_band_hoog: null, hrv: 100 + ((i * 37) % 21) - 10})));
    const h = herstelKern(V).ind.hart.hrv, r = h.weekRef;
    const dagBand = hbReferentie("hrv", V, {log: true});
    const ok = r && r.grootheid === "weekgemiddelde" && r.onafh >= HB.weekMinOnafh && r.n > r.onafh && (r.hoog - r.laag) < (dagBand.hoog - dagBand.laag);
    return {ok, detail: r ? `weekband ${Math.round(r.laag)}–${Math.round(r.hoog)} (${r.n} weekgemiddelden, ${r.onafh} niet-overlappend); nachtband ${Math.round(dagBand.laag)}–${Math.round(dagBand.hoog)}` : "geen weekreferentie"};
  });
  await test("Te weinig nachten: geen weekgemiddelde, geen oordeel", () => {
    schoon(); zet(reeks((d, i, n) => ({hrv_week: null, hrv_band_laag: null, hrv: i >= n - 7 && i % 2 ? null : (i >= n - 7 ? null : 100)})));
    const h = herstelKern(V).ind.hart.hrv;
    return {ok: h.week == null && h.weekStand == null, detail: `week ${h.week}, stand ${h.weekStand}`};
  });
  await test("Leerpaneel zegt eerlijk dat de leerlus in opbouw is", () => {
    schoon(); zet(reeks());
    const orig = uiPaneel; let html = ""; window.uiPaneel = (t, h) => { html = h; };
    try { hbLeerPaneel(); } finally { window.uiPaneel = orig; }
    const tekst = document.querySelector("#hsVermoeid") ? "" : "";
    return {ok: /Persoonlijke leerlus in opbouw/.test(html) && /afzonderlijke herstelperiodes/.test(html) && !/halve zekerheid/.test(document.documentElement.innerHTML + html), detail: html.match(/Persoonlijke leerlus in opbouw[^<]*<\/b>[^<]*/)?.[0] || "niet gevonden"};
  });
  herstel(); renderVermoeidheid();
  await test("Testgegevens blijven buiten je opslag", () => {
    const zelfde = Object.keys(opslag).every(k => localStorage.getItem(k) === opslag[k]) && localStorage.length === Object.keys(opslag).length;
    return {ok: zelfde && DATA.historie === echt.historie, detail: `opslag gelijk ${zelfde}`};
  });
  return uit;
})()
