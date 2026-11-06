/* Ongeplande trainingen: zichtbaar in Training en Plan, en meegeteld voor
   hun eigen doel in de weekscore.
     const r = eval(await (await fetch("/extra.js")).text())  (async: await r) */
(async () => {
  const uit = [];
  const opslag = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); opslag[k] = localStorage.getItem(k); }
  const echt = DATA.activities;
  const herstel = () => { DATA.activities = echt; HB_CACHE.clear();
    Object.keys(localStorage).forEach(k => { if (!(k in opslag)) localStorage.removeItem(k); });
    Object.entries(opslag).forEach(([k, v]) => { if (localStorage.getItem(k) !== v) localStorage.setItem(k, v); }); };
  const test = async (naam, f) => { try { const r = await f(); uit.push({naam, ...r}); } catch (e) { uit.push({naam, ok: false, detail: "fout: " + e.message}); } finally { herstel(); } };
  const v = vandaagIso(), ma = maandagVan(v);
  const kracht = (d, min = 40, id = 9990001) => ({id, date: d, datetime: `${d}T18:00:00`, sport: "Kracht", type_key: "strength_training", name: "Kracht extra", duration_s: min * 60, avg_hr: 110, load: 30});
  /* een dag deze week zonder geplande kracht */
  const dagen = [0, 1, 2, 3, 4, 5, 6].map(n => isoPlus(ma, n)).filter(d => d <= v);
  const vrij = dagen.find(d => !dagRoute(d, {alleenLezen: true}).items.some(i => i.soort === "kracht")) || v;

  await test("Een ongeplande krachttraining staat bij Training en Plan", () => {
    DATA.activities = [...echt.filter(a => a.date !== vrij || a.sport !== "Kracht"), kracht(vrij)];
    HB_CACHE.clear();
    ROUTE_DAG = vrij; renderTrainingRoute();
    const tr = document.getElementById("wkVandaag").innerHTML;
    /* Plan toont vandaag en later: een extra training van vandaag hoort daar ook */
    DATA.activities = [...DATA.activities, {...kracht(v, 40, 9990009), name: "Kracht vandaag extra"}]; HB_CACHE.clear();
    PLAN_DAG = v; renderPlanNieuw();
    const pl = (document.getElementById("plWeek") || {}).innerHTML || "";
    ROUTE_DAG = null; PLAN_DAG = null;
    const lijst = ongeplandOp(vrij);
    return {ok: lijst.some(x => x.doel === "kracht") && /Ook gedaan, niet gepland/.test(tr) && /Kracht extra/.test(tr) && /Kracht vandaag extra/.test(pl),
      detail: `${vrij}: ${lijst.map(x => `${x.wat} (${x.doel})`).join(", ")}`};
  });
  await test("In de weekscore vult hij een gemiste of onbekende krachtsessie, anders telt hij als extra", () => {
    DATA.activities = echt.filter(a => !(a.date >= ma && a.date <= v && a.sport === "Kracht" && !itemStatusLink(a)));
    HB_CACHE.clear();
    const voor = weekScore(ma);
    DATA.activities = [...DATA.activities, kracht(vrij)];
    HB_CACHE.clear();
    const na = weekScore(ma);
    const kv = voor.perDoel.kracht || {gedaan: 0, gemist: 0, onbekend: 0}, kn = na.perDoel.kracht || {gedaan: 0, extra: 0};
    const open = (kv.gemist || 0) + (kv.onbekend || 0);
    const ok = open > 0 ? kn.gedaan === kv.gedaan + 1 && na.tel.vervangen >= 1 && (na.score ?? 0) >= (voor.score ?? 0)
                        : (kn.extra || 0) === (kv.extra || 0) + 1 && na.score === voor.score;
    return {ok, detail: `kracht voor ${kv.gedaan}/${kv.gepland || 0} (open ${open}), na ${kn.gedaan}/${kn.gepland || 0} +${kn.extra || 0}; score ${voor.score} → ${na.score}`};
  });
  await test("Extra kracht vervangt geen handbal", () => {
    const voor = weekScore(ma);
    DATA.activities = [...echt, kracht(vrij, 40, 9990002), kracht(vrij, 40, 9990003), kracht(vrij, 40, 9990004), kracht(vrij, 40, 9990005)];
    HB_CACHE.clear();
    const na = weekScore(ma);
    const hv = voor.perDoel.handbal || {gedaan: 0}, hn = na.perDoel.handbal || {gedaan: 0};
    return {ok: hn.gedaan === hv.gedaan && (na.score ?? 0) <= 100, detail: `handbal ${hv.gedaan} → ${hn.gedaan}, score ${na.score}`};
  });
  await test("Korter dan een kwartier telt niet als training", () => {
    DATA.activities = [...echt, kracht(vrij, 10, 9990006)];
    HB_CACHE.clear();
    return {ok: !ongeplandOp(vrij).some(x => x.act && x.act.id === 9990006), detail: "10 minuten"};
  });
  await test("Zelf toegevoegde training telt mee, de zwaarte bij een geplande sessie niet", () => {
    const c = checkLees();
    checkZet({...c, [vrij]: {...(c[vrij] || {}), sessies: [{sport: "Kracht", naam: "Kracht", minuten: 30, rpe: 6, handmatig: true, toegevoegd: true}]}});
    DATA.activities = echt.filter(a => !(a.date === vrij && a.sport === "Kracht"));
    HB_CACHE.clear();
    const l = ongeplandOp(vrij);
    return {ok: l.some(x => x.bron === "eigen" && x.doel === "kracht"), detail: l.map(x => `${x.wat}/${x.bron}`).join(", ")};
  });
  await test("Activiteit toont de prikkel (Training Effect) onder de hartslaggrafiek", () => {
    const a = (DATA.activities || []).find(x => x.aerobic_te != null && x.anaerobic_te != null);
    if (!a) return {ok: false, detail: "geen activiteit met Training Effect"};
    let html = ""; const orig = uiPaneel; window.uiPaneel = (t, h) => { html = h; };
    try { activiteitPaneel(a.id); } finally { window.uiPaneel = orig; }
    const iTe = html.indexOf("Prikkel (Training Effect)"), iGraf = html.indexOf("as-grafiek"), iZone = html.indexOf("Hartslagzones");
    return {ok: iTe > 0 && (iGraf < 0 || iGraf < iTe) && (iZone < 0 || iTe < iZone) && /Aeroob/.test(html) && /Anaeroob/.test(html), detail: `${a.sport} ${a.aerobic_te}/${a.anaerobic_te}`};
  });
  await test("Een overgeslagen sessie verdwijnt uit de lijst en is terug te zetten", () => {
    const d = dagen.find(x => dagRoute(x, {alleenLezen: true}).items.some(i => i.soort !== "rust")) || v;
    const it = dagRoute(d, {alleenLezen: true}).items.find(i => i.soort !== "rust");
    planStatusZet(d, it.id, "overgeslagen");
    ROUTE_DAG = d; renderTrainingRoute();
    const host = document.getElementById("wkVandaag");
    const weg = !host.querySelector(`[data-sessie="${d}|${it.id}"]`) && !!host.querySelector(`[data-overgeslagen="${d}|${it.id}"]`);
    host.querySelector(`[data-overgeslagen="${d}|${it.id}"]`).click();
    const terug = itemStatus(d, it).k !== "overgeslagen";
    ROUTE_DAG = null;
    return {ok: weg && terug, detail: `${d} ${it.titel}: weg ${weg}, teruggezet ${terug}`};
  });
  await test("Advies weet van een ongeplande training vandaag", () => {
    DATA.activities = [...echt, {...kracht(v, 40, 9990011), name: "Kracht extra"}, {id: 9990012, date: v, datetime: `${v}T08:00:00`, sport: "Hardlopen", type_key: "running", name: "Loop", duration_s: 2400, load: 60}];
    HB_CACHE.clear();
    const a = routeAdvies();
    return {ok: !/^Volg vandaag je plan/.test(a.kop) && /extra|niet gepland|trainde/.test(a.kop + a.label + a.zin), detail: `${a.label} | ${a.kop} | ${a.zin}`};
  });
  await test("Stoplicht per doel: extra die binnen je gewone belasting past is groen", () => {
    DATA.activities = [...echt, {id: 9990021, date: vrij, datetime: `${vrij}T07:00:00`, sport: "Hardlopen", type_key: "running", name: "Loop extra", duration_s: 1800, load: 1}];
    HB_CACHE.clear();
    const w = weekScore(ma), d = weekDoelen(w).find(x => x.k === "conditie");
    const html = weekDoelenHtml(w) + wsBalken(w);
    return {ok: !!d.kleur && /hs-chip/.test(html) && /ws-stip/.test(html) && (w.loadMax8 == null || w.load <= w.loadMax8 ? (d.t.extra ? /past binnen/.test(d.oordeel) : true) : true),
      detail: `conditie ${d.kleur}: ${d.oordeel} (week ${w.load}, max 8 wk ${w.loadMax8})`};
  });
  await test("Extra terwijl je week zwaarder is dan je afgelopen 8 weken wordt oranje", () => {
    DATA.activities = [...echt, {id: 9990022, date: vrij, datetime: `${vrij}T07:00:00`, sport: "Hardlopen", type_key: "running", name: "Loop extra zwaar", duration_s: 5400, load: 5000}];
    HB_CACHE.clear();
    const w = weekScore(ma), d = weekDoelen(w).find(x => x.k === "conditie");
    return {ok: w.loadMax8 == null || (d.kleur === "oranje" || d.kleur === "rood") && /zwaarder/.test(d.oordeel), detail: `${d.kleur}: ${d.oordeel}`};
  });
  herstel(); allesHertekenen();
  return uit;
  function itemStatusLink(a) { return dagRoute(a.date, {alleenLezen: true}).items.some(i => (itemStatus(a.date, i).acts || []).some(x => x.id === a.id)); }
})()
