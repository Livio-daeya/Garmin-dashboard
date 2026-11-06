/* Controles voor de coach-API zonder echte Supabase of Anthropic:
   node tests/coach.test.mjs */
import Anthropic from "@anthropic-ai/sdk";
import {voerUit, coachRonde, nieuweVersie, POST, GEREEDSCHAP} from "../api/coach.mjs";

const uit = [];
const test = async (naam, f) => { try { const r = await f(); uit.push(`${r.ok ? "✓" : "✗"} ${naam}${r.detail ? " :: " + r.detail : ""}`); } catch (e) { uit.push(`✗ ${naam} :: fout ${e.stack}`); } };

/* een nep-database met dezelfde vorm als de REST-laag */
function nepDb(start = {}) {
  const t = {records: [], garmin_activiteit: [], garmin_dag: [], garmin_overzicht: [], coach_berichten: [], ...JSON.parse(JSON.stringify(start))};
  const filter = (rijen, q) => {
    const p = new URLSearchParams(q); let r = rijen.slice();
    for (const [k, v] of p) { if (["select", "order", "limit"].includes(k)) continue;
      const [op, w] = [v.slice(0, v.indexOf(".")), v.slice(v.indexOf(".") + 1)];
      r = r.filter(x => { const a = String(x[k]); return op === "eq" ? a === w : op === "gte" ? a >= w : op === "lte" ? a <= w : true; }); }
    if (p.get("order") === "id.desc") r.sort((a, b) => b.id - a.id);
    if (p.get("limit")) r = r.slice(0, +p.get("limit"));
    return r;
  };
  return {t, lees: async (tabel, q) => filter(t[tabel], q),
    schrijf: async (tabel, rijen) => rijen.map(r => {
      if (tabel === "coach_berichten") { const n = {id: t[tabel].length + 1, ...r}; t[tabel].push(n); return n; }
      const i = t[tabel].findIndex(x => x.vak === r.vak && x.sleutel === r.sleutel);
      if (i >= 0) t[tabel][i] = r; else t[tabel].push(r); return r; })};
}
const act = {id: 24659696204, datum: "2026-11-05", data: {date: "2026-11-05", sport: "Hardlopen", name: "Intervallen", duration_s: 3000, distance_m: 9000, avg_hr: 150, max_hr: 182,
  z1_s: 600, z2_s: 900, z3_s: 600, z4_s: 720, z5_s: 180, aerobic_te: 3.6, anaerobic_te: 2.1, load: 140, rondes: [{duur: 240}]}};

await test("Activiteiten van een dag worden gevonden, met zones en Training Effect", async () => {
  const db = nepDb({garmin_activiteit: [act]});
  const r = await voerUit(db, "lees_activiteiten", {van: "2026-11-05", tot: "2026-11-05"});
  const a = r.activiteiten[0];
  return {ok: r.aantal === 1 && a.zone_minuten_1_5.join(",") === "10,15,10,12,3" && a.aeroob_te === 3.6, detail: JSON.stringify(a)};
});
await test("Een sessie-RPE wordt een nieuwe versie met herkomst coach-chat", async () => {
  const db = nepDb({records: [{vak: "check", sleutel: "2026-11-05", data: {gevoel: 4, sessies: [], _t: 100, _bron: "telefoon-ab12"}}]});
  await voerUit(db, "bewaar_sessie", {datum: "2026-11-05", sport: "Kracht", rpe: 8, minuten: 45}, 500);
  const d = db.t.records[0].data;
  return {ok: d.gevoel === 4 && d.sessies[0].rpe === 8 && d._bron === "coach-chat" && d._basis === 100 && d._t === 500, detail: JSON.stringify(d)};
});
await test("Een check-in vult aan zonder bestaande velden te wissen", async () => {
  const db = nepDb({records: [{vak: "check", sleutel: "2026-11-05", data: {gevoel: 4, lijf: {benen: 1}, sessies: [{sport: "Handbal", rpe: 7}], _t: 100}}]});
  await voerUit(db, "bewaar_checkin", {datum: "2026-11-05", lijf: {achilles: 1}}, 600);
  const d = db.t.records[0].data;
  return {ok: d.gevoel === 4 && d.lijf.benen === 1 && d.lijf.achilles === 1 && d.sessies.length === 1, detail: JSON.stringify(d)};
});
await test("Een notitie komt als eigen record in het dashboard", async () => {
  const db = nepDb();
  const r = await voerUit(db, "bewaar_notitie", {datum: "2026-11-05", tekst: "Na dinsdag geen extra beenwerk"}, 700);
  return {ok: r.opgeslagen && db.t.records[0].vak === "notitie" && db.t.records[0].data.tekst.includes("beenwerk"), detail: db.t.records[0].sleutel};
});
await test("Verwijderde records en interne velden gaan niet naar de coach", async () => {
  const db = nepDb({records: [{vak: "check", sleutel: "2026-11-04", data: {_weg: true, _t: 1}}, {vak: "check", sleutel: "2026-11-05", data: {gevoel: 3, _t: 2, _conflicten: [{x: 1}]}}]});
  const r = await voerUit(db, "lees_invoer", {vak: "check"});
  return {ok: r.aantal === 1 && !("_conflicten" in r.records[0]), detail: JSON.stringify(r)};
});
await test("Ongeldige invoer geeft een foutmelding, geen zoekopdracht", async () => {
  const db = nepDb();
  const a = await voerUit(db, "lees_activiteit", {id: "1;drop"}), b = await voerUit(db, "lees_dagen", {van: "gisteren", tot: "x"});
  return {ok: !!a.fout && !!b.fout, detail: `${a.fout}; ${b.fout}`};
});

/* nep-Anthropic: eerst een tool-aanroep, dan een antwoord */
function nepClient(stappen) {
  const verzoeken = [];
  const client = new Anthropic({apiKey: "test", fetch: async (url, init) => {
    const body = JSON.parse(init.body); verzoeken.push(body);
    const stap = stappen[verzoeken.length - 1];
    return new Response(JSON.stringify({id: "msg_" + verzoeken.length, type: "message", role: "assistant", model: body.model, stop_reason: stap.stop, stop_sequence: null,
      content: stap.content, usage: {input_tokens: 10, output_tokens: 5}}), {status: 200, headers: {"content-type": "application/json"}});
  }});
  return {client, verzoeken};
}
await test("De coach zoekt de workout op, legt de zwaarte vast en antwoordt", async () => {
  const db = nepDb({garmin_activiteit: [act], records: [{vak: "context", sleutel: "actueel", data: {vandaag: "2026-11-05", systeem: "Je bent de coach.", context: {route: {vandaag: []}}, _t: 1}}]});
  const {client, verzoeken} = nepClient([
    {stop: "tool_use", content: [{type: "tool_use", id: "t1", name: "lees_activiteiten", input: {van: "2026-11-05", tot: "2026-11-05"}},
                                 {type: "tool_use", id: "t2", name: "bewaar_sessie", input: {datum: "2026-11-05", sport: "Hardlopen", rpe: 8}}]},
    {stop: "end_turn", content: [{type: "text", text: "**Conclusie:** Geen extra beenwerk vandaag.\n**Actie:** Alleen bovenlichaam."}]},
  ]);
  const r = await coachRonde({client, db, vraag: "Kan ik nog kracht doen na mijn intervallen? Voelde als een 8.", nu: 900});
  const tweede = verzoeken[1];
  const toolResult = tweede.messages[tweede.messages.length - 1].content;
  const ok = verzoeken.length === 2 && verzoeken[0].model === "claude-opus-5-5" && verzoeken[0].tools.length === GEREEDSCHAP.length
    && verzoeken[0].fallbacks === "default" && toolResult.length === 2 && /Intervallen/.test(toolResult[0].content)
    && db.t.records.find(x => x.vak === "check").data.sessies[0].rpe === 8 && r.acties.some(a => a.gereedschap === "bewaar_sessie" && a.opgeslagen)
    && /Conclusie/.test(r.tekst) && /Vandaag is 2026-11-05/.test(JSON.stringify(verzoeken[0].system));
  return {ok, detail: `${verzoeken.length} verzoeken; acties ${r.acties.map(a => a.gereedschap).join(", ")}; antwoord "${r.tekst.slice(0, 40)}"`};
});
await test("Eerder gesprek gaat mee, om en om en beginnend bij de gebruiker", async () => {
  const db = nepDb({coach_berichten: [{id: 1, rol: "assistant", tekst: "hallo"}, {id: 2, rol: "user", tekst: "vraag 1"}, {id: 3, rol: "assistant", tekst: "antwoord 1"}, {id: 4, rol: "user", tekst: "nieuwe vraag"}]});
  const {client, verzoeken} = nepClient([{stop: "end_turn", content: [{type: "text", text: "ok"}]}]);
  await coachRonde({client, db, vraag: "nieuwe vraag", nu: 1});
  const rollen = verzoeken[0].messages.map(m => m.role).join(",");
  const laatste = verzoeken[0].messages[verzoeken[0].messages.length - 1].content;
  return {ok: rollen === "user,assistant,user" && laatste === "nieuwe vraag", detail: `${rollen}; laatste "${laatste}"`};
});
await test("Zonder inlogtoken geen toegang", async () => {
  process.env.SUPABASE_URL = "https://x.supabase.co"; process.env.SUPABASE_PUBLISHABLE_KEY = "sb_publishable_x"; process.env.ANTHROPIC_API_KEY = "x";
  const r = await POST(new Request("https://coach.example/api/coach", {method: "POST", body: JSON.stringify({vraag: "hoi"})}));
  return {ok: r.status === 401, detail: String(r.status)};
});
await test("Een vreemde herkomst wordt geweigerd", async () => {
  const r = await POST(new Request("https://coach.example/api/coach", {method: "POST", headers: {origin: "https://kwaad.example", authorization: "Bearer x"}, body: "{}"}));
  return {ok: r.status === 403, detail: String(r.status)};
});
await test("Versie bouwt voort op de bestaande en behoudt conflicten", async () => {
  const v = nieuweVersie({data: {_t: 5, _conflicten: [{a: 1}]}}, {gevoel: 2, _ongesync: true}, 9);
  return {ok: v._basis === 5 && v._t === 9 && v._conflicten.length === 1 && !("_ongesync" in v), detail: JSON.stringify(v)};
});
console.log(uit.join("\n"));
process.exit(uit.some(x => x.startsWith("✗")) ? 1 : 0);
