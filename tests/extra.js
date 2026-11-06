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
        {...act(9991003, wo, "19:00", "Hardlopen", "running", 40, 120, 4.0, 1.5, "4x4 min"), hr_detail: {blokken_z3: [4, 4, 4, 4], blokken_z4: [3, 3.5, 3.5, 4], pieken_z4: 4}},
        act(9991004, dn, "20:00", "Handbal", "basketball", 75, 120, 3.0, 1.6, "Zaaltraining"),
        act(9991005, vr, "17:00", "Kracht", "strength_training", 40, 30, 1.0, 0.2, "Krachtsport"),
        {...act(9991006, vr, "18:30", "Hardlopen", "running", 45, 110, 3.8, 2.6, "Neerpelt hardlopen"), hr_detail: {blokken_z3: [3, 3, 3, 3], blokken_z4: [2, 2, 2.5], pieken_z4: 6}}];
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
  /* de beschreven week, als herbruikbare opzet */
  const beschrevenWeek = (extraOpties = {}) => {
    const vr = isoPlus(ma, 4), di = isoPlus(ma, 1), wo = isoPlus(ma, 2), dn = isoPlus(ma, 3);
    DATA.planbasis.vandaag = extraOpties.vandaag || vr;
    const act = (id, d, uur, sport, type, min, load, te, ana, naam, gl) => ({id, date: d, datetime: `${d}T${uur}:00`, sport, type_key: type, name: naam, duration_s: min * 60, load, garmin_load: gl ?? load, aerobic_te: te, anaerobic_te: ana});
    DATA.activities = [...echt.filter(a => a.date < ma || a.date > isoPlus(ma, 6)),
      act(9991001, ma, "18:00", "Kracht", "strength_training", 50, 40, 1.2, 0.3, "Kracht thuis"),
      act(9991002, di, "20:00", "Handbal", "basketball", 75, 130, 3.1, 1.8, "Zaaltraining", 55),
      {...act(9991003, wo, "19:00", "Hardlopen", "running", 40, 120, 4.0, 1.5, "4x4 min"), hr_detail: {blokken_z3: [4, 4, 4, 4], blokken_z4: [3, 3.5, 3.5, 4], pieken_z4: 4}},
      act(9991004, dn, "20:00", "Handbal", "basketball", 75, 120, 3.0, 1.6, "Zaaltraining", extraOpties.doZaal ?? 60),
      act(9991005, vr, "17:00", "Kracht", "strength_training", 40, 30, 1.0, 0.2, "Krachtsport"),
      {...act(9991006, vr, "18:30", "Hardlopen", "running", 45, 110, 3.8, 2.6, "Neerpelt hardlopen"), hr_detail: {blokken_z3: [3, 3, 3, 3], blokken_z4: [2, 2, 2.5], pieken_z4: 6}}].filter(a => a.date <= DATA.planbasis.vandaag);
    HB_CACHE.clear();
    const diHal = dagRoute(di, {alleenLezen: true}).items.find(i => i.soort === "kracht"); if (diHal) planStatusZet(di, diHal.id, "overgeslagen");
    const c = checkLees(); checkZet({...c, [di]: {...(c[di] || {}), sessies: [{sport: "Kracht", naam: "Kracht", minuten: 45, rpe: 7, handmatig: true, toegevoegd: true}]}});
    if (DATA.planbasis.vandaag >= vr) { const dnHal = dagRoute(dn, {alleenLezen: true}).items.find(i => i.soort === "kracht"); if (dnHal) planStatusZet(dn, dnHal.id, "overgeslagen");
      const vrZaal = dagRoute(vr, {alleenLezen: true}).items.find(i => i.soort === "handbal");
      if (vrZaal) { planStatusZet(vr, vrZaal.id, "overgeslagen"); vervangingZet(`${vr}|9991006`, vrZaal.id, "Zaaltraining", true); } }
    HB_CACHE.clear();
    return {vr, di, wo, dn};
  };
  const metVandaag = f => { const oud = DATA.planbasis.vandaag; try { return f(); } finally { DATA.planbasis.vandaag = oud; } };

  await test("Een onbekende verwachting wordt niet vervangen door de werkelijke sessiebelasting", () => metVandaag(() => {
    const {wo} = beschrevenWeek();
    const a1 = trainingsAdvies(ma);
    /* de woensdagsessie twee keer zo zwaar: de verwachting mag daardoor niet veranderen */
    DATA.activities = DATA.activities.map(x => x.id === 9991003 ? {...x, garmin_load: x.garmin_load + 500} : x); HB_CACHE.clear();
    const a2 = trainingsAdvies(ma);
    const woItem = dagRoute(wo, {alleenLezen: true}).items.find(i => ["hoog", "ana"].includes(i.soort));
    const e = woItem ? geldigeVerwachting(wo, woItem) : null;
    const B = a2.belasting, inVergelijking = B.vergelijkbaar.some(x => x.d === wo && /4x4/.test(x.titel));
    const ok = B.verwacht === a1.belasting.verwacht && B.uitgevoerdVergelijkbaar === a1.belasting.uitgevoerdVergelijkbaar && B.garminPunten === a1.belasting.garminPunten + 500
      && B.zonderVerwachting === a1.belasting.zonderVerwachting + 500 && !inVergelijking && /Uitgevoerd zonder verwachting/.test(adviesHtml(a2));
    return {ok, detail: `woensdag verwacht ${e && e.bereik ? e.bereik.join("–") : "onbekend"}; verwacht ${a1.belasting.verwacht} → ${B.verwacht}, vergelijkbaar uitgevoerd ${a1.belasting.uitgevoerdVergelijkbaar} → ${B.uitgevoerdVergelijkbaar}, zonder verwachting ${a1.belasting.zonderVerwachting} → ${B.zonderVerwachting}`};
  }));
  await test("Uitgevoerd en verwacht worden over dezelfde sessies vergeleken; alles telt in het totaal", () => metVandaag(() => {
    beschrevenWeek();
    const B = trainingsAdvies(ma).belasting;
    const somV = B.vergelijkbaar.reduce((t, x) => t + x.punten, 0);
    const ok = somV === B.uitgevoerdVergelijkbaar && B.garminPunten === B.uitgevoerdVergelijkbaar + B.zonderVerwachting
      && B.vergelijkbaar.every(x => x.bereik) && B.gedekt <= B.geplandMetRegistratie;
    const regel = l => l.map(x => `${x.d.slice(8)} ${x.titel} ${x.punten}${x.bereik ? ` [${x.bereik.join("–")}]` : ""}`).join("; ");
    return {ok, detail: `TESTWEEK (nagebouwd) | vergelijkbaar: ${regel(B.vergelijkbaar)} → ${B.uitgevoerdVergelijkbaar} tegenover ${B.verwachtBereik ? B.verwachtBereik.join("–") : "–"} (midden ${B.verwacht}), gedekt ${B.gedekt}/${B.geplandMetRegistratie} | zonder bereik: ${regel(B.zonderBereik) || "–"} | niet gepland: ${regel(B.ongepland) || "–"} | zonder registratie: ${B.zonderRegistratie.map(x => x.d.slice(8) + " " + x.titel).join("; ") || "–"} | totaal ${B.garminPunten}`};
  }));
  await test("Belasting binnen verwachting maar herstel onbekend: niet groen, geen extra intensief werk", () => metVandaag(() => {
    beschrevenWeek();
    const a = trainingsAdvies(ma);
    const ok = a.herstel.niveau !== "groen" ? a.status !== "groen" && (a.status !== "grijs" || /Herstel nog beoordelen/.test(a.reden) && /Geen extra intensief werk/.test(a.actie)) : true;
    return {ok, detail: `TESTWEEK | herstel ${a.herstel.niveau}, plan ${a.belasting.bovenPlan === false ? "binnen verwachting" : a.belasting.bovenPlan === null ? "onbekend" : "boven"} → ${a.status}: ${a.reden} → ${a.actie}`};
  }));
  await test("Met prikkel en herstel dat op gegevens groen is: groen, met Prikkel en Vervolg apart", () => metVandaag(() => {
    beschrevenWeek();
    const echtK = herstelKern;
    window.herstelKern = d => ({...echtK(d), niveau: "groen", regel: "test: herstel groen"});
    try {
      HB_CACHE.clear();
      const a = trainingsAdvies(ma), html = adviesHtml(a);
      const ok = (a.status === "groen" || a.status === "oranje") && /<b>Prikkel:<\/b>/.test(html) && /<b>Vervolg:<\/b>/.test(html) && /Binnen het plan \(achtergrond\)/.test(html) && !/\/100/.test(html);
      return {ok, detail: `TESTWEEK met herstel groen (gesimuleerd) → ${a.status}: ${a.reden} → ${a.actie}`};
    } finally { window.herstelKern = echtK; HB_CACHE.clear(); }
  }));
  await test("Teller en noemer van de dekking zijn overal gelijk", () => metVandaag(() => {
    beschrevenWeek();
    const B = trainingsAdvies(ma).belasting, html = adviesHtml(trainingsAdvies(ma));
    const ok = B.gedekt === B.vergelijkbaar.length && B.geplandMetRegistratie === B.vergelijkbaar.length + B.zonderBereik.length && html.includes(`${B.gedekt} van ${B.geplandMetRegistratie} uitgevoerde sessies`);
    return {ok, detail: `${B.gedekt} van ${B.geplandMetRegistratie} (vergelijkbaar ${B.vergelijkbaar.length}, waarvan ${B.vervangingen} vervanging; zonder bereik ${B.zonderBereik.length})`};
  }));
  await test("Oranje door herstel geeft het hersteladvies, niet 'geplande training kan door'", () => metVandaag(() => {
    const {wo, dn} = beschrevenWeek({vandaag: isoPlus(ma, 3)});
    const c = checkLees(); checkZet({...c, [wo]: {gevoel: 1, lijf: {benen: 2}}, [dn]: {gevoel: 1, lijf: {benen: 2, energie: 2}}}); HB_CACHE.clear();
    const a = trainingsAdvies(ma);
    const ok = a.status === "oranje" || a.status === "rood" ? !/kan volgens voorschrift|kan door/.test(a.actie) : true;
    return {ok, detail: `herstel ${a.herstel.niveau}; advies ${a.status}: ${a.actie}`};
  }));
  await test("Een onverwacht zware uitvoering blijft zichtbaar", () => metVandaag(() => {
    const {dn} = beschrevenWeek({doZaal: 300});
    const a = trainingsAdvies(ma), html = adviesHtml(a);
    const zaal = dagRoute(dn, {alleenLezen: true}).items.find(i => i.soort === "handbal"), e = zaal && geldigeVerwachting(dn, zaal);
    if (!e || !e.bereik) return {ok: true, detail: "geen verwachting voor de zaaltraining in deze data"};
    return {ok: a.belasting.onverwachtZwaar.some(x => x.d === dn) && /Zwaarder dan verwacht/.test(html) && /zwaarder dan verwacht/.test(html), detail: JSON.stringify(a.belasting.onverwachtZwaar)};
  }));
  await test("Nieuwe gegevens verbeteren alleen toekomstige verwachtingen", () => {
    verwachtingenVastleggen();
    const toekomst = Object.values(verwachtLees()).find(r => r.datum > vandaagIso() && r.versies[0].bereik);
    if (!toekomst) return {ok: true, detail: "geen toekomstige sessie met bereik"};
    const voor = JSON.stringify(toekomst.versies);
    const extraActs = Array.from({length: 8}, (_, n) => ({id: 9992000 + n, date: isoPlus(vandaagIso(), -n - 1), datetime: `${isoPlus(vandaagIso(), -n - 1)}T20:00:00`, sport: "Handbal", type_key: "basketball", name: "x", duration_s: 4500, load: 400, garmin_load: 400}));
    DATA.activities = [...echt, ...extraActs]; HB_CACHE.clear();
    verwachtingenVastleggen();
    const na = verwachtLees()[`${toekomst.datum}|${toekomst.item}`];
    const item = dagRoute(toekomst.datum, {alleenLezen: true}).items.find(i => i.id === toekomst.item);
    const nieuw = item ? verwachtePunten(item, toekomst.datum, vandaagIso()) : null;
    return {ok: JSON.stringify(na.versies) === voor, detail: `vastgelegd ${toekomst.versies[0].bereik.join("–")} blijft; met de nieuwe gegevens zou het nu ${nieuw && nieuw.bereik ? nieuw.bereik.join("–") : "–"} zijn (alleen voor nog niet vastgelegde sessies)`};
  });
  await test("De regels voor aanvullende training blokkeren de geplande donderdag niet", () => metVandaag(() => {
    const {dn} = beschrevenWeek({vandaag: isoPlus(ma, 3)});
    const voor = dagRoute(dn, {alleenLezen: true}).items.filter(i => i.soort === "kracht").map(i => i.id);
    const a = trainingsAdvies(ma);
    const na = dagRoute(dn, {alleenLezen: true}).items.filter(i => i.soort === "kracht").map(i => i.id);
    const html = adviesHtml(a);
    return {ok: voor.length >= 1 && JSON.stringify(voor) === JSON.stringify(na) && !/kracht.*(schrappen|niet doen)/i.test(a.actie) && /geldt niet voor je geplande trainingen/.test(html),
      detail: `donderdag kracht gepland: ${voor.length}; advies ${a.status}: ${a.actie}`};
  }));
  await test("De beschreven week geeft overal dezelfde aantallen en hetzelfde advies", () => metVandaag(() => {
    beschrevenWeek();
    const a = trainingsAdvies(ma), c = coachContext().trainingsadvies;
    allesHertekenen();
    const kaart = [...document.querySelectorAll(".ta--kort .hs-chip")].map(b => b.textContent.trim());
    const ok = c.status === a.status && c.kracht.sessies.length === a.kracht.sessies && c.handbal.gedaan === a.handbal.gedaan && kaart.every(k => k === a.titel) && kaart.length >= 1
      && a.kracht.sessies === 3 && a.handbal.gedaan === 2;
    return {ok, detail: `advies ${a.status}, kaarten ${kaart.join("/")}, coach ${c.status}; kracht ${a.kracht.sessies}/${c.kracht.sessies.length}, handbal ${a.handbal.gedaan}/${c.handbal.gedaan} | ${a.reden} → ${a.actie}`};
  }));
  await test("Het oorspronkelijke advies blijft bewaard; je antwoord over opvolgen wordt eraan gekoppeld", () => {
    herstelBewaar(herstelStatus(vandaagIso()));
    const eerst = JSON.parse(JSON.stringify((leerLees()[vandaagIso()] || {}).advies || null));
    adviesFeedbackZet("deels");
    DATA.activities = [...echt, {id: 9993001, date: vandaagIso(), datetime: `${vandaagIso()}T09:00:00`, sport: "Hardlopen", type_key: "running", name: "x", duration_s: 5400, load: 3000, garmin_load: 3000, aerobic_te: 4.5}];
    HB_CACHE.clear(); herstelBewaar(herstelStatus(vandaagIso()));
    const r = leerLees()[vandaagIso()];
    return {ok: !!eerst && JSON.stringify(r.advies) === JSON.stringify(eerst) && r.adviesFeedback.gevolgd === "deels",
      detail: `oorspronkelijk ${eerst && eerst.titel} (${eerst && eerst.t.slice(11, 16)}); versies ${(r.adviesVersies || []).map(x => x.titel).join(", ") || "geen"}; antwoord ${r.adviesFeedback.gevolgd}`};
  });
  /* ---- workouts via de coach: RIR, sessies, koppeling ---- */
  const wkRuw = (rir, naam = "bench press") => ({date: vrij, type: "kracht", workout: null, exercises: [{name: naam, sets: [{reps: 5, weight_kg: 80, ...(rir != null ? {rir} : {})}, {reps: 5, weight_kg: 80, ...(rir != null ? {rir} : {})}]}]});
  await test("Geen genoemde RIR blijft onbekend en telt niet als bevestigd uitdagend", () => {
    localStorage.removeItem(LOG_KEY);
    const v = workoutVoorstelBouwen(wkRuw(null));
    const o = Object.values(v.oefeningen)[0];
    workoutWegschrijven(v); HB_CACHE.clear();
    const K = trainingsAdvies(ma).kracht;
    return {ok: o.rir === null && o.reeksen.every(x => x.rir === null) && v.rirBron === "niet genoemd" && K.uitdagend === 0 && K.zonderRir >= 2, detail: `rir ${o.rir}; uitdagend ${K.uitdagend}, zonder RIR ${K.zonderRir}`};
  });
  await test("Genoemde RIR blijft behouden en is zichtbaar vóór opslaan", () => {
    const v = workoutVoorstelBouwen(wkRuw(2));
    const html = workoutKaart(v, 0), o = Object.values(v.oefeningen)[0];
    return {ok: o.rir === 2 && /@ RIR 2/.test(html) && /RIR zoals je hem noemde/.test(html), detail: `rir ${o.rir}, kaart toont RIR ${/@ RIR 2/.test(html)}`};
  });
  await test("Twee krachtsessies van hetzelfde type op dezelfde dag blijven apart; correctie raakt alleen de gekozen; herhaald bevestigen geeft geen dubbel", () => {
    localStorage.removeItem(LOG_KEY);
    const v1 = workoutVoorstelBouwen(wkRuw(2)), v2 = workoutVoorstelBouwen(wkRuw(1, "pull-ups"));
    workoutWegschrijven(v1); workoutWegschrijven(v2);
    const na2 = lijstLees(LOG_KEY);
    const dubbel = workoutWegschrijven(v2), na3 = lijstLees(LOG_KEY);
    const kaart = workoutKaart(workoutVoorstelBouwen(wkRuw(3)), 0);
    const v3 = workoutVoorstelBouwen(wkRuw(3));
    workoutWegschrijven(v3, na2[0].sessieId);
    const na4 = lijstLees(LOG_KEY);
    const een = na4.find(x => x.sessieId === na2[0].sessieId), twee = na4.find(x => x.sessieId === na2[1].sessieId);
    const ok = na2.length === 2 && na2[0].sessieId !== na2[1].sessieId && dubbel.dubbel && na3.length === 2 && /Als nieuwe sessie opslaan/.test(kaart) && /Vervang/.test(kaart)
      && na4.length === 2 && Object.values(een.oefeningen)[0].rir === 3 && (een.historie || []).length === 1 && JSON.stringify(twee.oefeningen) === JSON.stringify(na2[1].oefeningen);
    return {ok, detail: `na twee: ${na2.length}; opnieuw bevestigen: ${na3.length} (dubbel ${!!dubbel.dubbel}); na correctie: ${na4.length}, historie ${(een.historie || []).length}, andere sessie ongewijzigd ${JSON.stringify(twee.oefeningen) === JSON.stringify(na2[1].oefeningen)}`};
  });
  await test("Een onduidelijke Garmin-koppeling wordt niet automatisch de langste sessie", () => {
    DATA.activities = [...echt, {id: 9994001, date: vrij, datetime: `${vrij}T07:00:00`, sport: "Kracht", type_key: "strength_training", duration_s: 1800, load: 20},
      {id: 9994002, date: vrij, datetime: `${vrij}T19:00:00`, sport: "Kracht", type_key: "strength_training", duration_s: 3600, load: 40}];
    const v = workoutVoorstelBouwen(wkRuw(null)), html = workoutKaart(v, 0);
    return {ok: v.sessie === null && v.kandidaten.length >= 2 && /welke Garmin-sessie hoort hierbij/.test(html), detail: `${v.kandidaten.length} kandidaten, koppeling ${v.sessie ? v.sessie.id : "niet automatisch"}`};
  });
  await test("Hoog aeroob Training Effect zonder inhoudelijke gegevens wordt niet automatisch langer intensief", () => {
    const a = {id: 9994101, date: vrij, datetime: `${vrij}T18:00:00`, sport: "Hardlopen", type_key: "running", name: "Loop", duration_s: 2700, aerobic_te: 4.2, anaerobic_te: 2.5, load: 90};
    DATA.activities = [...echt, a]; HB_CACHE.clear();
    const k = conditieInhoud(a), adv = trainingsAdvies(ma), x = adv.conditie.lijst.find(y => y.a.id === 9994101);
    return {ok: k.soort === "inhoud niet vastgesteld" && x && x.soort === "inhoud niet vastgesteld" && adv.belasting.garminPunten >= 0, detail: `${k.soort} (${k.bron}); ${k.steun.join("; ")}`};
  });
  await test("Gecorrigeerde gegevens werken door: advies, krachtvolume, coach, leerlus; oude coach-RIR onzeker", () => {
    localStorage.removeItem(LOG_KEY);
    /* een oude coachregel met standaard-RIR 2, zoals die vóór 7-11 werd opgeslagen */
    lijstZet(LOG_KEY, [{type: "los", datum: vrij, bron: "coach", oefeningen: {bench: {kg: 80, reps: 5, sets: 3, rir: 2, reeksen: [{reps: 5, kg: 80}, {reps: 5, kg: 80}, {reps: 5, kg: 80}]}}}]);
    workoutWegschrijven(workoutVoorstelBouwen(wkRuw(1, "pull-ups"))); HB_CACHE.clear();
    const oud = logLees().find(x => x.bron === "coach" && !x.rirBron);
    const K = trainingsAdvies(ma).kracht, vol = weekVolume(), comb = dagCombinatie(vrij);
    const coach = coachContext().trainingsadvies.kracht;
    const ok = oud.rirOnzeker && oud.oefeningen.bench.rir === null && oud.oefeningen.bench.rirOrigineel === 2
      && K.rirOnzeker === 3 && K.uitdagend === 2 && K.dagen.some(x => x.d === vrij && x.bron.includes("krachtlog")) && Object.keys(vol).length > 0
      && coach.uitdagende_sets === 2 && comb.gelogdeKracht === true;
    return {ok, detail: `oude RIR onzeker (origineel ${oud.oefeningen.bench.rirOrigineel}); uitdagend ${K.uitdagend} (alleen genoemde RIR 1), onzeker ${K.rirOnzeker}; volume ${Object.keys(vol).join(",")}; coach ${coach.uitdagende_sets}; leerlus gelogd ${comb.gelogdeKracht}`};
  });
  /* ---- één verwerking voor alle schermen ---- */
  const woAct = () => echt.find(a => String(a.id) === String((BEVESTIGDE_WORKOUTS[0] || {}).activiteit));
  await test("Dezelfde sessie krijgt overal dezelfde feiten en herkomstlabels", () => {
    const a = woAct(); if (!a) return {ok: false, detail: "bevestigde woensdagactiviteit niet in de data"};
    const f = sessieFeiten(a), lab = feitenLabel(f)[0];
    let html = ""; const orig = uiPaneel; window.uiPaneel = (t, h) => { html = h; }; try { activiteitPaneel(a.id); } finally { window.uiPaneel = orig; }
    const m = weekMinuten(), w = m.hoog.workouts.find(x => String(x.activiteit) === String(a.id));
    const adv = trainingsAdvies(maandagVan(a.date)).conditie.lijst.find(x => x.a.id === a.id);
    const coach = coachContext().trainingsadvies.conditie.sessies.find(x => x.datum === a.date && x.naam === a.name);
    const ok = html.includes(lab) && w && w.status === "bevestigd" && adv && adv.bron === lab && adv.zeker === "bevestigd" && coach && coach.herkomst === "bevestigd" && coach.grond === lab;
    return {ok, detail: `${a.date} ${a.name}: "${lab}" | Training ${html.includes(lab)}, Belasting ${w && w.status} ${w && w.werk} werkmin, advies ${adv && adv.zeker}, coach ${coach && coach.herkomst}`};
  });
  await test("Bevestigde werkminuten worden niet dubbel geteld", () => {
    const a = woAct(); const m = weekMinuten();
    const bev = uitgevoerdLees().filter(x => x.soort === "hoog" && x.datum >= m.ma && x.datum <= m.zo).reduce((t, x) => t + (x.werk || 0), 0);
    return {ok: m.hoog.gedaan === bev && !m.hoog.onbevestigd.some(x => String(x.a.id) === String(a && a.id)), detail: `werkmin ${m.hoog.gedaan}, bevestigd ${bev}; zone 3–4 van die sessie ${a ? Math.round(((a.z3_s || 0) + (a.z4_s || 0)) / 60) : "?"} min telt niet nog eens`};
  });
  await test("Zone-minuten worden geen werkminuten", () => {
    const voor = weekMinuten().hoog.gedaan;
    DATA.activities = [...echt, {id: 9995001, date: vandaagIso(), datetime: `${vandaagIso()}T08:00:00`, sport: "Hardlopen", type_key: "running", name: "Loop", duration_s: 3000, aerobic_te: 4.0, z1_s: 300, z2_s: 300, z3_s: 900, z4_s: 900, z5_s: 0, hr_zones: [{zone: 3, sec: 900}, {zone: 4, sec: 900}], load: 80}];
    HB_CACHE.clear();
    const m = weekMinuten(), x = m.hoog.onbevestigd.find(y => y.a.id === 9995001);
    return {ok: m.hoog.gedaan === voor && x && x.z34 === 30, detail: `werkmin ${voor} → ${m.hoog.gedaan}; apart: ${x && x.z34} min hartslag zone 3–4`};
  });
  await test("Hartslagpieken worden geen sprints of bevestigde korte intervallen", () => {
    const a = {id: 9995101, date: vandaagIso(), sport: "Hardlopen", type_key: "running", duration_s: 1800, hr_detail: {blokken_z3: [], blokken_z4: [], pieken_z4: 12}, z1_s: 600, z2_s: 600, z3_s: 300, z4_s: 300, z5_s: 0};
    const f = sessieFeiten(a), lab = feitenLabel(f).join(" | ");
    return {ok: f.soort !== "kort intensief" && /hartslagpieken in zone 4 geregistreerd \(geen sprintaantal\)/.test(lab), detail: `${f.soort} · ${lab}`};
  });
  await test("Ontbrekende zones en Training Effect geven geen verzonnen rustige minuten", () => {
    const voor = weekMinuten().laag.gedaan;
    DATA.activities = [...echt, {id: 9995201, date: vandaagIso(), datetime: `${vandaagIso()}T08:00:00`, sport: "Hardlopen", type_key: "running", name: "Loop zonder hartslag", duration_s: 2400, load: 0}];
    HB_CACHE.clear();
    const m = weekMinuten(), f = sessieFeiten(DATA.activities.find(x => x.id === 9995201));
    return {ok: m.laag.gedaan === voor && m.laag.onbekend.some(x => x.id === 9995201) && f.soort === "inhoud niet vastgesteld" && f.te === null, detail: `rustige min ${voor} → ${m.laag.gedaan}; ${f.soort}; ontbreekt ${f.ontbreekt.join(", ")}`};
  });
  await test("Een onbekende sessie maakt de week niet automatisch lichter", () => {
    const d = isoPlus(vandaagIso(), -1);
    DATA.activities = [...echt.filter(a => a.date !== d), {id: 9995301, date: d, datetime: `${d}T08:00:00`, sport: "Hardlopen", type_key: "running", name: "Loop", duration_s: 2400, load: 60}];
    HB_CACHE.clear();
    const z = dagZwaarte(d), r = zwareReeks(vandaagIso());
    return {ok: z.k === "onbekend" && (r.dagen[1].k !== "onbekend" || r.onzeker || r.dagen[0].k !== "zwaar"), detail: `${d}: ${z.k} (${z.bron}); reeks ${r.opRij}, mogelijk ${r.opRijMogelijk}, onzeker ${r.onzeker}`};
  });
  await test("Ontbrekende intensiteitsgegevens veroorzaken geen aanvuladvies", () => {
    const echtK = herstelKern; window.herstelKern = dd => ({...echtK(dd), niveau: "groen"});
    try {
      DATA.activities = [...echt.filter(a => a.date < ma || a.date > isoPlus(ma, 6) || !CONDITIE_TYPE.test(a.type_key || "")),
        {id: 9995401, date: ma, datetime: `${ma}T08:00:00`, sport: "Hardlopen", type_key: "running", name: "Loop", duration_s: 2400, load: 60}];
      const I = bewaardLees(INSTEL_KEY, {}); bewaardSchrijf(INSTEL_KEY, {...I, uitgevoerd: [{datum: "2000-01-01", soort: "hoog", werk: 0}]});   // geen bevestigde woensdag
      HB_CACHE.clear();
      const a = trainingsAdvies(ma);
      return {ok: a.status !== "blauw", detail: `${a.status}: ${a.reden} → ${a.actie}`};
    } finally { window.herstelKern = echtK; HB_CACHE.clear(); }
  });
  await test("De bevestigde woensdagworkout blijft herkenbaar als uitgevoerd intervalwerk", () => {
    const a = woAct(); if (!a) return {ok: false, detail: "niet gevonden"};
    const f = sessieFeiten(a), z = dagZwaarte(a.date);
    return {ok: f.soort === "langer intensief" && f.zeker === "bevestigd" && f.bevestigd.werk === 16 && z.k === "zwaar", detail: `${f.soort}, ${f.zeker}, ${f.bevestigd.werk} werkmin; dag ${z.k} (${z.bron})`};
  });
  herstel(); allesHertekenen();
  return uit;
  function itemStatusLink(a) { return dagRoute(a.date, {alleenLezen: true}).items.some(i => (itemStatus(a.date, i).acts || []).some(x => x.id === a.id)); }
})()
