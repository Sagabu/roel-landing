import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import Database from "better-sqlite3";
import { readFileSync, existsSync, writeFileSync, copyFileSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { config } from "dotenv";
import { createHash, randomBytes } from "crypto";

// Load environment variables
config();

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");
const XLSX = require("xlsx");
const jwt = require("jsonwebtoken");

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH ? join(__dirname, process.env.DB_PATH) : join(__dirname, "fuglehund.db");
const PORT = Number(process.env.PORT || 8889);
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-not-for-production";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";
const SITE_PIN = process.env.SITE_PIN || "";  // Tom = deaktivert
const ADMIN_PIN = process.env.ADMIN_PIN || "";  // Tom = deaktivert

// --- SMS config (Twilio eller Sveve) ---
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER || "";
const TWILIO_MESSAGING_SERVICE_SID = process.env.TWILIO_MESSAGING_SERVICE_SID || "";
const twilioConfigured = !!(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && (TWILIO_PHONE_NUMBER || TWILIO_MESSAGING_SERVICE_SID));

// Fallback: Sveve (legacy)
const SVEVE_USER = process.env.SVEVE_USER || "";
const SVEVE_PASS = process.env.SVEVE_PASS || "";
const sveveConfigured = !!(SVEVE_USER && SVEVE_PASS);

// SMS provider prioritet: Twilio > Sveve > Dev mode
const smsProvider = twilioConfigured ? "twilio" : (sveveConfigured ? "sveve" : "dev");

// Warn if using default secret
if (!process.env.JWT_SECRET) {
  console.warn("⚠️  ADVARSEL: JWT_SECRET ikke satt i .env - bruker usikker dev-secret!");
}
if (SITE_PIN) {
  console.log("🔒 Site-lock aktivert med PIN");
}
if (ADMIN_PIN) {
  console.log("🔐 Admin-lock aktivert med PIN");
}

// --- Database setup ---
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("synchronous = NORMAL"); // Sørg for at data skrives til disk

// Checkpoint WAL regelmessig for å sikre at data er permanent lagret
setInterval(() => {
  try {
    db.pragma("wal_checkpoint(PASSIVE)");
  } catch (e) {
    console.error("WAL checkpoint error:", e.message);
  }
}, 30000); // Hver 30. sekund

// Graceful shutdown - checkpoint WAL og lukk database
const gracefulShutdown = () => {
  console.log("Graceful shutdown - checkpointing WAL...");
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();
    console.log("Database closed successfully");
  } catch (e) {
    console.error("Shutdown error:", e.message);
  }
  process.exit(0);
};
process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);

// --- Automatisk backup-system ---
const BACKUP_DIR = join(__dirname, "backups");
const MAX_AUTO_BACKUPS = 50; // Maks antall automatiske backups å beholde
let lastBackupTime = 0;
const BACKUP_INTERVAL_MS = 5 * 60 * 1000; // Minimum 5 minutter mellom auto-backups

// Opprett backup-mappe om den ikke finnes
if (!existsSync(BACKUP_DIR)) {
  mkdirSync(BACKUP_DIR, { recursive: true });
}

function autoBackup(reason = "auto") {
  const now = Date.now();
  // Begrens backup-frekvens
  if (now - lastBackupTime < BACKUP_INTERVAL_MS) {
    return;
  }

  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const backupName = `auto_${timestamp}_${reason}.db`;
    const backupPath = join(BACKUP_DIR, backupName);

    // Checkpoint WAL før backup for konsistent tilstand
    db.pragma("wal_checkpoint(TRUNCATE)");
    copyFileSync(DB_PATH, backupPath);
    lastBackupTime = now;

    // Rydd opp gamle auto-backups (behold kun siste N)
    const autoBackups = readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith("auto_") && f.endsWith(".db"))
      .sort()
      .reverse();

    if (autoBackups.length > MAX_AUTO_BACKUPS) {
      autoBackups.slice(MAX_AUTO_BACKUPS).forEach(old => {
        try { unlinkSync(join(BACKUP_DIR, old)); } catch (e) {}
      });
    }

    console.log(`📦 Auto-backup: ${backupName}`);
  } catch (err) {
    console.error("Backup-feil:", err.message);
  }
}

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

  -- Spørreundersøkelser
  CREATE TABLE IF NOT EXISTS undersokelser (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    data TEXT NOT NULL,
    source TEXT DEFAULT 'ukjent',
    ip_address TEXT DEFAULT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- OTP codes for SMS login
  CREATE TABLE IF NOT EXISTS otp_codes (
    telefon TEXT NOT NULL,
    code TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    used INTEGER DEFAULT 0
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
    regnr TEXT UNIQUE,
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
    bilde TEXT DEFAULT NULL,
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

  -- Klubb-medlemmer (importert medlemsliste for matching)
  CREATE TABLE IF NOT EXISTS klubb_medlemmer (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    klubb_id TEXT NOT NULL REFERENCES klubber(id),
    medlemsnummer TEXT,
    fornavn TEXT NOT NULL,
    etternavn TEXT NOT NULL,
    telefon_normalized TEXT,
    epost TEXT,
    matched_bruker_telefon TEXT REFERENCES brukere(telefon),
    matched_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(klubb_id, telefon_normalized)
  );

  -- Klubb-forespørsler (ventende klubb-opprettelser)
  CREATE TABLE IF NOT EXISTS klubb_foresporsel (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    orgnummer TEXT NOT NULL,
    navn TEXT NOT NULL,
    postnummer TEXT DEFAULT '',
    sted TEXT DEFAULT '',
    adresse TEXT DEFAULT '',
    leder_navn TEXT NOT NULL,
    leder_telefon TEXT NOT NULL,
    leder_epost TEXT DEFAULT '',
    leder_rolle TEXT DEFAULT 'leder',
    passord_hash TEXT DEFAULT '',
    ekstra_admins TEXT DEFAULT '[]',
    status TEXT DEFAULT 'pending',
    behandlet_av TEXT DEFAULT NULL,
    behandlet_dato TEXT DEFAULT NULL,
    avslag_grunn TEXT DEFAULT NULL,
    created_at TEXT DEFAULT (datetime('now'))
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

    -- Arbeidsflyt (dommer → NKK-rep → godkjent)
    status TEXT DEFAULT 'draft',
    submitted_at TEXT DEFAULT NULL,
    submitted_by TEXT DEFAULT NULL,
    approved_at TEXT DEFAULT NULL,
    approved_by TEXT DEFAULT NULL,
    nkk_comment TEXT DEFAULT NULL,

    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  INSERT OR IGNORE INTO trial_config (id) VALUES (1);

  -- Påmeldinger-tabell
  CREATE TABLE IF NOT EXISTS pameldinger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prove_id TEXT NOT NULL REFERENCES prover(id),
    hund_id INTEGER NOT NULL REFERENCES hunder(id),
    forer_telefon TEXT NOT NULL REFERENCES brukere(telefon),
    klasse TEXT NOT NULL CHECK(klasse IN ('UK', 'AK', 'VK')),
    dag INTEGER DEFAULT NULL,
    status TEXT DEFAULT 'pameldt' CHECK(status IN ('pameldt', 'venteliste', 'bekreftet', 'avmeldt', 'ikke_mott')),
    venteliste_plass INTEGER DEFAULT NULL,
    betalt INTEGER DEFAULT 0,
    betalt_belop INTEGER DEFAULT 0,
    betalings_dato TEXT DEFAULT NULL,
    sauebevis INTEGER DEFAULT 0,
    vaksinasjon_ok INTEGER DEFAULT 0,
    rabies_ok INTEGER DEFAULT 0,
    parti TEXT DEFAULT NULL,
    startnummer INTEGER DEFAULT NULL,
    makker_hund_id INTEGER DEFAULT NULL,
    notat TEXT DEFAULT '',
    pameldt_av_telefon TEXT REFERENCES brukere(telefon),
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(prove_id, hund_id)
  );

  -- Prøve-konfigurasjon (utvidet)
  CREATE TABLE IF NOT EXISTS prove_config (
    prove_id TEXT PRIMARY KEY REFERENCES prover(id),
    maks_deltakere_uk INTEGER DEFAULT 40,
    maks_deltakere_ak INTEGER DEFAULT 40,
    maks_deltakere_vk INTEGER DEFAULT 20,
    vk_dag INTEGER DEFAULT NULL,
    pris_hogfjell INTEGER DEFAULT 1350,
    pris_lavland INTEGER DEFAULT 1050,
    pris_skog INTEGER DEFAULT 900,
    pris_apport INTEGER DEFAULT 400,
    frist_pamelding TEXT DEFAULT NULL,
    frist_avmelding TEXT DEFAULT NULL,
    refusjon_prosent INTEGER DEFAULT 75,
    krever_sauebevis INTEGER DEFAULT 0,
    krever_vaksinasjon INTEGER DEFAULT 0,
    krever_rabies INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  -- FKF godkjente dommere (offisiell liste fra Fuglehundklubbenes Forbund)
  CREATE TABLE IF NOT EXISTS fkf_godkjente_dommere (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fornavn TEXT NOT NULL,
    etternavn TEXT NOT NULL,
    adresse TEXT DEFAULT '',
    postnummer TEXT DEFAULT '',
    sted TEXT DEFAULT '',
    telefon1 TEXT DEFAULT '',
    telefon2 TEXT DEFAULT '',
    telefon1_normalized TEXT DEFAULT '',
    telefon2_normalized TEXT DEFAULT '',
    epost TEXT DEFAULT '',
    aktiv INTEGER DEFAULT 1,
    imported_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_fkf_dommere_telefon1 ON fkf_godkjente_dommere(telefon1_normalized);
  CREATE INDEX IF NOT EXISTS idx_fkf_dommere_telefon2 ON fkf_godkjente_dommere(telefon2_normalized);

  -- Parti-signaturer for NKK-rapport
  CREATE TABLE IF NOT EXISTS parti_signaturer (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prove_id TEXT NOT NULL,
    parti TEXT NOT NULL,
    dommer_telefon TEXT REFERENCES brukere(telefon),
    dommer_signert_at TEXT DEFAULT NULL,
    nkkrep_telefon TEXT REFERENCES brukere(telefon),
    nkkrep_signert_at TEXT DEFAULT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(prove_id, parti, dommer_telefon)
  );

  -- Vipps-forespørsler (prøveleder sender betalingsforespørsler til deltakere)
  CREATE TABLE IF NOT EXISTS vipps_foresporsler (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prove_id TEXT NOT NULL REFERENCES prover(id),
    opprettet_av TEXT NOT NULL REFERENCES brukere(telefon),
    beskrivelse TEXT NOT NULL,
    belop INTEGER NOT NULL,
    vipps_nummer TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- Vipps-mottakere (hvem som har mottatt forespørsel og betalingsstatus)
  CREATE TABLE IF NOT EXISTS vipps_mottakere (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    foresporsel_id INTEGER NOT NULL REFERENCES vipps_foresporsler(id) ON DELETE CASCADE,
    deltaker_telefon TEXT NOT NULL,
    deltaker_navn TEXT NOT NULL,
    status TEXT DEFAULT 'venter' CHECK(status IN ('venter', 'betalt', 'kansellert')),
    betalt_dato TEXT DEFAULT NULL,
    notert_av TEXT DEFAULT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(foresporsel_id, deltaker_telefon)
  );

  -- SMS-logging for statistikk og feilsøking
  CREATE TABLE IF NOT EXISTS sms_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    retning TEXT NOT NULL CHECK(retning IN ('ut', 'inn')),
    fra TEXT NOT NULL,
    til TEXT NOT NULL,
    type TEXT NOT NULL,
    melding TEXT,
    twilio_sid TEXT,
    status TEXT DEFAULT 'sent',
    klubb_id TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_sms_log_created ON sms_log(created_at);
  CREATE INDEX IF NOT EXISTS idx_sms_log_type ON sms_log(type);
  CREATE INDEX IF NOT EXISTS idx_sms_log_klubb ON sms_log(klubb_id);

  -- DVK-kontroller (dyrevelferdskontroll)
  CREATE TABLE IF NOT EXISTS dvk_kontroller (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prove_id TEXT NOT NULL,
    tidspunkt TEXT NOT NULL,
    parti TEXT,
    type TEXT NOT NULL CHECK(type IN ('rutine', 'varslet', 'spontan', 'oppfolging')),
    hund TEXT,
    forer TEXT,
    beskrivelse TEXT,
    obs_hundehold INTEGER DEFAULT 0,
    obs_behandling INTEGER DEFAULT 0,
    obs_vannmat INTEGER DEFAULT 0,
    obs_hvile INTEGER DEFAULT 0,
    obs_veiledning INTEGER DEFAULT 0,
    obs_bekymring INTEGER DEFAULT 0,
    tiltak_ingen INTEGER DEFAULT 0,
    tiltak_veiledning INTEGER DEFAULT 0,
    tiltak_advarsel INTEGER DEFAULT 0,
    tiltak_dommer INTEGER DEFAULT 0,
    tiltak_proveleder INTEGER DEFAULT 0,
    tiltak_diskvalifikasjon INTEGER DEFAULT 0,
    registrert_av TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_dvk_kontroller_prove ON dvk_kontroller(prove_id);

  -- DVK-signatur
  CREATE TABLE IF NOT EXISTS dvk_signaturer (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prove_id TEXT NOT NULL UNIQUE,
    dvk_navn TEXT NOT NULL,
    dvk_telefon TEXT,
    initialer TEXT,
    signert_dato TEXT NOT NULL,
    signert_tid TEXT NOT NULL,
    full_signatur TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- DVK-journaler (komplett journal med alle data)
  CREATE TABLE IF NOT EXISTS dvk_journaler (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prove_id TEXT NOT NULL UNIQUE,
    prove_navn TEXT,
    arrangor_sted TEXT,
    prove_dato TEXT,
    dvk_navn TEXT NOT NULL,
    dvk_telefon TEXT,
    dvk_assistent TEXT,
    kontroller_json TEXT,
    avvik_json TEXT,
    vet_henvisninger_json TEXT,
    signatur_json TEXT,
    status TEXT DEFAULT 'draft' CHECK(status IN ('draft', 'signed', 'submitted')),
    signed_at TEXT,
    submitted_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_dvk_journaler_prove ON dvk_journaler(prove_id);
  CREATE INDEX IF NOT EXISTS idx_dvk_journaler_status ON dvk_journaler(status);

  -- Dokumentarkiv (alle dokumenter knyttet til en prøve)
  CREATE TABLE IF NOT EXISTS prove_dokumenter (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prove_id TEXT NOT NULL,
    dokument_type TEXT NOT NULL,
    tittel TEXT NOT NULL,
    filnavn TEXT,
    innhold_json TEXT,
    opprettet_av TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_prove_dokumenter_prove ON prove_dokumenter(prove_id);
  CREATE INDEX IF NOT EXISTS idx_prove_dokumenter_type ON prove_dokumenter(dokument_type);
`);

// --- Migrations for existing databases ---
const migrations = [
  "ALTER TABLE brukere ADD COLUMN samtykke_gitt TEXT DEFAULT NULL",
  "ALTER TABLE kritikker ADD COLUMN status TEXT DEFAULT 'draft'",
  "ALTER TABLE kritikker ADD COLUMN submitted_at TEXT DEFAULT NULL",
  "ALTER TABLE kritikker ADD COLUMN submitted_by TEXT DEFAULT NULL",
  "ALTER TABLE kritikker ADD COLUMN approved_at TEXT DEFAULT NULL",
  "ALTER TABLE kritikker ADD COLUMN approved_by TEXT DEFAULT NULL",
  "ALTER TABLE kritikker ADD COLUMN nkk_comment TEXT DEFAULT NULL",
  // Aversjonsbevis for sauetrening
  "ALTER TABLE hunder ADD COLUMN aversjonsbevis TEXT DEFAULT NULL",
  "ALTER TABLE hunder ADD COLUMN aversjonsbevis_dato TEXT DEFAULT NULL",
  "ALTER TABLE hunder ADD COLUMN aversjonsbevis_godkjent INTEGER DEFAULT 0",
  // Vipps-integrasjon for klubber
  "ALTER TABLE klubber ADD COLUMN vipps_nummer TEXT DEFAULT NULL",
  // Bilde-kolonne for hunder
  "ALTER TABLE hunder ADD COLUMN bilde TEXT DEFAULT NULL",
  // Passord-autentisering for brukere
  "ALTER TABLE brukere ADD COLUMN passord_hash TEXT DEFAULT NULL",
  "ALTER TABLE brukere ADD COLUMN siste_innlogging TEXT DEFAULT NULL",
  "ALTER TABLE brukere ADD COLUMN verifisert INTEGER DEFAULT 0",
  // Passord-autentisering for klubber
  "ALTER TABLE klubber ADD COLUMN passord_hash TEXT DEFAULT NULL",
  "ALTER TABLE klubber ADD COLUMN admin_telefon TEXT DEFAULT NULL",
  "ALTER TABLE klubber ADD COLUMN admin_epost TEXT DEFAULT NULL",
  "ALTER TABLE klubber ADD COLUMN siste_innlogging TEXT DEFAULT NULL",
  "ALTER TABLE klubber ADD COLUMN verifisert INTEGER DEFAULT 0",
  // Sporing av dommere med brukerprofil
  "ALTER TABLE fkf_godkjente_dommere ADD COLUMN linked_bruker_telefon TEXT DEFAULT NULL",
  "ALTER TABLE fkf_godkjente_dommere ADD COLUMN linked_at TEXT DEFAULT NULL",
  // SMS-samtykke med tidspunkt
  "ALTER TABLE brukere ADD COLUMN sms_samtykke INTEGER DEFAULT 0",
  "ALTER TABLE brukere ADD COLUMN sms_samtykke_tidspunkt TEXT DEFAULT NULL",
];
for (const sql of migrations) {
  try { db.exec(sql); } catch (e) { /* column already exists */ }
}

// Fix regnr NOT NULL constraint on existing databases (allow dogs without registration number)
try {
  const tableInfo = db.prepare("PRAGMA table_info(hunder)").all();
  const regnrCol = tableInfo.find(c => c.name === 'regnr');
  if (regnrCol && regnrCol.notnull === 1) {
    // Get current columns to handle migration correctly
    const cols = tableInfo.map(c => c.name);
    const selectCols = cols.join(', ');
    const needsBilde = !cols.includes('bilde');
    const needsAversjon = !cols.includes('aversjonsbevis');

    db.pragma("foreign_keys = OFF");
    db.exec("BEGIN TRANSACTION");
    db.exec(`ALTER TABLE hunder RENAME TO hunder_old`);
    db.exec(`
      CREATE TABLE hunder (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        regnr TEXT UNIQUE,
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
        bilde TEXT DEFAULT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        aversjonsbevis TEXT DEFAULT NULL,
        aversjonsbevis_dato TEXT DEFAULT NULL,
        aversjonsbevis_godkjent INTEGER DEFAULT 0
      )
    `);
    db.exec(`INSERT INTO hunder (${selectCols}) SELECT ${selectCols} FROM hunder_old`);
    db.exec(`DROP TABLE hunder_old`);

    // SQLite ALTER TABLE RENAME corrupts FK references in other tables
    // (they get rewritten to point at "hunder_old" instead of "hunder")
    const fkTables = ["resultater", "kritikker", "pameldinger", "fullmakter"];
    for (const t of fkTables) {
      const meta = db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(t);
      if (meta && meta.sql.includes('"hunder_old"')) {
        const fixedSql = meta.sql
          .replace(/"hunder_old"/g, 'hunder')
          .replace(`CREATE TABLE ${t}`, `CREATE TABLE ${t}_fkfix`);
        const tCols = db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name).join(', ');
        db.exec(fixedSql);
        db.exec(`INSERT INTO ${t}_fkfix (${tCols}) SELECT ${tCols} FROM ${t}`);
        db.exec(`DROP TABLE ${t}`);
        db.exec(`ALTER TABLE ${t}_fkfix RENAME TO ${t}`);
      }
    }

    db.exec("COMMIT");
    db.pragma("foreign_keys = ON");
    console.log("✅ Migrated hunder table: regnr now nullable, bilde column added");
  }
} catch (e) {
  try { db.exec("ROLLBACK"); } catch {}
  db.pragma("foreign_keys = ON");
  if (!e.message.includes('already exists') && !e.message.includes('no such table: hunder_old')) {
    console.error("Migration warning:", e.message);
  }
}

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
  insertDommer.run('vinterproven2026', '99999999', 'demo1', null);  // Chris Niebel - demo-parti med 3 hunder
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

  // Kritikk for Bleiebøtte (hund_id 8) - Irsk Setter - 5 kritikker totalt
  // Født: 2021-11-30 → Fyller 2 år: 2023-11-30
  // UK = 9 mnd til 2 år, AK = etter fylte 2 år
  // 1. premie krever minimum 60 min slipptid (men 60+ min garanterer ikke 1. premie)
  // 1. AK krever: fuglearbeid med reis, INGEN makkerstand, INGEN sjanse (hunden må være "ren")
  // 1. AK gir billett til VK

  // Bleiebøtte - kritikk 1: Vårprøven Snåsa 2023 (UK - hun er 1,5 år)
  insertKritikk.run(
    8, null, '99999994', '2023-05-14', 'UK', 'UK Parti 2', 'Snåsa',
    2, 4, 1,  // presisjon, reising, godkjent_reising
    1, 0, 1, 0, 2, 55,  // stand_m, stand_u, tomstand, makker_stand, sjanse, slipptid
    4, 4, 3, 4, 4, 4,  // jaktlyst, fart, selvstendighet, soksbredde, reviering, samarbeid
    0, 0, null, 0,  // sek_spontan, sek_forbi, apport, rapport_spontan
    '', '3. UK',  // adferd, premie (tomstand, sjanse=2, kort slipptid)
    'Ung og lovende irsk setter på sin første prøve. Viser fin jaktlyst, men noe uerfaren i terrenget. En tomstand og et par sjanser på fugl. Søket er litt smalt, men hunden har gode grunnegenskaper. Reiser kontrollert. Med mer erfaring vil dette bli en fin hund.'
  );

  // Bleiebøtte - kritikk 2: Høstprøven Oppdal 2023 (UK - hun er 1 år 10 mnd)
  insertKritikk.run(
    8, null, '99999997', '2023-09-16', 'UK', 'UK Parti 1', 'Oppdal',
    3, 5, 1,  // presisjon, reising, godkjent_reising
    2, 1, 0, 0, 0, 65,  // stand_m, stand_u, tomstand, makker_stand=0, sjanse=0, slipptid (REN!)
    5, 5, 4, 4, 4, 4,  // jaktlyst, fart, selvstendighet, soksbredde, reviering, samarbeid
    1, 0, null, 0,  // sek_spontan, sek_forbi, apport, rapport_spontan
    '', '1. UK',  // adferd, premie (ren hund: ingen makkerstand, ingen sjanse, god reis)
    'Flott irsk setter med masse energi og arbeidsvilje. Viser meget god jaktlyst og fart i terrenget. Søket er systematisk og effektivt. Ved fuglkontakt viser hunden fast og sikker stand med god marking. Reiser villig på kommando. Ren hund uten sjanser. En lovende unghund med stort potensial.'
  );

  // Bleiebøtte - kritikk 3: Vårprøven Tynset 2024 (AK - hun er 2 år 4 mnd)
  insertKritikk.run(
    8, null, '99999997', '2024-04-20', 'AK', 'AK Parti 3', 'Tynset',
    3, 5, 1,  // presisjon, reising, godkjent_reising
    2, 1, 0, 1, 1, 62,  // stand_m, stand_u, tomstand, makker_stand=1(!), sjanse=1(!), slipptid
    5, 5, 4, 5, 4, 4,  // jaktlyst, fart, selvstendighet, soksbredde, reviering, samarbeid
    1, 0, null, 0,  // sek_spontan, sek_forbi, apport, rapport_spontan
    '', '2. AK',  // adferd, premie (makkerstand og sjanse diskvalifiserer fra 1. AK)
    'Fin irsk setter med god jaktlyst og fart. Viser bred søksbredde og dekker terrenget godt. Solid fuglearbeid med tre stander. Reiser villig. En makkerstand og en sjanse på fugl hindrer toppresultat. Lovende utvikling mot VK-nivå.'
  );

  // Bleiebøtte - kritikk 4: Høstprøven Lierne 2024 (AK)
  insertKritikk.run(
    8, null, '99999994', '2024-09-28', 'AK', 'AK Parti 1', 'Lierne',
    4, 6, 1,  // presisjon, reising, godkjent_reising
    3, 2, 0, 0, 0, 70,  // stand_m, stand_u, tomstand, makker_stand=0, sjanse=0, slipptid (REN!)
    6, 5, 5, 5, 5, 5,  // jaktlyst, fart, selvstendighet, soksbredde, reviering, samarbeid
    2, 0, 1, 1,  // sek_spontan, sek_forbi, apport, rapport_spontan
    '', '1. AK',  // adferd, premie (REN: presis, god reis, ingen makkerstand, ingen sjanse → VK!)
    'Fremragende irsk setter med topp jaktlyst og arbeidskapasitet. Imponerende søksbredde og reviering. Presis i fuglearbeidet med fem stander uten tomstand. Reiser djerv og elegant. Helt ren hund uten sjanser eller makkerstand. Apporterte spontant. En av dagens beste slipp. Kvalifisert til VK!'
  );

  // Bleiebøtte - kritikk 5: Høstprøven Berkåk 2024 (AK - kan fortsatt gå AK selv med 1.AK)
  insertKritikk.run(
    8, null, '99999999', '2024-10-12', 'AK', 'AK Parti 2', 'Berkåk',
    3, 5, 1,  // presisjon, reising, godkjent_reising
    2, 1, 1, 0, 1, 65,  // stand_m, stand_u, tomstand=1(!), makker_stand=0, sjanse=1(!), slipptid
    5, 5, 5, 4, 4, 5,  // jaktlyst, fart, selvstendighet, soksbredde, reviering, samarbeid
    1, 0, 1, 0,  // sek_spontan, sek_forbi, apport, rapport_spontan
    '', '2. AK',  // adferd, premie (tomstand og sjanse hindrer 1. premie)
    'Solid irsk setter med god arbeidskapasitet. Dekker terrenget effektivt med god fart. En tomstand og en sjanse på fugl trekker ned, men ellers fint fuglearbeid. Presis i stand og reiser villig. Apporterte på kommando. En god hund som har vist VK-potensial.'
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

// Kun seed i development-mode
if (process.env.NODE_ENV !== 'production') {
  seedData();
}

const app = new Hono();

// --- Global error handler ---
app.onError((err, c) => {
  console.error("Server error:", err);
  return c.json({ error: err.message }, 500);
});

// ============================================
// JWT AUTENTISERING
// ============================================

// Generer JWT token
function generateToken(bruker) {
  const payload = {
    telefon: bruker.telefon,
    rolle: bruker.rolle,
    navn: `${bruker.fornavn} ${bruker.etternavn}`
  };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

// Verifiser JWT token
function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return null;
  }
}

// Auth middleware - hent bruker fra token (valgfri auth)
const optionalAuth = async (c, next) => {
  const authHeader = c.req.header("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    const payload = verifyToken(token);
    if (payload) {
      c.set("bruker", payload);
    }
  }
  await next();
};

// Auth middleware - krever gyldig token
const requireAuth = async (c, next) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Ingen tilgang - mangler token" }, 401);
  }

  const token = authHeader.slice(7);
  const payload = verifyToken(token);

  if (!payload) {
    return c.json({ error: "Ugyldig eller utløpt token" }, 401);
  }

  c.set("bruker", payload);
  await next();
};

// Hjelpefunksjon for å sjekke rolle (støtter komma-separerte roller)
function hasRole(rolleStr, requiredRole) {
  if (!rolleStr) return false;
  const roller = rolleStr.split(',').map(r => r.trim());
  return roller.includes(requiredRole);
}

function hasAnyRole(rolleStr, requiredRoles) {
  if (!rolleStr) return false;
  const roller = rolleStr.split(',').map(r => r.trim());
  return requiredRoles.some(r => roller.includes(r));
}

// Auth middleware - krever admin-rolle
const requireAdmin = async (c, next) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Ingen tilgang - mangler token" }, 401);
  }

  const token = authHeader.slice(7);
  const payload = verifyToken(token);

  if (!payload) {
    return c.json({ error: "Ugyldig eller utløpt token" }, 401);
  }

  if (!hasAnyRole(payload.rolle, ["admin", "superadmin", "klubbleder", "proveleder", "sekretær", "sekretar"])) {
    return c.json({ error: "Krever admin-tilgang" }, 403);
  }

  c.set("bruker", payload);
  await next();
};

// Auth middleware - krever dommer-rolle
const requireDommer = async (c, next) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Ingen tilgang - mangler token" }, 401);
  }

  const token = authHeader.slice(7);
  const payload = verifyToken(token);

  if (!payload) {
    return c.json({ error: "Ugyldig eller utløpt token" }, 401);
  }

  if (!hasAnyRole(payload.rolle, ["dommer", "admin"])) {
    return c.json({ error: "Krever dommer-tilgang" }, 403);
  }

  c.set("bruker", payload);
  await next();
};

// ============================================
// PASSWORD HELPERS
// ============================================

function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = createHash('sha256').update(password + salt).digest('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash) return false;
  const [salt, hash] = storedHash.split(':');
  const checkHash = createHash('sha256').update(password + salt).digest('hex');
  return hash === checkHash;
}

// Sjekk om bruker trenger re-verifisering (>60 dager siden siste innlogging)
function needsReverification(sisteInnlogging) {
  if (!sisteInnlogging) return true;
  const lastLogin = new Date(sisteInnlogging);
  const now = new Date();
  const daysSince = (now - lastLogin) / (1000 * 60 * 60 * 24);
  return daysSince > 60;
}

// ============================================
// SMS / OTP HELPERS
// ============================================

function generateOTP() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

const otpAttempts = new Map();
function checkOTPRate(telefon) {
  const now = Date.now();
  const attempts = otpAttempts.get(telefon) || [];
  const recent = attempts.filter(t => now - t < 10 * 60 * 1000);
  if (recent.length >= 5) return false;
  recent.push(now);
  otpAttempts.set(telefon, recent);
  return true;
}

// Logg SMS til database for statistikk
function logSMS(retning, fra, til, type, melding, twilio_sid = null, status = 'sent', klubb_id = null) {
  try {
    db.prepare(`
      INSERT INTO sms_log (retning, fra, til, type, melding, twilio_sid, status, klubb_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(retning, fra, til, type, melding || null, twilio_sid, status, klubb_id);
  } catch (e) {
    console.error('SMS logging error:', e.message);
  }
}

async function sendSMS(telefon, message, options = {}) {
  const { type = 'verifisering', klubb_id = null } = options;

  // Formater telefonnummer til internasjonalt format
  let phoneFormatted = telefon.replace(/\s/g, '');
  if (phoneFormatted.startsWith('4') && phoneFormatted.length === 8) {
    phoneFormatted = '+47' + phoneFormatted;
  } else if (!phoneFormatted.startsWith('+')) {
    phoneFormatted = '+47' + phoneFormatted;
  }

  const fromNumber = TWILIO_PHONE_NUMBER || 'Fuglehund';

  // Dev mode - ingen SMS-leverandør konfigurert
  if (smsProvider === "dev") {
    console.log(`📱 [DEV MODE] SMS til ${phoneFormatted}: ${message}`);
    logSMS('ut', fromNumber, phoneFormatted, type, message, null, 'dev', klubb_id);
    return { success: true, devMode: true };
  }

  // Twilio
  if (smsProvider === "twilio") {
    try {
      const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
      const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');

      const resp = await fetch(twilioUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams(
          TWILIO_MESSAGING_SERVICE_SID
            ? { To: phoneFormatted, MessagingServiceSid: TWILIO_MESSAGING_SERVICE_SID, Body: message }
            : { To: phoneFormatted, From: TWILIO_PHONE_NUMBER, Body: message }
        )
      });

      const data = await resp.json();

      if (resp.ok && data.sid) {
        const mode = TWILIO_MESSAGING_SERVICE_SID ? 'Alpha Sender' : 'Phone';
        console.log(`📱 [Twilio/${mode}] SMS sendt til ${phoneFormatted} (SID: ${data.sid})`);
        logSMS('ut', fromNumber, phoneFormatted, type, message, data.sid, 'sent', klubb_id);
        return { success: true, provider: 'twilio', sid: data.sid };
      } else {
        console.error("Twilio SMS error:", data);
        logSMS('ut', fromNumber, phoneFormatted, type, message, null, 'failed', klubb_id);
        return { success: false, error: data.message || 'Twilio error', provider: 'twilio' };
      }
    } catch (err) {
      console.error("Twilio SMS fetch error:", err.message);
      logSMS('ut', fromNumber, phoneFormatted, type, message, null, 'error', klubb_id);
      return { success: false, error: err.message, provider: 'twilio' };
    }
  }

  // Sveve (legacy fallback)
  if (smsProvider === "sveve") {
    const url = new URL("https://sveve.no/SMS/SendSMS");
    url.searchParams.set("user", SVEVE_USER);
    url.searchParams.set("passwd", SVEVE_PASS);
    url.searchParams.set("to", telefon);
    url.searchParams.set("msg", message);
    url.searchParams.set("from", "Fuglehund");

    try {
      const resp = await fetch(url.toString());
      const text = await resp.text();
      if (text.includes("<response>") && !text.includes("feil") && !text.includes("error")) {
        console.log(`📱 [Sveve] SMS sendt til ${telefon}`);
        logSMS('ut', 'Fuglehund', phoneFormatted, type, message, null, 'sent', klubb_id);
        return { success: true, provider: 'sveve' };
      } else {
        console.error("Sveve SMS error:", text);
        logSMS('ut', 'Fuglehund', phoneFormatted, type, message, null, 'failed', klubb_id);
        return { success: false, error: text, provider: 'sveve' };
      }
    } catch (err) {
      console.error("Sveve SMS fetch error:", err.message);
      logSMS('ut', 'Fuglehund', phoneFormatted, type, message, null, 'error', klubb_id);
      return { success: false, error: err.message, provider: 'sveve' };
    }
  }

  return { success: false, error: 'No SMS provider configured' };
}

function cleanExpired() {
  db.prepare("DELETE FROM otp_codes WHERE expires_at < datetime('now')").run();
}

// ============================================
// PHONE / MEMBER HELPERS
// ============================================

function normalizePhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length === 10 && digits.startsWith('47')) return digits.slice(2);
  if (digits.length === 8) return digits;
  if (digits.length > 8) return digits.slice(-8);
  return digits || null;
}

function runMemberMatching(klubbId) {
  db.prepare(`
    UPDATE klubb_medlemmer
    SET matched_bruker_telefon = (
      SELECT b.telefon FROM brukere b
      WHERE klubb_medlemmer.telefon_normalized IS NOT NULL
      AND klubb_medlemmer.telefon_normalized != ''
      AND REPLACE(REPLACE(REPLACE(REPLACE(b.telefon, ' ', ''), '+47', ''), '+', ''), '-', '')
        LIKE '%' || klubb_medlemmer.telefon_normalized
    ),
    matched_at = datetime('now')
    WHERE klubb_id = ?
    AND matched_bruker_telefon IS NULL
  `).run(klubbId);
}

// ============================================
// PRØVELEDER INVITASJON SMS
// ============================================

app.post("/api/sms/proveleder-invitasjon", async (c) => {
  const body = await c.req.json();
  const telefon = (body.telefon || "").replace(/\s/g, "");
  const navn = body.navn || "";
  const proveNavn = body.proveNavn || "en jaktprøve";

  if (!telefon || telefon.length < 8) {
    return c.json({ error: "Ugyldig telefonnummer" }, 400);
  }
  if (!navn) {
    return c.json({ error: "Navn er påkrevd" }, 400);
  }

  // Sjekk om mottaker er eksisterende bruker
  const eksisterendeBruker = db.prepare("SELECT telefon, fornavn FROM brukere WHERE telefon = ?").get(telefon);

  let smsMessage;
  if (eksisterendeBruker) {
    // Eksisterende bruker
    smsMessage = `Hei ${eksisterendeBruker.fornavn || navn}! Du er satt opp som prøveleder for ${proveNavn}. Logg inn på fuglehundprove.no for å administrere prøven.`;
  } else {
    // Ny bruker - send invitasjon til å registrere seg
    smsMessage = `Hei ${navn}! Du er invitert som prøveleder for ${proveNavn}. Opprett bruker på fuglehundprove.no/opprett-bruker.html for å komme i gang.`;
  }

  try {
    const smsResult = await sendSMS(telefon, smsMessage, { type: "proveleder_invitasjon" });

    if (!smsResult.success) {
      console.error(`[Prøveleder-invit] SMS feilet til ${telefon}:`, smsResult.error);
      return c.json({ error: smsResult.error || "Kunne ikke sende SMS" }, 500);
    }

    console.log(`[Prøveleder-invit] SMS sendt til ${telefon} (${eksisterendeBruker ? 'eksisterende' : 'ny'} bruker) for ${proveNavn}`);
    return c.json({ success: true, message: "Invitasjon sendt" });

  } catch (err) {
    console.error(`[Prøveleder-invit] Feil:`, err);
    return c.json({ error: "Feil ved sending av SMS" }, 500);
  }
});

// ============================================
// AUTH API ENDPOINTS
// ============================================

// Login - verifiser telefonnummer og returner JWT
// I produksjon: Her skal SMS-verifisering skje
app.post("/api/auth/login", async (c) => {
  const body = await c.req.json();
  const { telefon, kode } = body;

  if (!telefon) {
    return c.json({ error: "Telefonnummer påkrevd" }, 400);
  }

  // Sjekk om bruker finnes
  const bruker = db.prepare("SELECT * FROM brukere WHERE telefon = ?").get(telefon);

  if (!bruker) {
    return c.json({ error: "Bruker ikke funnet" }, 404);
  }

  // Verifiser SMS-kode
  // I dev-mode: Koden "1234" fungerer alltid
  // I produksjon: Her skal ekte SMS-verifisering implementeres
  const isDevMode = process.env.NODE_ENV !== "production";
  const validDevCode = "1234";

  if (!kode) {
    return c.json({ error: "Verifiseringskode påkrevd" }, 400);
  }

  // Bypass for testing: telefon 90852833 med kode 1234
  const isTestBypass = telefon === "90852833" && kode === "1234";

  if (isDevMode || isTestBypass) {
    // I dev-mode eller test-bypass: godta "1234" som gyldig kode
    if (kode !== validDevCode) {
      return c.json({ error: "Feil kode" }, 401);
    }
  } else {
    // I produksjon: Her skal SMS-verifisering implementeres
    // For nå: Avvis alle innlogginger i production uten ekte SMS-system
    return c.json({ error: "SMS-verifisering ikke konfigurert" }, 501);
  }

  const token = generateToken(bruker);

  return c.json({
    token,
    bruker: {
      telefon: bruker.telefon,
      fornavn: bruker.fornavn,
      etternavn: bruker.etternavn,
      rolle: bruker.rolle
    }
  });
});

// Verifiser token og returner brukerinfo
app.get("/api/auth/me", requireAuth, (c) => {
  const payload = c.get("bruker");

  // Hent full brukerinfo fra database
  const bruker = db.prepare("SELECT * FROM brukere WHERE telefon = ?").get(payload.telefon);

  if (!bruker) {
    return c.json({ error: "Bruker ikke funnet" }, 404);
  }

  return c.json({
    telefon: bruker.telefon,
    fornavn: bruker.fornavn,
    etternavn: bruker.etternavn,
    rolle: bruker.rolle,
    epost: bruker.epost
  });
});

// Logg ut (klientsiden fjerner token, men vi kan logge det)
app.post("/api/auth/logout", requireAuth, (c) => {
  const payload = c.get("bruker");
  console.log(`Bruker logget ut: ${payload.telefon}`);
  return c.json({ ok: true });
});

// Refresh token
app.post("/api/auth/refresh", requireAuth, (c) => {
  const payload = c.get("bruker");

  // Hent oppdatert brukerinfo
  const bruker = db.prepare("SELECT * FROM brukere WHERE telefon = ?").get(payload.telefon);

  if (!bruker) {
    return c.json({ error: "Bruker ikke funnet" }, 404);
  }

  const newToken = generateToken(bruker);

  return c.json({ token: newToken });
});

// Send OTP kode via SMS
app.post("/api/auth/send-code", async (c) => {
  const body = await c.req.json();
  const telefon = (body.telefon || "").replace(/\s/g, "");

  if (!/^\d{8}$/.test(telefon)) {
    return c.json({ error: "Ugyldig telefonnummer (8 siffer)" }, 400);
  }

  const dommerCheck = db.prepare("SELECT dommer_telefon FROM dommer_tildelinger WHERE dommer_telefon = ? LIMIT 1").get(telefon);
  const userCheck = db.prepare("SELECT telefon FROM brukere WHERE telefon = ?").get(telefon);

  // Sjekk også om dette er en FKF-godkjent dommer (tillat innlogging selv uten eksisterende bruker)
  const normalized = normalizePhone(telefon);
  const fkfDommer = db.prepare(`
    SELECT id FROM fkf_godkjente_dommere
    WHERE aktiv = 1 AND (telefon1_normalized = ? OR telefon2_normalized = ?)
  `).get(normalized, normalized);

  if (!dommerCheck && !userCheck && !fkfDommer) {
    return c.json({ error: "Telefonnummeret er ikke registrert" }, 404);
  }

  if (!checkOTPRate(telefon)) {
    return c.json({ error: "For mange forsøk. Vent litt." }, 429);
  }

  db.prepare("UPDATE otp_codes SET used = 1 WHERE telefon = ? AND used = 0").run(telefon);

  const code = generateOTP();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  db.prepare("INSERT INTO otp_codes (telefon, code, expires_at) VALUES (?, ?, ?)").run(telefon, code, expiresAt);

  const smsResult = await sendSMS(telefon, `Din innloggingskode for Fuglehundprøve: ${code}`);

  if (!smsResult.success) {
    return c.json({ error: "Kunne ikke sende SMS. Prøv igjen." }, 500);
  }

  return c.json({ ok: true, message: "Kode sendt på SMS", devMode: smsResult.devMode || false });
});

// Verifiser OTP kode UTEN å opprette bruker (for klubb-forespørsel)
app.post("/api/auth/verify-code-only", async (c) => {
  const body = await c.req.json();
  const telefon = (body.telefon || "").replace(/\s/g, "");
  const code = (body.code || "").trim();

  if (!telefon || !code) {
    return c.json({ error: "Telefon og kode er påkrevd" }, 400);
  }

  // Bypass for testing: telefon 90852833 med kode 1234
  const isTestBypass = telefon === "90852833" && code === "1234";

  const otp = isTestBypass ? { rowid: -1 } : db.prepare(
    "SELECT rowid, * FROM otp_codes WHERE telefon = ? AND code = ? AND used = 0 AND expires_at > datetime('now') ORDER BY created_at DESC LIMIT 1"
  ).get(telefon, code);

  if (!otp) {
    return c.json({ error: "Ugyldig eller utløpt kode" }, 401);
  }

  // Marker koden som brukt
  if (otp.rowid !== -1) {
    db.prepare("UPDATE otp_codes SET used = 1 WHERE rowid = ?").run(otp.rowid);
  }

  return c.json({ ok: true, verified: true });
});

// Verifiser OTP kode og returner JWT
app.post("/api/auth/verify-code", async (c) => {
  const body = await c.req.json();
  const telefon = (body.telefon || "").replace(/\s/g, "");
  const code = (body.code || "").trim();

  if (!telefon || !code) {
    return c.json({ error: "Telefon og kode er påkrevd" }, 400);
  }

  // Bypass for testing: telefon 90852833 med kode 1234
  const isTestBypass = telefon === "90852833" && code === "1234";

  const otp = isTestBypass ? { rowid: -1 } : db.prepare(
    "SELECT rowid, * FROM otp_codes WHERE telefon = ? AND code = ? AND used = 0 AND expires_at > datetime('now') ORDER BY created_at DESC LIMIT 1"
  ).get(telefon, code);

  if (!otp) {
    return c.json({ error: "Ugyldig eller utløpt kode" }, 401);
  }

  // Ikke oppdater OTP-tabell for test-bypass
  if (otp.rowid !== -1) {
    db.prepare("UPDATE otp_codes SET used = 1 WHERE rowid = ?").run(otp.rowid);
  }

  let bruker = db.prepare("SELECT * FROM brukere WHERE telefon = ?").get(telefon);

  // Sjekk om dette er en FKF-godkjent dommer
  const normalized = normalizePhone(telefon);
  const fkfDommer = db.prepare(`
    SELECT id, fornavn, etternavn, adresse, postnummer, sted, epost, linked_bruker_telefon
    FROM fkf_godkjente_dommere
    WHERE aktiv = 1 AND (telefon1_normalized = ? OR telefon2_normalized = ?)
  `).get(normalized, normalized);

  if (bruker) {
    // Sjekk om eksisterende bruker mangler dommer-rolle men er FKF-godkjent
    if (fkfDommer && !bruker.rolle.includes('dommer')) {
      const nyRolle = bruker.rolle + ',dommer';
      db.prepare("UPDATE brukere SET rolle = ?, updated_at = datetime('now') WHERE telefon = ?").run(nyRolle, telefon);
      bruker.rolle = nyRolle;
      console.log(`[Auto-dommer] Eksisterende bruker ${telefon} fikk dommer-rolle ved innlogging`);
      db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").run(
        "auto_dommer_tildelt",
        `Bruker ${telefon} fikk automatisk dommer-rolle ved innlogging (matchet FKF-dommer: ${fkfDommer.fornavn} ${fkfDommer.etternavn})`
      );
    }

    // Oppdater linked_bruker_telefon på FKF-dommer hvis ikke allerede satt
    if (fkfDommer && !fkfDommer.linked_bruker_telefon) {
      db.prepare("UPDATE fkf_godkjente_dommere SET linked_bruker_telefon = ?, linked_at = datetime('now') WHERE id = ?").run(telefon, fkfDommer.id);
    }

    const token = generateToken(bruker);
    return c.json({
      token,
      bruker: {
        telefon: bruker.telefon,
        fornavn: bruker.fornavn,
        etternavn: bruker.etternavn,
        rolle: bruker.rolle
      },
      isFkfDommer: !!fkfDommer
    });
  }

  // Ny bruker - opprett automatisk hvis FKF-dommer
  if (fkfDommer) {
    const rolle = 'deltaker,dommer';
    db.prepare(`
      INSERT INTO brukere (telefon, fornavn, etternavn, epost, adresse, postnummer, sted, rolle)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      telefon,
      fkfDommer.fornavn || '',
      fkfDommer.etternavn || '',
      fkfDommer.epost || '',
      fkfDommer.adresse || '',
      fkfDommer.postnummer || '',
      fkfDommer.sted || '',
      rolle
    );

    console.log(`[Auto-dommer] Ny bruker ${telefon} opprettet med dommer-rolle (FKF: ${fkfDommer.fornavn} ${fkfDommer.etternavn})`);
    db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").run(
      "auto_bruker_dommer",
      `Ny bruker opprettet automatisk fra FKF-dommerliste: ${fkfDommer.fornavn} ${fkfDommer.etternavn} (${telefon})`
    );

    // Oppdater linked_bruker_telefon på FKF-dommer
    db.prepare("UPDATE fkf_godkjente_dommere SET linked_bruker_telefon = ?, linked_at = datetime('now') WHERE id = ?").run(telefon, fkfDommer.id);

    bruker = db.prepare("SELECT * FROM brukere WHERE telefon = ?").get(telefon);
    const token = generateToken(bruker);
    return c.json({
      token,
      bruker: {
        telefon: bruker.telefon,
        fornavn: bruker.fornavn,
        etternavn: bruker.etternavn,
        rolle: bruker.rolle
      },
      isFkfDommer: true,
      autoCreated: true
    });
  }

  // Dommer uten brukerprofil (tildelt via prøve, men ikke i FKF-listen)
  const dommerInfo = db.prepare(`
    SELECT dt.parti, dt.dommer_rolle, p.navn as prove_navn
    FROM dommer_tildelinger dt
    JOIN prover p ON dt.prove_id = p.id
    WHERE dt.dommer_telefon = ?
  `).all(telefon);

  return c.json({
    telefon,
    isDommerOnly: true,
    dommerInfo
  });
});

// Registrer samtykke (GDPR)
app.post("/api/auth/consent", requireAuth, (c) => {
  const payload = c.get("bruker");
  db.prepare("UPDATE brukere SET samtykke_gitt = datetime('now') WHERE telefon = ?").run(payload.telefon);
  return c.json({ ok: true, samtykke_gitt: new Date().toISOString() });
});

// ============================================
// NY AUTENTISERING MED PASSORD
// ============================================

// Steg 1: Registrer ny bruker (send SMS-kode for verifisering)
app.post("/api/auth/register/send-code", async (c) => {
  const body = await c.req.json();
  const telefon = (body.telefon || "").replace(/\s/g, "");
  const fornavn = (body.fornavn || "").trim();
  const etternavn = (body.etternavn || "").trim();
  const epost = (body.epost || "").trim();

  if (!/^\d{8}$/.test(telefon)) {
    return c.json({ error: "Ugyldig telefonnummer (8 siffer)" }, 400);
  }
  if (!fornavn || !etternavn) {
    return c.json({ error: "Fornavn og etternavn er påkrevd" }, 400);
  }

  // Sjekk om bruker allerede eksisterer og er verifisert
  const existing = db.prepare("SELECT telefon, verifisert FROM brukere WHERE telefon = ?").get(telefon);
  if (existing && existing.verifisert) {
    return c.json({ error: "Bruker med dette telefonnummeret eksisterer allerede. Logg inn i stedet." }, 409);
  }

  if (!checkOTPRate(telefon)) {
    return c.json({ error: "For mange forsøk. Vent litt." }, 429);
  }

  // Ugyldiggjør gamle koder
  db.prepare("UPDATE otp_codes SET used = 1 WHERE telefon = ? AND used = 0").run(telefon);

  const code = generateOTP();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 min
  db.prepare("INSERT INTO otp_codes (telefon, code, expires_at) VALUES (?, ?, ?)").run(telefon, code, expiresAt);

  const smsResult = await sendSMS(telefon, `Din verifiseringskode for Fuglehundprøve: ${code}`);

  if (!smsResult.success) {
    return c.json({ error: "Kunne ikke sende SMS. Prøv igjen." }, 500);
  }

  return c.json({
    ok: true,
    message: "Verifiseringskode sendt på SMS",
    devMode: smsResult.devMode || false
  });
});

// Steg 2: Verifiser kode og opprett bruker med passord
app.post("/api/auth/register/verify", async (c) => {
  const body = await c.req.json();
  const telefon = (body.telefon || "").replace(/\s/g, "");
  const code = (body.code || "").trim();
  const passord = body.passord || "";
  const fornavn = (body.fornavn || "").trim();
  const etternavn = (body.etternavn || "").trim();
  const epost = (body.epost || "").trim();
  const smsSamtykke = body.sms_samtykke ? 1 : 0;
  const smsSamtykkeTidspunkt = body.sms_samtykke_tidspunkt || new Date().toISOString();

  if (!telefon || !code || !passord) {
    return c.json({ error: "Telefon, kode og passord er påkrevd" }, 400);
  }
  if (!fornavn || !etternavn) {
    return c.json({ error: "Fornavn og etternavn er påkrevd" }, 400);
  }

  // Verifiser OTP
  const otp = db.prepare(
    "SELECT rowid, * FROM otp_codes WHERE telefon = ? AND code = ? AND used = 0 AND expires_at > datetime('now') ORDER BY created_at DESC LIMIT 1"
  ).get(telefon, code);

  if (!otp) {
    return c.json({ error: "Ugyldig eller utløpt kode" }, 401);
  }

  db.prepare("UPDATE otp_codes SET used = 1 WHERE rowid = ?").run(otp.rowid);

  // Hash passordet
  const passordHash = hashPassword(passord);
  const now = new Date().toISOString();

  // Opprett eller oppdater bruker
  const existing = db.prepare("SELECT telefon FROM brukere WHERE telefon = ?").get(telefon);

  if (existing) {
    // Oppdater eksisterende bruker - SMS-samtykke oppdateres kun hvis det ikke allerede er satt
    db.prepare(`
      UPDATE brukere SET
        fornavn = ?, etternavn = ?, epost = ?,
        passord_hash = ?, verifisert = 1,
        siste_innlogging = ?, updated_at = ?,
        sms_samtykke = CASE WHEN sms_samtykke IS NULL OR sms_samtykke = 0 THEN ? ELSE sms_samtykke END,
        sms_samtykke_tidspunkt = CASE WHEN sms_samtykke_tidspunkt IS NULL THEN ? ELSE sms_samtykke_tidspunkt END
      WHERE telefon = ?
    `).run(fornavn, etternavn, epost, passordHash, now, now, smsSamtykke, smsSamtykkeTidspunkt, telefon);
  } else {
    const insertResult = db.prepare(`
      INSERT INTO brukere (telefon, fornavn, etternavn, epost, passord_hash, verifisert, siste_innlogging, created_at, updated_at, sms_samtykke, sms_samtykke_tidspunkt)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
    `).run(telefon, fornavn, etternavn, epost, passordHash, now, now, now, smsSamtykke, smsSamtykkeTidspunkt);
    console.log(`[Register] Ny bruker opprettet: ${telefon} (SMS-samtykke: ${smsSamtykke ? 'Ja' : 'Nei'}, tidspunkt: ${smsSamtykkeTidspunkt})`);

    // Auto-backup ved ny brukerregistrering
    autoBackup("ny_bruker");
  }

  let bruker = db.prepare("SELECT * FROM brukere WHERE telefon = ?").get(telefon);
  console.log(`[Register] Bruker fra DB: ${bruker ? bruker.telefon : 'IKKE FUNNET'}`);

  // Sjekk om dette er en FKF-godkjent dommer
  const normalized = normalizePhone(telefon);
  const fkfDommer = db.prepare(`
    SELECT id, fornavn, etternavn, linked_bruker_telefon
    FROM fkf_godkjente_dommere
    WHERE aktiv = 1 AND (telefon1_normalized = ? OR telefon2_normalized = ?)
  `).get(normalized, normalized);

  let isFkfDommer = false;
  if (fkfDommer) {
    isFkfDommer = true;
    // Gi automatisk dommer-rolle
    if (!bruker.rolle.includes('dommer')) {
      const nyRolle = (bruker.rolle || 'deltaker') + ',dommer';
      db.prepare("UPDATE brukere SET rolle = ?, updated_at = datetime('now') WHERE telefon = ?").run(nyRolle, telefon);
      bruker.rolle = nyRolle;
      console.log(`[Auto-dommer] Ny registrert bruker ${telefon} fikk dommer-rolle (FKF: ${fkfDommer.fornavn} ${fkfDommer.etternavn})`);
      db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").run(
        "auto_dommer_registrering",
        `Bruker ${telefon} fikk automatisk dommer-rolle ved registrering (matchet FKF-dommer: ${fkfDommer.fornavn} ${fkfDommer.etternavn})`
      );
    }
    // Oppdater linked_bruker_telefon hvis ikke allerede satt
    if (!fkfDommer.linked_bruker_telefon) {
      db.prepare("UPDATE fkf_godkjente_dommere SET linked_bruker_telefon = ?, linked_at = datetime('now') WHERE id = ?").run(telefon, fkfDommer.id);
    }
  }

  // Generer JWT
  const token = jwt.sign(
    {
      telefon: bruker.telefon,
      fornavn: bruker.fornavn,
      etternavn: bruker.etternavn,
      rolle: bruker.rolle || "deltaker"
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );

  return c.json({
    ok: true,
    token,
    bruker: {
      telefon: bruker.telefon,
      fornavn: bruker.fornavn,
      etternavn: bruker.etternavn,
      epost: bruker.epost,
      rolle: bruker.rolle
    },
    isFkfDommer
  });
});

// Logg inn med passord
app.post("/api/auth/login-password", async (c) => {
  const body = await c.req.json();
  const telefon = (body.telefon || "").replace(/\s/g, "");
  const passord = body.passord || "";

  if (!/^\d{8}$/.test(telefon)) {
    return c.json({ error: "Ugyldig telefonnummer" }, 400);
  }
  if (!passord) {
    return c.json({ error: "Passord er påkrevd" }, 400);
  }

  const bruker = db.prepare("SELECT * FROM brukere WHERE telefon = ? AND verifisert = 1").get(telefon);

  if (!bruker) {
    return c.json({ error: "Bruker ikke funnet eller ikke verifisert" }, 401);
  }

  if (!verifyPassword(passord, bruker.passord_hash)) {
    return c.json({ error: "Feil passord" }, 401);
  }

  // Sjekk om re-verifisering kreves (>60 dager)
  if (needsReverification(bruker.siste_innlogging)) {
    return c.json({
      requiresVerification: true,
      message: "Det er over 60 dager siden siste innlogging. Verifiser med SMS-kode.",
      telefon
    }, 200);
  }

  // Oppdater siste innlogging
  db.prepare("UPDATE brukere SET siste_innlogging = datetime('now') WHERE telefon = ?").run(telefon);

  const token = jwt.sign(
    {
      telefon: bruker.telefon,
      fornavn: bruker.fornavn,
      etternavn: bruker.etternavn,
      rolle: bruker.rolle || "deltaker"
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );

  return c.json({
    ok: true,
    token,
    bruker: {
      telefon: bruker.telefon,
      fornavn: bruker.fornavn,
      etternavn: bruker.etternavn,
      epost: bruker.epost,
      rolle: bruker.rolle
    }
  });
});

// Send re-verifiseringskode (for 60-dagers regel)
app.post("/api/auth/reverify/send-code", async (c) => {
  const body = await c.req.json();
  const telefon = (body.telefon || "").replace(/\s/g, "");

  if (!/^\d{8}$/.test(telefon)) {
    return c.json({ error: "Ugyldig telefonnummer" }, 400);
  }

  const bruker = db.prepare("SELECT telefon FROM brukere WHERE telefon = ? AND verifisert = 1").get(telefon);
  if (!bruker) {
    return c.json({ error: "Bruker ikke funnet" }, 404);
  }

  if (!checkOTPRate(telefon)) {
    return c.json({ error: "For mange forsøk. Vent litt." }, 429);
  }

  db.prepare("UPDATE otp_codes SET used = 1 WHERE telefon = ? AND used = 0").run(telefon);

  const code = generateOTP();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  db.prepare("INSERT INTO otp_codes (telefon, code, expires_at) VALUES (?, ?, ?)").run(telefon, code, expiresAt);

  const smsResult = await sendSMS(telefon, `Din verifiseringskode for Fuglehundprøve: ${code}`);

  if (!smsResult.success) {
    return c.json({ error: "Kunne ikke sende SMS. Prøv igjen." }, 500);
  }

  return c.json({ ok: true, message: "Kode sendt på SMS", devMode: smsResult.devMode || false });
});

// Verifiser re-verifiseringskode og logg inn
app.post("/api/auth/reverify/verify", async (c) => {
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

  db.prepare("UPDATE otp_codes SET used = 1 WHERE rowid = ?").run(otp.rowid);

  const bruker = db.prepare("SELECT * FROM brukere WHERE telefon = ?").get(telefon);
  if (!bruker) {
    return c.json({ error: "Bruker ikke funnet" }, 404);
  }

  // Oppdater siste innlogging
  db.prepare("UPDATE brukere SET siste_innlogging = datetime('now') WHERE telefon = ?").run(telefon);

  const token = jwt.sign(
    {
      telefon: bruker.telefon,
      fornavn: bruker.fornavn,
      etternavn: bruker.etternavn,
      rolle: bruker.rolle || "deltaker"
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );

  return c.json({
    ok: true,
    token,
    bruker: {
      telefon: bruker.telefon,
      fornavn: bruker.fornavn,
      etternavn: bruker.etternavn,
      epost: bruker.epost,
      rolle: bruker.rolle
    }
  });
});

// ============================================
// GLEMT PASSORD
// ============================================

// Send kode for passord-reset
app.post("/api/auth/forgot-password/send-code", async (c) => {
  const body = await c.req.json();
  const telefon = (body.telefon || "").replace(/\s/g, "");

  if (!/^\d{8}$/.test(telefon)) {
    return c.json({ error: "Ugyldig telefonnummer" }, 400);
  }

  // Sjekk om bruker finnes
  const bruker = db.prepare("SELECT telefon, fornavn FROM brukere WHERE telefon = ?").get(telefon);
  if (!bruker) {
    // Av sikkerhetsgrunner gir vi samme melding uansett
    return c.json({ ok: true, message: "Hvis nummeret er registrert, sendes en kode på SMS" });
  }

  if (!checkOTPRate(telefon)) {
    return c.json({ error: "For mange forsøk. Vent litt." }, 429);
  }

  // Marker gamle koder som brukt
  db.prepare("UPDATE otp_codes SET used = 1 WHERE telefon = ? AND used = 0").run(telefon);

  // Generer ny kode
  const code = generateOTP();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 min
  db.prepare("INSERT INTO otp_codes (telefon, code, expires_at) VALUES (?, ?, ?)").run(telefon, code, expiresAt);

  const smsResult = await sendSMS(telefon, `Din kode for å tilbakestille passord: ${code}`);

  if (!smsResult.success) {
    return c.json({ error: "Kunne ikke sende SMS. Prøv igjen." }, 500);
  }

  return c.json({ ok: true, message: "Kode sendt på SMS" });
});

// Verifiser kode og få reset-token
app.post("/api/auth/forgot-password/verify-code", async (c) => {
  const body = await c.req.json();
  const telefon = (body.telefon || "").replace(/\s/g, "");
  const kode = (body.kode || "").trim();

  if (!telefon || !kode) {
    return c.json({ error: "Telefon og kode er påkrevd" }, 400);
  }

  const otp = db.prepare(
    "SELECT rowid, * FROM otp_codes WHERE telefon = ? AND code = ? AND used = 0 AND expires_at > datetime('now') ORDER BY created_at DESC LIMIT 1"
  ).get(telefon, kode);

  if (!otp) {
    return c.json({ error: "Ugyldig eller utløpt kode" }, 401);
  }

  // Marker koden som brukt
  db.prepare("UPDATE otp_codes SET used = 1 WHERE rowid = ?").run(otp.rowid);

  // Generer en engangs reset-token (gyldig i 15 minutter)
  const resetToken = randomBytes(32).toString('hex');
  const resetExpires = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  // Lagre reset-token i en midlertidig tabell eller i otp_codes
  db.prepare(`
    INSERT INTO otp_codes (telefon, code, expires_at, used)
    VALUES (?, ?, ?, 0)
  `).run(telefon, 'RESET:' + resetToken, resetExpires);

  return c.json({ ok: true, resetToken });
});

// Sett nytt passord med reset-token
app.post("/api/auth/forgot-password/reset", async (c) => {
  const body = await c.req.json();
  const telefon = (body.telefon || "").replace(/\s/g, "");
  const resetToken = (body.resetToken || "").trim();
  const nyttPassord = body.nyttPassord || "";

  if (!telefon || !resetToken || !nyttPassord) {
    return c.json({ error: "Alle felt er påkrevd" }, 400);
  }

  if (nyttPassord.length < 6) {
    return c.json({ error: "Passord må være minst 6 tegn" }, 400);
  }

  // Verifiser reset-token
  const tokenRecord = db.prepare(
    "SELECT rowid FROM otp_codes WHERE telefon = ? AND code = ? AND used = 0 AND expires_at > datetime('now')"
  ).get(telefon, 'RESET:' + resetToken);

  if (!tokenRecord) {
    return c.json({ error: "Ugyldig eller utløpt reset-lenke. Prøv på nytt." }, 401);
  }

  // Marker token som brukt
  db.prepare("UPDATE otp_codes SET used = 1 WHERE rowid = ?").run(tokenRecord.rowid);

  // Oppdater passord
  const passordHash = hashPassword(nyttPassord);
  db.prepare(`
    UPDATE brukere
    SET passord_hash = ?, verifisert = 1, siste_innlogging = datetime('now'), updated_at = datetime('now')
    WHERE telefon = ?
  `).run(passordHash, telefon);

  // Auto-backup etter passordendring
  autoBackup("passord_reset");

  // Hent bruker og generer token
  const bruker = db.prepare("SELECT * FROM brukere WHERE telefon = ?").get(telefon);

  const token = jwt.sign(
    {
      telefon: bruker.telefon,
      fornavn: bruker.fornavn,
      etternavn: bruker.etternavn,
      rolle: bruker.rolle || "deltaker"
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );

  return c.json({
    ok: true,
    message: "Passord oppdatert",
    token,
    bruker: {
      telefon: bruker.telefon,
      fornavn: bruker.fornavn,
      etternavn: bruker.etternavn,
      epost: bruker.epost,
      rolle: bruker.rolle
    }
  });
});

// Endre passord (innlogget bruker)
app.post("/api/auth/change-password", async (c) => {
  const body = await c.req.json();
  const telefon = (body.telefon || "").replace(/\s/g, "");
  const currentPassword = body.currentPassword || "";
  const newPassword = body.newPassword || "";

  if (!/^\d{8}$/.test(telefon)) {
    return c.json({ error: "Ugyldig telefonnummer" }, 400);
  }
  if (!currentPassword) {
    return c.json({ error: "Nåværende passord er påkrevd" }, 400);
  }
  if (!newPassword || newPassword.length < 8) {
    return c.json({ error: "Nytt passord må være minst 8 tegn" }, 400);
  }

  // Hent bruker
  const bruker = db.prepare("SELECT * FROM brukere WHERE telefon = ? AND verifisert = 1").get(telefon);
  if (!bruker) {
    return c.json({ error: "Bruker ikke funnet" }, 404);
  }

  // Verifiser nåværende passord
  if (!verifyPassword(currentPassword, bruker.passord_hash)) {
    return c.json({ error: "Feil nåværende passord" }, 401);
  }

  // Oppdater passord
  const passordHash = hashPassword(newPassword);
  db.prepare(`
    UPDATE brukere
    SET passord_hash = ?, updated_at = datetime('now')
    WHERE telefon = ?
  `).run(passordHash, telefon);

  // Auto-backup etter passordendring
  autoBackup("passord_endret");

  return c.json({
    ok: true,
    message: "Passord endret"
  });
});

// ============================================
// KLUBB-AUTENTISERING MED PASSORD
// ============================================

// Registrer ny klubb - send SMS-kode
app.post("/api/auth/klubb/register/send-code", async (c) => {
  const body = await c.req.json();
  const telefon = (body.telefon || "").replace(/\s/g, "");
  const klubbNavn = (body.navn || "").trim();
  const orgnummer = (body.orgnummer || "").trim();

  if (!/^\d{8}$/.test(telefon)) {
    return c.json({ error: "Ugyldig telefonnummer (8 siffer)" }, 400);
  }
  if (!klubbNavn) {
    return c.json({ error: "Klubbnavn er påkrevd" }, 400);
  }

  // Sjekk om klubb med orgnummer allerede finnes
  if (orgnummer) {
    const existing = db.prepare("SELECT id FROM klubber WHERE orgnummer = ?").get(orgnummer);
    if (existing) {
      return c.json({ error: "Klubb med dette organisasjonsnummeret eksisterer allerede" }, 409);
    }
  }

  if (!checkOTPRate(telefon)) {
    return c.json({ error: "For mange forsøk. Vent litt." }, 429);
  }

  db.prepare("UPDATE otp_codes SET used = 1 WHERE telefon = ? AND used = 0").run(telefon);

  const code = generateOTP();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  db.prepare("INSERT INTO otp_codes (telefon, code, expires_at) VALUES (?, ?, ?)").run(telefon, code, expiresAt);

  const smsResult = await sendSMS(telefon, `Verifiseringskode for ${klubbNavn}: ${code}`);

  if (!smsResult.success) {
    return c.json({ error: "Kunne ikke sende SMS. Prøv igjen." }, 500);
  }

  return c.json({ ok: true, message: "Kode sendt på SMS", devMode: smsResult.devMode || false });
});

// Verifiser og opprett klubb med passord
app.post("/api/auth/klubb/register/verify", async (c) => {
  const body = await c.req.json();
  const telefon = (body.telefon || "").replace(/\s/g, "");
  const code = (body.code || "").trim();
  const passord = body.passord || "";
  const klubbNavn = (body.navn || "").trim();
  const orgnummer = (body.orgnummer || "").trim();
  const epost = (body.epost || "").trim();
  const region = (body.region || "").trim();
  const lederNavn = (body.lederNavn || "").trim();

  if (!telefon || !code || !passord || !klubbNavn) {
    return c.json({ error: "Alle påkrevde felt må fylles ut" }, 400);
  }

  const otp = db.prepare(
    "SELECT rowid, * FROM otp_codes WHERE telefon = ? AND code = ? AND used = 0 AND expires_at > datetime('now') ORDER BY created_at DESC LIMIT 1"
  ).get(telefon, code);

  if (!otp) {
    return c.json({ error: "Ugyldig eller utløpt kode" }, 401);
  }

  db.prepare("UPDATE otp_codes SET used = 1 WHERE rowid = ?").run(otp.rowid);

  const passordHash = hashPassword(passord);
  const klubbId = `klubb_${Date.now()}`;
  const now = new Date().toISOString();

  // Opprett klubb
  db.prepare(`
    INSERT INTO klubber (id, orgnummer, navn, region, passord_hash, admin_telefon, admin_epost, verifisert, siste_innlogging)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
  `).run(klubbId, orgnummer || null, klubbNavn, region, passordHash, telefon, epost, now);

  const klubb = db.prepare("SELECT * FROM klubber WHERE id = ?").get(klubbId);

  // Opprett brukerprofil for klubbleder hvis den ikke finnes
  let brukerOpprettet = false;
  let isFkfDommer = false;
  const eksisterendeBruker = db.prepare("SELECT telefon, rolle FROM brukere WHERE telefon = ?").get(telefon);

  // Sjekk om dette er en FKF-godkjent dommer
  const normalized = normalizePhone(telefon);
  const fkfDommer = db.prepare(`
    SELECT id, fornavn, etternavn, linked_bruker_telefon
    FROM fkf_godkjente_dommere
    WHERE aktiv = 1 AND (telefon1_normalized = ? OR telefon2_normalized = ?)
  `).get(normalized, normalized);

  if (fkfDommer) {
    isFkfDommer = true;
  }

  if (!eksisterendeBruker && lederNavn) {
    // Split navn i fornavn og etternavn
    const navnDeler = lederNavn.trim().split(/\s+/);
    const fornavn = navnDeler[0] || "";
    const etternavn = navnDeler.slice(1).join(" ") || "";

    // Sett rolle - inkluder dommer hvis FKF-godkjent
    const rolle = fkfDommer ? 'deltaker,dommer' : 'deltaker';

    db.prepare(`
      INSERT INTO brukere (telefon, fornavn, etternavn, epost, passord_hash, verifisert, siste_innlogging, rolle)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    `).run(telefon, fornavn, etternavn, epost, passordHash, now, rolle);
    brukerOpprettet = true;
    console.log(`📱 Brukerprofil opprettet for klubbleder: ${lederNavn} (${telefon})${fkfDommer ? ' [FKF-dommer]' : ''}`);

    // Oppdater FKF-dommer kobling
    if (fkfDommer && !fkfDommer.linked_bruker_telefon) {
      db.prepare("UPDATE fkf_godkjente_dommere SET linked_bruker_telefon = ?, linked_at = datetime('now') WHERE id = ?").run(telefon, fkfDommer.id);
      db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").run(
        "auto_dommer_klubb_registrering",
        `Klubbleder ${lederNavn} (${telefon}) fikk automatisk dommer-rolle ved klubb-registrering (matchet FKF-dommer: ${fkfDommer.fornavn} ${fkfDommer.etternavn})`
      );
    }
  } else if (eksisterendeBruker && fkfDommer && !eksisterendeBruker.rolle.includes('dommer')) {
    // Eksisterende bruker som er FKF-dommer men mangler rollen
    const nyRolle = eksisterendeBruker.rolle + ',dommer';
    db.prepare("UPDATE brukere SET rolle = ?, updated_at = datetime('now') WHERE telefon = ?").run(nyRolle, telefon);
    if (!fkfDommer.linked_bruker_telefon) {
      db.prepare("UPDATE fkf_godkjente_dommere SET linked_bruker_telefon = ?, linked_at = datetime('now') WHERE id = ?").run(telefon, fkfDommer.id);
    }
  }

  const token = jwt.sign(
    {
      klubbId: klubb.id,
      navn: klubb.navn,
      type: "klubb"
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );

  return c.json({
    ok: true,
    token,
    klubb: {
      id: klubb.id,
      navn: klubb.navn,
      orgnummer: klubb.orgnummer,
      region: klubb.region
    },
    brukerOpprettet,
    isFkfDommer
  });
});

// Klubb-innlogging med passord
app.post("/api/auth/klubb/login", async (c) => {
  const body = await c.req.json();
  const identifier = (body.identifier || "").trim(); // kan være orgnummer, klubb-id eller admin-telefon
  const passord = body.passord || "";

  if (!identifier || !passord) {
    return c.json({ error: "Klubb-ID og passord er påkrevd" }, 400);
  }

  // Finn klubb basert på ulike identifikatorer
  let klubb = db.prepare("SELECT * FROM klubber WHERE id = ? OR orgnummer = ? OR admin_telefon = ?")
    .get(identifier, identifier, identifier.replace(/\s/g, ""));

  if (!klubb) {
    return c.json({ error: "Klubb ikke funnet" }, 401);
  }

  if (!klubb.verifisert) {
    return c.json({ error: "Klubben er ikke verifisert" }, 401);
  }

  if (!verifyPassword(passord, klubb.passord_hash)) {
    return c.json({ error: "Feil passord" }, 401);
  }

  // Sjekk re-verifisering
  if (needsReverification(klubb.siste_innlogging)) {
    return c.json({
      requiresVerification: true,
      message: "Det er over 60 dager siden siste innlogging. Verifiser med SMS-kode.",
      telefon: klubb.admin_telefon,
      klubbId: klubb.id
    }, 200);
  }

  db.prepare("UPDATE klubber SET siste_innlogging = datetime('now') WHERE id = ?").run(klubb.id);

  const token = jwt.sign(
    {
      klubbId: klubb.id,
      navn: klubb.navn,
      type: "klubb"
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );

  return c.json({
    ok: true,
    token,
    klubb: {
      id: klubb.id,
      navn: klubb.navn,
      orgnummer: klubb.orgnummer,
      region: klubb.region
    }
  });
});

// Klubb re-verifisering
app.post("/api/auth/klubb/reverify/send-code", async (c) => {
  const body = await c.req.json();
  const klubbId = body.klubbId;

  const klubb = db.prepare("SELECT * FROM klubber WHERE id = ?").get(klubbId);
  if (!klubb || !klubb.admin_telefon) {
    return c.json({ error: "Klubb ikke funnet" }, 404);
  }

  const telefon = klubb.admin_telefon;

  if (!checkOTPRate(telefon)) {
    return c.json({ error: "For mange forsøk. Vent litt." }, 429);
  }

  db.prepare("UPDATE otp_codes SET used = 1 WHERE telefon = ? AND used = 0").run(telefon);

  const code = generateOTP();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  db.prepare("INSERT INTO otp_codes (telefon, code, expires_at) VALUES (?, ?, ?)").run(telefon, code, expiresAt);

  const smsResult = await sendSMS(telefon, `Verifiseringskode for ${klubb.navn}: ${code}`);

  if (!smsResult.success) {
    return c.json({ error: "Kunne ikke sende SMS. Prøv igjen." }, 500);
  }

  return c.json({ ok: true, message: "Kode sendt på SMS", devMode: smsResult.devMode || false });
});

// Verifiser klubb re-verifisering
app.post("/api/auth/klubb/reverify/verify", async (c) => {
  const body = await c.req.json();
  const klubbId = body.klubbId;
  const code = (body.code || "").trim();

  const klubb = db.prepare("SELECT * FROM klubber WHERE id = ?").get(klubbId);
  if (!klubb) {
    return c.json({ error: "Klubb ikke funnet" }, 404);
  }

  const telefon = klubb.admin_telefon;

  const otp = db.prepare(
    "SELECT rowid, * FROM otp_codes WHERE telefon = ? AND code = ? AND used = 0 AND expires_at > datetime('now') ORDER BY created_at DESC LIMIT 1"
  ).get(telefon, code);

  if (!otp) {
    return c.json({ error: "Ugyldig eller utløpt kode" }, 401);
  }

  db.prepare("UPDATE otp_codes SET used = 1 WHERE rowid = ?").run(otp.rowid);
  db.prepare("UPDATE klubber SET siste_innlogging = datetime('now') WHERE id = ?").run(klubb.id);

  const token = jwt.sign(
    {
      klubbId: klubb.id,
      navn: klubb.navn,
      type: "klubb"
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );

  return c.json({
    ok: true,
    token,
    klubb: {
      id: klubb.id,
      navn: klubb.navn,
      orgnummer: klubb.orgnummer,
      region: klubb.region
    }
  });
});

// ============================================
// SITE-LOCK (passordbeskyttelse for hele siden)
// ============================================

// Sjekk om site-lock er aktivert
app.get("/api/site-lock/status", (c) => {
  return c.json({ enabled: !!SITE_PIN });
});

// Verifiser PIN
app.post("/api/site-lock/verify", async (c) => {
  if (!SITE_PIN) {
    return c.json({ ok: true });
  }

  const body = await c.req.json();
  const { pin } = body;

  if (pin === SITE_PIN) {
    return c.json({ ok: true });
  }

  return c.json({ error: "Feil PIN" }, 401);
});

// Admin: Sett/endre PIN (krever admin)
app.put("/api/site-lock/pin", requireAdmin, async (c) => {
  const body = await c.req.json();
  // I produksjon ville vi lagret dette i database
  // For nå: logg at admin vil endre PIN
  console.log("Admin vil endre site PIN - må gjøres i .env");
  return c.json({ message: "PIN må endres i .env filen og server restartes" });
});

// ============================================
// ADMIN-LOCK API (beskytter admin-sider)
// ============================================

// Sjekk om admin-lock er aktivert
app.get("/api/admin-lock/status", (c) => {
  return c.json({ enabled: !!ADMIN_PIN });
});

// Verifiser admin PIN
app.post("/api/admin-lock/verify", async (c) => {
  if (!ADMIN_PIN) {
    return c.json({ ok: true });
  }

  const body = await c.req.json();
  const { pin } = body;

  if (pin === ADMIN_PIN) {
    return c.json({ ok: true });
  }

  return c.json({ error: "Feil admin-PIN" }, 401);
});

// --- localStorage bridge API ---
// Storage-lesing er åpen (trengs for shim å hente initial data)
app.get("/api/storage/:key", (c) => {
  const key = c.req.param("key");
  const row = db.prepare("SELECT value FROM kv_store WHERE key = ?").get(key);
  if (!row) return c.json({ value: null });
  return c.json({ value: JSON.parse(row.value) });
});

// Storage-skriving krever innlogging
app.put("/api/storage/:key", requireAuth, async (c) => {
  const key = c.req.param("key");
  const body = await c.req.json();
  const value = JSON.stringify(body.value);
  db.prepare("INSERT OR REPLACE INTO kv_store (key, value, updated_at) VALUES (?, ?, datetime('now'))").run(key, value);
  return c.json({ ok: true });
});

// Storage-sletting krever admin
app.delete("/api/storage/:key", requireAdmin, (c) => {
  const key = c.req.param("key");
  db.prepare("DELETE FROM kv_store WHERE key = ?").run(key);
  return c.json({ ok: true });
});

// Liste alle keys krever admin
app.get("/api/storage", requireAdmin, (c) => {
  const rows = db.prepare("SELECT key, updated_at FROM kv_store ORDER BY key").all();
  return c.json({ keys: rows });
});

// --- Trial config (admin) ---
app.get("/api/trial", (c) => {
  const row = db.prepare("SELECT * FROM trial_config WHERE id = 1").get();
  return c.json(row);
});

app.put("/api/trial", requireAdmin, async (c) => {
  const body = await c.req.json();
  const bruker = c.get("bruker");
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
    db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").run("trial_update", JSON.stringify({ ...body, endret_av: bruker.telefon }));
  }
  const row = db.prepare("SELECT * FROM trial_config WHERE id = 1").get();
  return c.json(row);
});

// --- Admin log (krever admin) ---
app.get("/api/admin/log", requireAdmin, (c) => {
  const limit = Number(c.req.query("limit") || 50);
  const rows = db.prepare("SELECT * FROM admin_log ORDER BY id DESC LIMIT ?").all(limit);
  return c.json({ items: rows });
});

// ============================================
// SPØRREUNDERSØKELSER API
// ============================================

// Motta undersøkelsessvar (åpen for alle)
app.post("/api/undersokelse", async (c) => {
  try {
    const data = await c.req.json();
    const ip = c.req.header("x-forwarded-for") || c.req.header("x-real-ip") || "ukjent";
    const source = data.source || "ukjent";

    db.prepare(`
      INSERT INTO undersokelser (data, source, ip_address)
      VALUES (?, ?, ?)
    `).run(JSON.stringify(data), source, ip);

    db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").run(
      "undersokelse_mottatt",
      `Nytt svar fra ${data.navn || data.kontakt_navn || 'Anonym'} (${source})`
    );

    // Auto-backup ved nytt undersøkelsessvar
    autoBackup("undersokelse");

    return c.json({ ok: true, message: "Takk for ditt svar!" });
  } catch (err) {
    console.error("Feil ved lagring av undersøkelse:", err);
    return c.json({ error: "Kunne ikke lagre svar" }, 500);
  }
});

// Hent alle undersøkelsessvar (admin-panel er beskyttet via admin-lock)
app.get("/api/undersokelser", (c) => {
  const rows = db.prepare("SELECT * FROM undersokelser ORDER BY created_at DESC").all();
  // Parse JSON data for hver rad
  const parsed = rows.map(r => ({
    ...r,
    data: JSON.parse(r.data)
  }));
  return c.json({ items: parsed, count: rows.length });
});

// Slett undersøkelsessvar (kun admin)
app.delete("/api/undersokelser/:id", requireAdmin, (c) => {
  const id = c.req.param("id");
  const existing = db.prepare("SELECT id FROM undersokelser WHERE id = ?").get(id);
  if (!existing) return c.json({ error: "Svar ikke funnet" }, 404);

  db.prepare("DELETE FROM undersokelser WHERE id = ?").run(id);
  return c.json({ ok: true });
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

// Dommer-statistikk for superadmin
app.get("/api/stats/dommere", (c) => {
  const totalt = db.prepare("SELECT COUNT(*) as n FROM fkf_godkjente_dommere WHERE aktiv = 1").get().n;
  const medProfil = db.prepare("SELECT COUNT(*) as n FROM fkf_godkjente_dommere WHERE aktiv = 1 AND linked_bruker_telefon IS NOT NULL").get().n;
  const utenProfil = totalt - medProfil;

  // Liste over dommere med profilstatus
  const dommere = db.prepare(`
    SELECT
      d.id, d.fornavn, d.etternavn, d.telefon1, d.telefon2, d.epost,
      d.linked_bruker_telefon, d.linked_at,
      b.rolle as bruker_rolle
    FROM fkf_godkjente_dommere d
    LEFT JOIN brukere b ON d.linked_bruker_telefon = b.telefon
    WHERE d.aktiv = 1
    ORDER BY d.etternavn, d.fornavn
  `).all();

  return c.json({
    totalt,
    medProfil,
    utenProfil,
    prosent: totalt > 0 ? Math.round((medProfil / totalt) * 100) : 0,
    dommere
  });
});

// ============================================
// BRUKERE API
// ============================================

// Hent alle brukere
app.get("/api/brukere", (c) => {
  const rows = db.prepare("SELECT * FROM brukere ORDER BY etternavn, fornavn").all();
  return c.json(rows);
});

// Søk etter brukere (for autocomplete)
app.get("/api/brukere/sok", (c) => {
  const q = c.req.query("q") || "";
  if (q.length < 2) {
    return c.json([]);
  }
  const searchTerm = `%${q}%`;
  const rows = db.prepare(`
    SELECT telefon, fornavn, etternavn, epost, rolle
    FROM brukere
    WHERE fornavn LIKE ? OR etternavn LIKE ? OR telefon LIKE ?
    ORDER BY etternavn, fornavn
    LIMIT 10
  `).all(searchTerm, searchTerm, searchTerm);
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

  const existing = db.prepare("SELECT telefon, rolle FROM brukere WHERE telefon = ?").get(telefon);
  let nyRolle = body.rolle || (existing ? existing.rolle : 'deltaker');
  const hadDommerRolle = existing && existing.rolle && existing.rolle.includes('dommer');
  const vilHaDommerRolle = nyRolle.includes('dommer');

  // Sjekk om telefonnummeret matcher en FKF-godkjent dommer
  const normalized = normalizePhone(telefon);
  const fkfDommer = db.prepare(`
    SELECT id, fornavn, etternavn FROM fkf_godkjente_dommere
    WHERE aktiv = 1 AND (telefon1_normalized = ? OR telefon2_normalized = ?)
  `).get(normalized, normalized);

  // Automatisk gi dommer-rolle hvis telefonnummeret matcher FKF-listen
  if (fkfDommer && !hadDommerRolle && !vilHaDommerRolle) {
    // Legg til dommer-rolle automatisk
    if (!nyRolle.includes('dommer')) {
      nyRolle = nyRolle ? nyRolle + ',dommer' : 'deltaker,dommer';
    }
    console.log(`[Auto-dommer] Bruker ${telefon} gjenkjent som FKF-dommer: ${fkfDommer.fornavn} ${fkfDommer.etternavn}`);
    db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").run(
      "auto_dommer_tildelt",
      `Bruker ${telefon} fikk automatisk dommer-rolle (matchet FKF-dommer: ${fkfDommer.fornavn} ${fkfDommer.etternavn})`
    );
  }

  // Hvis bruker eksplisitt vil ha dommer-rolle og ikke allerede har det, sjekk FKF-listen
  if (vilHaDommerRolle && !hadDommerRolle && !fkfDommer) {
    return c.json({
      error: "Ikke godkjent dommer",
      detail: "Du må være registrert som godkjent dommer hos FKF for å få dommer-tilgang. Kontakt din klubb hvis du mener dette er feil."
    }, 403);
  }

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
      nyRolle
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

// GDPR: Eksporter alle brukerdata (Art. 15/20)
app.get("/api/brukere/:telefon/export", requireAuth, (c) => {
  const payload = c.get("bruker");
  const telefon = c.req.param("telefon");
  if (payload.telefon !== telefon && !hasAnyRole(payload.rolle, ["admin"])) {
    return c.json({ error: "Ingen tilgang" }, 403);
  }

  const bruker = db.prepare("SELECT * FROM brukere WHERE telefon = ?").get(telefon);
  if (!bruker) return c.json({ error: "Bruker ikke funnet" }, 404);

  const hunder = db.prepare("SELECT * FROM hunder WHERE eier_telefon = ?").all(telefon);
  const hundIds = hunder.map(h => h.id);
  const resultater = hundIds.length > 0
    ? db.prepare(`SELECT * FROM resultater WHERE hund_id IN (${hundIds.map(() => '?').join(',')})`).all(...hundIds)
    : [];
  const klubbRoller = db.prepare("SELECT * FROM klubb_admins WHERE telefon = ?").all(telefon);
  const dommerTildelinger = db.prepare("SELECT * FROM dommer_tildelinger WHERE dommer_telefon = ?").all(telefon);

  return c.json({
    eksportert: new Date().toISOString(),
    beskrivelse: "Alle personopplysninger lagret om deg i Fuglehundprøve-systemet",
    bruker, hunder, resultater, klubb_roller: klubbRoller, dommer_tildelinger: dommerTildelinger
  });
});

// GDPR: Slett alle brukerdata (Art. 17)
app.delete("/api/brukere/:telefon", requireAuth, (c) => {
  const payload = c.get("bruker");
  const telefon = c.req.param("telefon");
  if (payload.telefon !== telefon && !hasAnyRole(payload.rolle, ["admin"])) {
    return c.json({ error: "Ingen tilgang" }, 403);
  }

  const bruker = db.prepare("SELECT telefon FROM brukere WHERE telefon = ?").get(telefon);
  if (!bruker) return c.json({ error: "Bruker ikke funnet" }, 404);

  const hundIds = db.prepare("SELECT id FROM hunder WHERE eier_telefon = ?").all(telefon).map(h => h.id);
  if (hundIds.length > 0) {
    db.prepare(`DELETE FROM resultater WHERE hund_id IN (${hundIds.map(() => '?').join(',')})`).run(...hundIds);
    db.prepare(`DELETE FROM kritikker WHERE hund_id IN (${hundIds.map(() => '?').join(',')})`).run(...hundIds);
  }
  db.prepare("DELETE FROM hunder WHERE eier_telefon = ?").run(telefon);
  db.prepare("DELETE FROM dommer_tildelinger WHERE dommer_telefon = ?").run(telefon);
  db.prepare("DELETE FROM klubb_admins WHERE telefon = ?").run(telefon);
  db.prepare("DELETE FROM otp_codes WHERE telefon = ?").run(telefon);
  db.prepare("DELETE FROM brukere WHERE telefon = ?").run(telefon);

  db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").run(
    "bruker_slettet", `Bruker ${telefon} slettet sine data (GDPR Art. 17)`
  );
  return c.json({ ok: true, message: "Alle dine data er slettet" });
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

// Opprett ny hund
app.post("/api/hunder", async (c) => {
  const body = await c.req.json();
  const { regnr, navn, rase, kjonn, fodselsdato, eier_telefon, klubb_id, bilde } = body;

  if (!navn) {
    return c.json({ error: "Navn er påkrevd" }, 400);
  }

  if (!eier_telefon) {
    return c.json({ error: "Eier-telefon er påkrevd" }, 400);
  }

  // Sjekk at eier finnes
  const eier = db.prepare("SELECT telefon FROM brukere WHERE telefon = ?").get(eier_telefon);
  if (!eier) {
    return c.json({ error: "Eier ikke funnet" }, 404);
  }

  // Sjekk om regnr allerede finnes (hvis oppgitt)
  if (regnr) {
    const existing = db.prepare("SELECT id FROM hunder WHERE regnr = ?").get(regnr);
    if (existing) {
      return c.json({ error: "En hund med dette registreringsnummeret finnes allerede" }, 409);
    }
  }

  try {
    const result = db.prepare(`
      INSERT INTO hunder (regnr, navn, rase, kjonn, fodt, eier_telefon, klubb_id, bilde)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(regnr || null, navn, rase || null, kjonn || null, fodselsdato || null, eier_telefon, klubb_id || null, bilde || null);

    const newHund = db.prepare("SELECT * FROM hunder WHERE id = ?").get(result.lastInsertRowid);
    return c.json(newHund, 201);
  } catch (e) {
    console.error("Feil ved opprettelse av hund:", e);
    return c.json({ error: "Kunne ikke opprette hund" }, 500);
  }
});

// Oppdater hund
app.put("/api/hunder/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();

  const existing = db.prepare("SELECT * FROM hunder WHERE id = ?").get(id);
  if (!existing) {
    return c.json({ error: "Hund ikke funnet" }, 404);
  }

  // Map frontend field names → db column names
  const fieldMap = {
    regnr: "regnr", navn: "navn", rase: "rase", kjonn: "kjonn",
    fodselsdato: "fodt", fodt: "fodt", klubb_id: "klubb_id", bilde: "bilde"
  };
  const sets = [];
  const vals = [];

  for (const [bodyKey, dbCol] of Object.entries(fieldMap)) {
    if (bodyKey in body) {
      sets.push(`${dbCol} = ?`);
      vals.push(body[bodyKey]);
    }
  }

  if (sets.length === 0) {
    return c.json({ error: "Ingen felter å oppdatere" }, 400);
  }

  vals.push(id);
  db.prepare(`UPDATE hunder SET ${sets.join(", ")} WHERE id = ?`).run(...vals);

  const updated = db.prepare("SELECT * FROM hunder WHERE id = ?").get(id);
  return c.json(updated);
});

// Slett hund
app.delete("/api/hunder/:id", (c) => {
  const id = c.req.param("id");

  const existing = db.prepare("SELECT * FROM hunder WHERE id = ?").get(id);
  if (!existing) {
    return c.json({ error: "Hund ikke funnet" }, 404);
  }

  // Slett relaterte data først
  db.prepare("DELETE FROM resultater WHERE hund_id = ?").run(id);
  db.prepare("DELETE FROM hunder WHERE id = ?").run(id);

  return c.json({ ok: true, message: "Hund slettet" });
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
// BRØNNØYSUND OPPSLAG (organisasjonsnummer)
// ============================================

// Slå opp organisasjon i Brønnøysundregistrene (offisiell API)
app.get("/api/brreg/:orgnr", async (c) => {
  const orgnr = c.req.param("orgnr").replace(/\D/g, '');

  if (orgnr.length !== 9) {
    return c.json({ error: "Organisasjonsnummer må være 9 siffer" }, 400);
  }

  try {
    // Brønnøysundregistrenes offisielle API (gratis, ingen API-nøkkel)
    const resp = await fetch(`https://data.brreg.no/enhetsregisteret/api/enheter/${orgnr}`, {
      headers: { 'Accept': 'application/json' }
    });

    if (!resp.ok) {
      if (resp.status === 404) {
        return c.json({ error: "Organisasjonsnummer ikke funnet" }, 404);
      }
      throw new Error(`Brønnøysund API feil: ${resp.status}`);
    }

    const data = await resp.json();

    // Returner relevant info
    return c.json({
      orgnr: data.organisasjonsnummer,
      navn: data.navn,
      organisasjonsform: data.organisasjonsform?.beskrivelse || null,
      forretningsadresse: data.forretningsadresse ? {
        adresse: data.forretningsadresse.adresse?.join(', ') || '',
        postnummer: data.forretningsadresse.postnummer || '',
        poststed: data.forretningsadresse.poststed || '',
        kommune: data.forretningsadresse.kommune || ''
      } : null,
      postadresse: data.postadresse ? {
        adresse: data.postadresse.adresse?.join(', ') || '',
        postnummer: data.postadresse.postnummer || '',
        poststed: data.postadresse.poststed || ''
      } : null,
      stiftelsesdato: data.stiftelsesdato || null,
      registreringsdatoEnhetsregisteret: data.registreringsdatoEnhetsregisteret || null
    });

  } catch (err) {
    console.error('[BRREG] Feil ved oppslag:', err);
    return c.json({ error: "Kunne ikke slå opp organisasjonsnummer" }, 500);
  }
});

// ============================================
// KLUBBER API
// ============================================

// Hent alle klubber
app.get("/api/klubber", (c) => {
  const rows = db.prepare("SELECT * FROM klubber ORDER BY navn").all();
  return c.json({ klubber: rows });
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

// Hent prøver for en klubb
app.get("/api/klubber/:id/prover", (c) => {
  const klubbId = c.req.param("id");
  const prover = db.prepare(`
    SELECT p.*,
           (SELECT COUNT(*) FROM pameldinger WHERE prove_id = p.id) as antall_pameldte
    FROM prover p
    WHERE p.klubb_id = ?
    ORDER BY p.start_dato DESC
  `).all(klubbId);

  return c.json({ prover });
});

// Oppdater klubb (inkl. Vipps-nummer)
app.put("/api/klubber/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();

  const existing = db.prepare("SELECT * FROM klubber WHERE id = ?").get(id);
  if (!existing) return c.json({ error: "Klubb ikke funnet" }, 404);

  const updates = [];
  const params = [];

  if (body.navn !== undefined) { updates.push("navn = ?"); params.push(body.navn); }
  if (body.region !== undefined) { updates.push("region = ?"); params.push(body.region); }
  if (body.orgnummer !== undefined) { updates.push("orgnummer = ?"); params.push(body.orgnummer); }
  if (body.vipps_nummer !== undefined) { updates.push("vipps_nummer = ?"); params.push(body.vipps_nummer); }
  if (body.epost !== undefined) { updates.push("epost = ?"); params.push(body.epost); }
  if (body.telefon !== undefined) { updates.push("telefon = ?"); params.push(body.telefon); }
  if (body.nettside !== undefined) { updates.push("nettside = ?"); params.push(body.nettside); }
  if (body.adresse !== undefined) { updates.push("adresse = ?"); params.push(body.adresse); }
  if (body.sted !== undefined) { updates.push("sted = ?"); params.push(body.sted); }

  if (updates.length === 0) return c.json({ error: "Ingen felt å oppdatere" }, 400);

  params.push(id);
  db.prepare(`UPDATE klubber SET ${updates.join(", ")} WHERE id = ?`).run(...params);

  const updated = db.prepare("SELECT * FROM klubber WHERE id = ?").get(id);
  return c.json(updated);
});

// ============================================
// KLUBB ADMINS API
// ============================================

// Legg til administrator for en klubb
app.post("/api/klubber/:id/admins", async (c) => {
  const klubbId = c.req.param("id");
  const body = await c.req.json();
  const telefon = (body.telefon || "").replace(/\s/g, "");
  const rolle = body.rolle || "admin";

  if (!telefon || !/^\d{8}$/.test(telefon)) {
    return c.json({ error: "Ugyldig telefonnummer" }, 400);
  }

  // Sjekk at klubben eksisterer
  const klubb = db.prepare("SELECT * FROM klubber WHERE id = ?").get(klubbId);
  if (!klubb) return c.json({ error: "Klubb ikke funnet" }, 404);

  // Sjekk om brukeren eksisterer
  const bruker = db.prepare("SELECT * FROM brukere WHERE telefon = ?").get(telefon);
  if (!bruker) {
    return c.json({ error: "Brukeren finnes ikke. Be vedkommende om å opprette konto først." }, 404);
  }

  // Legg til i klubb_admins
  try {
    db.prepare(`
      INSERT OR REPLACE INTO klubb_admins (telefon, klubb_id, rolle)
      VALUES (?, ?, ?)
    `).run(telefon, klubbId, rolle);

    // Oppdater brukerens rolle til å inkludere klubbleder
    const currentRole = bruker.rolle || "deltaker";
    if (!currentRole.includes("klubbleder")) {
      db.prepare("UPDATE brukere SET rolle = ? WHERE telefon = ?").run(
        currentRole + ",klubbleder",
        telefon
      );
    }

    return c.json({ ok: true, message: "Administrator lagt til" });
  } catch (err) {
    return c.json({ error: "Kunne ikke legge til administrator" }, 500);
  }
});

// Fjern administrator fra en klubb
app.delete("/api/klubber/:id/admins/:telefon", (c) => {
  const klubbId = c.req.param("id");
  const telefon = c.req.param("telefon");

  db.prepare("DELETE FROM klubb_admins WHERE klubb_id = ? AND telefon = ?").run(klubbId, telefon);

  // Sjekk om brukeren har andre klubb-tilganger
  const andreKlubber = db.prepare("SELECT COUNT(*) as count FROM klubb_admins WHERE telefon = ?").get(telefon);
  if (andreKlubber.count === 0) {
    // Fjern klubbleder-rolle fra bruker
    const bruker = db.prepare("SELECT rolle FROM brukere WHERE telefon = ?").get(telefon);
    if (bruker && bruker.rolle) {
      const nyRolle = bruker.rolle.replace(",klubbleder", "").replace("klubbleder,", "").replace("klubbleder", "deltaker");
      db.prepare("UPDATE brukere SET rolle = ? WHERE telefon = ?").run(nyRolle || "deltaker", telefon);
    }
  }

  return c.json({ ok: true });
});

// ============================================
// KLUBB MEDLEMMER API
// ============================================

// Hent medlemmer for en klubb
app.get("/api/klubber/:id/medlemmer", (c) => {
  const klubbId = c.req.param("id");
  const medlemmer = db.prepare(`
    SELECT km.*, b.fornavn as bruker_fornavn, b.etternavn as bruker_etternavn, b.telefon as bruker_telefon
    FROM klubb_medlemmer km
    LEFT JOIN brukere b ON km.matched_bruker_telefon = b.telefon
    WHERE km.klubb_id = ?
    ORDER BY km.etternavn, km.fornavn
  `).all(klubbId);
  const total = medlemmer.length;
  const registrert = medlemmer.filter(m => m.matched_bruker_telefon).length;
  return c.json({ medlemmer, total, registrert });
});

// Importer medlemsliste
app.post("/api/klubber/:id/medlemmer/import", requireAdmin, async (c) => {
  const klubbId = c.req.param("id");
  const body = await c.req.json();
  const { medlemmer } = body;
  if (!Array.isArray(medlemmer)) {
    return c.json({ error: "Forventet 'medlemmer' array" }, 400);
  }

  const insertStmt = db.prepare(`
    INSERT OR REPLACE INTO klubb_medlemmer (klubb_id, medlemsnummer, fornavn, etternavn, telefon_normalized, epost)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  let imported = 0;
  for (const m of medlemmer) {
    insertStmt.run(klubbId, m.medlemsnummer || null, m.fornavn || '', m.etternavn || '', normalizePhone(m.telefon), m.epost || null);
    imported++;
  }

  runMemberMatching(klubbId);
  return c.json({ success: true, imported });
});

// Kjør matching manuelt
app.post("/api/klubber/:id/medlemmer/match", requireAdmin, (c) => {
  const klubbId = c.req.param("id");
  runMemberMatching(klubbId);
  const result = db.prepare(`
    SELECT COUNT(*) as total, SUM(CASE WHEN matched_bruker_telefon IS NOT NULL THEN 1 ELSE 0 END) as matched
    FROM klubb_medlemmer WHERE klubb_id = ?
  `).get(klubbId);
  return c.json({ success: true, ...result });
});

// Slett medlemsliste
app.delete("/api/klubber/:id/medlemmer", requireAdmin, (c) => {
  const klubbId = c.req.param("id");
  db.prepare("DELETE FROM klubb_medlemmer WHERE klubb_id = ?").run(klubbId);
  return c.json({ success: true });
});

// ============================================
// KLUBB-FORESPØRSLER API
// ============================================

// Send inn klubb-forespørsel (offentlig - ingen auth kreves)
app.post("/api/klubb-foresporsel", async (c) => {
  const body = await c.req.json();
  // Støtt både gammel og ny format
  const orgnummer = body.orgnummer;
  const navn = body.navn;
  const postnummer = body.postnummer || '';
  const sted = body.sted || '';
  const adresse = body.adresse || '';

  // Ny format: leder_* felter direkte
  const lederNavn = body.leder_navn || body.leder?.navn;
  const lederTelefon = body.leder_telefon || body.leder?.telefon;
  const lederEpost = body.leder_epost || body.leder?.email || '';
  const lederRolle = body.leder_rolle || 'leder';
  const passord = body.passord || '';
  const ekstraAdmins = body.ekstra_admins || body.admins || '[]';

  if (!orgnummer || !navn || !lederNavn || !lederTelefon) {
    return c.json({ error: "Mangler påkrevde felt" }, 400);
  }

  // Sjekk om orgnummer allerede finnes
  const existing = db.prepare("SELECT id FROM klubber WHERE orgnummer = ?").get(orgnummer.replace(/\s/g, ''));
  if (existing) {
    return c.json({ error: "En klubb med dette organisasjonsnummeret er allerede registrert" }, 400);
  }

  // Sjekk om det allerede er en ventende forespørsel
  const pendingRequest = db.prepare("SELECT id FROM klubb_foresporsel WHERE orgnummer = ? AND status = 'pending'").get(orgnummer.replace(/\s/g, ''));
  if (pendingRequest) {
    return c.json({ error: "Det finnes allerede en ventende forespørsel for dette organisasjonsnummeret" }, 400);
  }

  // Hash passord hvis oppgitt
  let passordHash = '';
  if (passord) {
    passordHash = await hashPassword(passord);
  }

  const normalizedPhone = normalizePhone(lederTelefon);

  // Opprett brukerprofil umiddelbart (hvis ikke finnes)
  const existingUser = db.prepare("SELECT telefon FROM brukere WHERE telefon = ?").get(normalizedPhone);
  if (!existingUser) {
    const nameParts = lederNavn.trim().split(' ');
    const fornavn = nameParts[0] || '';
    const etternavn = nameParts.slice(1).join(' ') || '';
    db.prepare(`
      INSERT INTO brukere (telefon, fornavn, etternavn, epost, rolle, passord_hash)
      VALUES (?, ?, ?, ?, 'deltaker', ?)
    `).run(normalizedPhone, fornavn, etternavn, lederEpost, passordHash);
  } else if (passordHash) {
    // Oppdater passord hvis bruker finnes men ikke har passord
    db.prepare(`
      UPDATE brukere SET passord_hash = ? WHERE telefon = ? AND (passord_hash IS NULL OR passord_hash = '')
    `).run(passordHash, normalizedPhone);
  }

  const result = db.prepare(`
    INSERT INTO klubb_foresporsel (orgnummer, navn, postnummer, sted, adresse, leder_navn, leder_telefon, leder_epost, leder_rolle, passord_hash, ekstra_admins)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    orgnummer.replace(/\s/g, ''),
    navn.trim(),
    postnummer,
    sted,
    adresse,
    lederNavn.trim(),
    normalizedPhone,
    lederEpost,
    lederRolle,
    passordHash,
    typeof ekstraAdmins === 'string' ? ekstraAdmins : JSON.stringify(ekstraAdmins)
  );

  db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").run(
    "klubb_foresporsel",
    `Ny klubb-forespørsel: ${navn} (org.nr: ${orgnummer})`
  );

  // Send SMS-varsling til superadmin (Aleksander Roel)
  const superadminTelefon = "47419082"; // Aleksander Roel
  const rolleNavn = {
    'leder': 'Leder',
    'nestleder': 'Nestleder',
    'proveleder': 'Prøveleder',
    'sekretar': 'Sekretær',
    'styremedlem': 'Styremedlem',
    'annet': 'Annet'
  }[lederRolle] || lederRolle;

  try {
    await sendSMS(superadminTelefon, `Ny klubbforespørsel: ${navn.trim()} (${orgnummer.replace(/\s/g, '')})\n\nSøker: ${lederNavn.trim()} (${rolleNavn})\nTlf: ${normalizedPhone}\n\nLogg inn på fuglehundprove.no/admin-panel.html for å behandle.`, { type: 'klubb_foresporsel' });
    console.log(`📱 SMS sendt til superadmin om ny klubbforespørsel: ${navn}`);
  } catch (err) {
    console.error('Feil ved sending av SMS til superadmin:', err);
  }

  return c.json({ success: true, id: result.lastInsertRowid, telefon: normalizedPhone });
});

// Hent alle klubb-forespørsler (kun superadmin)
app.get("/api/klubb-foresporsel", (c) => {
  const status = c.req.query("status") || "pending";
  const rows = db.prepare(`
    SELECT * FROM klubb_foresporsel
    WHERE status = ?
    ORDER BY created_at DESC
  `).all(status);
  return c.json({ foresporsel: rows });
});

// Godkjenn klubb-forespørsel (kun superadmin)
app.post("/api/klubb-foresporsel/:id/godkjenn", async (c) => {
  const id = c.req.param("id");
  const foresporsel = db.prepare("SELECT * FROM klubb_foresporsel WHERE id = ?").get(id);

  if (!foresporsel) {
    return c.json({ error: "Forespørsel ikke funnet" }, 404);
  }

  if (foresporsel.status !== 'pending') {
    return c.json({ error: "Denne forespørselen er allerede behandlet" }, 400);
  }

  // Generer klubb-ID fra navn
  const klubbId = foresporsel.navn
    .toLowerCase()
    .replace(/[^a-zæøå0-9\s]/g, '')
    .replace(/\s+/g, '-')
    .substring(0, 30);

  // Opprett klubb med passord_hash fra forespørselen
  db.prepare(`
    INSERT INTO klubber (id, orgnummer, navn, region, passord_hash, admin_telefon, admin_epost)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    klubbId,
    foresporsel.orgnummer,
    foresporsel.navn,
    '',
    foresporsel.passord_hash || '',
    foresporsel.leder_telefon,
    foresporsel.leder_epost
  );

  // Opprett bruker for leder hvis ikke finnes
  const existingUser = db.prepare("SELECT telefon, passord_hash FROM brukere WHERE telefon = ?").get(foresporsel.leder_telefon);
  if (!existingUser) {
    const nameParts = foresporsel.leder_navn.split(' ');
    const fornavn = nameParts[0] || '';
    const etternavn = nameParts.slice(1).join(' ') || '';
    db.prepare(`
      INSERT INTO brukere (telefon, fornavn, etternavn, epost, rolle, passord_hash)
      VALUES (?, ?, ?, ?, 'deltaker,klubbleder', ?)
    `).run(foresporsel.leder_telefon, fornavn, etternavn, foresporsel.leder_epost, foresporsel.passord_hash || '');
  } else {
    // Oppdater rolle til å inkludere klubbleder og sett passord hvis mangler
    if (!existingUser.passord_hash && foresporsel.passord_hash) {
      db.prepare(`
        UPDATE brukere SET rolle = rolle || ',klubbleder', passord_hash = ?
        WHERE telefon = ? AND rolle NOT LIKE '%klubbleder%'
      `).run(foresporsel.passord_hash, foresporsel.leder_telefon);
    } else {
      db.prepare(`
        UPDATE brukere SET rolle = rolle || ',klubbleder'
        WHERE telefon = ? AND rolle NOT LIKE '%klubbleder%'
      `).run(foresporsel.leder_telefon);
    }
  }

  // Legg til leder som klubb-admin med rolle fra forespørsel
  const lederRolle = foresporsel.leder_rolle || 'leder';
  db.prepare(`
    INSERT OR IGNORE INTO klubb_admins (telefon, klubb_id, rolle)
    VALUES (?, ?, ?)
  `).run(foresporsel.leder_telefon, klubbId, lederRolle);

  // Behandle ekstra admins
  try {
    const ekstraAdmins = JSON.parse(foresporsel.ekstra_admins || '[]');
    for (const admin of ekstraAdmins) {
      if (admin.phone) {
        const adminTlf = normalizePhone(admin.phone);
        db.prepare(`
          INSERT OR IGNORE INTO klubb_admins (telefon, klubb_id, rolle)
          VALUES (?, ?, 'admin')
        `).run(adminTlf, klubbId);
      }
    }
  } catch (e) { /* ignore */ }

  // Oppdater forespørsel-status
  db.prepare(`
    UPDATE klubb_foresporsel
    SET status = 'approved', behandlet_dato = datetime('now')
    WHERE id = ?
  `).run(id);

  db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").run(
    "klubb_godkjent",
    `Godkjent klubb: ${foresporsel.navn} (ID: ${klubbId})`
  );

  // Send SMS til kontaktperson om godkjenning
  try {
    await sendSMS(
      foresporsel.leder_telefon,
      `Hei! "${foresporsel.navn}" er godkjent. Du har tilgang til klubbens profil via "Min side" på fuglehundprove.no`,
      { type: 'klubb_godkjent' }
    );
    console.log(`📱 SMS sendt til ${foresporsel.leder_telefon} om godkjent klubb: ${foresporsel.navn}`);
  } catch (smsErr) {
    console.error("Kunne ikke sende godkjennings-SMS:", smsErr);
    // Fortsett selv om SMS feiler
  }

  return c.json({ success: true, klubbId });
});

// Avslå klubb-forespørsel (kun superadmin)
app.post("/api/klubb-foresporsel/:id/avslaa", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  const { grunn } = body;

  const foresporsel = db.prepare("SELECT * FROM klubb_foresporsel WHERE id = ?").get(id);
  if (!foresporsel) {
    return c.json({ error: "Forespørsel ikke funnet" }, 404);
  }

  db.prepare(`
    UPDATE klubb_foresporsel
    SET status = 'rejected', behandlet_dato = datetime('now'), avslag_grunn = ?
    WHERE id = ?
  `).run(grunn || '', id);

  db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").run(
    "klubb_avslatt",
    `Avslått klubb-forespørsel: ${foresporsel.navn} - ${grunn || 'Ingen grunn oppgitt'}`
  );

  return c.json({ success: true });
});

// ============================================
// SUPERADMIN API - Brukeradministrasjon
// ============================================

// Hent alle brukere (kun superadmin)
app.get("/api/superadmin/brukere", (c) => {
  const search = c.req.query("search") || '';
  const rolle = c.req.query("rolle") || '';
  const limit = parseInt(c.req.query("limit") || '50');
  const offset = parseInt(c.req.query("offset") || '0');

  let whereConditions = [];
  let params = [];

  if (search) {
    whereConditions.push("(telefon LIKE ? OR fornavn LIKE ? OR etternavn LIKE ? OR epost LIKE ?)");
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }

  if (rolle) {
    whereConditions.push("rolle LIKE ?");
    params.push(`%${rolle}%`);
  }

  const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(" AND ")}` : "";

  const rows = db.prepare(`
    SELECT telefon, fornavn, etternavn, epost, rolle, created_at
    FROM brukere
    ${whereClause}
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const totalQuery = whereClause
    ? db.prepare(`SELECT COUNT(*) as n FROM brukere ${whereClause}`).get(...params)
    : db.prepare("SELECT COUNT(*) as n FROM brukere").get();

  return c.json({ brukere: rows, total: totalQuery.n });
});

// Oppdater bruker-rolle (kun superadmin)
app.put("/api/superadmin/brukere/:telefon/rolle", async (c) => {
  const telefon = c.req.param("telefon");
  const body = await c.req.json();
  const { rolle } = body;

  if (!rolle) {
    return c.json({ error: "Rolle må oppgis" }, 400);
  }

  db.prepare("UPDATE brukere SET rolle = ?, updated_at = datetime('now') WHERE telefon = ?").run(rolle, telefon);
  db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").run(
    "bruker_rolle_endret",
    `Endret rolle for ${telefon} til: ${rolle}`
  );

  return c.json({ success: true });
});

// ============================================
// SMS-SAMTYKKE STATISTIKK (SUPERADMIN)
// ============================================

// Hent SMS-samtykke statistikk
app.get("/api/superadmin/sms-samtykke", (c) => {
  const total = db.prepare("SELECT COUNT(*) as n FROM brukere").get().n;
  const medSamtykke = db.prepare("SELECT COUNT(*) as n FROM brukere WHERE sms_samtykke = 1").get().n;
  const utenSamtykke = total - medSamtykke;

  // Hent liste over brukere med samtykke (for eksport)
  const brukere = db.prepare(`
    SELECT telefon, fornavn, etternavn, epost, sms_samtykke, sms_samtykke_tidspunkt, created_at
    FROM brukere
    WHERE sms_samtykke = 1
    ORDER BY sms_samtykke_tidspunkt DESC
  `).all();

  return c.json({
    statistikk: {
      total,
      medSamtykke,
      utenSamtykke,
      prosent: total > 0 ? Math.round((medSamtykke / total) * 100) : 0
    },
    brukere
  });
});

// Eksporter SMS-samtykke rapport til CSV
app.get("/api/superadmin/sms-samtykke/export", (c) => {
  const brukere = db.prepare(`
    SELECT telefon, fornavn, etternavn, epost, sms_samtykke, sms_samtykke_tidspunkt, created_at
    FROM brukere
    WHERE sms_samtykke = 1
    ORDER BY sms_samtykke_tidspunkt DESC
  `).all();

  // Lag CSV-header
  const header = "Telefon,Fornavn,Etternavn,E-post,SMS-samtykke,Samtykke-tidspunkt,Bruker-opprettet";
  const rows = brukere.map(b => {
    return [
      b.telefon,
      b.fornavn || '',
      b.etternavn || '',
      b.epost || '',
      b.sms_samtykke ? 'Ja' : 'Nei',
      b.sms_samtykke_tidspunkt || '',
      b.created_at || ''
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',');
  });

  const csv = [header, ...rows].join('\n');

  c.header('Content-Type', 'text/csv; charset=utf-8');
  c.header('Content-Disposition', `attachment; filename="sms-samtykke-rapport-${new Date().toISOString().split('T')[0]}.csv"`);
  return c.body('\ufeff' + csv); // BOM for Excel-kompatibilitet
});

// ============================================
// GDPR SAMTYKKE API (SUPERADMIN)
// ============================================

// Hent samtykke-oversikt med søk og filter
app.get("/api/superadmin/samtykker", (c) => {
  const search = c.req.query("search") || "";
  const filter = c.req.query("filter") || "alle";
  const limit = parseInt(c.req.query("limit") || "100");

  let whereClause = "1=1";
  const params = [];

  // Søk
  if (search) {
    whereClause += " AND (fornavn LIKE ? OR etternavn LIKE ? OR telefon LIKE ? OR epost LIKE ?)";
    const searchParam = `%${search}%`;
    params.push(searchParam, searchParam, searchParam, searchParam);
  }

  // Filter
  if (filter === "med_samtykke") {
    whereClause += " AND samtykke_gitt IS NOT NULL";
  } else if (filter === "uten_samtykke") {
    whereClause += " AND samtykke_gitt IS NULL";
  }

  const brukere = db.prepare(`
    SELECT telefon, fornavn, etternavn, epost, rolle, samtykke_gitt, created_at
    FROM brukere
    WHERE ${whereClause}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...params, limit);

  // Statistikk
  const total = db.prepare("SELECT COUNT(*) as n FROM brukere").get().n;
  const medSamtykke = db.prepare("SELECT COUNT(*) as n FROM brukere WHERE samtykke_gitt IS NOT NULL").get().n;

  return c.json({
    brukere,
    total,
    statistikk: {
      med_samtykke: medSamtykke,
      uten_samtykke: total - medSamtykke
    }
  });
});

// GDPR Innsyn - hent all data for en bruker (GDPR Art. 15)
app.get("/api/superadmin/innsyn/:telefon", (c) => {
  const telefon = c.req.param("telefon");

  const bruker = db.prepare("SELECT * FROM brukere WHERE telefon = ?").get(telefon);
  if (!bruker) return c.json({ error: "Bruker ikke funnet" }, 404);

  // Hent relaterte data - bruk riktige kolonnenavn fra databaseskjema
  const hunder = db.prepare("SELECT * FROM hunder WHERE eier_telefon = ?").all(telefon);
  const pameldinger = db.prepare("SELECT * FROM pameldinger WHERE forer_telefon = ? OR pameldt_av_telefon = ?").all(telefon, telefon);
  const kritikker = db.prepare("SELECT * FROM kritikker WHERE dommer_telefon = ?").all(telefon);
  const fullmakter = db.prepare("SELECT * FROM fullmakter WHERE giver_telefon = ? OR mottaker_telefon = ?").all(telefon, telefon);
  const klubbRoller = db.prepare("SELECT * FROM klubb_admins WHERE telefon = ?").all(telefon);
  const smsLogg = db.prepare("SELECT id, type, til, fra, status, created_at FROM sms_log WHERE til = ? OR fra = ? ORDER BY created_at DESC LIMIT 50").all(telefon, telefon);

  // Fjern sensitiv data som passord
  delete bruker.passord_hash;

  return c.json({
    gdpr_info: {
      formål: "GDPR Art. 15 - Rett til innsyn",
      beskrivelse: "Komplett oversikt over alle personopplysninger lagret om deg",
      eksportert: new Date().toISOString(),
      databehandler: "Fuglehundprøve.no"
    },
    bruker,
    hunder,
    pameldinger,
    kritikker,
    fullmakter,
    klubbRoller,
    smsLogg
  });
});

// Sett samtykke manuelt (superadmin)
app.post("/api/superadmin/samtykke/:telefon", (c) => {
  const telefon = c.req.param("telefon");

  const bruker = db.prepare("SELECT * FROM brukere WHERE telefon = ?").get(telefon);
  if (!bruker) return c.json({ error: "Bruker ikke funnet" }, 404);

  db.prepare("UPDATE brukere SET samtykke_gitt = datetime('now') WHERE telefon = ?").run(telefon);

  return c.json({ ok: true, samtykke_gitt: new Date().toISOString() });
});

// Trekk samtykke (superadmin)
app.delete("/api/superadmin/samtykke/:telefon", (c) => {
  const telefon = c.req.param("telefon");

  const bruker = db.prepare("SELECT * FROM brukere WHERE telefon = ?").get(telefon);
  if (!bruker) return c.json({ error: "Bruker ikke funnet" }, 404);

  db.prepare("UPDATE brukere SET samtykke_gitt = NULL WHERE telefon = ?").run(telefon);

  return c.json({ ok: true });
});

// Eksporter samtykker til CSV
app.get("/api/superadmin/samtykker/eksport", (c) => {
  const brukere = db.prepare(`
    SELECT telefon, fornavn, etternavn, epost, rolle, samtykke_gitt, created_at
    FROM brukere
    ORDER BY samtykke_gitt DESC NULLS LAST, created_at DESC
  `).all();

  const header = "Telefon,Fornavn,Etternavn,E-post,Rolle,Samtykke gitt,Bruker opprettet";
  const rows = brukere.map(b => {
    return [
      b.telefon,
      b.fornavn || '',
      b.etternavn || '',
      b.epost || '',
      b.rolle || 'deltaker',
      b.samtykke_gitt || 'Mangler',
      b.created_at || ''
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',');
  });

  const csv = [header, ...rows].join('\n');

  c.header('Content-Type', 'text/csv; charset=utf-8');
  c.header('Content-Disposition', `attachment; filename="gdpr-samtykker-${new Date().toISOString().split('T')[0]}.csv"`);
  return c.body('\ufeff' + csv);
});

// ============================================
// SMS STATISTIKK API (SUPERADMIN)
// ============================================

// Hent SMS-statistikk med filtrering
app.get("/api/superadmin/sms-stats", (c) => {
  const periode = c.req.query("periode") || "maaned";
  const type = c.req.query("type") || "alle";
  const klubb_id = c.req.query("klubb_id") || null;

  // Beregn datointervall
  let datoFra;
  const now = new Date();
  switch (periode) {
    case "uke":
      datoFra = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      break;
    case "maaned":
      datoFra = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      break;
    case "aar":
      datoFra = new Date(now.getFullYear(), 0, 1);
      break;
    default:
      datoFra = new Date(2020, 0, 1); // "alle" - fra starten
  }
  const datoFraStr = datoFra.toISOString().split('T')[0];

  // Bygg WHERE-klausul
  let whereClauses = ["date(created_at) >= ?"];
  let params = [datoFraStr];

  if (type === "verifisering") {
    whereClauses.push("type = 'verifisering'");
  } else if (type.startsWith("klubb:")) {
    whereClauses.push("klubb_id = ?");
    params.push(type.replace("klubb:", ""));
  } else if (type !== "alle") {
    whereClauses.push("type = ?");
    params.push(type);
  }

  const whereSQL = whereClauses.join(" AND ");

  // Totalt ut og inn
  const totalt = db.prepare(`
    SELECT
      SUM(CASE WHEN retning = 'ut' THEN 1 ELSE 0 END) as ut,
      SUM(CASE WHEN retning = 'inn' THEN 1 ELSE 0 END) as inn
    FROM sms_log
    WHERE ${whereSQL}
  `).get(...params) || { ut: 0, inn: 0 };

  // Per dag
  const perDag = db.prepare(`
    SELECT
      date(created_at) as dato,
      SUM(CASE WHEN retning = 'ut' THEN 1 ELSE 0 END) as ut,
      SUM(CASE WHEN retning = 'inn' THEN 1 ELSE 0 END) as inn
    FROM sms_log
    WHERE ${whereSQL}
    GROUP BY date(created_at)
    ORDER BY dato DESC
    LIMIT 60
  `).all(...params) || [];

  // Per type
  const perTypeRows = db.prepare(`
    SELECT type, COUNT(*) as antall
    FROM sms_log
    WHERE ${whereSQL}
    GROUP BY type
    ORDER BY antall DESC
  `).all(...params) || [];

  const perType = {};
  perTypeRows.forEach(r => { perType[r.type] = r.antall; });

  // Per klubb (topp 10)
  const perKlubb = db.prepare(`
    SELECT
      s.klubb_id,
      k.navn as klubb_navn,
      SUM(CASE WHEN s.retning = 'ut' THEN 1 ELSE 0 END) as ut,
      SUM(CASE WHEN s.retning = 'inn' THEN 1 ELSE 0 END) as inn
    FROM sms_log s
    LEFT JOIN klubber k ON s.klubb_id = k.id
    WHERE ${whereSQL} AND s.klubb_id IS NOT NULL
    GROUP BY s.klubb_id
    ORDER BY (ut + inn) DESC
    LIMIT 10
  `).all(...params) || [];

  // Siste 20 meldinger
  const siste = db.prepare(`
    SELECT id, retning, fra, til, type, melding, status, klubb_id, created_at
    FROM sms_log
    WHERE ${whereSQL}
    ORDER BY created_at DESC
    LIMIT 20
  `).all(...params) || [];

  return c.json({
    periode,
    totalt,
    perDag: perDag.reverse(),
    perType,
    perKlubb,
    siste
  });
});

// Hent alle klubber som har sendt/mottatt SMS
app.get("/api/superadmin/sms-klubber", (c) => {
  const klubber = db.prepare(`
    SELECT DISTINCT s.klubb_id, k.navn as klubb_navn
    FROM sms_log s
    LEFT JOIN klubber k ON s.klubb_id = k.id
    WHERE s.klubb_id IS NOT NULL
    ORDER BY k.navn
  `).all();

  return c.json(klubber);
});

// Eksporter SMS-log som CSV
app.get("/api/superadmin/sms-export", (c) => {
  const periode = c.req.query("periode") || "maaned";
  const type = c.req.query("type") || "alle";

  // Beregn datointervall
  let datoFra;
  const now = new Date();
  switch (periode) {
    case "uke":
      datoFra = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      break;
    case "maaned":
      datoFra = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      break;
    case "aar":
      datoFra = new Date(now.getFullYear(), 0, 1);
      break;
    default:
      datoFra = new Date(2020, 0, 1);
  }
  const datoFraStr = datoFra.toISOString().split('T')[0];

  let whereClauses = ["date(created_at) >= ?"];
  let params = [datoFraStr];

  if (type === "verifisering") {
    whereClauses.push("type = 'verifisering'");
  } else if (type.startsWith("klubb:")) {
    whereClauses.push("klubb_id = ?");
    params.push(type.replace("klubb:", ""));
  } else if (type !== "alle") {
    whereClauses.push("type = ?");
    params.push(type);
  }

  const whereSQL = whereClauses.join(" AND ");

  const rows = db.prepare(`
    SELECT id, retning, fra, til, type, melding, twilio_sid, status, klubb_id, created_at
    FROM sms_log
    WHERE ${whereSQL}
    ORDER BY created_at DESC
  `).all(...params);

  // Generer CSV
  const header = "ID,Retning,Fra,Til,Type,Melding,Twilio SID,Status,Klubb ID,Tidspunkt\n";
  const csvRows = rows.map(r =>
    `${r.id},"${r.retning}","${r.fra}","${r.til}","${r.type}","${(r.melding || '').replace(/"/g, '""')}","${r.twilio_sid || ''}","${r.status}","${r.klubb_id || ''}","${r.created_at}"`
  ).join("\n");

  const csv = header + csvRows;

  c.header("Content-Type", "text/csv; charset=utf-8");
  c.header("Content-Disposition", `attachment; filename="sms-log-${new Date().toISOString().split('T')[0]}.csv"`);
  return c.body(csv);
});

// ============================================
// VIPPS-FORESPØRSLER API
// ============================================

// Opprett ny Vipps-forespørsel
app.post("/api/prover/:id/vipps-foresporsler", async (c) => {
  const proveId = c.req.param("id");
  const body = await c.req.json();
  const { opprettet_av, beskrivelse, belop, vipps_nummer, mottakere } = body;

  if (!opprettet_av || !beskrivelse || !belop || !vipps_nummer || !mottakere?.length) {
    return c.json({ error: "Mangler påkrevde felt" }, 400);
  }

  // Opprett forespørsel
  const result = db.prepare(`
    INSERT INTO vipps_foresporsler (prove_id, opprettet_av, beskrivelse, belop, vipps_nummer)
    VALUES (?, ?, ?, ?, ?)
  `).run(proveId, opprettet_av, beskrivelse, belop, vipps_nummer);

  const foresporselId = result.lastInsertRowid;

  // Legg til mottakere
  const insertMottaker = db.prepare(`
    INSERT INTO vipps_mottakere (foresporsel_id, deltaker_telefon, deltaker_navn)
    VALUES (?, ?, ?)
  `);

  for (const m of mottakere) {
    insertMottaker.run(foresporselId, m.telefon, m.navn);
  }

  // Generer Vipps-lenker for hver mottaker
  const vippsLenker = mottakere.map(m => ({
    telefon: m.telefon,
    navn: m.navn,
    lenke: `https://qr.vipps.no/28/2/01/031/${vipps_nummer}?v=1&s=${belop}`
  }));

  return c.json({
    id: foresporselId,
    vipps_lenker: vippsLenker,
    melding: `Vennligst betal ${belop} kr for ${beskrivelse}: https://qr.vipps.no/28/2/01/031/${vipps_nummer}?v=1&s=${belop}`
  });
});

// Hent alle Vipps-forespørsler for en prøve
app.get("/api/prover/:id/vipps-foresporsler", (c) => {
  const proveId = c.req.param("id");

  const foresporsler = db.prepare(`
    SELECT vf.*, b.fornavn || ' ' || b.etternavn as opprettet_av_navn
    FROM vipps_foresporsler vf
    LEFT JOIN brukere b ON vf.opprettet_av = b.telefon
    WHERE vf.prove_id = ?
    ORDER BY vf.created_at DESC
  `).all(proveId);

  // Hent mottakere for hver forespørsel
  const getMottakere = db.prepare(`
    SELECT * FROM vipps_mottakere WHERE foresporsel_id = ?
  `);

  const result = foresporsler.map(f => ({
    ...f,
    mottakere: getMottakere.all(f.id)
  }));

  return c.json(result);
});

// Hent én Vipps-forespørsel med mottakere
app.get("/api/vipps-foresporsler/:id", (c) => {
  const id = c.req.param("id");

  const foresporsel = db.prepare(`
    SELECT vf.*, b.fornavn || ' ' || b.etternavn as opprettet_av_navn
    FROM vipps_foresporsler vf
    LEFT JOIN brukere b ON vf.opprettet_av = b.telefon
    WHERE vf.id = ?
  `).get(id);

  if (!foresporsel) return c.json({ error: "Forespørsel ikke funnet" }, 404);

  const mottakere = db.prepare(`
    SELECT * FROM vipps_mottakere WHERE foresporsel_id = ?
  `).all(id);

  return c.json({ ...foresporsel, mottakere });
});

// Oppdater betalingsstatus for en mottaker
app.put("/api/vipps-foresporsler/:id/mottakere/:telefon", async (c) => {
  const foresporselId = c.req.param("id");
  const telefon = c.req.param("telefon");
  const body = await c.req.json();
  const { status, notert_av } = body;

  if (!['venter', 'betalt', 'kansellert'].includes(status)) {
    return c.json({ error: "Ugyldig status" }, 400);
  }

  const existing = db.prepare(`
    SELECT * FROM vipps_mottakere WHERE foresporsel_id = ? AND deltaker_telefon = ?
  `).get(foresporselId, telefon);

  if (!existing) return c.json({ error: "Mottaker ikke funnet" }, 404);

  if (status === 'betalt') {
    db.prepare(`
      UPDATE vipps_mottakere
      SET status = ?, betalt_dato = datetime('now'), notert_av = ?
      WHERE foresporsel_id = ? AND deltaker_telefon = ?
    `).run(status, notert_av || null, foresporselId, telefon);
  } else {
    db.prepare(`
      UPDATE vipps_mottakere
      SET status = ?, betalt_dato = NULL, notert_av = ?
      WHERE foresporsel_id = ? AND deltaker_telefon = ?
    `).run(status, notert_av || null, foresporselId, telefon);
  }

  return c.json({ success: true });
});

// Slett en Vipps-forespørsel
app.delete("/api/vipps-foresporsler/:id", (c) => {
  const id = c.req.param("id");
  db.prepare("DELETE FROM vipps_foresporsler WHERE id = ?").run(id);
  return c.json({ success: true });
});

// ============================================
// DOMMER-TILDELINGER API
// ============================================

// Hent alle dommere
app.get("/api/dommere", (c) => {
  const dommere = db.prepare(`
    SELECT telefon, fornavn, etternavn, epost
    FROM brukere WHERE rolle LIKE '%dommer%'
    ORDER BY etternavn, fornavn
  `).all();
  return c.json(dommere);
});

// Hent dommer-tildelinger for en prøve
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

// Tildel dommer til parti
app.post("/api/prover/:id/dommer-tildelinger", requireAdmin, async (c) => {
  const proveId = c.req.param("id");
  const body = await c.req.json();
  const { parti, dommer_telefon, dommer_rolle } = body;

  if (!parti || !dommer_telefon) {
    return c.json({ error: "Parti og dommer_telefon er påkrevd" }, 400);
  }

  const prove = db.prepare("SELECT id FROM prover WHERE id = ?").get(proveId);
  if (!prove) return c.json({ error: "Prøve ikke funnet" }, 404);

  const partiType = parti.toLowerCase().startsWith('vk') ? 'VK' : 'UKAK';
  const eksisterende = db.prepare("SELECT COUNT(*) as antall FROM dommer_tildelinger WHERE prove_id = ? AND parti = ? AND dommer_telefon != ?").get(proveId, parti, dommer_telefon);

  if (partiType === 'VK' && eksisterende.antall >= 2) {
    return c.json({ error: "VK-partier kan maksimalt ha 2 dommere" }, 400);
  }
  if (partiType === 'UKAK' && eksisterende.antall >= 2) {
    return c.json({ error: "UK/AK-partier kan maksimalt ha 2 dommere" }, 400);
  }

  try {
    db.prepare(`
      INSERT INTO dommer_tildelinger (prove_id, dommer_telefon, parti, dommer_rolle) VALUES (?, ?, ?, ?)
      ON CONFLICT(prove_id, dommer_telefon) DO UPDATE SET parti = excluded.parti, dommer_rolle = excluded.dommer_rolle
    `).run(proveId, dommer_telefon, parti, dommer_rolle || null);

    db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").run(
      "dommer_tildelt", `Dommer ${dommer_telefon} tildelt ${parti} på prøve ${proveId}`
    );
    return c.json({ success: true });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// Fjern dommer-tildeling
app.delete("/api/prover/:id/dommer-tildelinger/:tildelingId", requireAdmin, (c) => {
  const proveId = c.req.param("id");
  const tildelingId = c.req.param("tildelingId");
  const result = db.prepare("DELETE FROM dommer_tildelinger WHERE id = ? AND prove_id = ?").run(tildelingId, proveId);
  if (result.changes === 0) return c.json({ error: "Tildeling ikke funnet" }, 404);
  db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").run("dommer_fjernet", `Tildeling ${tildelingId} fjernet fra prøve ${proveId}`);
  return c.json({ success: true });
});

// Bulk-oppdater dommere for et parti
app.put("/api/prover/:id/dommer-tildelinger/parti/:parti", requireAdmin, async (c) => {
  const proveId = c.req.param("id");
  const parti = c.req.param("parti");
  const body = await c.req.json();
  const { dommere } = body;

  if (!Array.isArray(dommere)) return c.json({ error: "dommere må være en array" }, 400);

  const partiType = parti.toLowerCase().startsWith('vk') ? 'VK' : 'UKAK';
  if (partiType === 'VK' && dommere.length !== 2) return c.json({ error: "VK-partier må ha nøyaktig 2 dommere" }, 400);
  if (partiType === 'UKAK' && (dommere.length < 1 || dommere.length > 2)) return c.json({ error: "UK/AK-partier må ha 1-2 dommere" }, 400);

  try {
    db.prepare("DELETE FROM dommer_tildelinger WHERE prove_id = ? AND parti = ?").run(proveId, parti);
    const insert = db.prepare("INSERT INTO dommer_tildelinger (prove_id, dommer_telefon, parti, dommer_rolle) VALUES (?, ?, ?, ?)");
    for (const d of dommere) {
      insert.run(proveId, d.telefon, parti, d.rolle || null);
    }
    db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").run("dommer_parti_oppdatert", `${parti}: ${dommere.map(d => d.telefon).join(', ')}`);
    return c.json({ success: true });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// ============================================
// FKF GODKJENTE DOMMERE API
// ============================================

// Hent alle FKF-godkjente dommere
app.get("/api/fkf-dommere", (c) => {
  const dommere = db.prepare(`
    SELECT id, fornavn, etternavn, adresse, postnummer, sted,
           telefon1, telefon2, aktiv, imported_at
    FROM fkf_godkjente_dommere
    WHERE aktiv = 1
    ORDER BY etternavn, fornavn
  `).all();
  return c.json(dommere);
});

// Sjekk om et telefonnummer er FKF-godkjent dommer
app.get("/api/fkf-dommere/sjekk/:telefon", (c) => {
  const telefon = c.req.param("telefon");
  const normalized = normalizePhone(telefon);

  if (!normalized) {
    return c.json({ godkjent: false, error: "Ugyldig telefonnummer" });
  }

  const dommer = db.prepare(`
    SELECT id, fornavn, etternavn, adresse, postnummer, sted
    FROM fkf_godkjente_dommere
    WHERE aktiv = 1 AND (telefon1_normalized = ? OR telefon2_normalized = ?)
  `).get(normalized, normalized);

  if (dommer) {
    return c.json({ godkjent: true, dommer });
  }
  return c.json({ godkjent: false });
});

// Import FKF dommerliste (Excel/CSV) - kun admin
app.post("/api/fkf-dommere/import", requireAdmin, async (c) => {
  const body = await c.req.json();
  const { dommere, erstatt_alle } = body;

  if (!Array.isArray(dommere) || dommere.length === 0) {
    return c.json({ error: "Ingen dommere å importere" }, 400);
  }

  try {
    if (erstatt_alle) {
      db.prepare("DELETE FROM fkf_godkjente_dommere").run();
    }

    const insert = db.prepare(`
      INSERT INTO fkf_godkjente_dommere
        (fornavn, etternavn, adresse, postnummer, sted, telefon1, telefon2, telefon1_normalized, telefon2_normalized, epost)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let importert = 0;
    let feilet = 0;

    for (const d of dommere) {
      try {
        const t1 = normalizePhone(d.telefon1);
        const t2 = normalizePhone(d.telefon2);
        insert.run(
          d.fornavn || '',
          d.etternavn || '',
          d.adresse || '',
          d.postnummer || '',
          d.sted || '',
          d.telefon1 || '',
          d.telefon2 || '',
          t1 || '',
          t2 || '',
          d.epost || ''
        );
        importert++;
      } catch (e) {
        feilet++;
      }
    }

    db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").run(
      "fkf_dommere_import", `Importert ${importert} dommere (${feilet} feilet)${erstatt_alle ? ' - erstattet alle' : ''}`
    );

    return c.json({ success: true, importert, feilet });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// Legg til enkelt FKF-dommer manuelt
app.post("/api/fkf-dommere", requireAdmin, async (c) => {
  const body = await c.req.json();
  const { fornavn, etternavn, adresse, postnummer, sted, telefon1, telefon2 } = body;

  if (!etternavn) {
    return c.json({ error: "Etternavn er påkrevd" }, 400);
  }

  try {
    const t1 = normalizePhone(telefon1);
    const t2 = normalizePhone(telefon2);

    const result = db.prepare(`
      INSERT INTO fkf_godkjente_dommere
        (fornavn, etternavn, adresse, postnummer, sted, telefon1, telefon2, telefon1_normalized, telefon2_normalized)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(fornavn || '', etternavn, adresse || '', postnummer || '', sted || '', telefon1 || '', telefon2 || '', t1 || '', t2 || '');

    db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").run(
      "fkf_dommer_lagt_til", `${fornavn} ${etternavn} (ID: ${result.lastInsertRowid})`
    );

    return c.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// Oppdater FKF-dommer
app.put("/api/fkf-dommere/:id", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();

  const dommer = db.prepare("SELECT * FROM fkf_godkjente_dommere WHERE id = ?").get(id);
  if (!dommer) return c.json({ error: "Dommer ikke funnet" }, 404);

  const t1 = body.telefon1 !== undefined ? normalizePhone(body.telefon1) : dommer.telefon1_normalized;
  const t2 = body.telefon2 !== undefined ? normalizePhone(body.telefon2) : dommer.telefon2_normalized;

  db.prepare(`
    UPDATE fkf_godkjente_dommere SET
      fornavn = COALESCE(?, fornavn),
      etternavn = COALESCE(?, etternavn),
      adresse = COALESCE(?, adresse),
      postnummer = COALESCE(?, postnummer),
      sted = COALESCE(?, sted),
      telefon1 = COALESCE(?, telefon1),
      telefon2 = COALESCE(?, telefon2),
      telefon1_normalized = ?,
      telefon2_normalized = ?,
      aktiv = COALESCE(?, aktiv)
    WHERE id = ?
  `).run(
    body.fornavn, body.etternavn, body.adresse, body.postnummer, body.sted,
    body.telefon1, body.telefon2, t1 || '', t2 || '', body.aktiv, id
  );

  return c.json({ success: true });
});

// Slett FKF-dommer (eller deaktiver)
app.delete("/api/fkf-dommere/:id", requireAdmin, (c) => {
  const id = c.req.param("id");
  const deaktiver = c.req.query("deaktiver") === "true";

  if (deaktiver) {
    const result = db.prepare("UPDATE fkf_godkjente_dommere SET aktiv = 0 WHERE id = ?").run(id);
    if (result.changes === 0) return c.json({ error: "Dommer ikke funnet" }, 404);
    db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").run("fkf_dommer_deaktivert", `ID: ${id}`);
  } else {
    const result = db.prepare("DELETE FROM fkf_godkjente_dommere WHERE id = ?").run(id);
    if (result.changes === 0) return c.json({ error: "Dommer ikke funnet" }, 404);
    db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").run("fkf_dommer_slettet", `ID: ${id}`);
  }

  return c.json({ success: true });
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

// Alle prøver (for superadmin) - MÅ komme FØR /api/prover/:id
app.get("/api/prover/alle", (c) => {
  try {
    const prover = db.prepare(`
      SELECT p.*, k.navn as klubb_navn,
             (SELECT COUNT(*) FROM pameldte WHERE prove_id = p.id) as antall_pameldte
      FROM prover p
      LEFT JOIN klubber k ON p.klubb_id = k.id
      ORDER BY p.dato_fra DESC
    `).all();
    return c.json({ prover });
  } catch (err) {
    // Hvis tabellen ikke finnes ennå
    return c.json({ prover: [] });
  }
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

// Opprett ny prøve
app.post("/api/prover", requireAdmin, async (c) => {
  try {
    const body = await c.req.json();
    const bruker = c.get("bruker");

    // Generer unik ID
    const id = `prove_${Date.now()}_${randomBytes(4).toString('hex')}`;

    const {
      navn,
      sted = '',
      start_dato,
      slutt_dato,
      klubb_id = null,
      proveleder_telefon = null,
      nkkrep_telefon = null,
      klasser = { uk: true, ak: true, vk: true },
      partier = {}
    } = body;

    if (!navn) {
      return c.json({ error: "Prøvenavn er påkrevd" }, 400);
    }
    if (!start_dato) {
      return c.json({ error: "Startdato er påkrevd" }, 400);
    }

    db.prepare(`
      INSERT INTO prover (id, navn, sted, start_dato, slutt_dato, klubb_id, proveleder_telefon, nkkrep_telefon, klasser, partier, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planlagt')
    `).run(
      id,
      navn,
      sted,
      start_dato,
      slutt_dato || start_dato,
      klubb_id,
      proveleder_telefon,
      nkkrep_telefon,
      JSON.stringify(klasser),
      JSON.stringify(partier)
    );

    db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").run(
      "prove_opprettet",
      JSON.stringify({ id, navn, opprettet_av: bruker.telefon })
    );

    autoBackup("prove_opprettet");

    return c.json({ id, navn, message: "Prøve opprettet" });
  } catch (err) {
    console.error("Feil ved opprettelse av prøve:", err);
    return c.json({ error: err.message }, 500);
  }
});

// Oppdater prøve
app.put("/api/prover/:id", requireAdmin, async (c) => {
  try {
    const id = c.req.param("id");
    const body = await c.req.json();
    const bruker = c.get("bruker");

    const existing = db.prepare("SELECT * FROM prover WHERE id = ?").get(id);
    if (!existing) {
      return c.json({ error: "Prøve ikke funnet" }, 404);
    }

    const fields = ["navn", "sted", "start_dato", "slutt_dato", "klubb_id", "proveleder_telefon", "nkkrep_telefon", "status"];
    const sets = [];
    const vals = [];

    for (const f of fields) {
      if (f in body) {
        sets.push(`${f} = ?`);
        vals.push(body[f]);
      }
    }

    // Håndter JSON-felter separat
    if ('klasser' in body) {
      sets.push("klasser = ?");
      vals.push(JSON.stringify(body.klasser));
    }
    if ('partier' in body) {
      sets.push("partier = ?");
      vals.push(JSON.stringify(body.partier));
    }

    if (sets.length > 0) {
      vals.push(id);
      db.prepare(`UPDATE prover SET ${sets.join(", ")} WHERE id = ?`).run(...vals);

      db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").run(
        "prove_oppdatert",
        JSON.stringify({ id, endringer: Object.keys(body), endret_av: bruker.telefon })
      );
    }

    const updated = db.prepare("SELECT * FROM prover WHERE id = ?").get(id);
    return c.json({
      ...updated,
      klasser: JSON.parse(updated.klasser || '{}'),
      partier: JSON.parse(updated.partier || '{}')
    });
  } catch (err) {
    console.error("Feil ved oppdatering av prøve:", err);
    return c.json({ error: err.message }, 500);
  }
});

// Slett prøve
app.delete("/api/prover/:id", requireAdmin, async (c) => {
  try {
    const id = c.req.param("id");
    const bruker = c.get("bruker");

    const existing = db.prepare("SELECT * FROM prover WHERE id = ?").get(id);
    if (!existing) {
      return c.json({ error: "Prøve ikke funnet" }, 404);
    }

    autoBackup("prove_slettet");

    // Slett relaterte data først
    db.prepare("DELETE FROM dommer_tildelinger WHERE prove_id = ?").run(id);
    db.prepare("DELETE FROM prover WHERE id = ?").run(id);

    db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").run(
      "prove_slettet",
      JSON.stringify({ id, navn: existing.navn, slettet_av: bruker.telefon })
    );

    return c.json({ success: true, message: "Prøve slettet" });
  } catch (err) {
    console.error("Feil ved sletting av prøve:", err);
    return c.json({ error: err.message }, 500);
  }
});

// ============================================
// PÅMELDINGER API
// ============================================

// Hjelpefunksjon: Beregn alder på prøvedato
function beregnAlderPaProveDato(fodselsdato, provedato) {
  const fodt = new Date(fodselsdato);
  const prove = new Date(provedato);
  const diffMs = prove - fodt;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const years = Math.floor(diffDays / 365);
  const months = Math.floor((diffDays % 365) / 30);
  return { years, months, totalMonths: years * 12 + months };
}

// Hjelpefunksjon: Valider klassevelg
function validerKlasse(fodselsdato, provedato, klasse, har1AK = false) {
  const alder = beregnAlderPaProveDato(fodselsdato, provedato);
  const errors = [];
  const warnings = [];

  // Minimum 9 måneder for alle prøver
  if (alder.totalMonths < 9) {
    errors.push(`Hunden er for ung (${alder.totalMonths} mnd). Minimum alder er 9 måneder.`);
    return { valid: false, errors, warnings, alder };
  }

  if (klasse === 'UK') {
    // UK: 9 mnd til 2 år
    if (alder.totalMonths >= 24) {
      errors.push(`Hunden er for gammel for UK (${alder.years} år ${alder.months} mnd). UK er for hunder under 2 år.`);
    }
  } else if (klasse === 'AK') {
    // AK: Fra fylte 2 år
    if (alder.totalMonths < 24) {
      errors.push(`Hunden er for ung for AK (${alder.totalMonths} mnd). AK krever at hunden er fylt 2 år.`);
    }
  } else if (klasse === 'VK') {
    // VK: Må ha 1. AK
    if (alder.totalMonths < 24) {
      errors.push(`Hunden er for ung for VK (${alder.totalMonths} mnd).`);
    }
    if (!har1AK) {
      errors.push('VK krever at hunden har oppnådd 1. AK.');
    }
  }

  return { valid: errors.length === 0, errors, warnings, alder };
}

// Hjelpefunksjon: Sjekk venteliste og opprykk
function oppdaterVenteliste(proveId, klasse) {
  const config = db.prepare("SELECT * FROM prove_config WHERE prove_id = ?").get(proveId);
  if (!config) return;

  const maksField = klasse === 'UK' ? 'maks_deltakere_uk' : klasse === 'AK' ? 'maks_deltakere_ak' : 'maks_deltakere_vk';
  const maks = config[maksField] || 40;

  // Tell bekreftede/påmeldte
  const antallPameldt = db.prepare(`
    SELECT COUNT(*) as n FROM pameldinger
    WHERE prove_id = ? AND klasse = ? AND status IN ('pameldt', 'bekreftet')
  `).get(proveId, klasse).n;

  if (antallPameldt < maks) {
    // Rykk opp fra venteliste
    const ledigePlasser = maks - antallPameldt;
    const venteliste = db.prepare(`
      SELECT id, forer_telefon FROM pameldinger
      WHERE prove_id = ? AND klasse = ? AND status = 'venteliste'
      ORDER BY venteliste_plass ASC
      LIMIT ?
    `).all(proveId, klasse, ledigePlasser);

    for (const p of venteliste) {
      db.prepare(`
        UPDATE pameldinger SET status = 'pameldt', venteliste_plass = NULL, updated_at = datetime('now')
        WHERE id = ?
      `).run(p.id);

      // TODO: Send SMS-varsling om opprykk
      console.log(`📱 Opprykk fra venteliste: ${p.forer_telefon} rykket opp til ${klasse}`);
    }
  }
}

// Hent alle påmeldinger for en prøve
app.get("/api/prover/:id/pameldinger", (c) => {
  const proveId = c.req.param("id");
  const klasse = c.req.query("klasse");
  const status = c.req.query("status");

  let query = `
    SELECT p.*, h.navn as hund_navn, h.regnr, h.rase, h.fodt as hund_fodt,
           b.fornavn || ' ' || b.etternavn as forer_navn, b.telefon as forer_telefon,
           e.fornavn || ' ' || e.etternavn as eier_navn
    FROM pameldinger p
    JOIN hunder h ON p.hund_id = h.id
    JOIN brukere b ON p.forer_telefon = b.telefon
    LEFT JOIN brukere e ON h.eier_telefon = e.telefon
    WHERE p.prove_id = ?
  `;
  const params = [proveId];

  if (klasse) {
    query += " AND p.klasse = ?";
    params.push(klasse);
  }
  if (status) {
    query += " AND p.status = ?";
    params.push(status);
  }

  query += " ORDER BY p.klasse, p.status, p.created_at";

  const pameldinger = db.prepare(query).all(...params);

  // Hent konfigurasjon
  const config = db.prepare("SELECT * FROM prove_config WHERE prove_id = ?").get(proveId);

  // Tell per klasse
  const antall = {
    UK: { pameldt: 0, venteliste: 0, maks: config?.maks_deltakere_uk || 40 },
    AK: { pameldt: 0, venteliste: 0, maks: config?.maks_deltakere_ak || 40 },
    VK: { pameldt: 0, venteliste: 0, maks: config?.maks_deltakere_vk || 20 }
  };

  for (const p of pameldinger) {
    if (p.status === 'venteliste') {
      antall[p.klasse].venteliste++;
    } else if (p.status !== 'avmeldt') {
      antall[p.klasse].pameldt++;
    }
  }

  return c.json({ pameldinger, antall, config });
});

// Meld på til prøve
app.post("/api/prover/:id/pameldinger", requireAuth, async (c) => {
  const proveId = c.req.param("id");
  const body = await c.req.json();
  const bruker = c.get("bruker");

  // Valider påkrevde felt
  if (!body.hund_id || !body.klasse) {
    return c.json({ error: "Mangler påkrevde felt (hund_id, klasse)" }, 400);
  }

  // Hent prøve og konfigurasjon
  const prove = db.prepare("SELECT * FROM prover WHERE id = ?").get(proveId);
  if (!prove) {
    return c.json({ error: "Prøve ikke funnet" }, 404);
  }

  // Hent hund
  const hund = db.prepare("SELECT * FROM hunder WHERE id = ?").get(body.hund_id);
  if (!hund) {
    return c.json({ error: "Hund ikke funnet" }, 404);
  }

  // Sjekk om allerede påmeldt
  const existing = db.prepare("SELECT * FROM pameldinger WHERE prove_id = ? AND hund_id = ?").get(proveId, body.hund_id);
  if (existing && existing.status !== 'avmeldt') {
    return c.json({ error: "Hunden er allerede påmeldt denne prøven" }, 400);
  }

  // Valider klasse basert på alder
  const har1AK = db.prepare(`
    SELECT COUNT(*) as n FROM resultater
    WHERE hund_id = ? AND premie LIKE '1. AK%'
  `).get(body.hund_id).n > 0;

  const validering = validerKlasse(hund.fodt, prove.start_dato, body.klasse, har1AK);
  if (!validering.valid) {
    return c.json({ error: validering.errors.join(' '), validering }, 400);
  }

  // Hent konfigurasjon
  let config = db.prepare("SELECT * FROM prove_config WHERE prove_id = ?").get(proveId);
  if (!config) {
    // Opprett default konfigurasjon
    db.prepare("INSERT INTO prove_config (prove_id) VALUES (?)").run(proveId);
    config = db.prepare("SELECT * FROM prove_config WHERE prove_id = ?").get(proveId);
  }

  // Sjekk kapasitet
  const maksField = body.klasse === 'UK' ? 'maks_deltakere_uk' : body.klasse === 'AK' ? 'maks_deltakere_ak' : 'maks_deltakere_vk';
  const maks = config[maksField] || 40;

  const antallPameldt = db.prepare(`
    SELECT COUNT(*) as n FROM pameldinger
    WHERE prove_id = ? AND klasse = ? AND status IN ('pameldt', 'bekreftet')
  `).get(proveId, body.klasse).n;

  let status = 'pameldt';
  let ventelistePlass = null;

  if (antallPameldt >= maks) {
    // Sett på venteliste
    status = 'venteliste';
    const sisteVenteliste = db.prepare(`
      SELECT MAX(venteliste_plass) as plass FROM pameldinger
      WHERE prove_id = ? AND klasse = ? AND status = 'venteliste'
    `).get(proveId, body.klasse);
    ventelistePlass = (sisteVenteliste?.plass || 0) + 1;
  }

  // Opprett påmelding
  // Håndter dager - kan være enkelt tall eller array
  let dagerJson = null;
  if (body.dager) {
    dagerJson = JSON.stringify(Array.isArray(body.dager) ? body.dager : [body.dager]);
  } else if (body.dag) {
    dagerJson = JSON.stringify([body.dag]);
  }

  const forerTelefon = body.forer_telefon || bruker.telefon;
  const result = db.prepare(`
    INSERT INTO pameldinger (
      prove_id, hund_id, forer_telefon, klasse, dag, status, venteliste_plass,
      sauebevis, vaksinasjon_ok, rabies_ok, notat, pameldt_av_telefon
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    proveId, body.hund_id, forerTelefon, body.klasse, dagerJson,
    status, ventelistePlass,
    body.sauebevis ? 1 : 0, body.vaksinasjon_ok ? 1 : 0, body.rabies_ok ? 1 : 0,
    body.notat || '', bruker.telefon
  );

  // Logg
  db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").run(
    "pamelding_opprettet",
    JSON.stringify({ pamelding_id: result.lastInsertRowid, prove_id: proveId, hund_id: body.hund_id, klasse: body.klasse, status })
  );

  return c.json({
    id: result.lastInsertRowid,
    status,
    venteliste_plass: ventelistePlass,
    validering,
    message: status === 'venteliste' ?
      `Påmeldt på venteliste (plass ${ventelistePlass}). Du får SMS når plass blir ledig.` :
      'Påmelding registrert!'
  }, 201);
});

// Avmeld fra prøve
app.delete("/api/prover/:proveId/pameldinger/:id", requireAuth, async (c) => {
  const proveId = c.req.param("proveId");
  const id = c.req.param("id");
  const bruker = c.get("bruker");

  const pamelding = db.prepare("SELECT * FROM pameldinger WHERE id = ? AND prove_id = ?").get(id, proveId);
  if (!pamelding) {
    return c.json({ error: "Påmelding ikke funnet" }, 404);
  }

  // Sjekk tilgang (eier, fører, eller admin)
  const hund = db.prepare("SELECT eier_telefon FROM hunder WHERE id = ?").get(pamelding.hund_id);
  const erEier = hund && hund.eier_telefon === bruker.telefon;
  const erForer = pamelding.forer_telefon === bruker.telefon;
  const erAdmin = hasAnyRole(bruker.rolle, ["admin", "superadmin", "klubbleder", "proveleder", "sekretær", "sekretar"]);

  if (!erEier && !erForer && !erAdmin) {
    return c.json({ error: "Ingen tilgang til å avmelde" }, 403);
  }

  // Beregn eventuell refusjon
  const prove = db.prepare("SELECT * FROM prover WHERE id = ?").get(proveId);
  const config = db.prepare("SELECT * FROM prove_config WHERE prove_id = ?").get(proveId);
  let refusjon = { belop: 0, prosent: 0 };

  if (pamelding.betalt && pamelding.betalt_belop > 0) {
    // Sjekk om det er mer enn 12 timer til prøvestart
    const proveStart = new Date(prove.start_dato);
    const naa = new Date();
    const timerTilStart = (proveStart - naa) / (1000 * 60 * 60);

    if (pamelding.status === 'venteliste') {
      // 100% refusjon for venteliste som ikke fikk plass
      refusjon = { belop: pamelding.betalt_belop, prosent: 100 };
    } else if (timerTilStart > 12) {
      // 75% refusjon ved avmelding mer enn 12 timer før
      const prosent = config?.refusjon_prosent || 75;
      refusjon = { belop: Math.round(pamelding.betalt_belop * prosent / 100), prosent };
    }
  }

  // Oppdater status
  db.prepare(`
    UPDATE pameldinger SET status = 'avmeldt', updated_at = datetime('now')
    WHERE id = ?
  `).run(id);

  // Oppdater venteliste
  oppdaterVenteliste(proveId, pamelding.klasse);

  // Logg
  db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").run(
    "pamelding_avmeldt",
    JSON.stringify({ pamelding_id: id, avmeldt_av: bruker.telefon, refusjon })
  );

  return c.json({
    ok: true,
    refusjon,
    message: refusjon.belop > 0 ?
      `Avmeldt. Refusjon: ${refusjon.belop} kr (${refusjon.prosent}%)` :
      'Avmeldt fra prøven.'
  });
});

// Oppdater påmelding (admin)
app.put("/api/prover/:proveId/pameldinger/:id", requireAdmin, async (c) => {
  const proveId = c.req.param("proveId");
  const id = c.req.param("id");
  const body = await c.req.json();
  const bruker = c.get("bruker");

  const pamelding = db.prepare("SELECT * FROM pameldinger WHERE id = ? AND prove_id = ?").get(id, proveId);
  if (!pamelding) {
    return c.json({ error: "Påmelding ikke funnet" }, 404);
  }

  const fields = [
    "status", "venteliste_plass", "betalt", "betalt_belop", "betalings_dato",
    "sauebevis", "vaksinasjon_ok", "rabies_ok", "parti", "startnummer",
    "makker_hund_id", "notat"
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
    db.prepare(`UPDATE pameldinger SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
  }

  // Hvis status endret, oppdater venteliste
  if (body.status && body.status !== pamelding.status) {
    oppdaterVenteliste(proveId, pamelding.klasse);
  }

  const oppdatert = db.prepare("SELECT * FROM pameldinger WHERE id = ?").get(id);
  return c.json(oppdatert);
});

// Hent prøve-konfigurasjon
app.get("/api/prover/:id/config", (c) => {
  const proveId = c.req.param("id");
  let config = db.prepare("SELECT * FROM prove_config WHERE prove_id = ?").get(proveId);

  if (!config) {
    // Returner default
    config = {
      prove_id: proveId,
      maks_deltakere_uk: 40,
      maks_deltakere_ak: 40,
      maks_deltakere_vk: 20,
      vk_dag: null,
      pris_hogfjell: 1350,
      pris_lavland: 1050,
      pris_skog: 900,
      pris_apport: 400,
      refusjon_prosent: 75
    };
  }

  return c.json(config);
});

// Oppdater prøve-konfigurasjon (admin)
app.put("/api/prover/:id/config", requireAdmin, async (c) => {
  const proveId = c.req.param("id");
  const body = await c.req.json();

  // Opprett hvis ikke eksisterer
  db.prepare("INSERT OR IGNORE INTO prove_config (prove_id) VALUES (?)").run(proveId);

  const fields = [
    "maks_deltakere_uk", "maks_deltakere_ak", "maks_deltakere_vk",
    "pris_hogfjell", "pris_lavland", "pris_skog", "pris_apport",
    "frist_pamelding", "frist_avmelding", "refusjon_prosent",
    "krever_sauebevis", "krever_vaksinasjon", "krever_rabies"
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
    db.prepare(`UPDATE prove_config SET ${sets.join(", ")} WHERE prove_id = ?`).run(...vals, proveId);
  }

  const config = db.prepare("SELECT * FROM prove_config WHERE prove_id = ?").get(proveId);
  return c.json(config);
});

// ============================================
// TREKNING API
// ============================================

// Utfør trekning for en prøve
app.post("/api/prover/:id/trekning", requireAdmin, async (c) => {
  const proveId = c.req.param("id");
  const body = await c.req.json();
  const bruker = c.get("bruker");

  const prove = db.prepare("SELECT * FROM prover WHERE id = ?").get(proveId);
  if (!prove) {
    return c.json({ error: "Prøve ikke funnet" }, 404);
  }

  const klasse = body.klasse || 'AK'; // UK, AK, eller VK
  const antallPartier = body.antall_partier || 4;
  const hundePerParti = body.hunde_per_parti || 6;

  // Hent alle bekreftede/påmeldte i klassen
  const pameldinger = db.prepare(`
    SELECT p.id, p.hund_id, h.navn as hund_navn, h.regnr
    FROM pameldinger p
    JOIN hunder h ON p.hund_id = h.id
    WHERE p.prove_id = ? AND p.klasse = ? AND p.status IN ('pameldt', 'bekreftet')
    ORDER BY RANDOM()
  `).all(proveId, klasse);

  if (pameldinger.length === 0) {
    return c.json({ error: "Ingen påmeldte i denne klassen" }, 400);
  }

  // Fordel på partier
  const partier = [];
  for (let i = 0; i < antallPartier; i++) {
    partier.push({ parti: `${klasse}${i + 1}`, hunder: [] });
  }

  let partiIndex = 0;
  for (const p of pameldinger) {
    partier[partiIndex].hunder.push(p);

    // Gi startnummer
    const startnummer = partier[partiIndex].hunder.length;
    db.prepare(`
      UPDATE pameldinger SET parti = ?, startnummer = ?, status = 'bekreftet', updated_at = datetime('now')
      WHERE id = ?
    `).run(partier[partiIndex].parti, startnummer, p.id);

    partiIndex = (partiIndex + 1) % antallPartier;
  }

  // Tildel makkerpar innad i hvert parti
  for (const parti of partier) {
    const hunder = parti.hunder;
    for (let i = 0; i < hunder.length; i += 2) {
      if (i + 1 < hunder.length) {
        // Par opp hund i og i+1
        db.prepare("UPDATE pameldinger SET makker_hund_id = ? WHERE id = ?").run(hunder[i + 1].hund_id, hunder[i].id);
        db.prepare("UPDATE pameldinger SET makker_hund_id = ? WHERE id = ?").run(hunder[i].hund_id, hunder[i + 1].id);
      }
    }
  }

  // Logg
  db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").run(
    "trekning_utfort",
    JSON.stringify({ prove_id: proveId, klasse, antall_partier: antallPartier, antall_hunder: pameldinger.length, utfort_av: bruker.telefon })
  );

  return c.json({
    ok: true,
    klasse,
    antall_hunder: pameldinger.length,
    partier: partier.map(p => ({
      parti: p.parti,
      antall: p.hunder.length,
      hunder: p.hunder.map((h, idx) => ({
        startnummer: idx + 1,
        hund_navn: h.hund_navn,
        regnr: h.regnr
      }))
    }))
  });
});

// Hent trekning/partilister
app.get("/api/prover/:id/partier", (c) => {
  const proveId = c.req.param("id");

  const pameldinger = db.prepare(`
    SELECT p.*, h.navn as hund_navn, h.regnr, h.rase,
           b.fornavn || ' ' || b.etternavn as forer_navn,
           e.fornavn || ' ' || e.etternavn as eier_navn,
           mh.navn as makker_navn, mh.regnr as makker_regnr
    FROM pameldinger p
    JOIN hunder h ON p.hund_id = h.id
    JOIN brukere b ON p.forer_telefon = b.telefon
    LEFT JOIN brukere e ON h.eier_telefon = e.telefon
    LEFT JOIN hunder mh ON p.makker_hund_id = mh.id
    WHERE p.prove_id = ? AND p.parti IS NOT NULL
    ORDER BY p.parti, p.startnummer
  `).all(proveId);

  // Grupper etter parti
  const partier = {};
  for (const p of pameldinger) {
    if (!partier[p.parti]) {
      partier[p.parti] = [];
    }
    partier[p.parti].push(p);
  }

  return c.json({ partier });
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
// FULLMAKTER API
// ============================================

// Hent fullmakter for en bruker
app.get("/api/brukere/:telefon/fullmakter", (c) => {
  const telefon = c.req.param("telefon");

  // Sjekk om fullmakter-tabell eksisterer, hvis ikke opprett den
  db.exec(`
    CREATE TABLE IF NOT EXISTS fullmakter (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK(type IN ('given', 'received')),
      giver_telefon TEXT NOT NULL,
      mottaker_telefon TEXT,
      mottaker_navn TEXT,
      hund_id INTEGER,
      dog_name TEXT,
      dog_owner TEXT,
      trial TEXT,
      valid_from TEXT,
      valid_to TEXT,
      permissions TEXT DEFAULT '["run","results"]',
      status TEXT DEFAULT 'active' CHECK(status IN ('active', 'revoked')),
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (hund_id) REFERENCES hunder(id)
    )
  `);

  // Hent fullmakter gitt av brukeren
  const given = db.prepare(`
    SELECT f.*, h.navn as dog_name_from_hund
    FROM fullmakter f
    LEFT JOIN hunder h ON f.hund_id = h.id
    WHERE f.giver_telefon = ?
  `).all(telefon);

  // Hent fullmakter mottatt av brukeren
  const received = db.prepare(`
    SELECT f.*, h.navn as dog_name_from_hund,
           b.fornavn || ' ' || b.etternavn as dog_owner_name
    FROM fullmakter f
    LEFT JOIN hunder h ON f.hund_id = h.id
    LEFT JOIN brukere b ON f.giver_telefon = b.telefon
    WHERE f.mottaker_telefon = ?
  `).all(telefon);

  // Kombiner og formater resultatet
  const result = [
    ...given.map(f => ({
      ...f,
      type: 'given',
      dogName: f.dog_name || f.dog_name_from_hund || 'Ukjent',
      recipientName: f.mottaker_navn,
      recipientPhone: f.mottaker_telefon,
      validFrom: f.valid_from,
      validTo: f.valid_to,
      permissions: JSON.parse(f.permissions || '[]')
    })),
    ...received.map(f => ({
      ...f,
      type: 'received',
      dogName: f.dog_name || f.dog_name_from_hund || 'Ukjent',
      dogOwner: f.dog_owner || f.dog_owner_name || 'Ukjent',
      validFrom: f.valid_from,
      validTo: f.valid_to,
      permissions: JSON.parse(f.permissions || '[]')
    }))
  ];

  return c.json(result);
});

// Opprett ny fullmakt
app.post("/api/brukere/:telefon/fullmakter", async (c) => {
  const telefon = c.req.param("telefon");
  const body = await c.req.json();

  // Opprett tabell hvis den ikke finnes
  db.exec(`
    CREATE TABLE IF NOT EXISTS fullmakter (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK(type IN ('given', 'received')),
      giver_telefon TEXT NOT NULL,
      mottaker_telefon TEXT,
      mottaker_navn TEXT,
      hund_id INTEGER,
      dog_name TEXT,
      dog_owner TEXT,
      trial TEXT,
      valid_from TEXT,
      valid_to TEXT,
      permissions TEXT DEFAULT '["run","results"]',
      status TEXT DEFAULT 'active' CHECK(status IN ('active', 'revoked')),
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (hund_id) REFERENCES hunder(id)
    )
  `);

  const result = db.prepare(`
    INSERT INTO fullmakter (type, giver_telefon, mottaker_telefon, mottaker_navn, hund_id, dog_name, trial, valid_from, valid_to, permissions, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'given',
    telefon,
    body.recipientPhone || null,
    body.recipientName || null,
    body.dogId || null,
    body.dogName || null,
    body.trial || null,
    body.validFrom || null,
    body.validTo || null,
    JSON.stringify(body.permissions || ['run', 'results']),
    'active'
  );

  // Hent info om giveren
  const giver = db.prepare("SELECT fornavn, etternavn FROM brukere WHERE telefon = ?").get(telefon);
  const giverNavn = giver ? `${giver.fornavn} ${giver.etternavn}` : 'En hundeeier';

  // Send SMS til mottaker
  if (body.recipientPhone) {
    const recipientPhone = body.recipientPhone.replace(/\s/g, '');

    // Sjekk om mottaker er eksisterende bruker
    const eksisterendeBruker = db.prepare("SELECT telefon FROM brukere WHERE telefon = ?").get(recipientPhone);

    let smsMessage;
    if (eksisterendeBruker) {
      // Eksisterende bruker - send enkel bekreftelse
      smsMessage = `Hei! ${giverNavn} har gitt deg fullmakt til å stille med hunden ${body.dogName || 'deres hund'} på jaktprøver. Logg inn på fuglehundprove.no for detaljer.`;
    } else {
      // Ny bruker - send invitasjon til å registrere seg
      smsMessage = `Hei! ${giverNavn} har gitt deg fullmakt til å stille med hunden ${body.dogName || 'deres hund'} på jaktprøver. Opprett bruker på fuglehundprove.no/opprett-bruker.html for å se fullmakten og melde på til prøver.`;
    }

    // Send SMS
    try {
      await sendSMS(recipientPhone, smsMessage);
      console.log(`[Fullmakt] SMS sendt til ${recipientPhone} (${eksisterendeBruker ? 'eksisterende' : 'ny'} bruker)`);
    } catch (smsError) {
      console.error(`[Fullmakt] Kunne ikke sende SMS til ${recipientPhone}:`, smsError);
      // Fortsett selv om SMS feiler
    }
  }

  return c.json({
    id: result.lastInsertRowid,
    type: 'given',
    dogName: body.dogName,
    recipientName: body.recipientName,
    recipientPhone: body.recipientPhone,
    trial: body.trial,
    validFrom: body.validFrom,
    validTo: body.validTo,
    permissions: body.permissions || ['run', 'results'],
    status: 'active'
  }, 201);
});

// Slett/revoke fullmakt
app.delete("/api/brukere/:telefon/fullmakter/:id", (c) => {
  const telefon = c.req.param("telefon");
  const id = c.req.param("id");

  // Sjekk at fullmakten tilhører brukeren
  const fullmakt = db.prepare("SELECT * FROM fullmakter WHERE id = ? AND giver_telefon = ?").get(id, telefon);

  if (!fullmakt) {
    return c.json({ error: "Fullmakt ikke funnet" }, 404);
  }

  // Oppdater status til revoked
  db.prepare("UPDATE fullmakter SET status = 'revoked' WHERE id = ?").run(id);

  return c.json({ success: true });
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
    selvstendighet_sum: 0, selvstendighet_count: 0,
    slipptid_sum: 0, slipptid_count: 0,
    sek_spontan: 0, sek_forbi: 0,
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
    if (k.selvstendighet) { stats.selvstendighet_sum += Number(k.selvstendighet); stats.selvstendighet_count++; }
    if (k.slipptid) { stats.slipptid_sum += Number(k.slipptid); stats.slipptid_count++; }
    stats.sek_spontan += Number(k.sek_spontan) || 0;
    stats.sek_forbi += Number(k.sek_forbi) || 0;

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
    selvstendighet: stats.selvstendighet_count > 0 ? Math.round((stats.selvstendighet_sum / stats.selvstendighet_count) * 100) / 100 : 0,
    slipptid_snitt: stats.slipptid_count > 0 ? Math.round((stats.slipptid_sum / stats.slipptid_count) * 100) / 100 : null,
    sekundering: {
      spontan: stats.sek_spontan,
      forbi: stats.sek_forbi,
      total: stats.sek_spontan + stats.sek_forbi
    },
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
// AVERSJONSBEVIS API
// ============================================

// Last opp aversjonsbevis for en hund
app.post("/api/hunder/:id/aversjonsbevis", async (c) => {
  const id = c.req.param("id");

  // Sjekk at hunden finnes
  const hund = db.prepare("SELECT * FROM hunder WHERE id = ?").get(id);
  if (!hund) return c.json({ error: "Hund ikke funnet" }, 404);

  const body = await c.req.json();
  const { bilde, dato } = body;

  if (!bilde) {
    return c.json({ error: "Bilde er påkrevd" }, 400);
  }

  // Sjekk at bildet er base64 og ikke for stort (maks 5MB)
  const base64Data = bilde.replace(/^data:image\/[a-z]+;base64,/, "");
  const sizeInBytes = (base64Data.length * 3) / 4;
  const maxSize = 5 * 1024 * 1024; // 5MB

  if (sizeInBytes > maxSize) {
    return c.json({ error: "Bildet er for stort. Maks 5MB tillatt." }, 400);
  }

  // Sjekk at det er et gyldig bilde-format
  if (!bilde.match(/^data:image\/(jpeg|jpg|png|gif|webp);base64,/)) {
    return c.json({ error: "Ugyldig bildeformat. Bruk JPEG, PNG, GIF eller WebP." }, 400);
  }

  db.prepare(`
    UPDATE hunder
    SET aversjonsbevis = ?,
        aversjonsbevis_dato = ?,
        aversjonsbevis_godkjent = 0
    WHERE id = ?
  `).run(bilde, dato || new Date().toISOString().slice(0, 10), id);

  return c.json({
    success: true,
    message: "Aversjonsbevis lastet opp. Venter på godkjenning."
  });
});

// Hent aversjonsbevis for en hund
app.get("/api/hunder/:id/aversjonsbevis", (c) => {
  const id = c.req.param("id");
  const hund = db.prepare(`
    SELECT id, navn, regnr, aversjonsbevis, aversjonsbevis_dato, aversjonsbevis_godkjent
    FROM hunder WHERE id = ?
  `).get(id);

  if (!hund) return c.json({ error: "Hund ikke funnet" }, 404);

  return c.json({
    harAversjonsbevis: !!hund.aversjonsbevis,
    bilde: hund.aversjonsbevis,
    dato: hund.aversjonsbevis_dato,
    godkjent: hund.aversjonsbevis_godkjent === 1
  });
});

// Slett aversjonsbevis
app.delete("/api/hunder/:id/aversjonsbevis", (c) => {
  const id = c.req.param("id");

  db.prepare(`
    UPDATE hunder
    SET aversjonsbevis = NULL,
        aversjonsbevis_dato = NULL,
        aversjonsbevis_godkjent = 0
    WHERE id = ?
  `).run(id);

  return c.json({ success: true });
});

// Godkjenn aversjonsbevis (kun prøveleder/admin)
app.post("/api/hunder/:id/aversjonsbevis/godkjenn", (c) => {
  const id = c.req.param("id");

  db.prepare(`
    UPDATE hunder
    SET aversjonsbevis_godkjent = 1
    WHERE id = ?
  `).run(id);

  return c.json({ success: true, message: "Aversjonsbevis godkjent" });
});

// ============================================
// PARTI-SIGNATURER API
// ============================================

// Hent signaturstatus for et parti
app.get("/api/prover/:proveId/parti/:parti/signaturer", (c) => {
  const proveId = c.req.param("proveId");
  const parti = c.req.param("parti");

  const signaturer = db.prepare(`
    SELECT ps.*,
           d.fornavn || ' ' || d.etternavn as dommer_navn,
           n.fornavn || ' ' || n.etternavn as nkkrep_navn
    FROM parti_signaturer ps
    LEFT JOIN brukere d ON ps.dommer_telefon = d.telefon
    LEFT JOIN brukere n ON ps.nkkrep_telefon = n.telefon
    WHERE ps.prove_id = ? AND ps.parti = ?
  `).all(proveId, parti);

  return c.json({
    signaturer,
    dommerSignert: signaturer.some(s => s.dommer_signert_at),
    nkkrepSignert: signaturer.some(s => s.nkkrep_signert_at)
  });
});

// Dommer signerer partiliste
app.post("/api/prover/:proveId/parti/:parti/signer-dommer", async (c) => {
  const proveId = c.req.param("proveId");
  const parti = c.req.param("parti");
  const body = await c.req.json();
  const { dommerTelefon } = body;

  if (!dommerTelefon) {
    return c.json({ error: "Mangler dommerTelefon" }, 400);
  }

  // Sjekk om signatur allerede finnes
  const existing = db.prepare(`
    SELECT * FROM parti_signaturer
    WHERE prove_id = ? AND parti = ? AND dommer_telefon = ?
  `).get(proveId, parti, dommerTelefon);

  if (existing) {
    // Oppdater eksisterende
    db.prepare(`
      UPDATE parti_signaturer
      SET dommer_signert_at = datetime('now')
      WHERE id = ?
    `).run(existing.id);
  } else {
    // Opprett ny
    db.prepare(`
      INSERT INTO parti_signaturer (prove_id, parti, dommer_telefon, dommer_signert_at)
      VALUES (?, ?, ?, datetime('now'))
    `).run(proveId, parti, dommerTelefon);
  }

  return c.json({ success: true, message: "Partiliste signert av dommer" });
});

// NKK-rep signerer partiliste
app.post("/api/prover/:proveId/parti/:parti/signer-nkkrep", async (c) => {
  const proveId = c.req.param("proveId");
  const parti = c.req.param("parti");
  const body = await c.req.json();
  const { nkkrepTelefon, dommerTelefon } = body;

  if (!nkkrepTelefon || !dommerTelefon) {
    return c.json({ error: "Mangler nkkrepTelefon eller dommerTelefon" }, 400);
  }

  // Finn eksisterende signatur fra dommer
  const existing = db.prepare(`
    SELECT * FROM parti_signaturer
    WHERE prove_id = ? AND parti = ? AND dommer_telefon = ?
  `).get(proveId, parti, dommerTelefon);

  if (!existing) {
    return c.json({ error: "Dommer må signere først" }, 400);
  }

  // Oppdater med NKK-rep signatur
  db.prepare(`
    UPDATE parti_signaturer
    SET nkkrep_telefon = ?, nkkrep_signert_at = datetime('now')
    WHERE id = ?
  `).run(nkkrepTelefon, existing.id);

  return c.json({ success: true, message: "Partiliste godkjent av NKK-representant" });
});

// Hent alle signaturer for en prøve (for admin/rapport)
app.get("/api/prover/:proveId/signaturer", (c) => {
  const proveId = c.req.param("proveId");

  const signaturer = db.prepare(`
    SELECT ps.*,
           d.fornavn || ' ' || d.etternavn as dommer_navn,
           n.fornavn || ' ' || n.etternavn as nkkrep_navn
    FROM parti_signaturer ps
    LEFT JOIN brukere d ON ps.dommer_telefon = d.telefon
    LEFT JOIN brukere n ON ps.nkkrep_telefon = n.telefon
    WHERE ps.prove_id = ?
    ORDER BY ps.parti
  `).all(proveId);

  return c.json(signaturer);
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

// Opprett kritikk (krever dommer)
app.post("/api/kritikker", requireDommer, async (c) => {
  const body = await c.req.json();
  const bruker = c.get("bruker");

  // Bruk innlogget dommers telefon
  const dommer_telefon = bruker.telefon;

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
    body.hund_id, body.prove_id, dommer_telefon, body.dato, body.klasse, body.parti, body.sted,
    body.presisjon, body.reising, body.godkjent_reising ? 1 : 0,
    body.stand_m, body.stand_u, body.tomstand, body.makker_stand, body.sjanse, body.slipptid,
    body.jaktlyst, body.fart, body.selvstendighet, body.soksbredde, body.reviering, body.samarbeid,
    body.sek_spontan, body.sek_forbi, body.apport, body.rapport_spontan ? 1 : 0,
    body.adferd, body.premie, body.kritikk_tekst
  );

  db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").run(
    "kritikk_opprettet",
    JSON.stringify({ kritikk_id: result.lastInsertRowid, dommer: dommer_telefon, hund_id: body.hund_id })
  );

  return c.json({ id: result.lastInsertRowid, ok: true });
});

// Oppdater kritikk (krever dommer)
app.put("/api/kritikker/:id", requireDommer, async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  const bruker = c.get("bruker");

  // Sjekk at dommeren eier denne kritikken (eller er admin)
  const existing = db.prepare("SELECT dommer_telefon FROM kritikker WHERE id = ?").get(id);
  if (!existing) {
    return c.json({ error: "Kritikk ikke funnet" }, 404);
  }

  if (existing.dommer_telefon !== bruker.telefon && bruker.rolle !== "admin") {
    return c.json({ error: "Du kan kun redigere dine egne kritikker" }, 403);
  }

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

    db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").run(
      "kritikk_oppdatert",
      JSON.stringify({ kritikk_id: id, dommer: bruker.telefon })
    );
  }

  const kritikk = db.prepare("SELECT * FROM kritikker WHERE id = ?").get(id);
  return c.json(kritikk);
});

// Hent kritikker for en prøve
app.get("/api/prover/:proveId/kritikker", (c) => {
  const proveId = c.req.param("proveId");
  const rows = db.prepare(`
    SELECT k.*, h.navn as hund_navn, h.regnr, h.rase,
           b.fornavn || ' ' || b.etternavn as dommer_navn
    FROM kritikker k
    LEFT JOIN hunder h ON k.hund_id = h.id
    LEFT JOIN brukere b ON k.dommer_telefon = b.telefon
    WHERE k.prove_id = ?
    ORDER BY k.parti, k.dato
  `).all(proveId);
  return c.json(rows);
});

// Hent innsendte kritikker for NKK-rep godkjenning
app.get("/api/kritikker/pending", (c) => {
  const rows = db.prepare(`
    SELECT k.*, h.navn as hund_navn, h.regnr, h.rase,
           b.fornavn || ' ' || b.etternavn as dommer_navn,
           p.navn as prove_navn, p.sted as prove_sted
    FROM kritikker k
    LEFT JOIN hunder h ON k.hund_id = h.id
    LEFT JOIN brukere b ON k.dommer_telefon = b.telefon
    LEFT JOIN prover p ON k.prove_id = p.id
    WHERE k.status = 'submitted'
    ORDER BY k.submitted_at DESC
  `).all();
  return c.json(rows);
});

// Send kritikk til NKK-rep
app.put("/api/kritikker/:id/submit", requireDommer, async (c) => {
  const id = c.req.param("id");
  const bruker = c.get("bruker");

  const result = db.prepare(`
    UPDATE kritikker SET status = 'submitted', submitted_at = datetime('now'), submitted_by = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(`${bruker.navn || bruker.telefon}`, id);

  if (result.changes === 0) return c.json({ error: "Kritikk ikke funnet" }, 404);

  db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").run(
    "kritikk_submitted", `Kritikk ${id} sendt til NKK-rep av ${bruker.telefon}`
  );
  return c.json({ success: true });
});

// NKK-rep godkjenner kritikk
app.put("/api/kritikker/:id/godkjenn", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const bruker = c.get("bruker");

  const result = db.prepare(`
    UPDATE kritikker SET status = 'approved', approved_at = datetime('now'), approved_by = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(`${bruker.navn || bruker.telefon}`, id);

  if (result.changes === 0) return c.json({ error: "Kritikk ikke funnet" }, 404);

  db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").run(
    "kritikk_godkjent", `Kritikk ${id} godkjent av ${bruker.telefon}`
  );
  return c.json({ success: true });
});

// NKK-rep returnerer kritikk til dommer
app.put("/api/kritikker/:id/returner", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  const bruker = c.get("bruker");

  // Hent kritikk-info for å finne dommers telefon
  const kritikk = db.prepare(`
    SELECT k.*, h.navn as hund_navn
    FROM kritikker k
    LEFT JOIN hunder h ON k.hund_id = h.id
    WHERE k.id = ?
  `).get(id);

  if (!kritikk) return c.json({ error: "Kritikk ikke funnet" }, 404);

  const result = db.prepare(`
    UPDATE kritikker SET status = 'returned', nkk_comment = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(body.nkk_comment || '', id);

  if (result.changes === 0) return c.json({ error: "Kritikk ikke funnet" }, 404);

  db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").run(
    "kritikk_returnert", `Kritikk ${id} returnert av ${bruker.telefon}: ${body.nkk_comment || ''}`
  );

  // Send SMS til dommer om returnert kritikk
  if (kritikk.dommer_telefon) {
    const kommentar = body.nkk_comment ? `\n\nKommentar: ${body.nkk_comment}` : '';
    const melding = `Kritikken for ${kritikk.hund_navn || 'hunden'} er returnert av NKK-rep og trenger endringer.${kommentar}\n\nLogg inn på fuglehundprove.no for å oppdatere.`;

    try {
      await sendSMS(kritikk.dommer_telefon, melding, { type: 'kritikk_retur' });
      console.log(`📱 SMS sendt til dommer ${kritikk.dommer_telefon} om returnert kritikk ${id}`);
    } catch (err) {
      console.error('Feil ved sending av SMS til dommer:', err);
    }
  }

  return c.json({ success: true });
});

// --- Backup (krever admin) ---
app.get("/api/backup", requireAdmin, (c) => {
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

// --- Import deltakere til database ---
// Oppretter hunder og midlertidige eieroppslag basert på deltakerliste
app.post("/api/import-participants", requireAdmin, async (c) => {
  try {
    const body = await c.req.json();
    const { participants, proveId } = body;

    if (!participants || !Array.isArray(participants)) {
      return c.json({ error: "Ingen deltakere å importere" }, 400);
    }

    const results = {
      created: 0,
      updated: 0,
      skipped: 0,
      errors: []
    };

    // Transaksjonsbehandling
    const insertHund = db.prepare(`
      INSERT INTO hunder (regnr, navn, rase, kjonn, eier_telefon)
      VALUES (?, ?, ?, ?, ?)
    `);

    const updateHund = db.prepare(`
      UPDATE hunder SET navn = ?, rase = ?, eier_telefon = COALESCE(eier_telefon, ?)
      WHERE regnr = ?
    `);

    const findHund = db.prepare("SELECT id, eier_telefon FROM hunder WHERE regnr = ?");

    // Opprett midlertidig eier-oppslag tabell hvis ikke finnes
    db.exec(`
      CREATE TABLE IF NOT EXISTS eier_oppslag (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        regnr TEXT UNIQUE NOT NULL,
        eier_navn TEXT,
        eier_epost TEXT,
        forer_navn TEXT,
        forer_epost TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const insertEierOppslag = db.prepare(`
      INSERT OR REPLACE INTO eier_oppslag (regnr, eier_navn, eier_epost, forer_navn, forer_epost)
      VALUES (?, ?, ?, ?, ?)
    `);

    for (const p of participants) {
      try {
        const regnr = (p.regnr || '').trim();
        if (!regnr) {
          results.skipped++;
          continue;
        }

        // Lagre eierinfo i oppslag-tabell for senere kobling
        insertEierOppslag.run(
          regnr,
          p.eier || null,
          p.epost || null,
          p.forer || null,
          null
        );

        // Sjekk om hunden allerede finnes
        const existing = findHund.get(regnr);

        if (existing) {
          // Oppdater eksisterende hund (kun hvis ikke allerede har eier)
          updateHund.run(
            p.hundenavn || p.navn,
            p.rase || null,
            null, // Ikke overskrive eksisterende eier_telefon
            regnr
          );
          results.updated++;
        } else {
          // Opprett ny hund (uten eier_telefon foreløpig)
          insertHund.run(
            regnr,
            p.hundenavn || p.navn,
            p.rase || null,
            null, // Kjønn ikke i deltakerliste
            null  // Eier kobles senere når bruker registrerer seg
          );
          results.created++;
        }
      } catch (err) {
        results.errors.push({
          regnr: p.regnr,
          error: err.message
        });
      }
    }

    return c.json({
      success: true,
      message: `Importert ${results.created} nye hunder, oppdatert ${results.updated}`,
      ...results
    });

  } catch (err) {
    console.error("Import error:", err);
    return c.json({ error: "Feil ved import: " + err.message }, 500);
  }
});

// --- Koble bruker til hunder basert på e-post/navn ---
app.post("/api/koble-hunder", requireAuth, async (c) => {
  try {
    const bruker = c.get("bruker");
    const telefon = bruker.telefon;
    const email = bruker.epost || '';
    const fullNavn = `${bruker.fornavn || ''} ${bruker.etternavn || ''}`.trim().toLowerCase();

    // Finn hunder som matcher brukerens e-post eller navn fra eier_oppslag
    const oppslag = db.prepare(`
      SELECT o.regnr, h.id as hund_id
      FROM eier_oppslag o
      JOIN hunder h ON h.regnr = o.regnr
      WHERE h.eier_telefon IS NULL
        AND (
          (o.eier_epost IS NOT NULL AND LOWER(o.eier_epost) = LOWER(?))
          OR (o.forer_epost IS NOT NULL AND LOWER(o.forer_epost) = LOWER(?))
          OR (o.eier_navn IS NOT NULL AND LOWER(o.eier_navn) LIKE ?)
          OR (o.forer_navn IS NOT NULL AND LOWER(o.forer_navn) LIKE ?)
        )
    `).all(email, email, `%${fullNavn}%`, `%${fullNavn}%`);

    if (oppslag.length === 0) {
      return c.json({ success: true, linked: 0, message: "Ingen hunder å koble" });
    }

    // Koble hundene til brukeren
    const updateHund = db.prepare("UPDATE hunder SET eier_telefon = ? WHERE id = ?");
    let linked = 0;

    for (const o of oppslag) {
      try {
        updateHund.run(telefon, o.hund_id);
        linked++;
      } catch (err) {
        console.error('Feil ved kobling av hund:', o.regnr, err);
      }
    }

    return c.json({
      success: true,
      linked,
      message: `Koblet ${linked} hund${linked === 1 ? '' : 'er'} til din profil`
    });

  } catch (err) {
    console.error("Kobling error:", err);
    return c.json({ error: "Feil ved kobling: " + err.message }, 500);
  }
});

// --- Logo upload endpoint ---
app.post("/api/upload-logo", async (c) => {
  try {
    const formData = await c.req.formData();
    const file = formData.get("logo");

    if (!file || !(file instanceof File)) {
      return c.json({ error: "Ingen fil mottatt" }, 400);
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const ext = file.name.split(".").pop().toLowerCase();

    // Save as PNG (primary format)
    if (ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "svg") {
      const logoPath = join(__dirname, "images", "logo." + ext);
      writeFileSync(logoPath, buffer);

      // Also save as logo.png if not already PNG
      if (ext !== "png") {
        const pngPath = join(__dirname, "images", "logo-original." + ext);
        writeFileSync(pngPath, buffer);
      }

      console.log("✅ Logo uploaded:", file.name, "->", logoPath);
      return c.json({ success: true, filename: "logo." + ext });
    } else {
      return c.json({ error: "Ugyldig filformat. Bruk PNG, JPG eller SVG." }, 400);
    }
  } catch (err) {
    console.error("Logo upload error:", err);
    return c.json({ error: "Feil ved opplasting: " + err.message }, 500);
  }
});

// --- Serve scripts ---
app.get("/storage-shim.js", (c) => {
  c.header("Content-Type", "application/javascript");
  return c.body(readFileSync(join(__dirname, "storage-shim.js"), "utf-8"));
});

app.get("/auth.js", (c) => {
  c.header("Content-Type", "application/javascript");
  return c.body(readFileSync(join(__dirname, "auth.js"), "utf-8"));
});

app.get("/site-lock.js", (c) => {
  c.header("Content-Type", "application/javascript");
  return c.body(readFileSync(join(__dirname, "site-lock.js"), "utf-8"));
});

app.get("/admin-lock.js", (c) => {
  c.header("Content-Type", "application/javascript");
  return c.body(readFileSync(join(__dirname, "admin-lock.js"), "utf-8"));
});

// --- Inject scripts into HTML pages ---
const ADMIN_PAGES = ['admin.html', 'admin-panel.html'];

function serveWithShim(filePath, c, isAdmin = false) {
  if (!existsSync(filePath)) return c.text("Not found", 404);
  let html = readFileSync(filePath, "utf-8");

  // Mobile CSS fix + Site-lock først, deretter admin-lock (hvis admin-side), deretter auth og storage-shim
  let injected = `<link rel="stylesheet" href="/mobile-fix.css">\n`;
  injected += `<script src="/site-lock.js"></script>\n`;
  if (isAdmin) {
    injected += `<script src="/admin-lock.js"></script>\n`;
  }
  injected += `<script src="/auth.js"></script>\n<script src="/storage-shim.js"></script>\n<script src="/navbar.js" defer></script>`;

  if (html.includes("<head>")) {
    html = html.replace("<head>", `<head>\n${injected}`);
  } else {
    html = injected + "\n" + html;
  }
  c.header("Content-Type", "text/html; charset=utf-8");
  c.header("Cache-Control", "no-cache, no-store, must-revalidate");
  c.header("Pragma", "no-cache");
  c.header("Expires", "0");
  return c.body(html);
}

app.get("/", (c) => serveWithShim(join(__dirname, "index.html"), c));

// Clean URL for undersøkelse landingsside
app.get("/undersokelse", (c) => serveWithShim(join(__dirname, "undersokelse.html"), c));

// Clean URL for dommer-testside
app.get("/dommertest", (c) => serveWithShim(join(__dirname, "dommertest.html"), c));

// Clean URL for VK dommer-testside
app.get("/dommertestvk", (c) => serveWithShim(join(__dirname, "dommer-vk-test.html"), c));

// Clean URL for UK/AK todelt dommer-testside
app.get("/dommertestukak", (c) => serveWithShim(join(__dirname, "dommer-ukak-dual.html"), c));

app.get("/:page{.+\\.html}", (c) => {
  const page = c.req.param("page");
  const isAdmin = ADMIN_PAGES.includes(page);
  return serveWithShim(join(__dirname, page), c, isAdmin);
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

// ============================================
// DRIFTSADMIN API-ENDEPUNKTER
// ============================================

// Systemhelse
app.get("/api/system/health", (c) => {
  const fs = require("fs");
  const os = require("os");

  // Database størrelse
  let dbSize = "-";
  try {
    const stats = fs.statSync(DB_PATH);
    const sizeKb = stats.size / 1024;
    dbSize = sizeKb > 1024 ? `${(sizeKb / 1024).toFixed(1)} MB` : `${sizeKb.toFixed(0)} KB`;
  } catch (e) {}

  // Oppetid
  const uptimeSeconds = process.uptime();
  const hours = Math.floor(uptimeSeconds / 3600);
  const minutes = Math.floor((uptimeSeconds % 3600) / 60);
  const uptime = hours > 0 ? `${hours}t ${minutes}m` : `${minutes}m`;

  // Minne
  const memUsed = process.memoryUsage().heapUsed / 1024 / 1024;
  const memory = `${memUsed.toFixed(0)} MB`;

  // Node versjon
  const nodeVersion = process.version;

  return c.json({ dbSize, uptime, memory, nodeVersion });
});

// SMS-statistikk (driftsadmin) med filtrering
app.get("/api/sms/stats", (c) => {
  try {
    const klubbId = c.req.query("klubb") || "";
    const periode = c.req.query("periode") || "all";
    const retning = c.req.query("retning") || ""; // ut, inn, eller tom for alle

    // Sjekk om sms_log-tabellen eksisterer
    const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sms_log'").get();

    if (!tableExists) {
      return c.json({ totalt: 0, vellykket: 0, feilet: 0, kostnad: null, siste: [], klubber: [] });
    }

    // Bygg WHERE-klausul basert på filtre
    let whereConditions = [];
    let params = [];

    // Klubb-filter
    if (klubbId === "fuglehundprove.no") {
      whereConditions.push("(klubb_id IS NULL OR klubb_id = '' OR type = 'verifisering')");
    } else if (klubbId) {
      whereConditions.push("klubb_id = ?");
      params.push(klubbId);
    }

    // Retning-filter (utgående/innkommende)
    if (retning === "ut") {
      whereConditions.push("retning = 'ut'");
    } else if (retning === "inn") {
      whereConditions.push("retning = 'inn'");
    }

    // Periode-filter
    const now = new Date();
    let dateFilter = "";
    switch (periode) {
      case "today":
        dateFilter = `date(created_at) = date('now')`;
        break;
      case "week":
        dateFilter = `created_at >= datetime('now', '-7 days')`;
        break;
      case "month":
        dateFilter = `strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')`;
        break;
      case "last_month":
        dateFilter = `strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now', '-1 month')`;
        break;
      case "year":
        dateFilter = `strftime('%Y', created_at) = strftime('%Y', 'now')`;
        break;
      default:
        dateFilter = "";
    }
    if (dateFilter) {
      whereConditions.push(dateFilter);
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(" AND ")}` : "";

    const totalt = db.prepare(`SELECT COUNT(*) as n FROM sms_log ${whereClause}`).get(...params)?.n || 0;
    const vellykket = db.prepare(`SELECT COUNT(*) as n FROM sms_log ${whereClause} ${whereClause ? "AND" : "WHERE"} status = 'sent'`).get(...params)?.n || 0;
    const feilet = totalt - vellykket;

    // Estimert kostnad (ca 0.50 kr per utgående SMS)
    const utgaende = db.prepare(`SELECT COUNT(*) as n FROM sms_log ${whereClause} ${whereClause ? "AND" : "WHERE"} retning = 'ut' AND status = 'sent'`).get(...params)?.n || 0;
    const kostnad = (utgaende * 0.5).toFixed(0);

    // Siste 20 SMS med filter
    const siste = db.prepare(`SELECT * FROM sms_log ${whereClause} ORDER BY created_at DESC LIMIT 20`).all(...params);

    // Hent ALLE klubber (ikke bare de med SMS)
    const klubber = db.prepare(`
      SELECT id, navn FROM klubber ORDER BY navn
    `).all();

    return c.json({ totalt, vellykket, feilet, kostnad, utgaende, siste, klubber });
  } catch (err) {
    return c.json({ totalt: 0, vellykket: 0, feilet: 0, kostnad: null, siste: [], klubber: [], error: err.message });
  }
});

// Send SMS (for invitasjoner, varsler etc.)
app.post("/api/sms/send", async (c) => {
  try {
    const body = await c.req.json();
    const { to, message, type = "invitasjon", klubb_id = null } = body;

    if (!to || !message) {
      return c.json({ success: false, error: "Mangler telefonnummer eller melding" }, 400);
    }

    // Normaliser telefonnummer
    let telefon = to.replace(/\s+/g, "").replace(/^\+47/, "");
    if (!/^\d{8}$/.test(telefon)) {
      return c.json({ success: false, error: "Ugyldig telefonnummer" }, 400);
    }

    // Send SMS
    const result = await sendSMS(telefon, message, { type, klubb_id });

    if (result.success) {
      return c.json({ success: true, provider: result.provider });
    } else {
      return c.json({ success: false, error: result.error }, 500);
    }
  } catch (err) {
    console.error("SMS send error:", err);
    return c.json({ success: false, error: err.message }, 500);
  }
});

// Backup-liste (driftsadmin)
app.get("/api/backups", (c) => {
  const fs = require("fs");
  const path = require("path");

  const backupDir = path.join(__dirname, "backups");

  if (!fs.existsSync(backupDir)) {
    return c.json({ backups: [] });
  }

  const files = fs.readdirSync(backupDir)
    .filter(f => f.endsWith(".db"))
    .map(name => {
      const stats = fs.statSync(path.join(backupDir, name));
      const sizeKb = stats.size / 1024;
      return {
        name,
        size: sizeKb > 1024 ? `${(sizeKb / 1024).toFixed(1)} MB` : `${sizeKb.toFixed(0)} KB`,
        created: stats.mtime.toLocaleString("no-NO")
      };
    })
    .sort((a, b) => b.name.localeCompare(a.name));

  return c.json({ backups: files });
});

// Opprett backup
app.post("/api/backups/create", (c) => {
  const fs = require("fs");
  const path = require("path");

  const backupDir = path.join(__dirname, "backups");
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
  const backupName = `fuglehund_${timestamp}.db`;
  const backupPath = path.join(backupDir, backupName);

  try {
    fs.copyFileSync(DB_PATH, backupPath);
    db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").run(
      "backup_created", `Backup opprettet: ${backupName}`
    );
    return c.json({ success: true, name: backupName });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// Last ned spesifikk backup
app.get("/api/backup/:name", (c) => {
  const fs = require("fs");
  const path = require("path");

  const name = c.req.param("name");
  const backupPath = path.join(__dirname, "backups", name);

  if (!fs.existsSync(backupPath) || !name.endsWith(".db")) {
    return c.json({ error: "Backup ikke funnet" }, 404);
  }

  const data = fs.readFileSync(backupPath);
  c.header("Content-Type", "application/octet-stream");
  c.header("Content-Disposition", `attachment; filename="${name}"`);
  return c.body(data);
});

// Slett backup
app.delete("/api/backups/:name", (c) => {
  const fs = require("fs");
  const path = require("path");

  const name = c.req.param("name");
  const backupPath = path.join(__dirname, "backups", name);

  if (!fs.existsSync(backupPath) || !name.endsWith(".db")) {
    return c.json({ error: "Backup ikke funnet" }, 404);
  }

  try {
    fs.unlinkSync(backupPath);
    db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").run(
      "backup_deleted", `Backup slettet: ${name}`
    );
    return c.json({ success: true });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// Slett bruker (telefon som nøkkel)
app.delete("/api/superadmin/brukere/:telefon", (c) => {
  const telefon = c.req.param("telefon");

  try {
    const bruker = db.prepare("SELECT * FROM brukere WHERE telefon = ?").get(telefon);
    if (!bruker) {
      return c.json({ error: "Bruker ikke funnet" }, 404);
    }

    // Auto-backup FØR sletting
    autoBackup("bruker_slettet");

    db.prepare("DELETE FROM brukere WHERE telefon = ?").run(telefon);
    db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").run(
      "bruker_slettet", `Bruker slettet: ${bruker.fornavn} ${bruker.etternavn} (${bruker.telefon})`
    );
    return c.json({ success: true });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// ==========================================
// NKK-REP VARSLING
// ==========================================

// Send SMS-varsling til NKK-rep når kritikker er klare for godkjenning
app.post("/api/varsle-nkkrep", async (c) => {
  try {
    const body = await c.req.json();
    const { partyId, partyName, judgeName, dogCount } = body;

    if (!partyId || !judgeName) {
      return c.json({ error: "Mangler påkrevde felter" }, 400);
    }

    // Hent NKK-rep info fra trialTeam i kv_store
    const teamRow = db.prepare("SELECT value FROM kv_store WHERE key = ?").get("trialTeam");
    if (!teamRow) {
      return c.json({ error: "Ingen prøveteam konfigurert" }, 404);
    }

    let team;
    try {
      team = JSON.parse(teamRow.value);
    } catch (e) {
      return c.json({ error: "Ugyldig prøveteam-data" }, 500);
    }

    if (!team.nkkrep || !team.nkkrep.phone) {
      return c.json({ error: "NKK-representant ikke konfigurert eller mangler telefonnummer" }, 404);
    }

    const nkkRepPhone = team.nkkrep.phone;
    const nkkRepName = team.nkkrep.name || "NKK-rep";

    // Lag SMS-melding
    const message = `Kritikker fra ${partyName || partyId} er klare for godkjenning. Dommer: ${judgeName}. ${dogCount ? dogCount + ' hunder. ' : ''}Logg inn på fuglehundprove.no/nkk-godkjenning`;

    // Send SMS
    const smsResult = await sendSMS(nkkRepPhone, message, { type: "nkk_varsling" });

    if (!smsResult.success) {
      console.error(`Kunne ikke sende NKK-varsling til ${nkkRepPhone}:`, smsResult.error);
      return c.json({
        success: false,
        error: "Kunne ikke sende SMS",
        details: smsResult.error
      }, 500);
    }

    console.log(`📱 NKK-varsling sendt til ${nkkRepName} (${nkkRepPhone}) om kritikker fra ${partyName}`);

    return c.json({
      success: true,
      message: `Varsling sendt til ${nkkRepName}`,
      devMode: smsResult.devMode || false
    });

  } catch (err) {
    console.error("Feil ved NKK-varsling:", err);
    return c.json({ error: err.message }, 500);
  }
});

// =============================================
// DVK-KONTROLLER API
// =============================================

// Hent alle DVK-kontroller for en prøve
app.get("/api/dvk-kontroller/:prove_id", (c) => {
  const { prove_id } = c.req.param();
  try {
    const kontroller = db.prepare(`
      SELECT * FROM dvk_kontroller
      WHERE prove_id = ?
      ORDER BY created_at DESC
    `).all(prove_id);
    return c.json(kontroller);
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// Opprett ny DVK-kontroll
app.post("/api/dvk-kontroller", async (c) => {
  try {
    const body = await c.req.json();
    const {
      prove_id, tidspunkt, parti, type, hund, forer, beskrivelse,
      obs_hundehold, obs_behandling, obs_vannmat, obs_hvile, obs_veiledning, obs_bekymring,
      tiltak_ingen, tiltak_veiledning, tiltak_advarsel, tiltak_dommer, tiltak_proveleder, tiltak_diskvalifikasjon,
      registrert_av
    } = body;

    if (!prove_id || !tidspunkt || !type || !registrert_av) {
      return c.json({ error: "Mangler påkrevde felt: prove_id, tidspunkt, type, registrert_av" }, 400);
    }

    const result = db.prepare(`
      INSERT INTO dvk_kontroller (
        prove_id, tidspunkt, parti, type, hund, forer, beskrivelse,
        obs_hundehold, obs_behandling, obs_vannmat, obs_hvile, obs_veiledning, obs_bekymring,
        tiltak_ingen, tiltak_veiledning, tiltak_advarsel, tiltak_dommer, tiltak_proveleder, tiltak_diskvalifikasjon,
        registrert_av
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      prove_id, tidspunkt, parti || null, type, hund || null, forer || null, beskrivelse || null,
      obs_hundehold ? 1 : 0, obs_behandling ? 1 : 0, obs_vannmat ? 1 : 0,
      obs_hvile ? 1 : 0, obs_veiledning ? 1 : 0, obs_bekymring ? 1 : 0,
      tiltak_ingen ? 1 : 0, tiltak_veiledning ? 1 : 0, tiltak_advarsel ? 1 : 0,
      tiltak_dommer ? 1 : 0, tiltak_proveleder ? 1 : 0, tiltak_diskvalifikasjon ? 1 : 0,
      registrert_av
    );

    autoBackup("dvk-kontroll");
    return c.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// Slett en DVK-kontroll
app.delete("/api/dvk-kontroller/:id", (c) => {
  const { id } = c.req.param();
  try {
    const result = db.prepare("DELETE FROM dvk_kontroller WHERE id = ?").run(id);
    if (result.changes === 0) {
      return c.json({ error: "Kontroll ikke funnet" }, 404);
    }
    autoBackup("dvk-kontroll-delete");
    return c.json({ success: true });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// Hent DVK-signatur for en prøve
app.get("/api/dvk-signatur/:prove_id", (c) => {
  const { prove_id } = c.req.param();
  try {
    const signatur = db.prepare("SELECT * FROM dvk_signaturer WHERE prove_id = ?").get(prove_id);
    if (!signatur) {
      return c.json({ exists: false });
    }
    return c.json({ exists: true, ...signatur });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// Lagre/oppdater DVK-signatur
app.post("/api/dvk-signatur", async (c) => {
  try {
    const body = await c.req.json();
    const { prove_id, dvk_navn, dvk_telefon, initialer, signert_dato, signert_tid, full_signatur } = body;

    if (!prove_id || !dvk_navn || !signert_dato || !signert_tid || !full_signatur) {
      return c.json({ error: "Mangler påkrevde felt" }, 400);
    }

    // Upsert - oppdater hvis finnes, ellers opprett
    db.prepare(`
      INSERT INTO dvk_signaturer (prove_id, dvk_navn, dvk_telefon, initialer, signert_dato, signert_tid, full_signatur)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(prove_id) DO UPDATE SET
        dvk_navn = excluded.dvk_navn,
        dvk_telefon = excluded.dvk_telefon,
        initialer = excluded.initialer,
        signert_dato = excluded.signert_dato,
        signert_tid = excluded.signert_tid,
        full_signatur = excluded.full_signatur
    `).run(prove_id, dvk_navn, dvk_telefon || null, initialer || null, signert_dato, signert_tid, full_signatur);

    autoBackup("dvk-signatur");
    return c.json({ success: true });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// =============================================
// DVK-JOURNAL API (komplett journal)
// =============================================

// Hent DVK-journal for en prøve
app.get("/api/dvk-journal/:prove_id", (c) => {
  const { prove_id } = c.req.param();
  try {
    const journal = db.prepare("SELECT * FROM dvk_journaler WHERE prove_id = ?").get(prove_id);
    if (!journal) {
      return c.json({ exists: false });
    }
    // Parse JSON-felt
    return c.json({
      exists: true,
      ...journal,
      kontroller: journal.kontroller_json ? JSON.parse(journal.kontroller_json) : {},
      avvik: journal.avvik_json ? JSON.parse(journal.avvik_json) : [],
      vetHenvisninger: journal.vet_henvisninger_json ? JSON.parse(journal.vet_henvisninger_json) : [],
      signatur: journal.signatur_json ? JSON.parse(journal.signatur_json) : null
    });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// Lagre/oppdater DVK-journal (auto-save)
app.post("/api/dvk-journal", async (c) => {
  try {
    const body = await c.req.json();
    const {
      prove_id, prove_navn, arrangor_sted, prove_dato,
      dvk_navn, dvk_telefon, dvk_assistent,
      kontroller, avvik, vetHenvisninger
    } = body;

    if (!prove_id || !dvk_navn) {
      return c.json({ error: "Mangler påkrevde felt: prove_id, dvk_navn" }, 400);
    }

    // Upsert
    db.prepare(`
      INSERT INTO dvk_journaler (
        prove_id, prove_navn, arrangor_sted, prove_dato,
        dvk_navn, dvk_telefon, dvk_assistent,
        kontroller_json, avvik_json, vet_henvisninger_json,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(prove_id) DO UPDATE SET
        prove_navn = excluded.prove_navn,
        arrangor_sted = excluded.arrangor_sted,
        prove_dato = excluded.prove_dato,
        dvk_navn = excluded.dvk_navn,
        dvk_telefon = excluded.dvk_telefon,
        dvk_assistent = excluded.dvk_assistent,
        kontroller_json = excluded.kontroller_json,
        avvik_json = excluded.avvik_json,
        vet_henvisninger_json = excluded.vet_henvisninger_json,
        updated_at = datetime('now')
    `).run(
      prove_id, prove_navn || null, arrangor_sted || null, prove_dato || null,
      dvk_navn, dvk_telefon || null, dvk_assistent || null,
      JSON.stringify(kontroller || {}),
      JSON.stringify(avvik || []),
      JSON.stringify(vetHenvisninger || [])
    );

    return c.json({ success: true });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// Signer og ferdigstill DVK-journal
app.post("/api/dvk-journal/:prove_id/sign", async (c) => {
  const { prove_id } = c.req.param();
  try {
    const body = await c.req.json();
    const { signatur, journalData } = body;

    if (!signatur || !signatur.fullSignatur) {
      return c.json({ error: "Mangler signatur" }, 400);
    }

    // Oppdater journalen med signatur og sett status til signed
    db.prepare(`
      UPDATE dvk_journaler SET
        prove_navn = ?,
        arrangor_sted = ?,
        prove_dato = ?,
        dvk_navn = ?,
        dvk_telefon = ?,
        dvk_assistent = ?,
        kontroller_json = ?,
        avvik_json = ?,
        vet_henvisninger_json = ?,
        signatur_json = ?,
        status = 'signed',
        signed_at = datetime('now'),
        updated_at = datetime('now')
      WHERE prove_id = ?
    `).run(
      journalData.proveName || null,
      journalData.arrangorSted || null,
      journalData.proveDato || null,
      journalData.dvkNavn,
      journalData.dvkTelefon || null,
      journalData.dvkAssistent || null,
      JSON.stringify(journalData.kontroller || {}),
      JSON.stringify(journalData.avvik || []),
      JSON.stringify(journalData.vetHenvisninger || []),
      JSON.stringify(signatur),
      prove_id
    );

    // Hvis journal ikke finnes, opprett den
    const exists = db.prepare("SELECT id FROM dvk_journaler WHERE prove_id = ?").get(prove_id);
    if (!exists) {
      db.prepare(`
        INSERT INTO dvk_journaler (
          prove_id, prove_navn, arrangor_sted, prove_dato,
          dvk_navn, dvk_telefon, dvk_assistent,
          kontroller_json, avvik_json, vet_henvisninger_json,
          signatur_json, status, signed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'signed', datetime('now'))
      `).run(
        prove_id,
        journalData.proveName || null,
        journalData.arrangorSted || null,
        journalData.proveDato || null,
        journalData.dvkNavn,
        journalData.dvkTelefon || null,
        journalData.dvkAssistent || null,
        JSON.stringify(journalData.kontroller || {}),
        JSON.stringify(journalData.avvik || []),
        JSON.stringify(journalData.vetHenvisninger || []),
        JSON.stringify(signatur)
      );
    }

    // Lagre også i dokumentarkivet
    db.prepare(`
      INSERT INTO prove_dokumenter (prove_id, dokument_type, tittel, innhold_json, opprettet_av)
      VALUES (?, 'dvk_journal', 'DVK Kontrolljournal', ?, ?)
    `).run(
      prove_id,
      JSON.stringify({ ...journalData, signatur }),
      signatur.navn
    );

    autoBackup("dvk-journal-signed");
    return c.json({ success: true, message: "Journal signert og arkivert" });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// =============================================
// DOKUMENTARKIV API
// =============================================

// Hent alle dokumenter for en prøve
app.get("/api/prove-dokumenter/:prove_id", (c) => {
  const { prove_id } = c.req.param();
  try {
    const dokumenter = db.prepare(`
      SELECT id, prove_id, dokument_type, tittel, filnavn, opprettet_av, created_at
      FROM prove_dokumenter
      WHERE prove_id = ?
      ORDER BY created_at DESC
    `).all(prove_id);
    return c.json(dokumenter);
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// Hent ett dokument med innhold
app.get("/api/prove-dokumenter/:prove_id/:id", (c) => {
  const { prove_id, id } = c.req.param();
  try {
    const dok = db.prepare(`
      SELECT * FROM prove_dokumenter WHERE prove_id = ? AND id = ?
    `).get(prove_id, id);
    if (!dok) {
      return c.json({ error: "Dokument ikke funnet" }, 404);
    }
    return c.json({
      ...dok,
      innhold: dok.innhold_json ? JSON.parse(dok.innhold_json) : null
    });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// Legg til dokument i arkivet
app.post("/api/prove-dokumenter", async (c) => {
  try {
    const body = await c.req.json();
    const { prove_id, dokument_type, tittel, filnavn, innhold, opprettet_av } = body;

    if (!prove_id || !dokument_type || !tittel) {
      return c.json({ error: "Mangler påkrevde felt" }, 400);
    }

    const result = db.prepare(`
      INSERT INTO prove_dokumenter (prove_id, dokument_type, tittel, filnavn, innhold_json, opprettet_av)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      prove_id, dokument_type, tittel, filnavn || null,
      innhold ? JSON.stringify(innhold) : null,
      opprettet_av || null
    );

    autoBackup("dokument-arkivert");
    return c.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// Static files
app.use("/*", serveStatic({ root: __dirname }));

// Rydd opp utløpte OTP-koder hver time
setInterval(cleanExpired, 60 * 60 * 1000);

// Automatisk backup hver 30. minutt
setInterval(() => autoBackup("scheduled"), 30 * 60 * 1000);

// Backup ved oppstart
autoBackup("startup");

serve({ fetch: app.fetch, port: PORT, hostname: "0.0.0.0" }, () => {
  console.log(`🐕 Fuglehundprøve running on http://0.0.0.0:${PORT}`);
  console.log(`   Admin: http://localhost:${PORT}/admin-panel.html`);
  console.log(`   Backup: http://localhost:${PORT}/api/backup`);
  console.log(`   Auto-backup: Hver 30. minutt + ved endringer`);
  const smsStatus = smsProvider === "twilio" ? "Twilio" : (smsProvider === "sveve" ? "Sveve" : "Dev mode (codes logged to console)");
  console.log(`   SMS: ${smsStatus}`);
});
