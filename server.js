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
    UNIQUE(prove_id, parti, dommer_telefon)
  );

  -- Klubb-administratorer
  CREATE TABLE IF NOT EXISTS klubb_admins (
    telefon TEXT REFERENCES brukere(telefon),
    klubb_id TEXT REFERENCES klubber(id),
    rolle TEXT DEFAULT 'admin',
    PRIMARY KEY (telefon, klubb_id)
  );

  -- Kritikker-tabell (persisterer dommerkritikker)
  CREATE TABLE IF NOT EXISTS kritikker (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prove_id TEXT REFERENCES prover(id),
    parti TEXT NOT NULL,
    hund_regnr TEXT NOT NULL,
    hund_navn TEXT,
    hund_rase TEXT,
    eier TEXT,
    forer TEXT,
    klasse TEXT DEFAULT 'AK',
    dommer_telefon TEXT REFERENCES brukere(telefon),
    dommer_rolle INTEGER,
    -- Scores (JSON for fleksibilitet)
    scores TEXT DEFAULT '{}',
    -- Resultat
    premie TEXT,
    cacit TEXT,
    -- Kritikktekst
    tekst TEXT,
    feltnotater TEXT,
    -- Status: draft, submitted, approved, returned
    status TEXT DEFAULT 'draft',
    -- Timestamps
    submitted_at TEXT,
    submitted_by TEXT,
    approved_at TEXT,
    approved_by TEXT,
    nkk_comment TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(prove_id, parti, hund_regnr, dommer_telefon)
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
  const regnr = c.req.query("regnr");

  let query = `
    SELECT h.*, k.navn as klubb_navn, b.fornavn || ' ' || b.etternavn as eier_navn
    FROM hunder h
    LEFT JOIN klubber k ON h.klubb_id = k.id
    LEFT JOIN brukere b ON h.eier_telefon = b.telefon
  `;

  // Eksakt oppslag på regnr
  if (regnr) {
    query += ` WHERE h.regnr = ?`;
    const rows = db.prepare(query).all(regnr);
    return c.json(rows);
  }

  // Søk
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

// --- Dommer-tildelinger API ---

// Hent alle dommere med rolle "dommer" (for dropdown)
app.get("/api/dommere", (c) => {
  const dommere = db.prepare(`
    SELECT telefon, fornavn, etternavn, epost
    FROM brukere
    WHERE rolle LIKE '%dommer%'
    ORDER BY etternavn, fornavn
  `).all();
  return c.json(dommere);
});

// Hent dommertildelinger for en prøve
app.get("/api/prover/:id/dommer-tildelinger", (c) => {
  const proveId = c.req.param("id");
  const tildelinger = db.prepare(`
    SELECT dt.id, dt.parti, dt.dommer_rolle, dt.dommer_telefon,
           b.fornavn, b.etternavn, b.telefon
    FROM dommer_tildelinger dt
    JOIN brukere b ON dt.dommer_telefon = b.telefon
    WHERE dt.prove_id = ?
    ORDER BY dt.parti, dt.dommer_rolle
  `).all(proveId);
  return c.json(tildelinger);
});

// Legg til/oppdater dommertildeling
app.post("/api/prover/:id/dommer-tildelinger", async (c) => {
  const proveId = c.req.param("id");
  const body = await c.req.json();
  const { parti, dommer_telefon, dommer_rolle } = body;

  if (!parti || !dommer_telefon) {
    return c.json({ error: "Parti og dommer_telefon er påkrevd" }, 400);
  }

  // Sjekk om prøven finnes
  const prove = db.prepare("SELECT id FROM prover WHERE id = ?").get(proveId);
  if (!prove) {
    return c.json({ error: "Prøve ikke funnet" }, 404);
  }

  // Sjekk validering: UK/AK kan ha 1-2 dommere, VK må ha nøyaktig 2
  const partiType = parti.toLowerCase().startsWith('vk') ? 'VK' : 'UKAK';
  const eksisterende = db.prepare(`
    SELECT COUNT(*) as antall FROM dommer_tildelinger
    WHERE prove_id = ? AND parti = ? AND dommer_telefon != ?
  `).get(proveId, parti, dommer_telefon);

  if (partiType === 'VK' && eksisterende.antall >= 2) {
    return c.json({ error: "VK-partier kan maksimalt ha 2 dommere" }, 400);
  }
  if (partiType === 'UKAK' && eksisterende.antall >= 2) {
    return c.json({ error: "UK/AK-partier kan maksimalt ha 2 dommere" }, 400);
  }

  // Insert eller erstatt
  try {
    db.prepare(`
      INSERT INTO dommer_tildelinger (prove_id, dommer_telefon, parti, dommer_rolle)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(prove_id, parti, dommer_telefon) DO UPDATE SET
        dommer_rolle = excluded.dommer_rolle
    `).run(proveId, dommer_telefon, parti, dommer_rolle || null);

    // Logg endringen
    db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").run(
      "dommer_tildelt",
      `Dommer ${dommer_telefon} tildelt ${parti} på prøve ${proveId}`
    );

    return c.json({ success: true });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// Fjern dommertildeling
app.delete("/api/prover/:id/dommer-tildelinger/:tildelingId", (c) => {
  const proveId = c.req.param("id");
  const tildelingId = c.req.param("tildelingId");

  const result = db.prepare(`
    DELETE FROM dommer_tildelinger
    WHERE id = ? AND prove_id = ?
  `).run(tildelingId, proveId);

  if (result.changes === 0) {
    return c.json({ error: "Tildeling ikke funnet" }, 404);
  }

  db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").run(
    "dommer_fjernet",
    `Tildeling ${tildelingId} fjernet fra prøve ${proveId}`
  );

  return c.json({ success: true });
});

// Masseoppdatering av dommertildelinger for et parti
app.put("/api/prover/:id/dommer-tildelinger/parti/:parti", async (c) => {
  const proveId = c.req.param("id");
  const parti = c.req.param("parti");
  const body = await c.req.json();
  const { dommere } = body; // Array av { telefon, rolle }

  if (!Array.isArray(dommere)) {
    return c.json({ error: "dommere må være en array" }, 400);
  }

  // Validering
  const partiType = parti.toLowerCase().startsWith('vk') ? 'VK' : 'UKAK';
  if (partiType === 'VK' && dommere.length !== 2) {
    return c.json({ error: "VK-partier må ha nøyaktig 2 dommere" }, 400);
  }
  if (partiType === 'UKAK' && (dommere.length < 1 || dommere.length > 2)) {
    return c.json({ error: "UK/AK-partier må ha 1-2 dommere" }, 400);
  }

  try {
    // Slett eksisterende for dette partiet
    db.prepare("DELETE FROM dommer_tildelinger WHERE prove_id = ? AND parti = ?").run(proveId, parti);

    // Sett inn nye
    const insert = db.prepare(`
      INSERT INTO dommer_tildelinger (prove_id, dommer_telefon, parti, dommer_rolle)
      VALUES (?, ?, ?, ?)
    `);

    for (const d of dommere) {
      insert.run(proveId, d.telefon, parti, d.rolle || null);
    }

    db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").run(
      "dommer_parti_oppdatert",
      `${parti}: ${dommere.map(d => d.telefon).join(', ')}`
    );

    return c.json({ success: true });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// --- Kritikker API ---

// Hent alle kritikker for en prøve/parti
app.get("/api/prover/:proveId/kritikker", (c) => {
  const proveId = c.req.param("proveId");
  const parti = c.req.query("parti");
  const status = c.req.query("status"); // draft, submitted, approved, returned

  let query = `
    SELECT k.*, b.fornavn || ' ' || b.etternavn as dommer_navn
    FROM kritikker k
    LEFT JOIN brukere b ON k.dommer_telefon = b.telefon
    WHERE k.prove_id = ?
  `;
  const params = [proveId];

  if (parti) {
    query += " AND k.parti = ?";
    params.push(parti);
  }
  if (status) {
    query += " AND k.status = ?";
    params.push(status);
  }

  query += " ORDER BY k.parti, k.hund_regnr";

  const rows = db.prepare(query).all(...params);
  return c.json(rows.map(r => ({
    ...r,
    scores: JSON.parse(r.scores || '{}')
  })));
});

// Hent kritikker for NKK-rep (alle submitted)
app.get("/api/kritikker/pending", (c) => {
  const rows = db.prepare(`
    SELECT k.*, b.fornavn || ' ' || b.etternavn as dommer_navn,
           p.navn as prove_navn, p.sted as prove_sted
    FROM kritikker k
    LEFT JOIN brukere b ON k.dommer_telefon = b.telefon
    LEFT JOIN prover p ON k.prove_id = p.id
    WHERE k.status = 'submitted'
    ORDER BY k.submitted_at DESC
  `).all();

  return c.json(rows.map(r => ({
    ...r,
    scores: JSON.parse(r.scores || '{}')
  })));
});

// Lagre/oppdater kritikk (brukes av dommer)
app.post("/api/prover/:proveId/kritikker", async (c) => {
  const proveId = c.req.param("proveId");
  const body = await c.req.json();

  const {
    parti, hund_regnr, hund_navn, hund_rase, eier, forer, klasse,
    dommer_telefon, dommer_rolle, scores, premie, cacit, tekst, feltnotater, status
  } = body;

  if (!parti || !hund_regnr || !dommer_telefon) {
    return c.json({ error: "parti, hund_regnr og dommer_telefon er påkrevd" }, 400);
  }

  try {
    const result = db.prepare(`
      INSERT INTO kritikker (
        prove_id, parti, hund_regnr, hund_navn, hund_rase, eier, forer, klasse,
        dommer_telefon, dommer_rolle, scores, premie, cacit, tekst, feltnotater, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(prove_id, parti, hund_regnr, dommer_telefon) DO UPDATE SET
        hund_navn = excluded.hund_navn,
        hund_rase = excluded.hund_rase,
        eier = excluded.eier,
        forer = excluded.forer,
        klasse = excluded.klasse,
        scores = excluded.scores,
        premie = excluded.premie,
        cacit = excluded.cacit,
        tekst = excluded.tekst,
        feltnotater = excluded.feltnotater,
        status = excluded.status,
        updated_at = datetime('now')
    `).run(
      proveId, parti, hund_regnr, hund_navn || '', hund_rase || '', eier || '', forer || '', klasse || 'AK',
      dommer_telefon, dommer_rolle || null, JSON.stringify(scores || {}), premie || '', cacit || '', tekst || '', feltnotater || '', status || 'draft'
    );

    return c.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// Send kritikk til NKK-rep
app.put("/api/kritikker/:id/submit", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  const { submitted_by } = body;

  const result = db.prepare(`
    UPDATE kritikker
    SET status = 'submitted',
        submitted_at = datetime('now'),
        submitted_by = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(submitted_by || 'Dommer', id);

  if (result.changes === 0) {
    return c.json({ error: "Kritikk ikke funnet" }, 404);
  }

  db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").run(
    "kritikk_submitted",
    `Kritikk ${id} sendt til NKK-rep av ${submitted_by}`
  );

  return c.json({ success: true });
});

// NKK-rep godkjenner kritikk
app.put("/api/kritikker/:id/godkjenn", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  const { approved_by } = body;

  const result = db.prepare(`
    UPDATE kritikker
    SET status = 'approved',
        approved_at = datetime('now'),
        approved_by = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(approved_by || 'NKK-rep', id);

  if (result.changes === 0) {
    return c.json({ error: "Kritikk ikke funnet" }, 404);
  }

  db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").run(
    "kritikk_godkjent",
    `Kritikk ${id} godkjent av ${approved_by}`
  );

  return c.json({ success: true });
});

// NKK-rep returnerer kritikk til dommer
app.put("/api/kritikker/:id/returner", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  const { nkk_comment, returned_by } = body;

  const result = db.prepare(`
    UPDATE kritikker
    SET status = 'returned',
        nkk_comment = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(nkk_comment || '', id);

  if (result.changes === 0) {
    return c.json({ error: "Kritikk ikke funnet" }, 404);
  }

  db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").run(
    "kritikk_returnert",
    `Kritikk ${id} returnert av ${returned_by}: ${nkk_comment}`
  );

  return c.json({ success: true });
});

// Hent godkjente kritikker for en hund (brukes av hund.html)
app.get("/api/hunder/:regnr/kritikker", (c) => {
  const regnr = c.req.param("regnr");

  const rows = db.prepare(`
    SELECT k.*, b.fornavn || ' ' || b.etternavn as dommer_navn,
           p.navn as prove_navn, p.sted as prove_sted, p.start_dato
    FROM kritikker k
    LEFT JOIN brukere b ON k.dommer_telefon = b.telefon
    LEFT JOIN prover p ON k.prove_id = p.id
    WHERE k.hund_regnr = ? AND k.status = 'approved'
    ORDER BY k.approved_at DESC
  `).all(regnr);

  return c.json(rows.map(r => ({
    ...r,
    scores: JSON.parse(r.scores || '{}')
  })));
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

// Static files
app.use("/*", serveStatic({ root: __dirname }));

serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, () => {
  console.log(`🐕 Fuglehundprøve running on http://localhost:${PORT}`);
  console.log(`   Admin: http://localhost:${PORT}/admin-panel.html`);
  console.log(`   Backup: http://localhost:${PORT}/api/backup`);
});
