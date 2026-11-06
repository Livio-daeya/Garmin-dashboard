/* Controles voor de Supabase-koppeling en de coach op de server, met een
   nagebootste Supabase en server:
     const r = eval(await (await fetch("/supabase.js")).text())  (async: await r)
   Opslag, SUPA en fetch worden daarna teruggezet. */
(async () => {
  const uit = [];
  const opslag = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); opslag[k] = localStorage.getItem(k); }
  const echt = {supa: {...SUPA}, fetch: window.fetch, data: DATA.supabase, gesprek: COACH_GESPREK, sync: {...SYNC}};
  const herstel = () => {
    Object.assign(SUPA, echt.supa); window.fetch = echt.fetch; DATA.supabase = echt.data; COACH_GESPREK = echt.gesprek; Object.assign(SYNC, echt.sync);
    clearTimeout(SYNC_TIMER); clearTimeout(SUPA_STAND_TIMER);
    Object.keys(localStorage).forEach(k => { if (!(k in opslag)) localStorage.removeItem(k); });
    Object.entries(opslag).forEach(([k, v]) => { if (localStorage.getItem(k) !== v) localStorage.setItem(k, v); });
  };
  const test = async (naam, f) => { try { const r = await f(); uit.push({naam, ...r}); } catch (e) { uit.push({naam, ok: false, detail: "fout: " + e.message}); } finally { herstel(); } };

  /* nagebootste supabase-js: alleen wat de app gebruikt */
  function nepClient(start = []) {
    const db = {records: start.map(r => ({...r})), coach_berichten: []};
    const q = tabel => {
      const st = {f: [], vak: null};
      const res = () => { let r = db[tabel].filter(x => st.f.every(f => f(x))); return r; };
      const api = {
        select() { return api; }, in(k, vs) { st.f.push(x => vs.includes(x[k])); return api; }, eq(k, w) { st.f.push(x => x[k] === w); return api; },
        gt(k, w) { st.f.push(x => x[k] > w); return api; }, order() { return api; }, limit() { return api; },
        range(a, b) { return Promise.resolve({data: res().slice(a, b + 1), error: null}); },
        maybeSingle() { return Promise.resolve({data: res()[0] || null, error: null}); },
        upsert(rijen) { rijen.forEach(r => { const i = db[tabel].findIndex(x => x.vak === r.vak && x.sleutel === r.sleutel); if (i >= 0) db[tabel][i] = {...r}; else db[tabel].push({...r}); }); return Promise.resolve({error: null}); },
        delete() { const d = {gt: () => { db[tabel] = []; return Promise.resolve({error: null}); }}; return d; },
        then(ok) { return Promise.resolve({data: res().slice().reverse(), error: null}).then(ok); },
      };
      return api;
    };
    return {db, from: q, auth: {getSession: async () => ({data: {session: {access_token: "tok", user: {email: "ik@voorbeeld.nl"}}}})},
      channel: () => ({on() { return this; }, subscribe() { return this; }}), removeChannel() {}};
  }
  const aan = client => { SUPA.client = client; SUPA.sessie = {access_token: "tok", user: {email: "ik@voorbeeld.nl"}}; DATA.supabase = {url: "https://x.supabase.co", publishable_key: "sb_publishable_x", coach_url: "https://coach.voorbeeld/api/coach"}; syncInit(); };

  await test("Ingelogd: Supabase gaat voor de gist", () => {
    aan(nepClient());
    return {ok: SYNC.via === "supabase" && SYNC.aan, detail: `via ${SYNC.via}`};
  });
  await test("Eerste ronde: je lokale invoer komt in Supabase, met herkomst", async () => {
    const c = nepClient(); aan(c);
    localStorage.setItem(CHECK_KEY, JSON.stringify({"2026-11-04": {gevoel: 3, _t: 10, _bron: "telefoon-ab12"}}));
    await syncRonde(false);
    const r = c.db.records.find(x => x.vak === "check" && x.sleutel === "2026-11-04");
    return {ok: !!r && r.data.gevoel === 3 && r.data._bron === "telefoon-ab12" && !r.data._ongesync, detail: JSON.stringify(r)};
  });
  await test("Wat de coach vastlegde komt in je dashboard", async () => {
    const c = nepClient([{vak: "check", sleutel: "2026-11-05", data: {gevoel: null, sessies: [{sport: "Kracht", rpe: 8, minuten: 45, via: "coach-chat"}], _t: 50, _bron: "coach-chat", _basis: null}}]);
    aan(c); localStorage.removeItem(CHECK_KEY);
    await syncRonde(false);
    const s = (checkLees()["2026-11-05"] || {}).sessies || [];
    return {ok: s.length === 1 && s[0].rpe === 8 && checkLees()["2026-11-05"]._bron === "coach-chat", detail: JSON.stringify(checkLees()["2026-11-05"])};
  });
  await test("Coach en telefoon tegelijk: beide versies blijven bewaard", async () => {
    const c = nepClient([{vak: "check", sleutel: "2026-11-05", data: {gevoel: 2, _t: 300, _bron: "coach-chat", _basis: 100}}]);
    aan(c);
    localStorage.setItem(CHECK_KEY, JSON.stringify({"2026-11-05": {gevoel: 4, _t: 200, _bron: "telefoon-ab12", _basis: 100, _ongesync: true}}));
    await syncRonde(false);
    const r = checkLees()["2026-11-05"];
    return {ok: r.gevoel === 2 && (r._conflicten || []).some(x => x.gevoel === 4 && x._bron === "telefoon-ab12"), detail: JSON.stringify(r)};
  });
  await test("Notities en workoutaanpassingen synchroniseren mee", async () => {
    const c = nepClient([{vak: "notitie", sleutel: "2026-11-05-a", data: {datum: "2026-11-05", tekst: "Na dinsdag geen extra beenwerk", _t: 5, _bron: "coach-chat"}}]);
    aan(c); localStorage.removeItem(NOTITIE_KEY);
    wkAanZet({...wkAanLees(), testtype: {oefeningen: ["x"]}});
    await syncRonde(false);
    return {ok: Object.values(notitiesLees()).some(n => /beenwerk/.test(n.tekst)) && c.db.records.some(x => x.vak === "wkaan" && x.sleutel === "testtype"), detail: `${c.db.records.map(x => x.vak).join(",")}`};
  });
  await test("Je stand wordt gedeeld met de coach, maar niet overschreven door oudere Garmin-gegevens", async () => {
    const c = nepClient(); aan(c);
    const een = await supaStandDelen(true);
    const st = c.db.records.find(x => x.vak === "context");
    c.db.records = [{vak: "context", sleutel: "actueel", data: {garmin: "2999-01-01T00:00:00Z", _t: 1}}];
    const twee = await supaStandDelen(true);
    return {ok: een === true && !!st && !!st.data.context && !!st.data.systeem && st.data.garmin === (DATA.generated || null) && twee === false && c.db.records[0].data.garmin.startsWith("2999"),
      detail: `eerste ${een}, met nieuwere stand elders ${twee}; context-sleutels ${st ? Object.keys(st.data.context).slice(0, 5).join(",") : "-"}`};
  });
  await test("Coach op de server: antwoord, wat hij bekeek en vastlegde, en een workoutkaart", async () => {
    const c = nepClient(); aan(c);
    let verzoek = null;
    window.fetch = async (url, init) => { if (String(url).includes("coach.voorbeeld")) { verzoek = {url, init}; return new Response(JSON.stringify({
      tekst: "**Conclusie:** Bovenlichaam kan.\n**Actie:** Geen beenwerk erbij.", id: 7, model: "claude-opus-5-5",
      acties: [{gereedschap: "lees_activiteiten", invoer: {van: "2026-11-05", tot: "2026-11-05"}}, {gereedschap: "bewaar_sessie", invoer: {datum: "2026-11-05", sport: "Hardlopen", rpe: 8}, opgeslagen: true},
               {gereedschap: "stel_workout_voor", invoer: {}, workout: {date: "2026-11-05", type: "kracht", workout: null, exercises: [{name: "pull-ups", sets: [{reps: 8, weight_kg: null}, {reps: 8, weight_kg: null}]}]}}]}),
      {status: 200, headers: {"content-type": "application/json"}}); } return echt.fetch(url, init); };
    COACH_GESPREK = [];
    document.getElementById("coachIn").value = "Kan ik nog kracht doen na mijn intervallen? Voelde als een 8.";
    await coachStuur();
    const html = document.getElementById("coachLog").innerHTML, b = COACH_GESPREK[COACH_GESPREK.length - 1];
    const body = JSON.parse(verzoek.init.body);
    return {ok: verzoek.init.headers.authorization === "Bearer tok" && body.vraag.includes("intervallen") && /Bovenlichaam kan/.test(html)
      && /Bekeken: activiteiten/.test(html) && /Vastgelegd in je dashboard: zwaarte hardlopen/.test(html) && !!b.workout && /Klopt, zet in mijn logboek/.test(html)
      && c.db.records.some(x => x.vak === "context"), detail: `${b.serverId}; workout ${b.workout ? b.workout.regels.length + " oefening(en)" : "geen"}`};
  });
  await test("Serverfout wordt netjes gemeld", async () => {
    aan(nepClient());
    window.fetch = async (url, init) => String(url).includes("coach.voorbeeld") ? new Response(JSON.stringify({fout: "inlog verlopen of ongeldig"}), {status: 401}) : echt.fetch(url, init);
    COACH_GESPREK = []; document.getElementById("coachIn").value = "hoi";
    await coachStuur();
    const b = COACH_GESPREK[COACH_GESPREK.length - 1];
    return {ok: /Het lukte niet/.test(b.tekst) && /inlog verlopen/.test(b.tekst) && !b.bezig, detail: b.tekst};
  });
  await test("Inloggen met wachtwoord, en een wachtwoord instellen als je ingelogd bent", async () => {
    const c = nepClient(); let gevraagd = null, gezet = null;
    c.auth.signInWithPassword = async ({email, password}) => { gevraagd = {email, password};
      return password === "goed-wachtwoord" ? {data: {session: {access_token: "t2", user: {email}}}, error: null} : {data: {}, error: {message: "Invalid login credentials"}}; };
    c.auth.updateUser = async ({password}) => { gezet = password; return {error: null}; };
    SUPA.client = c; SUPA.sessie = null; DATA.supabase = {url: "u", publishable_key: "k"};
    let fout = null; try { await supaInloggenWachtwoord("ik@voorbeeld.nl", "fout"); } catch (e) { fout = e.message; }
    await supaInloggenWachtwoord("ik@voorbeeld.nl", "goed-wachtwoord"); syncInit();
    renderSyncPaneel();
    const html = document.getElementById("syncPaneel").innerHTML;
    await supaWachtwoordZetten("nieuw-wachtwoord-123");
    return {ok: fout === "E-mailadres of wachtwoord klopt niet." && SYNC.via === "supabase" && /Ingelogd als ik@voorbeeld.nl/.test(html) && /Wachtwoord instellen/.test(html) && gezet === "nieuw-wachtwoord-123",
      detail: `fout "${fout}", via ${SYNC.via}, gezet ${gezet}`};
  });
  await test("Uitgelogd: inlogscherm met e-mail en wachtwoord", () => {
    SUPA.client = nepClient(); SUPA.sessie = null; DATA.supabase = {url: "u", publishable_key: "k"}; syncInit(); renderSyncPaneel();
    const el = document.getElementById("syncPaneel");
    return {ok: !!el.querySelector("#supaMail") && !!el.querySelector("#supaWw[type=password]") && !!el.querySelector("#supaInWw"), detail: el.innerText.slice(0, 80)};
  });
  await test("Zonder inlog blijft alles zoals het was (gist, sleutel in browser)", () => {
    SUPA.sessie = null; SUPA.client = null; syncInit();
    return {ok: SYNC.via !== "supabase" && !coachServer(), detail: `via ${SYNC.via}, coachServer ${coachServer()}`};
  });
  await test("Op GitHub Pages zonder coach-adres: geen servercoach", () => {
    DATA.supabase = {url: "u", publishable_key: "k"};
    return {ok: coachServerUrl() === null || location.hostname !== "livio-daeya.github.io", detail: `${location.hostname} → ${coachServerUrl()}`};
  });
  herstel(); renderCoachSetup(); renderSyncPaneel();
  await test("Testgegevens blijven buiten je opslag", () => {
    const zelfde = Object.keys(opslag).every(k => localStorage.getItem(k) === opslag[k]) && localStorage.length === Object.keys(opslag).length;
    return {ok: zelfde && SUPA.sessie === echt.supa.sessie, detail: `opslag gelijk ${zelfde}`};
  });
  return uit;
})()
