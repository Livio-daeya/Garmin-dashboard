/* Flowcontroles voor het herontwerp. Draait in de browser op de preview:
   const r = eval(await (await fetch("/flows.js")).text())  (async: await r)
   Zet je eigen opslag na afloop terug; testgegevens staan apart. */
(async () => {
  const uit = [];
  const test = async (naam, f) => { try { const r = await f(); uit.push({naam, ...r}); } catch (e) { uit.push({naam, ok: false, detail: "fout: " + e.message}); } };
  const wacht = ms => new Promise(r => setTimeout(r, ms));
  const BEWAAR = [INSTEL_KEY, CHECK_KEY, LOG_KEY, WK_CONCEPT_KEY].map(k => [k, localStorage.getItem(k)]);
  const terug = () => BEWAAR.forEach(([k, v]) => v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v));
  const V = "2026-11-05";
  DATA.planbasis.vandaag = V; ROUTE_DAG = V;

  await test("Geen horizontale paginascroll op de zes pagina's", async () => {
    const fout = [];
    for (const tab of TABS) { routeToon({soort: "tab", naam: tab}, true); await wacht(60);
      if (document.documentElement.scrollWidth > innerWidth + 1) fout.push(`${tab} ${document.documentElement.scrollWidth}>${innerWidth}`); }
    routeToon({soort: "tab", naam: "training"}, true);
    return {ok: !fout.length, detail: fout.join(", ") || `breedte ${innerWidth}: geen`};
  });

  await test("Bediening niet afgesneden: knoppen binnen het scherm", async () => {
    const fout = [];
    for (const tab of TABS) { routeToon({soort: "tab", naam: tab}, true); await wacht(40);
      document.querySelectorAll(`#tab-${tab} button`).forEach(b => {
        const r = b.getBoundingClientRect(); if (r.width && (r.right > innerWidth + 1 || r.left < -1)) fout.push(`${tab}: ${b.textContent.trim().slice(0, 20)}`); }); }
    routeToon({soort: "tab", naam: "training"}, true);
    return {ok: !fout.length, detail: fout.slice(0, 5).join(" | ") || "geen"};
  });

  await test("Klikvlakken van hoofdbediening minstens 44 px", async () => {
    renderTrainingRoute();
    const klein = [...document.querySelectorAll("#wkVandaag .u-knop:not(.u-knop--klein), #wkVandaag .u-icoonknop, #wkVandaag .u-dag")]
      .filter(b => b.getBoundingClientRect().height && b.getBoundingClientRect().height < 43.5).map(b => b.className);
    return {ok: !klein.length, detail: klein.join(", ") || "alle ≥ 44 px"};
  });

  await test("Gedaan, Deels gedaan, Overgeslagen en terugdraaien", async () => {
    const it = dagRoute(V).items.find(i => i.soort === "kracht");
    const st = [];
    for (const w of ["gedaan", "deels", "overgeslagen"]) { planStatusZet(V, it.id, w); const s = itemStatus(V, it); st.push(s.deels ? "deels" : s.k); }
    planStatusZet(V, it.id, null);
    const auto = itemStatus(V, it).k;
    return {ok: st.join() === "gedaan,deels,overgeslagen" && auto !== "overgeslagen", detail: `${st.join(" → ")} → automatisch: ${auto}`};
  });

  await test("Status via het menu, met ongedaan maken", async () => {
    renderTrainingRoute();
    const kaart = [...document.querySelectorAll("#wkVandaag .tk")].find(k => /Hal donderdag/.test(k.textContent));
    const knop = kaart.querySelector("[data-menu]"); knop.click(); await wacht(20);
    const menu = document.querySelector(".u-menu");
    const opties = [...menu.querySelectorAll("button")].map(b => b.textContent);
    [...menu.querySelectorAll("button")].find(b => b.textContent === "Deels gedaan").click(); await wacht(20);
    const na = itemStatus(V, sessieZoek(knop.dataset.menu)[1]);
    document.querySelector(".u-melding-terug").click(); await wacht(20);
    const terugSt = (instelLees().planstatus || {})[knop.dataset.menu];
    return {ok: na.deels && opties.includes("Overgeslagen"), detail: `opties: ${opties.join(", ")}; na keuze deels=${na.deels}; na ongedaan: ${terugSt || "Garmin"}`};
  });

  await test("Feedback opslaan en wijzigen; na verversen gelijk", async () => {
    const it = dagRoute(V).items.find(i => i.soort === "handbal");
    feedbackBewaar(V, it, {rpe: 6, duur: null, inhoud: "spel", noot: "test"});
    const a = feedbackVan(V, it);
    feedbackBewaar(V, it, {rpe: 7, duur: null, inhoud: "lopen", noot: ""});
    const b = feedbackVan(V, it);
    /* "verversen": opnieuw uit de opslag lezen */
    const c = JSON.parse(localStorage.getItem(CHECK_KEY))[V].sessies.find(x => x.sport === "Handbal");
    return {ok: a.rpe === 6 && b.rpe === 7 && b.inhoud === "lopen" && c.rpe === 7, detail: `${a.rpe}/10 ${a.inhoud} → ${b.rpe}/10 ${b.inhoud}; opslag ${c.rpe}`};
  });

  await test("Fout tijdens opslaan: invoer blijft staan, foutmelding zichtbaar", async () => {
    const it = dagRoute(V).items.find(i => i.soort === "handbal");
    sessieFeedback(V, it); await wacht(30);
    const box = document.querySelector("#uPaneel .up-inhoud");
    box.querySelector('[data-v="4"]').click();
    box.querySelector("#fbNoot").value = "blijft staan";
    const echt = Storage.prototype.setItem;
    Storage.prototype.setItem = function () { throw new Error("vol"); };
    box.querySelector("[data-opslaan]").click(); await wacht(20);
    Storage.prototype.setItem = echt;
    const fout = !box.querySelector("#fbFout").hidden, open = document.getElementById("uPaneel").classList.contains("open");
    const rpe = box.querySelector('[aria-checked="true"]')?.dataset.v, noot = box.querySelector("#fbNoot").value;
    uiPaneelSluit(); await wacht(300);
    return {ok: fout && open && rpe === "4" && noot === "blijft staan", detail: `melding ${fout}, paneel open ${open}, keuze ${rpe}, toelichting "${noot}"`};
  });

  await test("Ontbrekende en vertraagde registratie", async () => {
    const di = "2026-11-03";
    const hb = dagRoute(di, {alleenLezen: true}).items.find(i => i.soort === "kracht");
    const s = itemStatus(di, hb);
    ROUTE_DAG = di; renderTrainingRoute();
    const tekst = [...document.querySelectorAll("#wkVandaag .tk")].map(k => k.textContent).join(" ");
    /* vandaag, nog zonder Garmin: zaaltraining vooraf met Afronden */
    const act = DATA.activities.find(a => a.date === V && a.sport === "Handbal");
    const i = DATA.activities.indexOf(act); DATA.activities.splice(i, 1);
    ROUTE_DAG = V; renderTrainingRoute();
    const vooraf = !!document.querySelector('#wkVandaag [data-afronden]');
    DATA.activities.splice(i, 0, act); renderTrainingRoute();
    return {ok: s.k === "onbekend" && /Geen registratie/.test(tekst) && vooraf, detail: `di hal: ${s.k}; vandaag zonder Garmin toont Afronden: ${vooraf}`};
  });

  await test("Geen dubbele sessie na synchronisatie", async () => {
    const voor = (FITHEID.find(x => x.date === V) || {}).load;
    const alles = checkLees();
    alles[V] = {...(alles[V] || {}), sessies: [...((alles[V] || {}).sessies || []), {sport: "Handbal", naam: "Handbal", minuten: 67, rpe: 7, handmatig: true}]};
    checkZet(alles); belastingHerberekenen();
    const na = (FITHEID.find(x => x.date === V) || {}).load;
    const ses = sessiesVanDag(V).filter(x => x.sport === "Handbal");
    return {ok: voor === na && ses.some(x => x.ingehaald), detail: `belasting ${voor} → ${na}; handmatige regel gemarkeerd als ingehaald: ${ses.some(x => x.ingehaald)}`};
  });

  await test("Zelfde advies en waarden op Vandaag, Belasting en Plan", async () => {
    renderVandaagNieuw(); renderBelFocus(); renderPlanNieuw();
    const a = document.getElementById("vdAdvies").hidden ? "verborgen" : "zichtbaar", b = a;
    const rb = document.querySelector('[data-meet="laag"] .u-meet-getal').childNodes[0].textContent.trim();
    const rp = document.querySelector("#plVoortgang .pl-cijfers b").textContent.trim();
    const hb = document.querySelector('[data-meet="hoog"] .u-meet-getal').childNodes[0].textContent.trim().replace("*", "");
    const hp = document.querySelectorAll("#plVoortgang .pl-cijfers b")[1].textContent.trim();
    return {ok: a === "verborgen" && rb === rp && hb === hp, detail: `advies op Vandaag ${a}; rustig ${rb}/${rp}; werkmin ${hb}/${hp}`};
  });

  await test("Workoutmodus: juiste eenheden per oefening", async () => {
    localStorage.removeItem(WK_CONCEPT_KEY);
    const it = dagRoute(V).items.find(i => i.soort === "kracht");
    workoutStart(V, it); await wacht(20);
    const soorten = {};
    WKM.oef.forEach((o, n) => { WKM.actief = n; workoutTeken();
      soorten[o.naam.split(" ")[0]] = [...document.querySelectorAll("#wkModus .wm-set--kop span")].map(s => s.textContent).filter(Boolean).slice(1).join("+"); });
    workoutSluiten(true);
    const hold = Object.entries(soorten).find(([k]) => /Hollow/.test(k)), carry = Object.entries(soorten).find(([k]) => /Suitcase/.test(k));
    const druk = Object.entries(soorten).find(([k]) => /Incline/.test(k));
    const conditie = dagRoute("2026-11-04", {alleenLezen: true}).items.find(i => i.soort === "hoog");
    let interval = "";
    if (conditie) { workoutStart("2026-11-04", conditie); interval = [...document.querySelectorAll("#wkModus .wm-set--kop span")].map(s => s.textContent).filter(Boolean).slice(1).join("+"); workoutSluiten(true); }
    return {ok: hold[1] === "sec" && carry[1] === "m+kg" && druk[1] === "herh+kg" && (!conditie || interval === "herh+werk s+herstel s"),
      detail: Object.entries(soorten).map(([k, v]) => `${k}: ${v}`).join(" · ") + (conditie ? ` · interval: ${interval}` : "")};
  });

  await test("Workoutmodus: alleen afgeronde sets gelogd, niets verzonnen", async () => {
    localStorage.removeItem(WK_CONCEPT_KEY);
    const it = dagRoute(V).items.find(i => i.soort === "kracht");
    const voor = logLees().length;
    workoutStart(V, it);
    const o = WKM.oef.find(x => x.soort === "kracht");
    WKM.actief = WKM.oef.indexOf(o);
    o.sets[0] = {a: "8", b: "40", klaar: true}; o.sets[1] = {a: "8", b: "40", klaar: false};
    workoutBewaarConcept();
    const concept = JSON.parse(localStorage.getItem(WK_CONCEPT_KEY));
    workoutAfronden(); await wacht(20);
    const log = logLees().find(x => x.datum === V && x.type === it.wk);
    const keys = Object.keys(log ? log.oefeningen : {});
    uiPaneelSluit(); await wacht(300);
    return {ok: !!concept && keys.length === 1 && log.oefeningen[keys[0]].sets === 1 && log.oefeningen[keys[0]].kg === 40,
      detail: `concept bewaard ${!!concept}; gelogd: ${keys.map(k => `${k} ${log.oefeningen[k].sets} set(s) ${log.oefeningen[k].kg} kg`).join(", ")}; logregels ${voor} → ${logLees().length}`};
  });

  await test("Detailpaneel: dialoog, focus erin, Esc sluit, focus terug", async () => {
    renderTrainingRoute();
    const knop = document.querySelector('#wkVandaag [data-details]'); knop.focus(); knop.click(); await wacht(30);
    const p = document.querySelector("#uPaneel .up");
    const rol = p.getAttribute("role") === "dialog" && p.getAttribute("aria-modal") === "true";
    const focusIn = p.contains(document.activeElement);
    p.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true})); await wacht(350);
    const dicht = !document.getElementById("uPaneel").classList.contains("open");
    return {ok: rol && focusIn && dicht && document.activeElement === knop, detail: `dialoog ${rol}, focus in paneel ${focusIn}, dicht ${dicht}, focus terug ${document.activeElement === knop}`};
  });

  await test("Terugknop sluit eerst het paneel; pagina blijft staan", async () => {
    routeToon({soort: "tab", naam: "training"}, true);
    const hash = location.hash;
    document.querySelector('#wkVandaag [data-details]').click(); await wacht(30);
    history.back(); await wacht(350);
    return {ok: !PANEEL.open && location.hash === hash && document.getElementById("tab-training").classList.contains("active"), detail: `paneel dicht ${!PANEEL.open}, pagina ${location.hash}`};
  });

  await test("Minder beweging: overgangen uit", async () => {
    const regels = [...document.styleSheets].flatMap(s => { try { return [...s.cssRules]; } catch (e) { return []; } })
      .filter(r => r.media && /prefers-reduced-motion/.test(r.media.mediaText)).map(r => r.cssText).join(" ");
    return {ok: /\.up/.test(regels) && /u-melding/.test(regels), detail: /\.up/.test(regels) ? "paneel, melding en kaarten zonder overgang" : "ontbreekt"};
  });

  await test("Drie bollen op Belasting, Vorm in het midden en groter", async () => {
    const d = [...document.querySelectorAll("#belDials > *")];
    const namen = d.map(x => x.textContent.replace(/\s+/g, " ").trim().split(" ").find(w => /AEROOB|VORM|ANAEROOB/i.test(w)));
    const groot = d[1] && d[1].getBoundingClientRect().width >= d[0].getBoundingClientRect().width;
    return {ok: d.length === 3 && groot, detail: `${d.length} bollen; ${namen.join(", ")}; midden groter ${groot}`};
  });

  await test("Workoutsamenvatting sluit aan op de brongegevens (do zaal, wo 4 × 4)", async () => {
    const rap = [];
    let ok = true;
    for (const id of ["24978867411", "24965478064"]) {
      const a = DATA.activities.find(x => x.id === id);
      activiteitPaneel(id); await wacht(300);
      const p = document.querySelector("#uPaneel .up-inhoud");
      const duur = p.querySelector(".as-stat b").textContent;
      const zones = [...p.querySelectorAll(".zrij b")].map(b => b.textContent);
      const bronZ = a.hr_zones.slice().sort((x, y) => x.zone - y.zone).map(z => mmss(z.sec));
      const d = ACT_GRAFIEK.data.datasets[0].data.filter(x => x.y != null);
      const gem = Math.round(d.reduce((t, x) => t + x.y, 0) / d.length), max = Math.max(...d.map(x => x.y));
      const goed = duur === mmss(a.duration_s) && zones.join() === bronZ.join() && gem === Math.round(a.avg_hr) && max === Math.round(a.max_hr) && d.length === a.hr_reeks.t.length;
      ok = ok && goed;
      rap.push(`${a.name}: duur ${duur}, zones ${zones.join("/")}, reeks gem ${gem}/${a.avg_hr} max ${max}/${a.max_hr}, ${d.length} punten`);
      uiPaneelSluit(); await wacht(320);
    }
    return {ok, detail: rap.join(" | ")};
  });

  await test("Vandaag: één kaart per activiteit, geplande sessie niet dubbel", async () => {
    DATA.planbasis.vandaag = V; renderVandaagNieuw();
    const kaarten = [...document.querySelectorAll("#vdTraining .act-kaart")].map(k => k.dataset.act);
    const plan = [...document.querySelectorAll("#vdTraining .tk .tk-titel b")].map(b => b.textContent);
    return {ok: kaarten.length === new Set(kaarten).size && kaarten.includes("24978867411") && !plan.includes("Zaaltraining"),
      detail: `activiteiten: ${kaarten.join(", ")}; plankaarten: ${plan.join(", ") || "geen"}`};
  });

  await test("Dezelfde samenvatting vanuit Vandaag, Training en Sessies", async () => {
    const titels = [];
    DATA.planbasis.vandaag = V; renderVandaagNieuw();
    document.querySelector('#vdTraining [data-act="24978867411"]').click(); await wacht(250); titels.push(document.getElementById("upTitel").textContent); uiPaneelSluit(); await wacht(320);
    ROUTE_DAG = V; renderTrainingRoute();
    document.querySelector('#wkVandaag [data-activiteit="24978867411"]').click(); await wacht(250); titels.push(document.getElementById("upTitel").textContent); uiPaneelSluit(); await wacht(320);
    openSessie("24978867411"); await wacht(250); titels.push(document.getElementById("upTitel").textContent); uiPaneelSluit(); await wacht(320);
    return {ok: titels.every(t => t === titels[0]), detail: titels.join(" | ")};
  });

  await test("Weekscore: getal voor uitvoering, onbekend telt niet, nooit boven 100", async () => {
    const ma = maandagVan(V), di = "2026-11-03";
    const it = dagRoute(di, {alleenLezen: true}).items.filter(i => i.soort !== "rust");
    const w = () => weekScore(ma);
    const klopt = x => x.score == null || x.score === Math.min(100, Math.round(100 * (x.tel.gedaan + 0.5 * x.tel.deels) / (x.tel.gepland - x.tel.onbekend)));
    it.forEach(i => planStatusZet(di, i.id, null)); const onb = w();
    it.forEach(i => planStatusZet(di, i.id, "gedaan")); const goed = w();
    it.forEach(i => planStatusZet(di, i.id, "overgeslagen")); const mis = w();
    it.forEach(i => planStatusZet(di, i.id, null));
    const html = weekScoreHtml(mis, {kort: true});
    const ok = onb.tel.onbekend >= it.length && goed.score > mis.score && [onb, goed, mis].every(klopt) && goed.score <= 100
      && /Weekplan uitgevoerd/.test(html) && /ws-spoor/.test(html) && !/Te licht|Te zwaar/.test(html);
    return {ok, detail: `onbekend ${onb.kop} (${onb.tel.onbekend} onbekend) → gedaan ${goed.kop} → overgeslagen ${mis.kop}; ${weekScoreKort(mis)}`};
  });

  await test("Sessie uit de planning halen telt overal mee en is terug te draaien", async () => {
    const d = "2026-11-06", i = dagRoute(d, {alleenLezen: true}).items.find(x => x.soort === "handbal");
    const voor = weekScore(maandagVan(V)).tel.gepland;
    planVerwijder(d, i); allesNaInvoer();
    const weg = dagRoute(d, {alleenLezen: true}).items.every(x => x.soort === "rust");
    const inWijz = wijzigingenLees().some(w => w.datum === d && w.regel === "eigen");
    planVerwijderTerug(d, i.id); allesNaInvoer();
    const terugOk = dagRoute(d, {alleenLezen: true}).items.some(x => x.soort === "handbal");
    return {ok: weg && inWijz && terugOk, detail: `verwijderd ${weg}, bij wijzigingen ${inWijz}, terug ${terugOk} (gepland tot nu ${voor})`};
  });

  await test("Weekscore per doel: wat mist en volgende week weer oppakken, zonder garanties", async () => {
    const di = "2026-11-03", it = dagRoute(di, {alleenLezen: true}).items.filter(i => i.soort !== "rust");
    it.forEach(i => planStatusZet(di, i.id, "overgeslagen"));
    const w = weekScore(maandagVan(V)), d = weekDoelen(w).filter(x => x.t.gemist);
    it.forEach(i => planStatusZet(di, i.id, null));
    const ok = d.length > 0 && d.every(x => x.woord === "achter" && /Pak volgende week|coach/.test(x.tekst) && /Geen extra inhaaltraining|coach/.test(x.tekst) && !/gevaar|risico/.test(x.tekst));
    return {ok, detail: d.map(x => `${x.naam}: ${x.woord} | ${x.tekst}`).join(" || ")};
  });

  await test("Herstelstatus: grijs zonder check-in, oranje bij aanhoudend gevoel, rood bij ziek of pijn", async () => {
    const c0 = JSON.parse(JSON.stringify(checkLees()));
    const zet = o => { checkZet(o); };
    zet({}); const grijs = herstelStatus(V);
    zet({[V]: {gevoel: 4, lijf: {benen: 0, energie: 1}}}); const normaal = herstelStatus(V).ind.gevoel.niveau;
    zet({[V]: {gevoel: 1, lijf: {benen: 2}}, [isoPlus(V, -1)]: {gevoel: 2, lijf: {benen: 2}}}); const oranje = herstelStatus(V);
    zet({[V]: {gevoel: 3, lijf: {ziek: 1}}}); const rood = herstelStatus(V).niveau;
    zet({[V]: {gevoel: 4, lijf: {achilles: 2}}}); const pees = herstelStatus(V);
    zet(c0); renderVermoeidheid();
    const kaart = document.querySelector("#hsVermoeid .hb-balk") && document.querySelectorAll("#hsVermoeid .hb-balk button").length === 2 && !document.querySelector("#hsVermoeid .hs-i, #hsVermoeid .hs-dag");
    const ok = grijs.niveau === "grijs" && /onbekend/.test(grijs.oorzaak) && ["groen", "blauw"].includes(normaal)
      && oranje.niveau === "oranje" && oranje.actie.length > 0 && !/rust tot|HRV normaal/i.test(oranje.actie) && rood === "rood" && pees.niveau === "rood" && pees.klachten.length === 1 && kaart;
    return {ok, detail: `grijs "${grijs.oorzaak}"; gevoel normaal ${normaal}; ${oranje.niveau} "${oranje.actie}"; ziek ${rood}; pees ${pees.niveau}; kaart ${!!kaart}`};
  });

  await test("Weekscore: compacte kaart en paneel tonen hetzelfde, ook na wijziging buiten de kaart", async () => {
    const di = "2026-11-03", it = dagRoute(di, {alleenLezen: true}).items.filter(i => i.soort !== "rust");
    allesNaInvoer();
    it.forEach(i => planStatusZet(di, i.id, "overgeslagen"));   // wijziging zonder hertekenen, zoals na een sync
    allesHertekenen();
    const kaart = [...document.querySelectorAll(".ws--kort .ws-getal b")].map(b => b.textContent);
    const orig = uiPaneel; let html = ""; window.uiPaneel = (t, h) => { html = h; };
    try { weekScorePaneel(); } finally { window.uiPaneel = orig; }
    const paneel = (html.match(/ws-getal"><b>(\d+)/) || [])[1];
    const nu = String(weekScore(maandagVan(V)).score);
    it.forEach(i => planStatusZet(di, i.id, null)); allesNaInvoer();
    return {ok: kaart.length >= 1 && kaart.every(k => k === nu) && paneel === nu, detail: `kaarten ${kaart.join("/")}, paneel ${paneel}, berekend ${nu}`};
  });

  terug();
  DATA.planbasis.vandaag = V; ROUTE_DAG = null; belastingHerberekenen(); allesNaInvoer(); HB_CACHE.clear(); allesHertekenen();
  return uit;
})()
