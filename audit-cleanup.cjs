const Database = require("better-sqlite3");
const db = new Database("fuglehund.db");
const proveId = "prove_1776184107994_d58b27ee";

console.log("=== DYP SJEKK AV DATA FOR PRØVE ===\n" + proveId + "\n");

// Tabeller som kan inneholde deltaker-relatert data
const tabeller = [
    { navn: "parti_deltakere", col: "prove_id" },
    { navn: "partier", col: "prove_id" },
    { navn: "venteliste", col: "prove_id" },
    { navn: "pameldinger", col: "prove_id" },
    { navn: "parti_signaturer", col: "prove_id" },
    { navn: "dommer_tildelinger", col: "prove_id" },
    { navn: "kritikker", col: "prove_id" },
    { navn: "dommer_notater", col: "prove_id" },
    { navn: "vk_bedomming", col: "prove_id" },
    { navn: "dommer_foresporsler", col: "prove_id" },
    { navn: "dommer_oppgjor", col: "prove_id" },
    { navn: "fullmakter", col: "prove_id" },
    { navn: "ventende_fullmakter", col: "prove_id" },
    { navn: "avmeldinger", col: "prove_id" },
    { navn: "dvk_kontroller", col: "prove_id" },
    { navn: "dvk_signaturer", col: "prove_id" },
    { navn: "dvk_journaler", col: "prove_id" },
    { navn: "vipps_foresporsler", col: "prove_id" },
    { navn: "jegermiddag_pameldinger", col: "prove_id" },
    { navn: "rapport_versjoner", col: "prove_id" },
    { navn: "rapport_logg", col: "prove_id" },
    { navn: "rolle_sms_sendt", col: "prove_id" },
    { navn: "prove_team", col: "prove_id" },
    { navn: "prove_dokumenter", col: "prove_id" },
    { navn: "prove_config", col: "prove_id" }
];

console.log("--- Rader i tabeller ---");
let totalLeftover = 0;
for (const t of tabeller) {
    try {
        const row = db.prepare(`SELECT COUNT(*) as cnt FROM ${t.navn} WHERE ${t.col} = ?`).get(proveId);
        const marker = row.cnt > 0 ? " ⚠️" : "";
        if (row.cnt > 0) totalLeftover += row.cnt;
        console.log(`  ${t.navn}: ${row.cnt}${marker}`);
    } catch (e) {
        console.log(`  ${t.navn}: (tabell finnes ikke eller mangler kolonne: ${e.message.split('\n')[0]})`);
    }
}

// kv_store
console.log("\n--- kv_store-nøkler ---");
const kvKeys = db.prepare(`SELECT key, length(value) as len, updated_at FROM kv_store WHERE key LIKE '%${proveId}%' ORDER BY key`).all();
if (kvKeys.length === 0) {
    console.log("  (ingen)");
} else {
    kvKeys.forEach(k => console.log(`  ${k.key} (${k.len} bytes, oppdatert ${k.updated_at})`));
}

// Dommer-oppgjør og andre tabeller uten prove_id som kan ha relatert data
console.log("\n--- SMS-logg ---");
const smsCount = db.prepare("SELECT COUNT(*) as cnt FROM sms_log WHERE prove_id = ?").get(proveId);
console.log(`  sms_log for denne prøven: ${smsCount.cnt}${smsCount.cnt > 0 ? ' ⚠️' : ''}`);

// Admin log (vi vil ikke slette dette, men vise)
console.log("\n--- Admin-log (siste 5 relatert til prøven) ---");
const logRader = db.prepare(`SELECT id, created_at, action, substr(detail,1,100) as detail FROM admin_log WHERE detail LIKE '%${proveId}%' ORDER BY id DESC LIMIT 5`).all();
logRader.forEach(r => console.log(`  #${r.id} ${r.created_at} — ${r.action}`));

// Prøven selv skal ikke slettes
console.log("\n--- Prøven-record ---");
const prove = db.prepare("SELECT id, navn, start_dato, slutt_dato FROM prover WHERE id = ?").get(proveId);
if (prove) {
    console.log(`  ${prove.id} | ${prove.navn} | ${prove.start_dato} - ${prove.slutt_dato} ✓ (beholdes)`);
} else {
    console.log("  ⚠️ Prøven er SLETTET!");
}

console.log(`\n=== OPPSUMMERING ===`);
console.log(`Totalt rader med deltakerdata: ${totalLeftover}`);
console.log(`kv_store-nøkler: ${kvKeys.length}`);
if (totalLeftover === 0 && kvKeys.length <= 4) {
    // Normal "tomt" state vil ha: praktiskInfo, automatikkInnstillinger, trialVkType, trialVkConfig
    console.log("✅ Ser rent ut — klar for ny import");
} else {
    console.log("⚠️ Data henger igjen — krever opprydding");
}
