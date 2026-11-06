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
  await test("Een workout verwijderen haalt plan én registratie weg, en is terug te zetten", async () => {
    const d = dagen.find(x => dagRoute(x, {alleenLezen: true}).items.some(i => i.soort !== "rust" && (itemStatus(x, i).acts || []).length));
    if (!d) return {ok: true, detail: "geen geplande sessie met registratie deze week"};
    const it = dagRoute(d, {alleenLezen: true}).items.find(i => i.soort !== "rust" && (itemStatus(d, i).acts || []).length);
    const act = itemStatus(d, it).acts[0];
    const scoreVoor = weekScore(ma).score;
    workoutVerwijderen(d, it);
    document.querySelector("[data-ja]").click();
    const wegPlan = !dagRoute(d, {alleenLezen: true}).items.some(i => i.id === it.id && i.soort !== "rust");
    const wegAct = !DATA.activities.some(a => String(a.id) === String(act.id)) && !ongeplandOp(d).some(x => x.act && String(x.act.id) === String(act.id));
    ROUTE_DAG = d; renderTrainingRoute();
    const terugKnop = document.querySelector(`#wkVandaag [data-terugact="${act.id}"]`);
    const scoreNa = weekScore(ma).score;
    planVerwijderTerug(d, it.id); actVerbergen(act.id, false); allesHertekenen(); ROUTE_DAG = null;
    const terug = DATA.activities.some(a => String(a.id) === String(act.id)) && dagRoute(d, {alleenLezen: true}).items.some(i => i.id === it.id && i.soort !== "rust");
    return {ok: wegPlan && wegAct && !!terugKnop && terug, detail: `${d} ${it.titel}: plan weg ${wegPlan}, registratie weg ${wegAct}, terugzetknop ${!!terugKnop}, terug ${terug}; score ${scoreVoor} → ${scoreNa}`};
  });
  await test("Een ongeplande registratie verwijderen vanuit de activiteit", () => {
    DATA.activities = [...echt, kracht(vrij, 40, 9990041)]; HB_CACHE.clear();
    if (!DATA._alleActs || DATA._gefilterd === false) { DATA._alleActs = DATA.activities; }
    let html = ""; const orig = uiPaneel; window.uiPaneel = (t, h, f) => { html = h; };
    try { activiteitPaneel(9990041); } finally { window.uiPaneel = orig; }
    return {ok: /data-as="verwijder"/.test(html), detail: "knop aanwezig"};
  });
  await test("Eigen krachtinvoer op een dag met een overgeslagen haltraining telt als kracht", () => {
    const d = dagen.find(x => dagRoute(x, {alleenLezen: true}).items.some(i => i.soort === "kracht"));
    if (!d) return {ok: true, detail: "geen geplande kracht deze week"};
    const it = dagRoute(d, {alleenLezen: true}).items.find(i => i.soort === "kracht");
    planStatusZet(d, it.id, "overgeslagen");
    const c = checkLees(); checkZet({...c, [d]: {...(c[d] || {}), sessies: [{sport: "Kracht", naam: "Kracht", minuten: 45, rpe: 7, handmatig: true}]}});
    DATA.activities = echt.filter(a => !(a.date === d && a.sport === "Kracht")); HB_CACHE.clear();
    const a = trainingsAdvies(ma);
    return {ok: ongeplandOp(d).some(x => x.doel === "kracht" && x.bron === "eigen") && a.kracht.dagen.some(x => x.d === d), detail: `${d}: ${JSON.stringify(a.kracht.dagen)}`};
  });
  await test("Een ongeplande loop op de dag van een overgeslagen zaaltraining is pas na bevestiging een vervanging", () => {
    const d = dagen.find(x => dagRoute(x, {alleenLezen: true}).items.some(i => i.soort === "handbal"));
    if (!d) return {ok: true, detail: "geen zaaltraining deze week"};
    const it = dagRoute(d, {alleenLezen: true}).items.find(i => i.soort === "handbal");
    planStatusZet(d, it.id, "overgeslagen");
    DATA.activities = [...echt.filter(a => !(a.date === d && a.sport === "Handbal")), {id: 9990051, date: d, datetime: `${d}T18:00:00`, sport: "Hardlopen", type_key: "running", name: "Buitenintervallen", duration_s: 2700, aerobic_te: 3.6, anaerobic_te: 2.4, load: 120}];
    HB_CACHE.clear();
    const voor = ongeplandOp(d).find(y => y.act && y.act.id === 9990051);
    vervangingZet(`${d}|9990051`, it.id, "Zaaltraining", true); HB_CACHE.clear();
    const a = trainingsAdvies(ma), x = ongeplandOp(d).find(y => y.act && y.act.id === 9990051);
    const html = adviesHtml(a);
    return {ok: !!voor && !voor.vervangt && !!voor.vervangVraag && !!x && x.vervangt === "Zaaltraining" && /vervanging van zaaltraining/.test(html) && /geen techniek/.test(html),
      detail: `${d}: eerst vraag "${voor && voor.vervangVraag && voor.vervangVraag.titel}", na bevestiging vervangt ${x && x.vervangt}`};
  });
  await test("Jouw beschreven week: 3 krachtsessies, 2 zaaltrainingen, loop als bevestigde vervanging, geen extra intensief werk richting de wedstrijd", () => {
    const vr = isoPlus(ma, 4), di = isoPlus(ma, 1), wo = isoPlus(ma, 2), dn = isoPlus(ma, 3);
    const oudV = DATA.planbasis.vandaag; DATA.planbasis.vandaag = vr;
    try {
      const act = (id, d, uur, sport, type, min, load, te, ana, naam) => ({id, date: d, datetime: `${d}T${uur}:00`, sport, type_key: type, name: naam, duration_s: min * 60, load, aerobic_te: te, anaerobic_te: ana});
      DATA.activities = [...echt.filter(a => a.date < ma || a.date > isoPlus(ma, 6)),
        act(9991001, ma, "18:00", "Kracht", "strength_training", 50, 40, 1.2, 0.3, "Kracht thuis"),
        act(9991002, di, "20:00", "Handbal", "basketball", 75, 130, 3.1, 1.8, "Zaaltraining"),
        act(9991003, wo, "19:00", "Hardlopen", "running", 40, 120, 4.0, 1.5, "4x4 min"),
        act(9991004, dn, "20:00", "Handbal", "basketball", 75, 120, 3.0, 1.6, "Zaaltraining"),
        act(9991005, vr, "17:00", "Kracht", "strength_training", 40, 30, 1.0, 0.2, "Krachtsport"),
        act(9991006, vr, "18:30", "Hardlopen", "running", 45, 110, 3.8, 2.6, "Neerpelt hardlopen")];
      HB_CACHE.clear();
      /* dinsdagochtend kracht zelf ingevuld; haltraining dinsdag niet gedaan */
      const diHal = dagRoute(di, {alleenLezen: true}).items.find(i => i.soort === "kracht"); if (diHal) planStatusZet(di, diHal.id, "overgeslagen");
      const dnHal = dagRoute(dn, {alleenLezen: true}).items.find(i => i.soort === "kracht"); if (dnHal) planStatusZet(dn, dnHal.id, "overgeslagen");
      const c = checkLees(); checkZet({...c, [di]: {...(c[di] || {}), sessies: [{sport: "Kracht", naam: "Kracht", minuten: 45, rpe: 7, handmatig: true, toegevoegd: true}]}});
      const vrZaal = dagRoute(vr, {alleenLezen: true}).items.find(i => i.soort === "handbal");
      if (vrZaal) { planStatusZet(vr, vrZaal.id, "overgeslagen"); vervangingZet(`${vr}|9991006`, vrZaal.id, "Zaaltraining", true); }
      HB_CACHE.clear();
      const a = trainingsAdvies(ma);
      const ok = a.kracht.sessies === 3 && a.handbal.gedaan === 2 && a.conditie.intensief >= 2 && a.conditie.lijst.some(x => x.vervangt === "Zaaltraining")
        && ["oranje", "groen", "grijs"].includes(a.status) && a.status !== "blauw" && /Geen extra/.test(a.actie) && a.sessies.length >= 7;
      return {ok, detail: `kracht ${a.kracht.sessies} (${a.kracht.dagen.map(x => x.d.slice(8) + ":" + x.bron.join("+")).join(" ")}), handbal ${a.handbal.gedaan}/${a.handbal.gepland}, intensief ${a.conditie.intensief}; ${a.status} "${a.titel}": ${a.reden} → ${a.actie} | belasting ${a.belasting.nu} (${a.belasting.verhouding}%), verwacht ${a.belasting.verwacht}, op rij ${a.belasting.opRij}`};
    } finally { DATA.planbasis.vandaag = oudV; }
  });
  await test("Combinaties per dag worden vastgelegd, zonder conclusie", () => {
    const d = isoPlus(vandaagIso(), -1);
    const c = dagCombinatie(d);
    herstelBewaar(herstelStatus(vandaagIso()));
    const r = leerLees()[d];
    return {ok: !!r && !!r.combinatie && "krachtEnZaal" in r.combinatie && "dagenTotWedstrijd" in r.combinatie && "daarna" in r && hbLeerStats().beoordelingen === Object.values(leerLees()).filter(x => !x.alleenContext).length,
      detail: JSON.stringify(c).slice(0, 160)};
  });
  herstel(); allesHertekenen();
  return uit;
  function itemStatusLink(a) { return dagRoute(a.date, {alleenLezen: true}).items.some(i => (itemStatus(a.date, i).acts || []).some(x => x.id === a.id)); }
})()
