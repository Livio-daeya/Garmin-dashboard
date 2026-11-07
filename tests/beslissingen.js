/* Beslissituaties van het plan, uitgevoerd in de pagina zelf.
   Draai in de browserconsole van een lokaal gebouwde index.html:
     fetch("tests/beslissingen.js").then(r => r.text()).then(eval)
   of plak deze code in de console. Elke situatie zet zijn eigen gegevens
   klaar en herstelt alles daarna. Uitkomst: een lijst met OK/FOUT. */
(() => {
  const uit = [];
  const bewaar = {ls: {...localStorage}, daily: JSON.parse(JSON.stringify(DATA.daily)),
                  acts: JSON.parse(JSON.stringify(DATA.activities)), vandaag: DATA.planbasis.vandaag};
  const herstel = () => {
    localStorage.clear(); Object.entries(bewaar.ls).forEach(([k, v]) => localStorage.setItem(k, v));
    DATA.daily = JSON.parse(JSON.stringify(bewaar.daily));
    DATA.activities = JSON.parse(JSON.stringify(bewaar.acts));
    DATA.planbasis.vandaag = bewaar.vandaag;
  };
  const zet = (sleutel, waarde) => localStorage.setItem(sleutel, JSON.stringify(waarde));
  const instel = extra => zet(INSTEL_KEY, {...bewaardLees(INSTEL_KEY, {}), ...extra});
  const check = (iso, c) => checkZet({...checkLees(), [iso]: c});
  const test = (naam, fn) => {
    try { const r = fn(); uit.push({naam, ok: !!r.ok, detail: r.detail}); }
    catch (e) { uit.push({naam, ok: false, detail: "fout: " + e.message}); }
    finally { herstel(); }
  };
  const route = iso => dagRoute(iso, {alleenLezen: true});
  const MA = "2026-11-09", DI = "2026-11-10", WO = "2026-11-11", DO = "2026-11-12";

  test("Garmin-tekort terwijl de relevante training al gepland staat", () => {
    DATA.planbasis.vandaag = WO;
    const a = routeAdvies();
    const r = route(WO);
    const hoog = r.items.some(i => i.soort === "hoog");
    const extra = r.items.filter(i => i.soort === "hoog").length;
    return {ok: hoog && extra === 1 && !/extra sessie/i.test(a.kop), detail: `${a.kop} ${a.zin}`};
  });

  test("Zware beentraining met weinig cardiovasculaire belasting", () => {
    DATA.planbasis.vandaag = WO;
    logZet([{datum: DI, oefeningen: {squat: {kg: 160, reps: 5, rir: 2, sets: 3}}}]);
    check(WO, {gevoel: 3, sessies: [], lijf: {benen: 2}});
    /* woensdag een hoog-aerobe sessie forceren via de eigen planning */
    const r = regels({iso: WO, items: [{id: "c", ...conditieWorkout("hoog", WO)}], sig: herstelSignalen(WO),
                      recent: recenteContext(WO), wedstrijdOver: null});
    const w = r.find(x => x.regel === "benen" || x.regel === "fysio");
    return {ok: !!w && /airbike|roei/i.test(w.nieuw.voorschrift), detail: w ? w.wat : "geen wijziging"};
  });

  test("Goede wearablewaarden maar pijnlijke achillespees", () => {
    DATA.planbasis.vandaag = WO;
    check(WO, {gevoel: 4, sessies: [], lijf: {achilles: 2}});
    const r = route(WO);
    const loop = r.items.filter(i => ["hoog", "ana", "test"].includes(i.soort));
    const allesFiets = loop.every(i => !/\blopen\b|shuttle/i.test(i.voorschrift || "") || /airbike|roei/i.test(i.voorschrift));
    return {ok: r.wijzigingen.some(w => ["achilles", "fysio"].includes(w.regel)) && allesFiets,
            detail: r.wijzigingen.map(w => w.wat).join("; ") || "geen wijziging"};
  });

  test("Eén slechte nacht terwijl de trend normaal is", () => {
    DATA.planbasis.vandaag = MA;
    const hb = bandVan("hrv");
    const laatst = DATA.daily[DATA.daily.length - 1];
    DATA.daily.push({...laatst, date: MA, hrv: hb && hb.genoeg ? hb.onder - 15 : 40});
    const sig = herstelSignalen(MA);
    const r = route(MA);
    return {ok: sig.groepen.length === 0 && !r.wijzigingen.some(w => w.regel === "herstel"),
            detail: `groepen: ${sig.groepen.length}, losse signalen: ${sig.enkel.join(", ") || "geen"}`};
  });

  test("Gemiste training zonder automatisch inhaaladvies", () => {
    DATA.planbasis.vandaag = "2026-11-13";
    const wo = route(WO).items.find(i => i.soort === "hoog");
    const st = itemStatus(WO, wo);
    const later = [DO, "2026-11-13", "2026-11-14", "2026-11-15"].flatMap(d => route(d).items).filter(i => i.soort === "hoog");
    return {ok: st.k === "onbekend" && later.length === 0, detail: `woensdag: ${st.tekst}; extra hoog-aerobe sessies later deze week: ${later.length}`};
  });

  test("Test zonder vooruitgang bij goed herstel", () => {
    const b = testBesluit({soort: "cooper", datum: "2027-01-04", meter: 2620, vergelijkbaar: true},
                          {soort: "cooper", datum: "2026-11-09", meter: 2600}, {groepen: []});
    return {ok: b.k === "gericht", detail: b.tekst};
  });

  test("Test zonder vooruitgang bij duidelijke vermoeidheid", () => {
    const b = testBesluit({soort: "yoyo", datum: "2027-02-01", afstand: 600, vergelijkbaar: true},
                          {soort: "yoyo", datum: "2026-12-07", afstand: 620}, {niveau: "oranje", groepen: [{k: "gevoel"}]});
    return {ok: b.k === "herstel", detail: b.tekst};
  });

  test("Wedstrijd over twee dagen", () => {
    DATA.planbasis.vandaag = DI;
    planZetItems(DO, [{kind: "wedstrijd", sport: "Handbal", min: 90}]);
    const r = route(DI);
    const k = r.items.find(i => i.soort === "kracht");
    const zwaar = k && (k.oefeningen || []).some(o => ["squat", "trapbar"].includes(o.k));
    return {ok: !!k && !zwaar, detail: k ? `${k.titel}${k.gewijzigd ? " — " + k.gewijzigd.waarom : ""}` : "geen kracht"};
  });

  test("Offseasonweek zonder wedstrijd", () => {
    const dagen = [0, 1, 2, 3, 4, 5, 6].map(i => route(isoPlus("2027-06-07", i)));
    const items = dagen.flatMap(d => d.items);
    const hb = items.filter(i => i.soort === "handbal" || i.soort === "wedstrijd").length;
    const soorten = [...new Set(items.map(i => i.soort))];
    return {ok: hb === 0 && ["hoog", "laag", "kracht"].every(s => soorten.includes(s)),
            detail: `soorten: ${soorten.join(", ")}; handbal: ${hb}`};
  });

  test("Onvoldoende gegevens voor een verantwoord puntenbereik", () => {
    const v = verwachtePunten({soort: "laag"}, WO);
    DATA.activities = DATA.activities.filter(a => a.sport !== "Kracht").concat(DATA.activities.filter(a => a.sport === "Kracht").slice(0, 2));
    const k = verwachtePunten({soort: "kracht"}, DI);
    return {ok: k.bereik === null && /te weinig|geen/i.test(k.tekst),
            detail: `kracht met 2 voorbeelden: ${k.tekst}; rustige duur: ${v ? v.tekst : "-"}`};
  });

  test("Krachtsessie zonder sets is onbekend, niet nul", () => {
    DATA.planbasis.vandaag = WO;
    logZet([]);
    const k = krachtStand();
    const a = routeAdvies();
    return {ok: k.onbekend && a.waarom.some(w => /onbekend, niet als nul/.test(w)),
            detail: a.waarom.find(w => /Kracht/.test(w))};
  });

  test("Ziek: geen training", () => {
    DATA.planbasis.vandaag = MA;
    check(MA, {gevoel: 2, sessies: [], lijf: {ziek: 1}});
    const r = route(MA);
    return {ok: r.items.filter(i => i.soort !== "rust").length === 0 || r.items.every(i => ["rust", "handbal", "wedstrijd", "check"].includes(i.soort)),
            detail: r.items.map(i => i.titel).join(", ")};
  });

  test("Maximale test wacht zolang de achillespees onbekend is", () => {
    const r = route(WO);
    const t = r.items.find(i => i.id === "test");
    return {ok: t && t.wacht && r.items.some(i => i.soort === "hoog"), detail: t ? t.titel : "geen test"};
  });

  test("Fitheid min vermoeidheid gelijk aan vorm (zelfde meetmoment)", () => {
    const f = FITHEID || DATA.fitness;
    const nu = f[f.length - 1], st = f[f.length - 2];
    const verschil = Math.abs((st.ctl - st.atl) - nu.tsb);
    return {ok: verschil <= 0.2, detail: `${st.ctl} − ${st.atl} = ${(st.ctl - st.atl).toFixed(1)}, vorm ${nu.tsb}`};
  });


  /* ---- materiaal en één voorschrift (november 2026) ---- */
  const VERBODEN = k => (OEF_MAT[k] || []).some(n => /kabel|machine/.test(n));

  test("Dinsdag en donderdag: geen kabel- of machineoefeningen", () => {
    const items = [DI, DO].flatMap(d => route(d).items.filter(i => i.soort === "kracht"));
    const fout = items.flatMap(i => i.oefeningen.filter(o => VERBODEN(o.k)).map(o => `${i.titel}: ${o.naam}`));
    DATA.planbasis.vandaag = DI;
    const ctx = workoutContext();
    const voorstel = workoutVoorstellen(ctx).lijst.filter(x => x.W.plek === "hal" || !x.W.soort)
      .flatMap(x => wkOefeningen(x.sleutel).filter(k => oefBeschikbaar(k, x.W.plek) && VERBODEN(k)));
    const keuze = Object.keys(OEF).filter(k => oefBeschikbaar(k, "hal") && VERBODEN(k));
    return {ok: !fout.length && !voorstel.length && !keuze.length,
            detail: `plan: ${fout.join(", ") || "geen"}; voorstellen: ${voorstel.join(", ") || "geen"}; keuzelijst hal: ${keuze.join(", ") || "geen"}`};
  });

  test("Hal: bank (ook schuin) en pull-upbar wel, dips en kabels niet", () => {
    const wel = ["bench", "pullup", "inclinebb", "csrow"].filter(k => oefBeschikbaar(k, "hal"));
    const niet = ["dip", "pushdown", "seatedrow", "pulldown"].filter(k => oefBeschikbaar(k, "hal"));
    const plan = [DI, DO].flatMap(d => route(d).items).flatMap(i => (i.oefeningen || []).map(o => o.k));
    return {ok: wel.length === 4 && !niet.length && plan.includes("bench") && plan.includes("pullup") && plan.includes("inclinebb"),
            detail: `beschikbaar: ${wel.join(", ")}; niet: ${niet.join(", ") || "geen"}`};
  });

  test("Dumbbells in de hal nooit boven 15 kg", () => {
    DATA.planbasis.vandaag = DI;
    logZet([{type: "halDi", datum: "2026-11-03", oefeningen: {curl: {kg: 15, reps: 12, rir: 2, sets: 2}}}]);
    const r = volgendeSet("curl", {volumeFactor: 1, rirExtra: 0}, WORKOUTS.halDi.voorschrift.curl, "hal");
    return {ok: r.kg <= 15, detail: `${r.kg} kg — ${r.reden}`};
  });

  test("Voorstel, plan en logvelden hebben hetzelfde voorschrift", () => {
    DATA.planbasis.vandaag = DI;
    const ctx = workoutContext();
    const rijen = bouwWorkout("halDi", ctx);
    const plan = route(DI).items.find(i => i.wk === "halDi");
    const gelijk = plan && plan.oefeningen.length === rijen.length && plan.oefeningen.every((o, n) =>
      o.k === rijen[n].sleutel && o.sets === rijen[n].sets && o.rir === rijen[n].rir);
    const regels = rijen.map(r => setregelsVoor("halDi", r.sleutel, r).length === r.sets);
    return {ok: gelijk && regels.every(Boolean),
            detail: rijen.map(r => `${r.oef.naam} ${r.sets}×${r.laag}–${r.hoog} ${r.rir} (logregels ${setregelsVoor("halDi", r.sleutel, r).length})`).join("; ")};
  });

  test("Zware zaaltraining verkort de haltraining", () => {
    DATA.planbasis.vandaag = DI;
    const voor = route(DI).items.find(i => i.wk === "halDi").oefeningen.length;
    instel({halzwaar: {[DI]: true}});
    const na = route(DI).items.find(i => i.wk === "halDi");
    return {ok: na.verkort && na.oefeningen.length < voor && na.oefeningen.some(o => o.k === "bench") && na.oefeningen.some(o => o.k === "pullup"),
            detail: `${voor} → ${na.oefeningen.map(o => o.naam).join(", ")}`};
  });

  test("Krachtbelasting weegt mee in conditie- en hersteladvies", () => {
    DATA.planbasis.vandaag = DO;
    logZet([{type: "thuisWo", datum: WO, oefeningen: {trapbar: {kg: 160, reps: 5, rir: 3, sets: 2}}}]);
    checkZet({...checkLees(), [DO]: {gevoel: 3, sessies: [], lijf: {benen: 2}}});
    const k = krachtStand();
    const r = regels({iso: DO, items: [{id: "c", ...conditieWorkout("hoog", DO)}], sig: herstelSignalen(DO),
                      recent: recenteContext(DO), wedstrijdOver: null});
    const a = routeAdvies();
    return {ok: !!k.benen && r.some(x => ["benen", "fysio"].includes(x.regel)) && a.waarom.some(w => /zware benen/.test(w)),
            detail: `beentraining ${k.benen && k.benen.datum}; ${r.map(x => x.wat).join("; ")}`};
  });


  test("Bevestigde workout telt één keer: werkminuten, geen extra hartslagschatting", () => {
    DATA.planbasis.vandaag = "2026-11-05";
    uitgevoerdBijwerken();
    const m = weekMinuten();
    const wo = itemStatus("2026-11-04", route("2026-11-04").items.find(i => i.soort === "hoog") || {soort: "hoog", id: "c"});
    return {ok: m.hoog.gedaan === 16 && !m.hoog.benaderd && /bevestigd/.test(wo.tekst),
            detail: `week: ${m.hoog.gedaan} werkmin (${m.hoog.workouts.map(w => w.status).join(", ")}); woensdag: ${wo.tekst}`};
  });

  test("Rustige duur via handbal is niet groen op verwachting alleen", () => {
    DATA.planbasis.vandaag = "2026-11-05";
    renderBelFocus();
    const chip = document.querySelector('[data-meet="laag"]').dataset.status;
    const m = weekMinuten();
    return {ok: m.handbal.z2 >= 60 || chip !== "ok", detail: `zone 2 gedaan ${m.handbal.z2}, verwacht ${m.handbal.verwZ2}; ${chip}`};
  });


  /* ---- juistheid van de telling (controle 5 november 2026) ---- */
  const WOENSDAG = "24965478064";
  /* Per seconde opnieuw geteld uit de ruwe meetpunten (3110 punten, 1 s
     interval, overal hartslag): zone 1-5 in seconden, en 10 s onder zone 1. */
  const HERTELLING = [238, 635, 864, 774, 588];

  test("Zonetelling 4 november gelijk aan de hertelling per seconde", () => {
    const a = DATA.activities.find(x => String(x.id) === WOENSDAG);
    const sec = [1, 2, 3, 4, 5].map(z => (a.hr_zones.find(x => x.zone === z) || {}).sec || 0);
    const verschil = sec.map((x, i) => Math.abs(x - HERTELLING[i]));
    const som = sec.reduce((t, x) => t + x, 0);
    return {ok: verschil.every(d => d <= 1) && som <= a.duration_s && a.duration_s - som <= 15,
            detail: `dashboard ${sec.join("/")} s, hertelling ${HERTELLING.join("/")} s, buiten zones ${Math.round(a.duration_s - som)} s`};
  });

  test("Rustige inspanning = zone 1 + zone 2 over de week, elke activiteit één keer", () => {
    DATA.planbasis.vandaag = "2026-11-05"; FOCUS_OPEN = null; renderBelFocus();
    const ma = "2026-11-02", zo = "2026-11-08";
    const acts = DATA.activities.filter(a => a.date >= ma && a.date <= zo && a.hr_zones && (a.sport === "Handbal" || CONDITIE_TYPE.test(a.type_key || "")));
    const ids = new Set(acts.map(a => a.id));
    const verwacht = Math.round(acts.reduce((t, a) => t + a.hr_zones.filter(z => z.zone <= 2).reduce((u, z) => u + z.sec, 0), 0) / 60);
    const getal = +document.querySelector('[data-meet="laag"] .u-meet-getal').childNodes[0].textContent;
    return {ok: getal === verwacht && ids.size === acts.length, detail: `kaart ${getal}, berekend ${verwacht}, activiteiten ${acts.length}`};
  });

  test("Tempo: 16 werkmin, geplande prikkel uitgevoerd, geen verborgen minimum", () => {
    DATA.planbasis.vandaag = "2026-11-05"; uitgevoerdBijwerken(); renderBelFocus();
    const k = document.querySelector('[data-meet="hoog"]');
    const getal = +k.querySelector(".u-meet-getal").childNodes[0].textContent;
    const st = k.dataset.status;
    return {ok: getal === 16 && st === "ok" && !/19/.test(k.textContent),
            detail: `${getal} werkmin, status "${st}"`};
  });

  test("Geen doel en onvoldoende gegevens zijn verschillende labels", () => {
    DATA.planbasis.vandaag = "2026-11-05"; renderBelFocus();
    const laag = document.querySelector('[data-meet="laag"]').getAttribute("aria-label").toLowerCase();
    DATA.planbasis.vandaag = "2026-11-09";   // na de week: zaalsessies zonder registratie
    const items = routeWeek("2026-11-02").dagen.flatMap(d => d.items.map(it => ({...it, iso: d.iso})));
    const wk = blokStatus(items, ["handbal", "wedstrijd", "ana"], 0, null).w;
    return {ok: /, geen doel$/.test(laag) && wk === "onvoldoende gegevens", detail: `rustig: ${laag}; korte inspanningen week 2/11 achteraf: ${wk}`};
  });


  test("Advies en tempoblok spreken elkaar niet tegen", () => {
    DATA.planbasis.vandaag = "2026-11-05"; uitgevoerdBijwerken(); renderBelFocus();
    const groen = document.querySelector('[data-meet="hoog"]').dataset.status === "ok";
    const a = routeAdvies();
    return {ok: !(groen && /weinig aandacht/.test(a.zin)), detail: `${a.kop} ${a.zin}`};
  });


  test("Geen automatische extra intervallen na een lichte handbalavond; actie met echte reden", () => {
    /* dinsdag 10/11, 0 min zone 4-5, zwaarte 4, pees vrij: geen extra */
    const D = "2026-11-10";
    DATA.activities.push({id: "test-licht", date: D, sport: "Handbal", name: "test", duration_s: 5400,
      hr_zones: [{zone: 1, sec: 1500, vanaf: 95}, {zone: 2, sec: 1200, vanaf: 114}, {zone: 3, sec: 600, vanaf: 133}, {zone: 4, sec: 0, vanaf: 152}, {zone: 5, sec: 0, vanaf: 171}]});
    instel({status: {...(bewaardLees(INSTEL_KEY, {}).status || {}), achilles: "vrij"}});
    DATA.planbasis.vandaag = D;
    rpeZet(D, "Handbal", 4);
    const licht = handbalPrikkel(D, {soort: "handbal", id: "hb"});
    DATA.activities.pop();
    DATA.planbasis.vandaag = DO;
    const dO = handbalPrikkel(DO, {soort: "handbal", id: "hb"});
    const drie = licht.bijdrage.map(b => b.naam).join(", ");
    return {ok: licht.extra === null && /^Vandaag niets extra · volgende prikkel/.test(licht.nu)
              && /wedstrijd zaterdag/.test(dO.nu) && licht.bijdrage.length === 3 && /niet uit één training/.test(licht.conditie),
            detail: `di: ${licht.nu} | do: ${dO.nu} | ${drie}`};
  });

  test("Handbal: geen oordeel op eigen spreiding of zelfgekozen grens; actie met echte reden", () => {
    const zet = (D, z4, rpe) => {
      DATA.activities.push({id: "test-oordeel", date: D, sport: "Handbal", name: "test", duration_s: 5400,
        hr_zones: [{zone: 1, sec: 1500, vanaf: 95}, {zone: 2, sec: 1200, vanaf: 114}, {zone: 3, sec: 600, vanaf: 133}, {zone: 4, sec: z4, vanaf: 152}, {zone: 5, sec: 0, vanaf: 171}]});
      rpeZet(D, "Handbal", rpe);
      DATA.planbasis.vandaag = D;
      const h = handbalPrikkel(D, {soort: "handbal", id: "hb"});
      DATA.activities.pop();
      return h;
    };
    const diLicht = zet(DI, 0, 4), doVeel = zet(DO, 1800, 9);
    return {ok: diLicht.oordeel === null && doVeel.oordeel === null && diLicht.extra === null
              && /volgende prikkel/.test(diLicht.nu) && /wedstrijd zaterdag/.test(doVeel.nu),
            detail: `di licht, zwaarte 4: ${diLicht.nu} | do veel, zwaarte 9: ${doVeel.nu}`};
  });

  test("Ontbrekende hartslag is onbekend, geen 0", () => {
    /* deze week zonder hartslag: haal de zones van de handbalsessies tijdelijk weg */
    DATA.planbasis.vandaag = "2026-11-05"; FOCUS_OPEN = "kort";
    const weg = (DATA.activities || []).filter(x => x.sport === "Handbal" && x.date >= "2026-11-02" && x.date <= "2026-11-08")
      .map(x => [x, x.hr_zones, x.z4_s, x.z5_s]);
    weg.forEach(([x]) => { x.hr_zones = null; x.z4_s = null; x.z5_s = null; });
    renderBelFocus();
    const d = document.createElement("div"); d.innerHTML = BEL_DETAIL.kort[1];
    const t = d.textContent;
    const kaart = document.querySelector('[data-meet="kort"]').innerText;
    weg.forEach(([x, z, z4, z5]) => { x.hr_zones = z; x.z4_s = z4; x.z5_s = z5; });
    return {ok: /onbekend deze week/.test(t) && !/Hoge hartslag[^.]*: 0 min/.test(t) && !/\b0 ?min/.test(kaart),
            detail: t.split("\n").filter(Boolean).slice(0, 3).join(" | ")};
  });

  test("Normale handbalavond: geen aanvulling", () => {
    DATA.planbasis.vandaag = DI;
    instel({hbgevoel: {[DI]: "normaal"}});
    const di = handbalPrikkel(DI, {soort: "handbal"});
    return {ok: di.aanvulling === null, detail: di.oordeel};
  });

  test("4 × 4 telt niet als korte intensieve inspanningen", () => {
    DATA.planbasis.vandaag = "2026-11-05";
    const m = weekMinuten();
    return {ok: m.kort.acts.every(a => a.sport === "Handbal" || false) && m.kort.anaGedaan === 0,
            detail: `korte sessies: ${m.kort.hbGedaan + m.kort.anaGedaan}, activiteiten ${m.kort.acts.map(a => a.sport).join(", ") || "geen"}`};
  });


  test("Weekschema: maandag fysio-benen, woensdag airbike 4 × 4, donderdag geen benen", () => {
    const ma = route(MA).items.find(i => i.wk === "fysioMa");
    const wo = route(WO).items.find(i => i.soort === "hoog");
    const dO = route(DO).items.find(i => i.wk === "halDo");
    return {ok: !!ma && ma.oefeningen.some(o => o.k === "boxsquat" && o.kg === 50) && wo && /Airbike 4 × 4/.test(wo.titel) && wo.werk === 16
              && dO && !dO.oefeningen.some(o => OEF[o.k] && OEF[o.k].onder),
            detail: `ma: ${ma && ma.oefeningen.map(o => o.naam).join(", ")} | wo: ${wo && wo.titel} | do: ${dO && dO.oefeningen.map(o => o.naam).join(", ")}`};
  });

  test("Hal: geen kabel- of machineoefening in het voorschrift", () => {
    const k = [DI, DO].flatMap(d => route(d).items.filter(i => i.plek === "hal")).flatMap(i => i.oefeningen.map(o => o.k));
    const fout = k.filter(x => ["seatedrow", "pulldown", "pushdown", "facepull", "legext", "legcurl"].includes(x));
    return {ok: !fout.length, detail: fout.join(", ") || "geen"};
  });

  /* De pagina weer tonen zoals hij met jouw echte gegevens is. */
  try { FOCUS_OPEN = null; renderBelDials(); renderRouteAlles(); } catch (e) { /* alleen weergave */ }
  return uit;
})();
