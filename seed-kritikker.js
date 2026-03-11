import Database from "better-sqlite3";

const db = new Database("fuglehund.db");

// Slett eksisterende test-kritikker for denne hunden
db.prepare("DELETE FROM kritikker WHERE hund_regnr = ?").run("NO67890/23");

// Realistisk karrierevei for Bleiebøtte (født 2021-11-30):
// - UK (under 2 år): Noen prøver som unghund
// - AK (etter fylte 2 år): Jobber mot 1. premie (VK-billett)
// - VK: Etter oppnådd 1.AK, stiller i vinnerklassen
//
// Premiestruktur:
// UK/AK: 1. premie, 2. premie, 3. premie, ÅP
// VK: 1.VK m/CACIT (kun 1.plass), 1.VK m/CK, 2.VK m/CK, ÅP

const kritikker = [
  // UK - Som unghund (under 2 år, altså før nov 2023)
  {
    prove_id: null,
    parti: "UK-1",
    hund_regnr: "NO67890/23",
    hund_navn: "Bleiebøtte",
    hund_rase: "Irsk Setter",
    eier: "Marstein Manstein",
    forer: "Marstein Manstein",
    klasse: "UK",
    dommer_telefon: null,
    scores: JSON.stringify({STAND_M: 1, STAND_U: 0, TOMSTAND: 1, MAKKER_STAND: 0, JAKTLYST: 4, FART: 4, SOKSBREDDE: 3, REVIERING: 3, SAMARBEID: 3, PRESISJON: 2, REISING: 3}),
    premie: "3. premie",
    tekst: "Lovende unghund med fin jaktlyst. Noe uerfaren i fuglearbeidet, men viser gode anlegg.",
    status: "approved",
    approved_at: "2023-06-15T11:00:00Z",
    approved_by: "NKK-rep"
  },
  {
    prove_id: null,
    parti: "UK-2",
    hund_regnr: "NO67890/23",
    hund_navn: "Bleiebøtte",
    hund_rase: "Irsk Setter",
    eier: "Marstein Manstein",
    forer: "Marstein Manstein",
    klasse: "UK",
    dommer_telefon: null,
    scores: JSON.stringify({STAND_M: 1, STAND_U: 1, TOMSTAND: 0, MAKKER_STAND: 1, JAKTLYST: 5, FART: 4, SOKSBREDDE: 4, REVIERING: 3, SAMARBEID: 4, PRESISJON: 3, REISING: 4}),
    premie: "2. premie",
    tekst: "Klar fremgang fra sist. Bedre fuglearbeid og mer sikker i stand.",
    status: "approved",
    approved_at: "2023-09-10T14:00:00Z",
    approved_by: "NKK-rep"
  },

  // AK - Etter fylte 2 år (fra des 2023)
  {
    prove_id: null,
    parti: "AK-1",
    hund_regnr: "NO67890/23",
    hund_navn: "Bleiebøtte",
    hund_rase: "Irsk Setter",
    eier: "Marstein Manstein",
    forer: "Marstein Manstein",
    klasse: "AK",
    dommer_telefon: null,
    scores: JSON.stringify({STAND_M: 2, STAND_U: 1, TOMSTAND: 1, MAKKER_STAND: 1, JAKTLYST: 5, FART: 5, SOKSBREDDE: 4, REVIERING: 4, SAMARBEID: 4, PRESISJON: 3, REISING: 4}),
    premie: "2. premie",
    tekst: "Fin hund som viser god jaktlyst og fart. Noe forsiktig i reisingen, men solid fuglearbeid.",
    status: "approved",
    approved_at: "2024-03-20T10:00:00Z",
    approved_by: "NKK-rep"
  },
  {
    prove_id: null,
    parti: "AK-2",
    hund_regnr: "NO67890/23",
    hund_navn: "Bleiebøtte",
    hund_rase: "Irsk Setter",
    eier: "Marstein Manstein",
    forer: "Marstein Manstein",
    klasse: "AK",
    dommer_telefon: null,
    scores: JSON.stringify({STAND_M: 2, STAND_U: 2, TOMSTAND: 0, MAKKER_STAND: 1, JAKTLYST: 5, FART: 5, SOKSBREDDE: 5, REVIERING: 4, SAMARBEID: 5, PRESISJON: 4, REISING: 5}),
    premie: "1. premie",  // VK-billett!
    tekst: "Flott prestasjon! Meget god jaktlyst og fart, effektivt søk. Sikker i fuglearbeidet med villig reis. Kvalifisert til VK.",
    status: "approved",
    approved_at: "2024-09-15T12:00:00Z",
    approved_by: "NKK-rep"
  },

  // VK - Etter oppnådd 1.AK (vinnerklasse)
  {
    prove_id: null,
    parti: "VK-1",
    hund_regnr: "NO67890/23",
    hund_navn: "Bleiebøtte",
    hund_rase: "Irsk Setter",
    eier: "Marstein Manstein",
    forer: "Marstein Manstein",
    klasse: "VK",
    dommer_telefon: null,
    scores: JSON.stringify({STAND_M: 3, STAND_U: 1, TOMSTAND: 0, MAKKER_STAND: 2, JAKTLYST: 5, FART: 5, SOKSBREDDE: 5, REVIERING: 5, SAMARBEID: 5, PRESISJON: 4, REISING: 5}),
    premie: "2.VK m/CK",
    tekst: "Sterk VK-debut. Arbeider målrettet og effektivt, godt fuglearbeid gjennom hele slippet.",
    status: "approved",
    approved_at: "2025-03-22T14:30:00Z",
    approved_by: "NKK-rep"
  },
  {
    prove_id: null,
    parti: "VK-2",
    hund_regnr: "NO67890/23",
    hund_navn: "Bleiebøtte",
    hund_rase: "Irsk Setter",
    eier: "Marstein Manstein",
    forer: "Marstein Manstein",
    klasse: "VK",
    dommer_telefon: null,
    scores: JSON.stringify({STAND_M: 4, STAND_U: 2, TOMSTAND: 0, MAKKER_STAND: 3, JAKTLYST: 6, FART: 5, SOKSBREDDE: 5, REVIERING: 5, SAMARBEID: 5, PRESISJON: 4, REISING: 6}),
    premie: "1.VK m/CACIT",
    tekst: "Eksepsjonell hund i toppform! Utmerket fuglearbeid med mange stander. Djerv og sikker reis. Verdig CACIT-vinner.",
    status: "approved",
    approved_at: "2025-09-10T16:00:00Z",
    approved_by: "NKK-rep"
  }
];

const stmt = db.prepare(`
  INSERT INTO kritikker (prove_id, parti, hund_regnr, hund_navn, hund_rase, eier, forer, klasse, dommer_telefon, scores, premie, tekst, status, approved_at, approved_by)
  VALUES (@prove_id, @parti, @hund_regnr, @hund_navn, @hund_rase, @eier, @forer, @klasse, @dommer_telefon, @scores, @premie, @tekst, @status, @approved_at, @approved_by)
`);

for (const k of kritikker) {
  try {
    stmt.run(k);
    console.log("✅ Lagt inn kritikk:", k.klasse, k.parti, k.premie);
  } catch (e) {
    console.error("❌ Feil:", e.message);
  }
}

const count = db.prepare("SELECT COUNT(*) as count FROM kritikker WHERE hund_regnr = ?").get("NO67890/23").count;
console.log(`\n🐕 Ferdig! Bleiebøtte har nå ${count} kritikker i databasen.`);
console.log("\nKarrierevei:");
console.log("  UK: 3. premie → 2. premie");
console.log("  AK: 2. premie → 1. premie (VK-billett!)");
console.log("  VK: 2.VK m/CK → 1.VK m/CACIT");

db.close();
