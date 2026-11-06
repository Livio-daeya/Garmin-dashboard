/* Controles voor de herstelbeoordeling (model HB-2). Draait geïsoleerd in de
   browser op de preview:
     const r = eval(await (await fetch("/herstel.js")).text())  (async: await r)
   Gebruikt technische testdata in een kopie van DATA en zet zowel DATA als
   alle opslag daarna terug. Testdata komt nooit in je historie, je
   beoordelingslog of de coachcontext. */
(async () => {
  const uit = [];
  const test = async (naam, f) => { HB_CACHE.clear(); try { const r = await f(); uit.push({naam, ...r}); } catch (e) { uit.push({naam, ok: false, detail: "fout: " + e.message}); } finally { herstel(); } };
  const opslag = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); opslag[k] = localStorage.getItem(k); }
  const echt = {historie: DATA.historie, acts: DATA.historie_acts, vandaag: DATA.planbasis.vandaag};
  const herstel = () => { DATA.historie = echt.historie; DATA.historie_acts = echt.acts; DATA.planbasis.vandaag = echt.vandaag;
    Object.keys(localStorage).forEach(k => { if (!(k in opslag)) localStorage.removeItem(k); });
    Object.entries(opslag).forEach(([k, v]) => { if (localStorage.getItem(k) !== v) localStorage.setItem(k, v); }); HB_CACHE.clear(); };
  const V = "2026-11-05";
  /* technische testreeks: 120 dagen, één toestel, rustige spreiding */
  const reeks = (f = () => ({}), n = 120) => Array.from({length: n}, (_, i) => { const d = isoPlus(V, -(n - 1 - i)), j = i % 7;
    return {date: d, toestel: 1, hrv: 100 + (j - 3) * 3, hrv_week: 100, hrv_band_laag: 85, hrv_band_hoog: 120, hrv_status: "BALANCED",
      rhr: 45 + (j % 3) - 1, slaap_hr: 50 + (j % 3), sleep_h: 7.5 + (j - 3) * 0.1, huidtemp_afw: (j - 3) * 0.05, resp_sleep: 13 + (j % 3) * 0.2,
      spo2_gem: null, readiness: 70, bb_wake: 80, stress_avg: 25, ...f(d, i, n)}; });
  const zet = (rijen, acts = []) => { DATA.historie = rijen; DATA.historie_acts = acts; DATA.planbasis.vandaag = V; HB_CACHE.clear(); };
  const checks = o => { checkZet(o); HB_CACHE.clear(); };
  const normaal = {[V]: {gevoel: 4, lijf: {benen: 0, herstel: 0, energie: 0}}};

  await test("Geen gegevens wordt niet normaal", () => {
    zet([]); checks({});
    const k = herstelKern(V);
    return {ok: k.niveau === "grijs" && k.ind.hart.niveau === "grijs" && k.ind.slaap.niveau === "grijs", detail: `${k.niveau}; hart ${k.ind.hart.niveau}; slaap ${k.ind.slaap.niveau}`};
  });
  await test("Ontbrekende temperatuur wordt niet nul", () => {
    zet(reeks(() => ({huidtemp_afw: null}))); checks(normaal);
    const t = herstelKern(V).ind.overig.temp;
    const html = hbMetingRij("Huidtemperatuur", t, n => n, " °C");
    return {ok: t.actueel === null && t.stand === "onbekend" && /haal dit uit de Garmin-data/.test(html), detail: `actueel ${t.actueel}, stand ${t.stand}`};
  });
  await test("Een losse HRV-afwijking wordt geen diagnose", () => {
    zet(reeks((d, i, n) => i === n - 1 ? {hrv: 60} : {})); checks(normaal);
    const k = herstelKern(V);
    return {ok: !["oranje", "rood"].includes(k.niveau), detail: `${k.niveau}; hart: ${k.ind.hart.reden}`};
  });
  await test("Een hoge HRV wordt niet automatisch groen", () => {
    zet(reeks((d, i, n) => i >= n - 7 ? {hrv: 140, hrv_week: 135} : {})); checks(normaal);
    const k = herstelKern(V);
    return {ok: k.ind.hart.niveau !== "groen" && k.niveau !== "groen", detail: `hart ${k.ind.hart.niveau} (${k.ind.hart.reden}); totaal ${k.niveau}`};
  });
  await test("Normale hartmetingen wissen zware benen of pijn niet", () => {
    zet(reeks());
    checks({[V]: {gevoel: 4, lijf: {achilles: 2}}}); const pijn = herstelKern(V).niveau;
    checks({[V]: {gevoel: 3, lijf: {benen: 2}}, [isoPlus(V, -1)]: {gevoel: 3, lijf: {benen: 2}}}); const benen = herstelKern(V);
    return {ok: pijn === "rood" && benen.niveau === "oranje" && benen.ind.hart.niveau === "groen", detail: `pijn ${pijn}; zware benen ${benen.niveau} bij hart ${benen.ind.hart.niveau}`};
  });
  const loop = (d, pace, hr, extra = {}) => ({id: d + pace, date: d, sport: "Hardlopen", toestel: 1, binnen: false, duration_s: 2400, avg_hr: hr, pace_s_per_km: pace, hard_frac: 0.05, load: 50, ...extra});
  const eerdere = [20, 30, 40, 50].map(n => loop(isoPlus(V, -n), 360, 140));
  await test("Hogere hartslag bij sneller lopen is geen vermoeidheidssignaal", () => {
    zet(reeks(), [...eerdere, loop(isoPlus(V, -1), 300, 165)]); checks(normaal);
    const p = herstelKern(V).ind.prestatie;
    return {ok: !p.punten.some(x => x.slechter) && p.beperkt.length === 1, detail: `${p.punten.length} vergelijkingen; ${p.beperkt.join("; ")}`};
  });
  await test("Ongelijke omstandigheden blokkeren de vergelijking", () => {
    zet(reeks(), [...eerdere, loop(isoPlus(V, -1), 360, 160, {toestel: 2}), loop(isoPlus(V, -2), 360, 160, {binnen: true})]); checks(normaal);
    const p = herstelKern(V).ind.prestatie;
    return {ok: !p.punten.length, detail: `${p.punten.length} vergelijkingen; beperkt: ${p.beperkt.length}`};
  });
  await test("Lagere hartslag met slechter functioneren is geen verbetering", () => {
    const rpe = {}; [20, 30, 40, 50].forEach(n => { rpe[isoPlus(V, -n)] = {sessies: [{sport: "Hardlopen", rpe: 4, minuten: 40}]}; });
    rpe[isoPlus(V, -1)] = {sessies: [{sport: "Hardlopen", rpe: 7, minuten: 40}]};
    zet(reeks(), [...eerdere, loop(isoPlus(V, -1), 360, 125)]); checks({...rpe, ...normaal});
    const p = herstelKern(V).ind.prestatie, l = p.punten.find(x => x.soort === "lopen");
    return {ok: !!l && l.slechter, detail: l ? l.tekst : "geen vergelijking"};
  });
  await test("Huidtemperatuur heet geen lichaamstemperatuur", () => {
    zet(reeks()); checks(normaal);
    const orig = uiPaneel; let html = ""; window.uiPaneel = (t, h) => { html = h; };
    try { herstelIndicatorPaneel("overig"); } finally { window.uiPaneel = orig; }
    return {ok: /geen lichaamstemperatuur/.test(html) && !/je lichaamstemperatuur (is|was)/i.test(html), detail: html.match(/Huidtemperatuur is[^.]+\./) ? html.match(/Huidtemperatuur is[^.]+\./)[0] : "tekst niet gevonden"};
  });
  await test("Garmin-samenstellingen tellen niet dubbel", () => {
    zet(reeks()); checks(normaal); const a = herstelKern(V).niveau;
    zet(reeks(() => ({readiness: 5, bb_wake: 5, stress_avg: 95}))); checks(normaal); const b = herstelKern(V).niveau;
    return {ok: a === b, detail: `normaal ${a}; met extreme Garmin-scores ${b}`};
  });
  await test("Een langdurige afwijking verdwijnt niet door referentieverschuiving", () => {
    zet(reeks((d, i, n) => i >= n - 21 ? {rhr: 53} : {})); checks(normaal);
    const h = herstelKern(V).ind.hart;
    return {ok: h.ongunstig && h.rhr.boven7 >= 3, detail: `${h.reden}; band ${hbRond(h.rhr.ref.laag, 1)}–${hbRond(h.rhr.ref.hoog, 1)}`};
  });
  await test("Een toestelwissel wordt herkend", () => {
    zet(reeks((d, i, n) => i < n - 40 ? {toestel: 9, rhr: 55} : {})); checks(normaal);
    const r = herstelKern(V).ind.hart.rhr.ref;
    return {ok: r.uitgesloten > 0 && r.centraal < 50, detail: `${r.uitgesloten} uitgesloten; centraal ${hbRond(r.centraal, 1)}`};
  });
  await test("Een slaapgemiddelde is geen slaapbehoefte", () => {
    zet(reeks()); checks(normaal);
    const s = herstelKern(V).ind.slaap;
    return {ok: s.behoefte === null && s.tekort === null && !/tekort/.test(s.reden), detail: `behoefte ${s.behoefte}; ${s.reden}`};
  });
  await test("Kracht alleen met passende eerdere prestatie vergeleken", () => {
    zet(reeks());
    const k = (datum, kg, reps, rir) => ({type: "A", datum, plek: null, oefeningen: {bench: {kg, reps, sets: 3, rir}}});
    logZet([k(isoPlus(V, -10), 100, 6, 2), k(isoPlus(V, -3), 105, 4, 2)]); HB_CACHE.clear();
    const ander = herstelKern(V).ind.prestatie.punten.length;
    logZet([k(isoPlus(V, -10), 100, 6, null), k(isoPlus(V, -3), 100, 4, 2)]); HB_CACHE.clear();
    const p = herstelKern(V).ind.prestatie;
    return {ok: ander === 0 && p.punten.length === 0 && p.beperkt.length === 1, detail: `ander gewicht: ${ander}; zonder RIR: ${p.beperkt.join("; ")}`};
  });
  await test("Ziekte wordt niet weggemiddeld", () => {
    zet(reeks()); checks({[V]: {gevoel: 4, lijf: {ziek: 1}}});
    const k = herstelKern(V);
    return {ok: k.niveau === "rood", detail: `${k.niveau}: ${k.regel}`};
  });
  await test("Alle schermen tonen dezelfde beoordeling", () => {
    zet(reeks()); checks({[V]: {gevoel: 2, lijf: {benen: 2}}, [isoPlus(V, -1)]: {gevoel: 2, lijf: {benen: 2}}});
    const k = herstelKern(V), s = herstelSignalen(V), c = coachContext().herstel, h = herstelStatus(V);
    return {ok: k.niveau === s.niveau && c.status === h.titel && c.regel === k.regel, detail: `kern ${k.niveau}, plan ${s.niveau}, coach "${c.status}"`};
  });
  await test("Historische beoordeling gebruikt geen toekomstige gegevens", () => {
    const d = isoPlus(V, -10);
    zet(reeks()); checks(normaal); const voor = JSON.stringify({n: herstelKern(d).niveau, h: herstelKern(d).ind.hart.rhr.actueel, r: herstelKern(d).ind.hart.rhr.ref.centraal});
    zet(reeks((x, i, n) => i > n - 10 ? {rhr: 70, hrv: 40, hrv_week: 40, sleep_h: 4} : {})); checks(normaal);
    const na = JSON.stringify({n: herstelKern(d).niveau, h: herstelKern(d).ind.hart.rhr.actueel, r: herstelKern(d).ind.hart.rhr.ref.centraal});
    return {ok: voor === na, detail: `${voor} / ${na}`};
  });
  herstel();
  await test("Testgegevens blijven buiten je historie, log en coach", () => {
    const zelfde = Object.keys(opslag).every(k => localStorage.getItem(k) === opslag[k]) && localStorage.length === Object.keys(opslag).length;
    return {ok: zelfde && DATA.historie === echt.historie && DATA.historie_acts === echt.acts, detail: `opslag gelijk ${zelfde}`};
  });
  return uit;
})()
