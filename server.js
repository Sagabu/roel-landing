import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import Database from "better-sqlite3";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");
const XLSX = require("xlsx");

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, "fuglehund.db");
const PORT = Number(process.env.PORT || 8889);

// --- Database setup ---
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS kv_store (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS trial_config (
    id INTEGER PRIMARY KEY DEFAULT 1,
    name TEXT NOT NULL DEFAULT 'Høgkjølprøven 2026',
    location TEXT DEFAULT '',
    start_date TEXT DEFAULT '',
    end_date TEXT DEFAULT '',
    organizing_club TEXT DEFAULT '',
    club_logo TEXT DEFAULT '',
    description TEXT DEFAULT '',
    contact_email TEXT DEFAULT '',
    contact_phone TEXT DEFAULT '',
    is_published INTEGER DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS admin_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    detail TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- Brukere-tabell
  CREATE TABLE IF NOT EXISTS brukere (
    telefon TEXT PRIMARY KEY,
    fornavn TEXT NOT NULL,
    etternavn TEXT NOT NULL,
    epost TEXT DEFAULT '',
    adresse TEXT DEFAULT '',
    postnummer TEXT DEFAULT '',
    sted TEXT DEFAULT '',
    rolle TEXT DEFAULT 'deltaker',
    medlem_siden TEXT DEFAULT (strftime('%Y', 'now')),
    profilbilde TEXT DEFAULT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  -- Klubber-tabell
  CREATE TABLE IF NOT EXISTS klubber (
    id TEXT PRIMARY KEY,
    orgnummer TEXT UNIQUE,
    navn TEXT NOT NULL,
    region TEXT DEFAULT ''
  );

  -- Hunder-tabell
  CREATE TABLE IF NOT EXISTS hunder (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    regnr TEXT UNIQUE NOT NULL,
    navn TEXT NOT NULL,
    rase TEXT DEFAULT '',
    kjonn TEXT DEFAULT 'male',
    fodt TEXT DEFAULT '',
    eier_telefon TEXT REFERENCES brukere(telefon),
    klubb_id TEXT REFERENCES klubber(id),
    far_id INTEGER REFERENCES hunder(id),
    mor_id INTEGER REFERENCES hunder(id),
    far_regnr TEXT DEFAULT '',
    mor_regnr TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- Resultater-tabell (hund-resultater)
  CREATE TABLE IF NOT EXISTS resultater (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hund_id INTEGER REFERENCES hunder(id),
    dato TEXT NOT NULL,
    prove_navn TEXT NOT NULL,
    klasse TEXT DEFAULT 'AK',
    premie TEXT DEFAULT '',
    dommer TEXT DEFAULT ''
  );

  -- Prøver-tabell
  CREATE TABLE IF NOT EXISTS prover (
    id TEXT PRIMARY KEY,
    navn TEXT NOT NULL,
    sted TEXT DEFAULT '',
    start_dato TEXT,
    slutt_dato TEXT,
    klubb_id TEXT REFERENCES klubber(id),
    proveleder_telefon TEXT REFERENCES brukere(telefon),
    nkkrep_telefon TEXT REFERENCES brukere(telefon),
    status TEXT DEFAULT 'planlagt',
    klasser TEXT DEFAULT '{"uk":true,"ak":true,"vk":true}',
    partier TEXT DEFAULT '{}',
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- Dommer-tildelinger (kobler dommer til parti i en prøve)
  CREATE TABLE IF NOT EXISTS dommer_tildelinger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prove_id TEXT REFERENCES prover(id),
    dommer_telefon TEXT REFERENCES brukere(telefon),
    parti TEXT NOT NULL,
    dommer_rolle INTEGER DEFAULT NULL,
    UNIQUE(prove_id, dommer_telefon)
  );

  -- Klubb-administratorer
  CREATE TABLE IF NOT EXISTS klubb_admins (
    telefon TEXT REFERENCES brukere(telefon),
    klubb_id TEXT REFERENCES klubber(id),
    rolle TEXT DEFAULT 'admin',
    PRIMARY KEY (telefon, klubb_id)
  );

  -- Kritikker-tabell (fullstendige FKF kritikkskjemaer)
  CREATE TABLE IF NOT EXISTS kritikker (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hund_id INTEGER REFERENCES hunder(id),
    prove_id TEXT REFERENCES prover(id),
    dommer_telefon TEXT REFERENCES brukere(telefon),
    dato TEXT NOT NULL,
    klasse TEXT DEFAULT 'AK',
    parti TEXT DEFAULT '',
    sted TEXT DEFAULT '',

    -- Fuglebehandling
    presisjon INTEGER DEFAULT NULL,
    reising INTEGER DEFAULT NULL,
    godkjent_reising INTEGER DEFAULT 0,

    -- Stand og arbeid
    stand_m INTEGER DEFAULT 0,
    stand_u INTEGER DEFAULT 0,
    tomstand INTEGER DEFAULT 0,
    makker_stand INTEGER DEFAULT 0,
    sjanse INTEGER DEFAULT 0,
    slipptid INTEGER DEFAULT NULL,

    -- Egenskaper (1-6 skala)
    jaktlyst INTEGER DEFAULT NULL,
    fart INTEGER DEFAULT NULL,
    selvstendighet INTEGER DEFAULT NULL,
    soksbredde INTEGER DEFAULT NULL,
    reviering INTEGER DEFAULT NULL,
    samarbeid INTEGER DEFAULT NULL,

    -- Sekundering og apport
    sek_spontan INTEGER DEFAULT 0,
    sek_forbi INTEGER DEFAULT 0,
    apport INTEGER DEFAULT NULL,
    rapport_spontan INTEGER DEFAULT 0,

    -- Adferd og premie
    adferd TEXT DEFAULT '',
    premie TEXT DEFAULT '',

    -- Fritekst kritikk
    kritikk_tekst TEXT DEFAULT '',

    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  INSERT OR IGNORE INTO trial_config (id) VALUES (1);
`);

// --- Seed initial data if tables are empty ---
function seedData() {
  const brukerCount = db.prepare("SELECT COUNT(*) as n FROM brukere").get().n;
  if (brukerCount > 0) return; // Already seeded

  console.log("🌱 Seeding initial data...");

  // Seed klubber
  const klubber = [
    { id: 'namdal', orgnummer: '987654321', navn: 'Namdal Fuglehundklubb', region: 'Trøndelag' },
    { id: 'malvik', orgnummer: '987654322', navn: 'Malvik Fuglehundklubb', region: 'Trøndelag' },
    { id: 'selbu', orgnummer: '987654323', navn: 'Selbu Fuglehundklubb', region: 'Trøndelag' },
    { id: 'sorfjeldske', orgnummer: '987654324', navn: 'Sørfjeldske Fuglehundklubb', region: 'Trøndelag' },
    { id: 'stjordal', orgnummer: '987654325', navn: 'Stjørdal Fuglehundklubb', region: 'Trøndelag' }
  ];
  const insertKlubb = db.prepare("INSERT INTO klubber (id, orgnummer, navn, region) VALUES (?, ?, ?, ?)");
  for (const k of klubber) {
    insertKlubb.run(k.id, k.orgnummer, k.navn, k.region);
  }

  // Seed brukere
  const brukere = [
    { telefon: '99999999', fornavn: 'Chris', etternavn: 'Niebel', epost: 'chris.niebel@example.com', adresse: 'Jaktveien 15', postnummer: '7800', sted: 'Namsos', rolle: 'deltaker,dommer', medlem_siden: '2019' },
    { telefon: '99999998', fornavn: 'Gæggen', etternavn: 'Wågert', epost: 'gaeggen.wagert@example.com', adresse: 'Fugleveien 7', postnummer: '7563', sted: 'Malvik', rolle: 'deltaker', medlem_siden: '2020' },
    { telefon: '99999997', fornavn: 'Monja', etternavn: 'Aakert', epost: 'monja.aakert@example.com', adresse: 'Lederveien 1', postnummer: '7800', sted: 'Namsos', rolle: 'deltaker,dommer,klubbleder,proveleder', medlem_siden: '2015' },
    { telefon: '99999996', fornavn: 'Torstein', etternavn: 'Møstn', epost: 'torstein.mostn@example.com', adresse: 'Selbuveien 22', postnummer: '7580', sted: 'Selbu', rolle: 'deltaker', medlem_siden: '2018' },
    { telefon: '99999995', fornavn: 'Marstein', etternavn: 'Manstein', epost: 'marstein.manstein@example.com', adresse: 'Fjellgata 44', postnummer: '7340', sted: 'Oppdal', rolle: 'deltaker,nkkrep', medlem_siden: '2021' },
    { telefon: '99999994', fornavn: 'Roar', etternavn: 'Storseth', epost: 'roar.storseth@example.com', adresse: 'Hundegata 8', postnummer: '7500', sted: 'Stjørdal', rolle: 'deltaker,dommer', medlem_siden: '2017' }
  ];
  const insertBruker = db.prepare("INSERT INTO brukere (telefon, fornavn, etternavn, epost, adresse, postnummer, sted, rolle, medlem_siden) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (const b of brukere) {
    insertBruker.run(b.telefon, b.fornavn, b.etternavn, b.epost, b.adresse, b.postnummer, b.sted, b.rolle, b.medlem_siden);
  }

  // Seed klubb-admins
  db.prepare("INSERT INTO klubb_admins (telefon, klubb_id, rolle) VALUES (?, ?, ?)").run('99999997', 'namdal', 'leder');

  // Seed hunder med resultater
  const insertHund = db.prepare("INSERT INTO hunder (regnr, navn, rase, kjonn, fodt, eier_telefon, klubb_id) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const insertResultat = db.prepare("INSERT INTO resultater (hund_id, dato, prove_navn, klasse, premie, dommer) VALUES (?, ?, ?, ?, ?, ?)");

  // Chris Niebel's hund
  let result = insertHund.run('NO45678/22', 'Breton XXL', 'Breton', 'male', '2020-05-15', '99999999', 'namdal');
  let hundId = result.lastInsertRowid;
  insertResultat.run(hundId, '2024-09-14', 'Namdalseid Høstprøve', 'AK', '2. AK', 'Kari Olsen');
  insertResultat.run(hundId, '2024-03-22', 'Vårprøven Steinkjer', 'AK', '1. AK', 'Per Hansen');
  insertResultat.run(hundId, '2023-09-10', 'Høstprøven Namsos', 'UK', '2. UK', 'Monja Aakert');

  // Gæggen Wågert's hunder
  result = insertHund.run('NO34567/21', 'Zico', 'Gordon Setter', 'male', '2019-03-20', '99999998', 'malvik');
  hundId = result.lastInsertRowid;
  insertResultat.run(hundId, '2024-10-05', 'Malvik Høstprøve', 'VK', '3. VK', 'Arne Fjell');
  insertResultat.run(hundId, '2024-04-12', 'Trondheim Vårprøve', 'AK', '1. AK', 'Liv Strand');
  insertResultat.run(hundId, '2023-09-28', 'NM Fuglehund', 'AK', '2. AK', 'Tor Dahl');

  result = insertHund.run('NO45123/23', 'Mainoo', 'Gordon Setter', 'male', '2021-07-10', '99999998', 'malvik');
  hundId = result.lastInsertRowid;
  insertResultat.run(hundId, '2024-09-20', 'Selbu Prøve', 'UK', '1. UK', 'Hans Mo');
  insertResultat.run(hundId, '2024-05-18', 'Vårprøven Klæbu', 'UK', '2. UK', 'Gerd Vik');

  // Monja Aakert's hunder
  result = insertHund.run('NO23456/20', 'Tripp', 'Gordon Setter', 'male', '2018-02-14', '99999997', 'namdal');
  hundId = result.lastInsertRowid;
  insertResultat.run(hundId, '2024-10-12', 'Namdal Høstprøve', 'VK', 'CERT', 'Ole Nordmann');
  insertResultat.run(hundId, '2024-06-08', 'Sommerprøven Lierne', 'VK', '1. VK', 'Roar Storseth');
  insertResultat.run(hundId, '2023-10-21', 'NM Fuglehund', 'VK', '2. VK', 'Knut Lie');

  result = insertHund.run('NO23457/20', 'Trapp', 'Gordon Setter', 'male', '2018-02-14', '99999997', 'namdal');
  hundId = result.lastInsertRowid;
  insertResultat.run(hundId, '2024-09-30', 'Grong Høstprøve', 'AK', '1. AK', 'Stein Berg');
  insertResultat.run(hundId, '2024-04-20', 'Vårprøven Namdalen', 'AK', '2. AK', 'Liv Mo');

  // Torstein Møstn's hunder
  result = insertHund.run('NO56789/21', 'Stora', 'Irsk Setter', 'female', '2019-08-22', '99999996', 'selbu');
  hundId = result.lastInsertRowid;
  insertResultat.run(hundId, '2024-09-15', 'Selbu Høstprøve', 'AK', '1. AK', 'Eva Dahl');
  insertResultat.run(hundId, '2024-05-05', 'Vårprøven Tydal', 'AK', '3. AK', 'Odd Lie');
  insertResultat.run(hundId, '2023-09-22', 'Røros Prøve', 'UK', '1. UK', 'Marit Vik');

  result = insertHund.run('NO56790/22', 'Petra', 'Irsk Setter', 'female', '2020-04-18', '99999996', 'selbu');
  hundId = result.lastInsertRowid;
  insertResultat.run(hundId, '2024-10-01', 'Holtålen Prøve', 'UK', '2. UK', 'Jon Berg');
  insertResultat.run(hundId, '2024-06-15', 'Sommerprøven Selbu', 'UK', '1. UK', 'Anne Mo');

  // Marstein Manstein's hund
  result = insertHund.run('NO67890/23', 'Bleiebøtte', 'Irsk Setter', 'female', '2021-11-30', '99999995', 'sorfjeldske');
  hundId = result.lastInsertRowid;
  insertResultat.run(hundId, '2024-09-08', 'Oppdal Høstprøve', 'UK', '1. UK', 'Rolf Strand');
  insertResultat.run(hundId, '2024-04-28', 'Vårprøven Rennebu', 'UK', '3. UK', 'Gro Fjell');

  // Roar Storseth's hund
  result = insertHund.run('NO78901/22', 'Kjemperask', 'Engelsk Setter', 'male', '2020-09-05', '99999994', 'stjordal');
  hundId = result.lastInsertRowid;
  insertResultat.run(hundId, '2024-10-08', 'Stjørdal Høstprøve', 'VK', '2. VK', 'Tor Hansen');
  insertResultat.run(hundId, '2024-05-25', 'Vårprøven Meråker', 'AK', '1. AK', 'Liv Olsen');
  insertResultat.run(hundId, '2023-10-14', 'Levanger Prøve', 'AK', '1. AK', 'Per Mo');

  // Seed Vinterprøven 2026
  db.prepare(`INSERT INTO prover (id, navn, sted, start_dato, slutt_dato, klubb_id, proveleder_telefon, nkkrep_telefon, status, klasser, partier) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'vinterproven2026',
    'Vinterprøven 2026',
    'Lierne',
    '2026-01-17',
    '2026-01-18',
    'namdal',
    '99999997',
    '99999995',
    'active',
    JSON.stringify({ uk: true, ak: true, vk: true, vkType: '2day' }),
    JSON.stringify({ day1: { ukak: 3, vkKval: 2 }, day2: { ukak: 4, vkFinale: 1 } })
  );

  // Seed dommer-tildelinger for Vinterprøven
  const insertDommer = db.prepare("INSERT INTO dommer_tildelinger (prove_id, dommer_telefon, parti, dommer_rolle) VALUES (?, ?, ?, ?)");
  insertDommer.run('vinterproven2026', '99999999', 'ukak1', null);
  insertDommer.run('vinterproven2026', '99999997', 'vkfinale', 1);
  insertDommer.run('vinterproven2026', '99999994', 'ukak2', null);

  // Seed kritikker med fullstendige FKF-data
  const insertKritikk = db.prepare(`
    INSERT INTO kritikker (
      hund_id, prove_id, dommer_telefon, dato, klasse, parti, sted,
      presisjon, reising, godkjent_reising,
      stand_m, stand_u, tomstand, makker_stand, sjanse, slipptid,
      jaktlyst, fart, selvstendighet, soksbredde, reviering, samarbeid,
      sek_spontan, sek_forbi, apport, rapport_spontan,
      adferd, premie, kritikk_tekst
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Kritikk for Bleiebøtte (hund_id 8) - Irsk Setter
  insertKritikk.run(
    8, 'vinterproven2026', '99999997', '2024-09-08', 'UK', 'UK Parti 1', 'Oppdal',
    3, 5, 1,  // presisjon, reising, godkjent_reising
    2, 1, 0, 1, 3, 42,  // stand_m, stand_u, tomstand, makker_stand, sjanse, slipptid
    5, 5, 4, 4, 4, 4,  // jaktlyst, fart, selvstendighet, soksbredde, reviering, samarbeid
    1, 0, null, 0,  // sek_spontan, sek_forbi, apport, rapport_spontan
    '', '1. UK',  // adferd, premie
    'Flott irsk setter med masse energi og arbeidsvilje. Viser meget god jaktlyst og fart i terrenget. Søket er systematisk og effektivt. Ved fuglkontakt viser hunden fast og sikker stand med god marking. Reiser villig på kommando. En lovende unghund med stort potensial.'
  );

  // Kritikk for Breton XXL (hund_id 1)
  insertKritikk.run(
    1, 'vinterproven2026', '99999999', '2024-09-14', 'AK', 'AK Parti 2', 'Namdalseid',
    3, 4, 1,
    2, 1, 1, 0, 2, 38,
    5, 4, 4, 3, 4, 4,
    0, 0, 1, 0,
    '', '2. AK',
    'Fin Breton med god arbeidsvilje. Dekker terrenget effektivt med tilpasset søk. Viser god fart og fin stil. Fuglearbeidet er pålitelig med fast stand. Noe forsiktig ved sekundering, men viser god ro. En trivelig hund.'
  );

  // Kritikk for Kjemperask (hund_id 9) - Engelsk Setter
  insertKritikk.run(
    9, 'vinterproven2026', '99999994', '2024-10-08', 'VK', 'VK Kval 1', 'Stjørdal',
    4, 5, 1,
    3, 2, 0, 2, 4, 50,
    5, 5, 5, 4, 4, 4,
    2, 0, 1, 1,
    '', 'CK',
    'Solid engelsk setter med meget god arbeidsvilje gjennom hele slippet. Godt tilpasset terreng med effektivt søk. Fuglarbeidet er stabilt og pålitelig med fast stand og fin marking. Viser god ro ved stand og reiser fint. Utmerket samarbeid med fører. Et godt VK-slipp som viser at hunden har kvaliteter for videre avl.'
  );

  // Kritikk for Tripp (hund_id 4) - Gordon Setter
  insertKritikk.run(
    4, 'vinterproven2026', '99999997', '2024-10-12', 'VK', 'VK Finale', 'Namdal',
    4, 6, 1,
    3, 2, 0, 2, 5, 55,
    6, 5, 5, 4, 5, 4,
    2, 0, 1, 1,
    '', 'CERT',
    'Eksepsjonell Gordon Setter med imponerende arbeidskapasitet og stil. Dekker store områder med presisjon og intensitet. Fuglearbeidet er på høyeste nivå med fast, sikker stand og fin marking. Reiser elegant på kommando. Viser utmerket samarbeid med fører gjennom hele slippet. En verdig CERT-vinner.'
  );

  console.log("✅ Initial data seeded successfully");
}

seedData();

const app = new Hono();

// --- Global error handler ---
app.onError((err, c) => {
  console.error("Server error:", err);
  return c.json({ error: err.message }, 500);
});

// --- localStorage bridge API ---
app.get("/api/storage/:key", (c) => {
  const key = c.req.param("key");
  const row = db.prepare("SELECT value FROM kv_store WHERE key = ?").get(key);
  if (!row) return c.json({ value: null });
  return c.json({ value: JSON.parse(row.value) });
});

app.put("/api/storage/:key", async (c) => {
  const key = c.req.param("key");
  const body = await c.req.json();
  const value = JSON.stringify(body.value);
  db.prepare("INSERT OR REPLACE INTO kv_store (key, value, updated_at) VALUES (?, ?, datetime('now'))").run(key, value);
  return c.json({ ok: true });
});

app.delete("/api/storage/:key", (c) => {
  const key = c.req.param("key");
  db.prepare("DELETE FROM kv_store WHERE key = ?").run(key);
  return c.json({ ok: true });
});

app.get("/api/storage", (c) => {
  const rows = db.prepare("SELECT key, updated_at FROM kv_store ORDER BY key").all();
  return c.json({ keys: rows });
});

// --- Trial config (admin) ---
app.get("/api/trial", (c) => {
  const row = db.prepare("SELECT * FROM trial_config WHERE id = 1").get();
  return c.json(row);
});

app.put("/api/trial", async (c) => {
  const body = await c.req.json();
  const fields = ["name", "location", "start_date", "end_date", "organizing_club", "club_logo", "description", "contact_email", "contact_phone", "is_published"];
  const sets = [];
  const vals = [];
  for (const f of fields) {
    if (f in body) {
      sets.push(`${f} = ?`);
      vals.push(body[f]);
    }
  }
  if (sets.length > 0) {
    sets.push("updated_at = datetime('now')");
    db.prepare(`UPDATE trial_config SET ${sets.join(", ")} WHERE id = 1`).run(...vals);
    db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").run("trial_update", JSON.stringify(body));
  }
  const row = db.prepare("SELECT * FROM trial_config WHERE id = 1").get();
  return c.json(row);
});

// --- Admin log ---
app.get("/api/admin/log", (c) => {
  const limit = Number(c.req.query("limit") || 50);
  const rows = db.prepare("SELECT * FROM admin_log ORDER BY id DESC LIMIT ?").all(limit);
  return c.json({ items: rows });
});

// --- Stats ---
app.get("/api/stats", (c) => {
  const kvCount = db.prepare("SELECT COUNT(*) as n FROM kv_store").get().n;
  const logCount = db.prepare("SELECT COUNT(*) as n FROM admin_log").get().n;
  const trial = db.prepare("SELECT name, is_published FROM trial_config WHERE id = 1").get();
  const brukerCount = db.prepare("SELECT COUNT(*) as n FROM brukere").get().n;
  const hundCount = db.prepare("SELECT COUNT(*) as n FROM hunder").get().n;
  const klubbCount = db.prepare("SELECT COUNT(*) as n FROM klubber").get().n;
  const proveCount = db.prepare("SELECT COUNT(*) as n FROM prover").get().n;
  return c.json({ kvEntries: kvCount, adminLogEntries: logCount, trial, brukere: brukerCount, hunder: hundCount, klubber: klubbCount, prover: proveCount });
});

// ============================================
// BRUKERE API
// ============================================

// Hent alle brukere
app.get("/api/brukere", (c) => {
  const rows = db.prepare("SELECT * FROM brukere ORDER BY etternavn, fornavn").all();
  return c.json(rows);
});

// Hent én bruker på telefon
app.get("/api/brukere/:telefon", (c) => {
  const telefon = c.req.param("telefon");
  const row = db.prepare("SELECT * FROM brukere WHERE telefon = ?").get(telefon);
  if (!row) return c.json({ error: "Bruker ikke funnet" }, 404);

  // Hent også klubb-info hvis bruker er admin
  const klubbAdmin = db.prepare(`
    SELECT ka.rolle as klubb_rolle, k.id as klubb_id, k.navn as klubb_navn
    FROM klubb_admins ka
    JOIN klubber k ON ka.klubb_id = k.id
    WHERE ka.telefon = ?
  `).get(telefon);

  return c.json({ ...row, klubbAdmin: klubbAdmin || null });
});

// Opprett eller oppdater bruker
app.put("/api/brukere/:telefon", async (c) => {
  const telefon = c.req.param("telefon");
  const body = await c.req.json();

  const existing = db.prepare("SELECT telefon FROM brukere WHERE telefon = ?").get(telefon);

  if (existing) {
    // Oppdater
    const fields = ["fornavn", "etternavn", "epost", "adresse", "postnummer", "sted", "rolle", "profilbilde"];
    const sets = [];
    const vals = [];
    for (const f of fields) {
      if (f in body) {
        sets.push(`${f} = ?`);
        vals.push(body[f]);
      }
    }
    if (sets.length > 0) {
      sets.push("updated_at = datetime('now')");
      db.prepare(`UPDATE brukere SET ${sets.join(", ")} WHERE telefon = ?`).run(...vals, telefon);
    }
  } else {
    // Opprett ny
    db.prepare(`
      INSERT INTO brukere (telefon, fornavn, etternavn, epost, adresse, postnummer, sted, rolle)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      telefon,
      body.fornavn || '',
      body.etternavn || '',
      body.epost || '',
      body.adresse || '',
      body.postnummer || '',
      body.sted || '',
      body.rolle || 'deltaker'
    );
  }

  const row = db.prepare("SELECT * FROM brukere WHERE telefon = ?").get(telefon);
  return c.json(row);
});

// Sjekk om bruker er dommer for en prøve
app.get("/api/brukere/:telefon/dommer-info", (c) => {
  const telefon = c.req.param("telefon");
  const proveId = c.req.query("prove_id");

  let query = `
    SELECT dt.*, p.navn as prove_navn, p.sted as prove_sted, p.start_dato, p.slutt_dato, b.fornavn, b.etternavn
    FROM dommer_tildelinger dt
    JOIN prover p ON dt.prove_id = p.id
    JOIN brukere b ON dt.dommer_telefon = b.telefon
    WHERE dt.dommer_telefon = ?
  `;
  const params = [telefon];

  if (proveId) {
    query += " AND dt.prove_id = ?";
    params.push(proveId);
  }

  const rows = db.prepare(query).all(...params);

  if (rows.length === 0) return c.json({ isDommer: false });

  return c.json({
    isDommer: true,
    tildelinger: rows.map(r => ({
      proveId: r.prove_id,
      proveNavn: r.prove_navn,
      proveSted: r.prove_sted,
      startDato: r.start_dato,
      sluttDato: r.slutt_dato,
      parti: r.parti,
      dommerRolle: r.dommer_rolle,
      navn: `${r.fornavn} ${r.etternavn}`
    }))
  });
});

// ============================================
// HUNDER API
// ============================================

// Hent alle hunder for en bruker
app.get("/api/brukere/:telefon/hunder", (c) => {
  const telefon = c.req.param("telefon");
  const hunder = db.prepare(`
    SELECT h.*, k.navn as klubb_navn
    FROM hunder h
    LEFT JOIN klubber k ON h.klubb_id = k.id
    WHERE h.eier_telefon = ?
  `).all(telefon);

  // Hent resultater for hver hund
  const getResultater = db.prepare("SELECT * FROM resultater WHERE hund_id = ? ORDER BY dato DESC");
  const result = hunder.map(h => ({
    ...h,
    results: getResultater.all(h.id)
  }));

  return c.json(result);
});

// Hent alle hunder (for søk)
app.get("/api/hunder", (c) => {
  const search = c.req.query("search");
  let query = `
    SELECT h.*, k.navn as klubb_navn, b.fornavn || ' ' || b.etternavn as eier_navn
    FROM hunder h
    LEFT JOIN klubber k ON h.klubb_id = k.id
    LEFT JOIN brukere b ON h.eier_telefon = b.telefon
  `;

  if (search) {
    query += ` WHERE h.navn LIKE ? OR h.regnr LIKE ? OR b.fornavn LIKE ? OR b.etternavn LIKE ?`;
    const searchPattern = `%${search}%`;
    const rows = db.prepare(query).all(searchPattern, searchPattern, searchPattern, searchPattern);
    return c.json(rows);
  }

  const rows = db.prepare(query + " ORDER BY h.navn").all();
  return c.json(rows);
});

// Hent én hund
app.get("/api/hunder/:id", (c) => {
  const id = c.req.param("id");
  const hund = db.prepare(`
    SELECT h.*, k.navn as klubb_navn, b.fornavn || ' ' || b.etternavn as eier_navn, b.telefon as eier_telefon
    FROM hunder h
    LEFT JOIN klubber k ON h.klubb_id = k.id
    LEFT JOIN brukere b ON h.eier_telefon = b.telefon
    WHERE h.id = ? OR h.regnr = ?
  `).get(id, id);

  if (!hund) return c.json({ error: "Hund ikke funnet" }, 404);

  const resultater = db.prepare("SELECT * FROM resultater WHERE hund_id = ? ORDER BY dato DESC").all(hund.id);

  return c.json({ ...hund, results: resultater });
});

// ============================================
// KLUBBER API
// ============================================

// Hent alle klubber
app.get("/api/klubber", (c) => {
  const rows = db.prepare("SELECT * FROM klubber ORDER BY navn").all();
  return c.json(rows);
});

// Hent én klubb
app.get("/api/klubber/:id", (c) => {
  const id = c.req.param("id");
  const row = db.prepare("SELECT * FROM klubber WHERE id = ?").get(id);
  if (!row) return c.json({ error: "Klubb ikke funnet" }, 404);

  // Hent admins for klubben
  const admins = db.prepare(`
    SELECT b.telefon, b.fornavn, b.etternavn, ka.rolle
    FROM klubb_admins ka
    JOIN brukere b ON ka.telefon = b.telefon
    WHERE ka.klubb_id = ?
  `).all(id);

  return c.json({ ...row, admins });
});

// ============================================
// PRØVER API
// ============================================

// Hent alle prøver
app.get("/api/prover", (c) => {
  const rows = db.prepare(`
    SELECT p.*, k.navn as klubb_navn,
           pl.fornavn || ' ' || pl.etternavn as proveleder_navn,
           nr.fornavn || ' ' || nr.etternavn as nkkrep_navn
    FROM prover p
    LEFT JOIN klubber k ON p.klubb_id = k.id
    LEFT JOIN brukere pl ON p.proveleder_telefon = pl.telefon
    LEFT JOIN brukere nr ON p.nkkrep_telefon = nr.telefon
    ORDER BY p.start_dato DESC
  `).all();
  return c.json(rows);
});

// Hent én prøve
app.get("/api/prover/:id", (c) => {
  const id = c.req.param("id");
  const row = db.prepare(`
    SELECT p.*, k.navn as klubb_navn,
           pl.fornavn || ' ' || pl.etternavn as proveleder_navn, pl.telefon as proveleder_telefon,
           nr.fornavn || ' ' || nr.etternavn as nkkrep_navn, nr.telefon as nkkrep_telefon
    FROM prover p
    LEFT JOIN klubber k ON p.klubb_id = k.id
    LEFT JOIN brukere pl ON p.proveleder_telefon = pl.telefon
    LEFT JOIN brukere nr ON p.nkkrep_telefon = nr.telefon
    WHERE p.id = ?
  `).get(id);

  if (!row) return c.json({ error: "Prøve ikke funnet" }, 404);

  // Hent dommere for prøven
  const dommere = db.prepare(`
    SELECT dt.parti, dt.dommer_rolle, b.telefon, b.fornavn, b.etternavn
    FROM dommer_tildelinger dt
    JOIN brukere b ON dt.dommer_telefon = b.telefon
    WHERE dt.prove_id = ?
  `).all(id);

  return c.json({
    ...row,
    klasser: JSON.parse(row.klasser || '{}'),
    partier: JSON.parse(row.partier || '{}'),
    dommere
  });
});

// Hent prøver for en bruker (der brukeren har en rolle)
app.get("/api/brukere/:telefon/prover", (c) => {
  const telefon = c.req.param("telefon");

  // Finn prøver der bruker er prøveleder, NKK-rep, eller dommer
  const prover = db.prepare(`
    SELECT DISTINCT p.*, k.navn as klubb_navn,
           CASE
             WHEN p.proveleder_telefon = ? THEN 'proveleder'
             WHEN p.nkkrep_telefon = ? THEN 'nkkrep'
             ELSE NULL
           END as admin_rolle
    FROM prover p
    LEFT JOIN klubber k ON p.klubb_id = k.id
    WHERE p.proveleder_telefon = ? OR p.nkkrep_telefon = ?
       OR p.id IN (SELECT prove_id FROM dommer_tildelinger WHERE dommer_telefon = ?)
    ORDER BY p.start_dato DESC
  `).all(telefon, telefon, telefon, telefon, telefon);

  // Hent dommer-info for hver prøve
  const getDommerInfo = db.prepare("SELECT parti, dommer_rolle FROM dommer_tildelinger WHERE prove_id = ? AND dommer_telefon = ?");

  const result = prover.map(p => {
    const dommerInfo = getDommerInfo.get(p.id, telefon);
    return {
      ...p,
      klasser: JSON.parse(p.klasser || '{}'),
      partier: JSON.parse(p.partier || '{}'),
      dommerInfo: dommerInfo || null
    };
  });

  return c.json(result);
});

// ============================================
// AVLSSTATISTIKK API (Kun Irsk Setter)
// ============================================

// Hjelpefunksjon: Beregn statistikk fra kritikker
function beregnHundestatistikk(kritikker, klasse = null) {
  let filtrert = kritikker;
  if (klasse && klasse !== 'SAMLET') {
    filtrert = kritikker.filter(k => (k.klasse || '').toUpperCase() === klasse.toUpperCase());
  }

  if (filtrert.length === 0) return null;

  const stats = {
    starter: filtrert.length,
    stand_m: 0, stand_u: 0, makker_stand: 0, tomstand: 0,
    jaktlyst_sum: 0, jaktlyst_count: 0,
    fart_sum: 0, fart_count: 0,
    bredde_sum: 0, bredde_count: 0,
    reviering_sum: 0, reviering_count: 0,
    samarbeid_sum: 0, samarbeid_count: 0,
    reis_nekter: 0, reis_svart_forsiktig: 0, reis_forsiktig: 0,
    reis_kontrollert: 0, reis_villig: 0, reis_djerv: 0,
    presis_meget_upresis: 0, presis_upresis: 0, presis_noe_upresis: 0, presis_presis: 0,
    premierte: 0
  };

  for (const k of filtrert) {
    stats.stand_m += Number(k.stand_m) || 0;
    stats.stand_u += Number(k.stand_u) || 0;
    stats.makker_stand += Number(k.makker_stand) || 0;
    stats.tomstand += Number(k.tomstand) || 0;

    if (k.jaktlyst) { stats.jaktlyst_sum += Number(k.jaktlyst); stats.jaktlyst_count++; }
    if (k.fart) { stats.fart_sum += Number(k.fart); stats.fart_count++; }
    if (k.soksbredde) { stats.bredde_sum += Number(k.soksbredde); stats.bredde_count++; }
    if (k.reviering) { stats.reviering_sum += Number(k.reviering); stats.reviering_count++; }
    if (k.samarbeid) { stats.samarbeid_sum += Number(k.samarbeid); stats.samarbeid_count++; }

    const reis = Number(k.reising) || 0;
    if (reis === 1) stats.reis_nekter++;
    else if (reis === 2) stats.reis_svart_forsiktig++;
    else if (reis === 3) stats.reis_forsiktig++;
    else if (reis === 4) stats.reis_kontrollert++;
    else if (reis === 5) stats.reis_villig++;
    else if (reis === 6) stats.reis_djerv++;

    const presisjon = Number(k.presisjon) || 0;
    if (presisjon === 1) stats.presis_meget_upresis++;
    else if (presisjon === 2) stats.presis_upresis++;
    else if (presisjon === 3) stats.presis_noe_upresis++;
    else if (presisjon === 4) stats.presis_presis++;

    if (k.premie && k.premie.trim() !== '' && !k.premie.toLowerCase().includes('ingen')) {
      stats.premierte++;
    }
  }

  const totalStand = stats.stand_m + stats.stand_u + stats.tomstand;

  return {
    klasse: klasse || 'SAMLET',
    starter: stats.starter,
    stand_m: stats.stand_m,
    stand_u: stats.stand_u,
    makker_stand: stats.makker_stand,
    tomstand: stats.tomstand,
    andel_tomstand: totalStand > 0 ? Math.round((stats.tomstand / totalStand) * 1000) / 10 : 0,
    viltfinnerevne: stats.starter > 0 ? Math.round(((stats.stand_m + stats.stand_u) / stats.starter) * 100) / 100 : 0,
    jaktlyst: stats.jaktlyst_count > 0 ? Math.round((stats.jaktlyst_sum / stats.jaktlyst_count) * 100) / 100 : 0,
    fart: stats.fart_count > 0 ? Math.round((stats.fart_sum / stats.fart_count) * 100) / 100 : 0,
    bredde: stats.bredde_count > 0 ? Math.round((stats.bredde_sum / stats.bredde_count) * 100) / 100 : 0,
    reviering: stats.reviering_count > 0 ? Math.round((stats.reviering_sum / stats.reviering_count) * 100) / 100 : 0,
    samarbeid: stats.samarbeid_count > 0 ? Math.round((stats.samarbeid_sum / stats.samarbeid_count) * 100) / 100 : 0,
    reis: {
      nekter: stats.reis_nekter, svart_forsiktig: stats.reis_svart_forsiktig,
      forsiktig: stats.reis_forsiktig, kontrollert: stats.reis_kontrollert,
      villig: stats.reis_villig, djerv: stats.reis_djerv
    },
    presisjon: {
      meget_upresis: stats.presis_meget_upresis, upresis: stats.presis_upresis,
      noe_upresis: stats.presis_noe_upresis, presis: stats.presis_presis,
      gjennomsnitt: (() => {
        const total = stats.presis_meget_upresis + stats.presis_upresis + stats.presis_noe_upresis + stats.presis_presis;
        if (total === 0) return 0;
        const sum = stats.presis_meget_upresis * 1 + stats.presis_upresis * 2 + stats.presis_noe_upresis * 3 + stats.presis_presis * 4;
        return Math.round((sum / total) * 100) / 100;
      })()
    },
    premierte: stats.premierte,
    premie_prosent: stats.starter > 0 ? Math.round((stats.premierte / stats.starter) * 1000) / 10 : 0
  };
}

// Hent avlsstatistikk for en hund
app.get("/api/hunder/:id/statistikk", (c) => {
  const id = c.req.param("id");
  const fraAar = c.req.query("fra") || null;
  const tilAar = c.req.query("til") || null;

  const hund = db.prepare("SELECT * FROM hunder WHERE id = ? OR regnr = ?").get(id, id);
  if (!hund) return c.json({ error: "Hund ikke funnet" }, 404);

  // Hent kritikker for hunden
  let kritikkQuery = `SELECT * FROM kritikker WHERE hund_id = ?`;
  const params = [hund.id];

  if (fraAar) {
    kritikkQuery += " AND strftime('%Y', dato) >= ?";
    params.push(fraAar);
  }
  if (tilAar) {
    kritikkQuery += " AND strftime('%Y', dato) <= ?";
    params.push(tilAar);
  }

  const kritikker = db.prepare(kritikkQuery).all(...params);

  const klasser = ['UK', 'AK', 'VK', 'SAMLET'];
  const statistikk = {};

  for (const klasse of klasser) {
    const stats = beregnHundestatistikk(kritikker, klasse);
    if (stats) statistikk[klasse] = stats;
  }

  return c.json({
    hund: { id: hund.id, regnr: hund.regnr, navn: hund.navn, rase: hund.rase, kjonn: hund.kjonn, fodt: hund.fodt },
    filter: { fraAar, tilAar },
    statistikk
  });
});

// Hent avkom for en hund
app.get("/api/hunder/:id/avkom", (c) => {
  const id = c.req.param("id");
  const hund = db.prepare("SELECT * FROM hunder WHERE id = ? OR regnr = ?").get(id, id);
  if (!hund) return c.json({ error: "Hund ikke funnet" }, 404);

  const avkom = db.prepare(`
    SELECT h.*, b.fornavn || ' ' || b.etternavn as eier_navn,
           CASE WHEN h.far_id = ? THEN 'far' ELSE 'mor' END as forelder_rolle
    FROM hunder h
    LEFT JOIN brukere b ON h.eier_telefon = b.telefon
    WHERE h.far_id = ? OR h.mor_id = ?
    ORDER BY h.fodt DESC
  `).all(hund.id, hund.id, hund.id);

  return c.json({ forelder: { id: hund.id, regnr: hund.regnr, navn: hund.navn }, antall_avkom: avkom.length, avkom });
});

// Hent aggregert avkomsstatistikk
app.get("/api/hunder/:id/avkom-statistikk", (c) => {
  const id = c.req.param("id");
  const hund = db.prepare("SELECT * FROM hunder WHERE id = ? OR regnr = ?").get(id, id);
  if (!hund) return c.json({ error: "Hund ikke funnet" }, 404);

  const avkom = db.prepare(`SELECT id FROM hunder WHERE far_id = ? OR mor_id = ?`).all(hund.id, hund.id);

  if (avkom.length === 0) {
    return c.json({ forelder: { id: hund.id, regnr: hund.regnr, navn: hund.navn }, antall_avkom: 0, statistikk: {} });
  }

  const avkomIds = avkom.map(a => a.id);
  const placeholders = avkomIds.map(() => '?').join(',');
  const kritikker = db.prepare(`SELECT * FROM kritikker WHERE hund_id IN (${placeholders})`).all(...avkomIds);

  const klasser = ['UK', 'AK', 'VK', 'SAMLET'];
  const statistikk = {};

  for (const klasse of klasser) {
    const stats = beregnHundestatistikk(kritikker, klasse);
    if (stats) {
      statistikk[klasse] = { viltfinnerevne: stats.viltfinnerevne, premie_prosent: stats.premie_prosent, starter: stats.starter, jaktlyst: stats.jaktlyst };
    }
  }

  return c.json({ forelder: { id: hund.id, regnr: hund.regnr, navn: hund.navn }, antall_avkom: avkom.length, statistikk });
});

// Sett foreldre for en hund
app.put("/api/hunder/:id/foreldre", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();

  const hund = db.prepare("SELECT * FROM hunder WHERE id = ? OR regnr = ?").get(id, id);
  if (!hund) return c.json({ error: "Hund ikke funnet" }, 404);

  const updates = [];
  const values = [];

  if (body.far_regnr !== undefined) {
    const far = db.prepare("SELECT id FROM hunder WHERE regnr = ?").get(body.far_regnr);
    if (far) { updates.push("far_id = ?"); values.push(far.id); }
    updates.push("far_regnr = ?");
    values.push(body.far_regnr || null);
  }

  if (body.mor_regnr !== undefined) {
    const mor = db.prepare("SELECT id FROM hunder WHERE regnr = ?").get(body.mor_regnr);
    if (mor) { updates.push("mor_id = ?"); values.push(mor.id); }
    updates.push("mor_regnr = ?");
    values.push(body.mor_regnr || null);
  }

  if (updates.length > 0) {
    values.push(hund.id);
    db.prepare(`UPDATE hunder SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  }

  const oppdatert = db.prepare("SELECT * FROM hunder WHERE id = ?").get(hund.id);
  return c.json(oppdatert);
});

// ============================================
// KRITIKKER API
// ============================================

// Hent alle kritikker for en hund
app.get("/api/hunder/:id/kritikker", (c) => {
  const id = c.req.param("id");
  const kritikker = db.prepare(`
    SELECT k.*,
           p.navn as prove_navn, p.sted as prove_sted,
           b.fornavn || ' ' || b.etternavn as dommer_navn
    FROM kritikker k
    LEFT JOIN prover p ON k.prove_id = p.id
    LEFT JOIN brukere b ON k.dommer_telefon = b.telefon
    WHERE k.hund_id = ?
    ORDER BY k.dato DESC
  `).all(id);
  return c.json(kritikker);
});

// Hent én kritikk
app.get("/api/kritikker/:id", (c) => {
  const id = c.req.param("id");
  const kritikk = db.prepare(`
    SELECT k.*,
           h.navn as hund_navn, h.regnr, h.rase,
           p.navn as prove_navn, p.sted as prove_sted,
           b.fornavn || ' ' || b.etternavn as dommer_navn
    FROM kritikker k
    LEFT JOIN hunder h ON k.hund_id = h.id
    LEFT JOIN prover p ON k.prove_id = p.id
    LEFT JOIN brukere b ON k.dommer_telefon = b.telefon
    WHERE k.id = ?
  `).get(id);
  if (!kritikk) return c.json({ error: "Kritikk ikke funnet" }, 404);
  return c.json(kritikk);
});

// Opprett eller oppdater kritikk
app.post("/api/kritikker", async (c) => {
  const body = await c.req.json();

  const result = db.prepare(`
    INSERT INTO kritikker (
      hund_id, prove_id, dommer_telefon, dato, klasse, parti, sted,
      presisjon, reising, godkjent_reising,
      stand_m, stand_u, tomstand, makker_stand, sjanse, slipptid,
      jaktlyst, fart, selvstendighet, soksbredde, reviering, samarbeid,
      sek_spontan, sek_forbi, apport, rapport_spontan,
      adferd, premie, kritikk_tekst
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    body.hund_id, body.prove_id, body.dommer_telefon, body.dato, body.klasse, body.parti, body.sted,
    body.presisjon, body.reising, body.godkjent_reising ? 1 : 0,
    body.stand_m, body.stand_u, body.tomstand, body.makker_stand, body.sjanse, body.slipptid,
    body.jaktlyst, body.fart, body.selvstendighet, body.soksbredde, body.reviering, body.samarbeid,
    body.sek_spontan, body.sek_forbi, body.apport, body.rapport_spontan ? 1 : 0,
    body.adferd, body.premie, body.kritikk_tekst
  );

  return c.json({ id: result.lastInsertRowid, ok: true });
});

// Oppdater kritikk
app.put("/api/kritikker/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();

  const fields = [
    "presisjon", "reising", "godkjent_reising",
    "stand_m", "stand_u", "tomstand", "makker_stand", "sjanse", "slipptid",
    "jaktlyst", "fart", "selvstendighet", "soksbredde", "reviering", "samarbeid",
    "sek_spontan", "sek_forbi", "apport", "rapport_spontan",
    "adferd", "premie", "kritikk_tekst"
  ];

  const sets = [];
  const vals = [];
  for (const f of fields) {
    if (f in body) {
      sets.push(`${f} = ?`);
      vals.push(body[f]);
    }
  }

  if (sets.length > 0) {
    sets.push("updated_at = datetime('now')");
    db.prepare(`UPDATE kritikker SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
  }

  const kritikk = db.prepare("SELECT * FROM kritikker WHERE id = ?").get(id);
  return c.json(kritikk);
});

// --- Backup ---
app.get("/api/backup", (c) => {
  if (!existsSync(DB_PATH)) return c.text("No database", 404);
  const data = readFileSync(DB_PATH);
  c.header("Content-Type", "application/octet-stream");
  c.header("Content-Disposition", `attachment; filename="fuglehund-${new Date().toISOString().slice(0, 10)}.db"`);
  return c.body(data);
});

// --- Helper: Convert "Etternavn, Fornavn" to "Fornavn Etternavn" ---
function formatName(name) {
  if (!name) return "";
  if (name.includes(",")) {
    const parts = name.split(",").map(p => p.trim());
    return parts.reverse().join(" ");
  }
  return name;
}

// --- Helper: Parse class with day (UK1, UK2, AK1, AK2, VK) ---
function parseClass(klasseRaw) {
  const klasse = (klasseRaw || "AK").toUpperCase().trim();
  // Match patterns like UK1, UK2, AK1, AK2, VK
  const match = klasse.match(/^(UK|AK|VK)(\d)?$/);
  if (match) {
    return {
      klasse: match[1],
      dag: match[2] ? parseInt(match[2]) : null
    };
  }
  return { klasse: "AK", dag: null };
}

// --- Parse participant list (PDF, CSV, Excel) ---
// Supports both FormData upload and JSON base64 upload
app.post("/api/parse-participants", async (c) => {
  let fileName, buffer;

  const contentType = c.req.header("content-type") || "";

  if (contentType.includes("application/json")) {
    // Base64 JSON upload (works through proxies)
    try {
      const body = await c.req.json();
      if (!body.fileName || !body.data) {
        return c.json({ error: "Mangler fileName eller data" }, 400);
      }
      fileName = body.fileName.toLowerCase();
      buffer = Buffer.from(body.data, "base64");
    } catch (jsonErr) {
      console.error("JSON parse error:", jsonErr);
      return c.json({ error: "Kunne ikke lese JSON: " + jsonErr.message }, 400);
    }
  } else {
    // FormData upload (traditional)
    let formData;
    try {
      formData = await c.req.formData();
    } catch (formErr) {
      console.error("FormData error:", formErr);
      return c.json({ error: "Kunne ikke lese skjemadata: " + formErr.message }, 400);
    }

    const file = formData.get("file");

    if (!file) {
      return c.json({ error: "Ingen fil lastet opp" }, 400);
    }

    fileName = file.name.toLowerCase();
    try {
      buffer = Buffer.from(await file.arrayBuffer());
    } catch (bufErr) {
      console.error("ArrayBuffer error:", bufErr);
      return c.json({ error: "Kunne ikke lese filinnhold: " + bufErr.message }, 400);
    }
  }

  let participants = [];

  try {
    if (fileName.endsWith(".pdf")) {
      // PDF-parsing er ustabil - anbefal CSV/Excel i stedet
      return c.json({
        error: "PDF-format støttes ikke lenger på grunn av kompatibilitetsproblemer. Vennligst eksporter deltakerlisten til CSV eller Excel (.xlsx) format i stedet.",
        hint: "I de fleste systemer kan du velge 'Eksporter' eller 'Last ned som' og velge CSV eller Excel."
      }, 400);

      // Format: Regnr, Navn, Rase, Eier (etternavn, fornavn), Fører (etternavn, fornavn), Klasse (UK1/UK2/AK1/AK2/VK), Epost
      for (const line of lines) {
        // Try to match registration number pattern (e.g., NO12345/22 or SE12345/22)
        const regMatch = line.match(/([A-Z]{2}\d+\/\d+)/);
        if (regMatch) {
          // Split line by multiple spaces or tabs
          const parts = line.split(/\s{2,}|\t/).map(p => p.trim()).filter(p => p);

          if (parts.length >= 5) {
            const klasseInfo = parseClass(parts[5]);
            const participant = {
              regnr: parts[0] || "",
              hundenavn: parts[1] || "",
              rase: parts[2] || "",
              eier: formatName(parts[3]),
              forer: formatName(parts[4] || parts[3]),
              klasseRaw: parts[5] || "AK",
              klasse: klasseInfo.klasse,
              dag: klasseInfo.dag,
              epost: parts[6] || ""
            };

            // Clean up regnr if it contains the dog name
            if (participant.regnr.includes(" ")) {
              const regParts = participant.regnr.split(" ");
              participant.regnr = regParts.find(p => p.match(/[A-Z]{2}\d+\/\d+/)) || participant.regnr;
            }

            participants.push(participant);
          }
        }
      }

      // If structured parsing failed, try line-by-line with regex
      if (participants.length === 0) {
        const regexPattern = /([A-Z]{2}\d+\/\d+)\s+(.+?)\s{2,}(.+?)\s{2,}(.+?)\s{2,}(.+?)\s{2,}(UK\d?|AK\d?|VK)\s*(.+)?/i;
        for (const line of lines) {
          const match = line.match(regexPattern);
          if (match) {
            const klasseInfo = parseClass(match[6]);
            participants.push({
              regnr: match[1],
              hundenavn: match[2].trim(),
              rase: match[3].trim(),
              eier: formatName(match[4].trim()),
              forer: formatName(match[5].trim()),
              klasseRaw: match[6].toUpperCase(),
              klasse: klasseInfo.klasse,
              dag: klasseInfo.dag,
              epost: (match[7] || "").trim()
            });
          }
        }
      }

    } else if (fileName.endsWith(".csv")) {
      // Parse CSV
      const text = buffer.toString("utf-8");
      const lines = text.split("\n").map(l => l.trim()).filter(l => l.length > 0);

      // Skip header
      const dataLines = lines.slice(1);

      for (const line of dataLines) {
        const parts = line.split(/[,;]/).map(p => p.trim().replace(/^["']|["']$/g, ""));
        if (parts.length >= 5) {
          const klasseInfo = parseClass(parts[5]);
          participants.push({
            regnr: parts[0] || "",
            hundenavn: parts[1] || "",
            rase: parts[2] || "",
            eier: formatName(parts[3]),
            forer: formatName(parts[4] || parts[3]),
            klasseRaw: parts[5] || "AK",
            klasse: klasseInfo.klasse,
            dag: klasseInfo.dag,
            epost: parts[6] || ""
          });
        }
      }

    } else if (fileName.endsWith(".xlsx") || fileName.endsWith(".xls")) {
      // Parse Excel
      const workbook = XLSX.read(buffer, { type: "buffer" });
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });

      // Skip header row
      const dataRows = data.slice(1);

      for (const row of dataRows) {
        if (row.length >= 5 && row[0]) {
          const klasseInfo = parseClass(String(row[5] || "AK"));
          participants.push({
            regnr: String(row[0] || ""),
            hundenavn: String(row[1] || ""),
            rase: String(row[2] || ""),
            eier: formatName(String(row[3] || "")),
            forer: formatName(String(row[4] || row[3] || "")),
            klasseRaw: String(row[5] || "AK").toUpperCase(),
            klasse: klasseInfo.klasse,
            dag: klasseInfo.dag,
            epost: String(row[6] || "")
          });
        }
      }
    } else if (fileName.endsWith(".txt")) {
      // Parse plain text file (same format as CSV but tab/space separated)
      const text = buffer.toString("utf-8");
      const lines = text.split("\n").map(l => l.trim()).filter(l => l.length > 0);

      for (const line of lines) {
        // Skip header-like lines
        if (line.toLowerCase().includes("regnr") || line.toLowerCase().includes("hundenavn")) continue;

        // Try to match registration number pattern
        const regMatch = line.match(/([A-Z]{2}\d+\/\d+)/);
        if (regMatch) {
          const parts = line.split(/\t|\s{2,}/).map(p => p.trim()).filter(p => p);
          if (parts.length >= 5) {
            const klasseInfo = parseClass(parts[5] || "AK");
            participants.push({
              regnr: parts[0] || "",
              hundenavn: parts[1] || "",
              rase: parts[2] || "",
              eier: formatName(parts[3] || ""),
              forer: formatName(parts[4] || parts[3] || ""),
              klasseRaw: (parts[5] || "AK").toUpperCase(),
              klasse: klasseInfo.klasse,
              dag: klasseInfo.dag,
              epost: parts[6] || ""
            });
          }
        }
      }
    } else {
      return c.json({ error: "Ugyldig filformat. Bruk PDF, CSV, TXT eller Excel (.xlsx)" }, 400);
    }

    // Filter out empty entries
    participants = participants.filter(p => p.regnr && p.hundenavn);

    // Categorize by class and day
    const byClass = {
      UK1: participants.filter(p => p.klasse === "UK" && p.dag === 1),
      UK2: participants.filter(p => p.klasse === "UK" && p.dag === 2),
      UK: participants.filter(p => p.klasse === "UK" && !p.dag),
      AK1: participants.filter(p => p.klasse === "AK" && p.dag === 1),
      AK2: participants.filter(p => p.klasse === "AK" && p.dag === 2),
      AK: participants.filter(p => p.klasse === "AK" && !p.dag),
      VK: participants.filter(p => p.klasse === "VK")
    };

    return c.json({
      success: true,
      total: participants.length,
      byClass: {
        UK1: byClass.UK1.length,
        UK2: byClass.UK2.length,
        UK: byClass.UK.length + byClass.UK1.length + byClass.UK2.length,
        AK1: byClass.AK1.length,
        AK2: byClass.AK2.length,
        AK: byClass.AK.length + byClass.AK1.length + byClass.AK2.length,
        VK: byClass.VK.length
      },
      byDay: {
        dag1: byClass.UK1.length + byClass.AK1.length,
        dag2: byClass.UK2.length + byClass.AK2.length
      },
      participants
    });

  } catch (err) {
    console.error("Parse error:", err);
    return c.json({ error: "Kunne ikke lese filen: " + err.message }, 500);
  }
});

// --- Serve shim ---
app.get("/storage-shim.js", (c) => {
  c.header("Content-Type", "application/javascript");
  return c.body(readFileSync(join(__dirname, "storage-shim.js"), "utf-8"));
});

// --- Admin panel ---
app.get("/admin-panel.html", (c) => {
  c.header("Content-Type", "text/html; charset=utf-8");
  return c.body(readFileSync(join(__dirname, "admin-panel.html"), "utf-8"));
});

// --- Inject shim into HTML pages ---
function serveWithShim(filePath, c) {
  if (!existsSync(filePath)) return c.text("Not found", 404);
  let html = readFileSync(filePath, "utf-8");
  const shimTag = `<script src="/storage-shim.js"></script>`;
  if (html.includes("<head>")) {
    html = html.replace("<head>", `<head>\n${shimTag}`);
  } else {
    html = shimTag + "\n" + html;
  }
  c.header("Content-Type", "text/html; charset=utf-8");
  return c.body(html);
}

app.get("/", (c) => serveWithShim(join(__dirname, "index.html"), c));

app.get("/:page{.+\\.html}", (c) => {
  const page = c.req.param("page");
  return serveWithShim(join(__dirname, page), c);
});

// Serve .vibe-images directory explicitly (hidden folders aren't served by default)
app.get("/.vibe-images/:filename", (c) => {
  const filename = c.req.param("filename");
  const filePath = join(__dirname, ".vibe-images", filename);
  if (!existsSync(filePath)) return c.text("Not found", 404);
  const data = readFileSync(filePath);
  // Determine content type from extension
  const ext = filename.split('.').pop()?.toLowerCase();
  const mimeTypes = {
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif',
    'webp': 'image/webp',
    'svg': 'image/svg+xml'
  };
  c.header("Content-Type", mimeTypes[ext] || "application/octet-stream");
  return c.body(data);
});

// Static files
app.use("/*", serveStatic({ root: __dirname }));

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`🐕 Fuglehundprøve running on http://localhost:${PORT}`);
  console.log(`   Admin: http://localhost:${PORT}/admin-panel.html`);
  console.log(`   Backup: http://localhost:${PORT}/api/backup`);
});
