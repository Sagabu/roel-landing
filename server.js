import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import Database from "better-sqlite3";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { randomBytes } from "crypto";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");
const XLSX = require("xlsx");

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, "fuglehund.db");
const PORT = Number(process.env.PORT || 8889);

// --- Twilio config (from environment) ---
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_FROM = process.env.TWILIO_FROM_NUMBER || "";
let twilioClient = null;
if (TWILIO_SID && TWILIO_TOKEN) {
  const Twilio = require("twilio");
  twilioClient = Twilio(TWILIO_SID, TWILIO_TOKEN);
  console.log("📱 Twilio SMS configured");
} else {
  console.log("⚠️  Twilio not configured — SMS codes will be logged to console (dev mode)");
}

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
    name TEXT NOT NULL DEFAULT '',
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
    samtykke_gitt TEXT DEFAULT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  -- OTP codes for SMS login
  CREATE TABLE IF NOT EXISTS otp_codes (
    telefon TEXT NOT NULL,
    code TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    used INTEGER DEFAULT 0
  );

  -- Auth sessions
  CREATE TABLE IF NOT EXISTS auth_sessions (
    token TEXT PRIMARY KEY,
    telefon TEXT NOT NULL REFERENCES brukere(telefon),
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
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

// ============================================
// AUTH: OTP + Sessions
// ============================================

function generateOTP() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

function generateToken() {
  return randomBytes(32).toString("hex");
}

// Clean expired OTPs and sessions periodically
function cleanExpired() {
  db.prepare("DELETE FROM otp_codes WHERE expires_at < datetime('now')").run();
  db.prepare("DELETE FROM auth_sessions WHERE expires_at < datetime('now')").run();
}
setInterval(cleanExpired, 60 * 60 * 1000); // hourly

// Get authenticated user from request (returns null if not authenticated)
function getAuthUser(c) {
  const authHeader = c.req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  const session = db.prepare(
    "SELECT telefon FROM auth_sessions WHERE token = ? AND expires_at > datetime('now')"
  ).get(token);
  return session ? session.telefon : null;
}

// Middleware: require auth — returns 401 if not authenticated
function requireAuth(c) {
  const telefon = getAuthUser(c);
  if (!telefon) return c.json({ error: "Ikke autentisert. Logg inn først." }, 401);
  return telefon;
}

// Rate limiting for OTP (in-memory, simple)
const otpAttempts = new Map();
function checkOTPRate(telefon) {
  const now = Date.now();
  const attempts = otpAttempts.get(telefon) || [];
  const recent = attempts.filter(t => now - t < 10 * 60 * 1000); // last 10 min
  if (recent.length >= 5) return false; // max 5 per 10 min
  recent.push(now);
  otpAttempts.set(telefon, recent);
  return true;
}

// POST /api/auth/send-code — send OTP via SMS
app.post("/api/auth/send-code", async (c) => {
  const body = await c.req.json();
  const telefon = (body.telefon || "").replace(/\s/g, "");

  if (!/^\d{8}$/.test(telefon)) {
    return c.json({ error: "Ugyldig telefonnummer (8 siffer)" }, 400);
  }

  // Check user exists
  const user = db.prepare("SELECT telefon FROM brukere WHERE telefon = ?").get(telefon);
  if (!user) {
    return c.json({ error: "Telefonnummeret er ikke registrert" }, 404);
  }

  // Rate limit
  if (!checkOTPRate(telefon)) {
    return c.json({ error: "For mange forsøk. Vent litt." }, 429);
  }

  // Invalidate old codes for this number
  db.prepare("UPDATE otp_codes SET used = 1 WHERE telefon = ? AND used = 0").run(telefon);

  const code = generateOTP();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString(); // 5 min
  db.prepare("INSERT INTO otp_codes (telefon, code, expires_at) VALUES (?, ?, ?)").run(telefon, code, expiresAt);

  if (twilioClient) {
    try {
      await twilioClient.messages.create({
        body: `Din innloggingskode for Fuglehundprøve: ${code}`,
        from: TWILIO_FROM,
        to: `+47${telefon}`
      });
    } catch (err) {
      console.error("Twilio SMS error:", err.message);
      return c.json({ error: "Kunne ikke sende SMS. Prøv igjen." }, 500);
    }
  } else {
    // Dev mode: log code to console
    console.log(`📱 OTP for ${telefon}: ${code}`);
  }

  return c.json({ ok: true, message: "Kode sendt på SMS" });
});

// POST /api/auth/verify-code — verify OTP, create session
app.post("/api/auth/verify-code", async (c) => {
  const body = await c.req.json();
  const telefon = (body.telefon || "").replace(/\s/g, "");
  const code = (body.code || "").trim();

  if (!telefon || !code) {
    return c.json({ error: "Telefon og kode er påkrevd" }, 400);
  }

  const otp = db.prepare(
    "SELECT rowid, * FROM otp_codes WHERE telefon = ? AND code = ? AND used = 0 AND expires_at > datetime('now') ORDER BY created_at DESC LIMIT 1"
  ).get(telefon, code);

  if (!otp) {
    return c.json({ error: "Ugyldig eller utløpt kode" }, 401);
  }

  // Mark OTP as used
  db.prepare("UPDATE otp_codes SET used = 1 WHERE rowid = ?").run(otp.rowid);

  // Create session (30 days)
  const token = generateToken();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare("INSERT INTO auth_sessions (token, telefon, expires_at) VALUES (?, ?, ?)").run(token, telefon, expiresAt);

  // Get user info
  const user = db.prepare("SELECT * FROM brukere WHERE telefon = ?").get(telefon);

  return c.json({
    ok: true,
    token,
    user: {
      telefon: user.telefon,
      fornavn: user.fornavn,
      etternavn: user.etternavn,
      rolle: user.rolle,
      samtykke_gitt: user.samtykke_gitt
    }
  });
});

// POST /api/auth/logout — destroy session
app.post("/api/auth/logout", (c) => {
  const authHeader = c.req.header("Authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    db.prepare("DELETE FROM auth_sessions WHERE token = ?").run(authHeader.slice(7));
  }
  return c.json({ ok: true });
});

// GET /api/auth/me — check current session
app.get("/api/auth/me", (c) => {
  const telefon = getAuthUser(c);
  if (!telefon) return c.json({ authenticated: false });
  const user = db.prepare("SELECT telefon, fornavn, etternavn, rolle, samtykke_gitt FROM brukere WHERE telefon = ?").get(telefon);
  return c.json({ authenticated: true, user });
});

// ============================================
// CONSENT
// ============================================

// POST /api/auth/consent — record user consent
app.post("/api/auth/consent", async (c) => {
  const telefon = requireAuth(c);
  if (typeof telefon !== "string") return telefon; // 401 response
  db.prepare("UPDATE brukere SET samtykke_gitt = datetime('now') WHERE telefon = ?").run(telefon);
  return c.json({ ok: true, samtykke_gitt: new Date().toISOString() });
});

// ============================================
// USER DATA EXPORT (GDPR Art. 15/20)
// ============================================

app.get("/api/brukere/:telefon/export", (c) => {
  const authed = requireAuth(c);
  if (typeof authed !== "string") return authed;
  const telefon = c.req.param("telefon");
  // Users can only export their own data (admins could be extended later)
  if (authed !== telefon) return c.json({ error: "Ingen tilgang" }, 403);

  const bruker = db.prepare("SELECT * FROM brukere WHERE telefon = ?").get(telefon);
  if (!bruker) return c.json({ error: "Bruker ikke funnet" }, 404);

  const hunder = db.prepare("SELECT * FROM hunder WHERE eier_telefon = ?").all(telefon);
  const hundIds = hunder.map(h => h.id);
  const resultater = hundIds.length > 0
    ? db.prepare(`SELECT * FROM resultater WHERE hund_id IN (${hundIds.map(() => '?').join(',')})`)
        .all(...hundIds)
    : [];
  const klubbRoller = db.prepare("SELECT * FROM klubb_admins WHERE telefon = ?").all(telefon);
  const dommerTildelinger = db.prepare("SELECT * FROM dommer_tildelinger WHERE dommer_telefon = ?").all(telefon);

  return c.json({
    eksportert: new Date().toISOString(),
    beskrivelse: "Alle personopplysninger lagret om deg i Fuglehundprøve-systemet",
    bruker,
    hunder,
    resultater,
    klubb_roller: klubbRoller,
    dommer_tildelinger: dommerTildelinger
  });
});

// ============================================
// USER DELETION (GDPR Art. 17)
// ============================================

app.delete("/api/brukere/:telefon", (c) => {
  const authed = requireAuth(c);
  if (typeof authed !== "string") return authed;
  const telefon = c.req.param("telefon");
  if (authed !== telefon) return c.json({ error: "Ingen tilgang" }, 403);

  const bruker = db.prepare("SELECT telefon FROM brukere WHERE telefon = ?").get(telefon);
  if (!bruker) return c.json({ error: "Bruker ikke funnet" }, 404);

  // Cascade delete
  const hundIds = db.prepare("SELECT id FROM hunder WHERE eier_telefon = ?").all(telefon).map(h => h.id);
  if (hundIds.length > 0) {
    db.prepare(`DELETE FROM resultater WHERE hund_id IN (${hundIds.map(() => '?').join(',')})`).run(...hundIds);
  }
  db.prepare("DELETE FROM hunder WHERE eier_telefon = ?").run(telefon);
  db.prepare("DELETE FROM dommer_tildelinger WHERE dommer_telefon = ?").run(telefon);
  db.prepare("DELETE FROM klubb_admins WHERE telefon = ?").run(telefon);
  db.prepare("DELETE FROM auth_sessions WHERE telefon = ?").run(telefon);
  db.prepare("DELETE FROM otp_codes WHERE telefon = ?").run(telefon);
  db.prepare("DELETE FROM brukere WHERE telefon = ?").run(telefon);

  db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").run(
    "bruker_slettet", `Bruker ${telefon} slettet sine data (GDPR Art. 17)`
  );

  return c.json({ ok: true, message: "Alle dine data er slettet" });
});

// --- localStorage bridge API (auth required) ---
app.get("/api/storage/:key", (c) => {
  const authed = requireAuth(c);
  if (typeof authed !== "string") return authed;
  const key = c.req.param("key");
  const row = db.prepare("SELECT value FROM kv_store WHERE key = ?").get(key);
  if (!row) return c.json({ value: null });
  return c.json({ value: JSON.parse(row.value) });
});

app.put("/api/storage/:key", async (c) => {
  const authed = requireAuth(c);
  if (typeof authed !== "string") return authed;
  const key = c.req.param("key");
  const body = await c.req.json();
  const value = JSON.stringify(body.value);
  db.prepare("INSERT OR REPLACE INTO kv_store (key, value, updated_at) VALUES (?, ?, datetime('now'))").run(key, value);
  return c.json({ ok: true });
});

app.delete("/api/storage/:key", (c) => {
  const authed = requireAuth(c);
  if (typeof authed !== "string") return authed;
  const key = c.req.param("key");
  db.prepare("DELETE FROM kv_store WHERE key = ?").run(key);
  return c.json({ ok: true });
});

app.get("/api/storage", (c) => {
  const authed = requireAuth(c);
  if (typeof authed !== "string") return authed;
  const rows = db.prepare("SELECT key, updated_at FROM kv_store ORDER BY key").all();
  return c.json({ keys: rows });
});

// --- Trial config (admin) ---
app.get("/api/trial", (c) => {
  const row = db.prepare("SELECT * FROM trial_config WHERE id = 1").get();
  return c.json(row);
});

app.put("/api/trial", async (c) => {
  const authed = requireAuth(c);
  if (typeof authed !== "string") return authed;
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

// Hent alle brukere (requires auth — admin only in future, for now any logged-in user)
app.get("/api/brukere", (c) => {
  const authed = requireAuth(c);
  if (typeof authed !== "string") return authed;
  const rows = db.prepare("SELECT telefon, fornavn, etternavn, rolle FROM brukere ORDER BY etternavn, fornavn").all();
  return c.json(rows);
});

// Hent én bruker på telefon (auth required)
app.get("/api/brukere/:telefon", (c) => {
  const authed = requireAuth(c);
  if (typeof authed !== "string") return authed;
  const telefon = c.req.param("telefon");
  const row = db.prepare("SELECT * FROM brukere WHERE telefon = ?").get(telefon);
  if (!row) return c.json({ error: "Bruker ikke funnet" }, 404);

  // Non-self access: return limited info
  if (authed !== telefon) {
    return c.json({ telefon: row.telefon, fornavn: row.fornavn, etternavn: row.etternavn, rolle: row.rolle });
  }

  // Self access: full info
  const klubbAdmin = db.prepare(`
    SELECT ka.rolle as klubb_rolle, k.id as klubb_id, k.navn as klubb_navn
    FROM klubb_admins ka
    JOIN klubber k ON ka.klubb_id = k.id
    WHERE ka.telefon = ?
  `).get(telefon);

  return c.json({ ...row, klubbAdmin: klubbAdmin || null });
});

// Opprett eller oppdater bruker (auth required, self only)
app.put("/api/brukere/:telefon", async (c) => {
  const authed = requireAuth(c);
  if (typeof authed !== "string") return authed;
  const telefon = c.req.param("telefon");
  if (authed !== telefon) return c.json({ error: "Ingen tilgang" }, 403);
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

// Sjekk om bruker er dommer for en prøve (auth required)
app.get("/api/brukere/:telefon/dommer-info", (c) => {
  const authed = requireAuth(c);
  if (typeof authed !== "string") return authed;
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

// Hent alle hunder for en bruker (auth required)
app.get("/api/brukere/:telefon/hunder", (c) => {
  const authed = requireAuth(c);
  if (typeof authed !== "string") return authed;
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

// Legg til/oppdater dommertildeling (auth required)
app.post("/api/prover/:id/dommer-tildelinger", async (c) => {
  const authed = requireAuth(c);
  if (typeof authed !== "string") return authed;
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

// Fjern dommertildeling (auth required)
app.delete("/api/prover/:id/dommer-tildelinger/:tildelingId", (c) => {
  const authed = requireAuth(c);
  if (typeof authed !== "string") return authed;
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

// Masseoppdatering av dommertildelinger for et parti (auth required)
app.put("/api/prover/:id/dommer-tildelinger/parti/:parti", async (c) => {
  const authed = requireAuth(c);
  if (typeof authed !== "string") return authed;
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

// --- Backup (auth required) ---
app.get("/api/backup", (c) => {
  const authed = requireAuth(c);
  if (typeof authed !== "string") return authed;
  // Only allow users with admin/proveleder/klubbleder role
  const user = db.prepare("SELECT rolle FROM brukere WHERE telefon = ?").get(authed);
  if (!user || !/(admin|proveleder|klubbleder)/.test(user.rolle)) {
    return c.json({ error: "Kun administratorer kan laste ned backup" }, 403);
  }
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

// --- Privacy policy ---
app.get("/personvern", (c) => {
  c.header("Content-Type", "text/html; charset=utf-8");
  return c.body(`<!DOCTYPE html>
<html lang="no">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Personvern - Fuglehundprøve</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-50 text-gray-800">
  <div class="max-w-3xl mx-auto px-6 py-12">
    <a href="/" class="text-blue-600 hover:underline text-sm">&larr; Tilbake</a>
    <h1 class="text-3xl font-bold mt-4 mb-8">Personvernerklæring</h1>

    <section class="mb-8">
      <h2 class="text-xl font-semibold mb-3">Hva vi lagrer</h2>
      <p class="mb-2">For at systemet skal fungere lagrer vi:</p>
      <ul class="list-disc pl-6 space-y-1">
        <li><strong>Kontaktinfo:</strong> Navn, telefonnummer, e-post, adresse</li>
        <li><strong>Medlemskap:</strong> Klubbtilhørighet og rolle (deltaker, dommer, etc.)</li>
        <li><strong>Hunder:</strong> Registreringsnummer, navn, rase, eierskap</li>
        <li><strong>Prøveresultater:</strong> Klasse, premie, dommer, dato</li>
        <li><strong>Kritikker:</strong> Dommerens vurdering av hunden under prøven</li>
      </ul>
    </section>

    <section class="mb-8">
      <h2 class="text-xl font-semibold mb-3">Hvorfor</h2>
      <p>Dataen brukes utelukkende til å administrere jaktprøver: påmelding, partilister, dommertildeling og kritikkskjemaer. Ingen data deles med tredjeparter eller brukes til markedsføring.</p>
    </section>

    <section class="mb-8">
      <h2 class="text-xl font-semibold mb-3">Hvor</h2>
      <p>All data lagres lokalt i en SQLite-database. Ingen skylagring. SMS-koder for innlogging sendes via Twilio (USA-basert tjeneste, kun telefonnummeret ditt sendes dit).</p>
    </section>

    <section class="mb-8">
      <h2 class="text-xl font-semibold mb-3">Dine rettigheter</h2>
      <ul class="list-disc pl-6 space-y-1">
        <li><strong>Innsyn:</strong> Last ned alle dine data via Min side &rarr; Eksporter data</li>
        <li><strong>Retting:</strong> Oppdater profilen din via Min side</li>
        <li><strong>Sletting:</strong> Slett all din data via Min side &rarr; Slett konto</li>
      </ul>
    </section>

    <section class="mb-8">
      <h2 class="text-xl font-semibold mb-3">Sikkerhet</h2>
      <p>Innlogging skjer via engangskode på SMS. Sesjoner utløper etter 30 dager. API-endepunkter krever autentisering for tilgang til persondata.</p>
    </section>

    <section class="mb-8">
      <h2 class="text-xl font-semibold mb-3">Kontakt</h2>
      <p>Spørsmål om personvern rettes til arrangøren av prøven du deltar på.</p>
    </section>
  </div>
</body>
</html>`);
});

// --- Serve shim ---
app.get("/storage-shim.js", (c) => {
  c.header("Content-Type", "application/javascript");
  c.header("Cache-Control", "no-cache, no-store, must-revalidate");
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

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`🐕 Fuglehundprøve running on http://localhost:${PORT}`);
  console.log(`   Admin: http://localhost:${PORT}/admin-panel.html`);
  console.log(`   Backup: http://localhost:${PORT}/api/backup`);
});
