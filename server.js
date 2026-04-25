import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { bodyLimit } from "hono/body-limit";
import Database from "better-sqlite3";
import { readFileSync, existsSync, writeFileSync, copyFileSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { config } from "dotenv";
import { createHash, randomBytes, createCipheriv, createDecipheriv, scryptSync } from "crypto";
import bcrypt from "bcrypt";

// Load environment variables
config();

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");
const XLSX = require("xlsx");
const jwt = require("jsonwebtoken");

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH ? join(__dirname, process.env.DB_PATH) : join(__dirname, "fuglehund.db");
const PORT = Number(process.env.PORT || 8889);
// JWT_SECRET MÅ settes i produksjon - ingen default verdi tillatt
const JWT_SECRET = process.env.JWT_SECRET;
// Sesjon: 12 timer absolutt maks (krever re-login selv ved aktiv bruk)
// Inaktivitets-timeout håndteres i frontend (60 min)
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "12h";

if (!JWT_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    console.error("❌ KRITISK FEIL: JWT_SECRET må settes i produksjon!");
    console.error("   Legg til JWT_SECRET i .env eller som miljøvariabel.");
    console.error("   Eksempel: JWT_SECRET=$(openssl rand -hex 32)");
    process.exit(1);
  } else {
    console.warn("⚠️  ADVARSEL: JWT_SECRET ikke satt - bruker USIKKER dev-verdi!");
    console.warn("   Dette er IKKE trygt for produksjon!");
  }
}
const JWT_SECRET_FINAL = JWT_SECRET || "DEV-ONLY-INSECURE-SECRET-DO-NOT-USE-IN-PRODUCTION";
const SITE_PIN = process.env.SITE_PIN || "";  // Tom = deaktivert
const ADMIN_PIN = process.env.ADMIN_PIN || "";  // Tom = deaktivert

// --- Kryptering for sensitive data (Vipps API-nøkler etc.) ---
// Bruker AES-256-GCM med nøkkel derivert fra JWT_SECRET
const ENCRYPTION_KEY = scryptSync(JWT_SECRET_FINAL, 'fuglehund-salt-v1', 32);
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';

function encryptSensitive(plaintext) {
  if (!plaintext) return null;
  const iv = randomBytes(16);
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  // Format: iv:authTag:encrypted
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

function decryptSensitive(ciphertext) {
  if (!ciphertext) return null;
  // Sjekk om det er gammel ukryptert verdi (migration support)
  if (!ciphertext.includes(':')) {
    return ciphertext; // Returnerer ukryptert for bakoverkompatibilitet
  }
  try {
    const [ivHex, authTagHex, encrypted] = ciphertext.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, ENCRYPTION_KEY, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    console.error('[Decrypt] Feil ved dekryptering:', err.message);
    return ciphertext; // Returner original ved feil (kan være ukryptert)
  }
}

// --- SMS config (Sveve prioritert, Twilio som backup) ---
const SVEVE_USER = process.env.SVEVE_USER || "";
const SVEVE_PASS = process.env.SVEVE_PASS || "";
const SVEVE_FROM = process.env.SVEVE_FROM || "Fuglehund"; // Avsendernavn (maks 11 tegn)
const sveveConfigured = !!(SVEVE_USER && SVEVE_PASS);

// --- AI config (Claude for dokumentavlesning) ---
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const aiConfigured = !!ANTHROPIC_API_KEY;

// Twilio (backup/legacy)
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER || "";
const TWILIO_MESSAGING_SERVICE_SID = process.env.TWILIO_MESSAGING_SERVICE_SID || "";
const twilioConfigured = !!(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && (TWILIO_PHONE_NUMBER || TWILIO_MESSAGING_SERVICE_SID));

// SMS provider prioritet: Sveve > Twilio > Dev mode

// Rate limiting for masse-SMS (per prøve: maks 2 utsendelser per time)
const masseSmsRateLimit = new Map(); // proveId -> { lastSent: timestamp, count: number }
const MASSE_SMS_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutter mellom utsendelser
const MASSE_SMS_MAX_PER_HOUR = 3; // Maks 3 utsendelser per time per prøve
const smsProvider = sveveConfigured ? "sveve" : (twilioConfigured ? "twilio" : "dev");

// SMS-køsystem konfigurasjon
const SMS_QUEUE_BATCH_SIZE = 10; // Antall SMS å sende per batch
const SMS_QUEUE_BATCH_DELAY_MS = 1000; // Delay mellom hver SMS i batch
const SMS_QUEUE_INTERVAL_MS = 5000; // Hvor ofte køen sjekkes
let smsQueueProcessing = false;

// Warn if using default secret
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

  -- Rapport-logg (for å spore sendte rapporter)
  CREATE TABLE IF NOT EXISTS rapport_logg (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prove_id TEXT NOT NULL,
    rapport_type TEXT NOT NULL,  -- 'NKK', 'FKF', 'raseklubb', 'NJFF'
    mottaker TEXT DEFAULT '',     -- epost eller organisasjon
    generert_av TEXT DEFAULT '',  -- bruker som genererte
    filnavn TEXT DEFAULT '',
    antall_kritikker INTEGER DEFAULT 0,
    detaljer TEXT DEFAULT '',     -- JSON med mer info
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
    nkkvara_telefon TEXT REFERENCES brukere(telefon),
    dvk_telefon TEXT REFERENCES brukere(telefon),
    dvk_navn TEXT DEFAULT '',
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

  -- Partier (gruppering av hunder i en prøve)
  CREATE TABLE IF NOT EXISTS partier (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prove_id TEXT NOT NULL REFERENCES prover(id) ON DELETE CASCADE,
    navn TEXT NOT NULL,
    display_navn TEXT,
    type TEXT DEFAULT 'ukak',
    dato TEXT,
    klasse TEXT,
    sortering INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(prove_id, navn)
  );

  -- Parti-deltakere (hunder fordelt på partier)
  CREATE TABLE IF NOT EXISTS parti_deltakere (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parti_id INTEGER NOT NULL REFERENCES partier(id) ON DELETE CASCADE,
    prove_id TEXT NOT NULL REFERENCES prover(id) ON DELETE CASCADE,
    hund_regnr TEXT NOT NULL,
    hund_navn TEXT,
    rase TEXT,
    kjonn TEXT,
    klasse TEXT,
    eier_navn TEXT,
    eier_telefon TEXT,
    forer_navn TEXT,
    forer_telefon TEXT,
    startnummer INTEGER,
    bekreftet INTEGER DEFAULT 0,
    status TEXT DEFAULT 'aktiv',
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(parti_id, hund_regnr)
  );

  -- Arkiv av parti_deltakere før destruktiv PUT (for recovery hvis klienten
  -- sender ufullstendig liste — f.eks. PDF-parser som mangler en dag).
  -- Behold siste 20 per prøve.
  CREATE TABLE IF NOT EXISTS parti_deltakere_arkiv (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prove_id TEXT NOT NULL,
    arkivert_at TEXT DEFAULT (datetime('now')),
    aarsak TEXT,
    gammel_antall INTEGER,
    ny_antall INTEGER,
    snapshot_json TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_pda_prove ON parti_deltakere_arkiv(prove_id, arkivert_at DESC);

  -- Venteliste (hunder som ikke fikk plass)
  CREATE TABLE IF NOT EXISTS venteliste (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prove_id TEXT NOT NULL REFERENCES prover(id) ON DELETE CASCADE,
    hund_regnr TEXT NOT NULL,
    hund_navn TEXT,
    rase TEXT,
    klasse TEXT,
    dag INTEGER,
    eier_navn TEXT,
    forer_navn TEXT,
    prioritet INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(prove_id, hund_regnr, dag)
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
    prove_id TEXT,
    mottaker_navn TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_sms_log_created ON sms_log(created_at);
  CREATE INDEX IF NOT EXISTS idx_sms_log_type ON sms_log(type);
  CREATE INDEX IF NOT EXISTS idx_sms_log_klubb ON sms_log(klubb_id);
  -- idx_sms_log_prove opprettes som migrasjon fordi prove_id-kolonnen legges til i migrations

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

  -- Rapport-versjoner (audit-trail for rapporter)
  CREATE TABLE IF NOT EXISTS rapport_versjoner (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prove_id TEXT NOT NULL,
    rapport_type TEXT NOT NULL CHECK(rapport_type IN ('nkk', 'fkf', 'raseklubb', 'kritikker')),
    versjon INTEGER DEFAULT 1,
    data_json TEXT,
    endret_av TEXT,
    endret_av_navn TEXT,
    endring_beskrivelse TEXT,
    signatur_status TEXT DEFAULT 'usignert' CHECK(signatur_status IN ('usignert', 'delvis_signert', 'fullstendig_signert')),
    proveleder_signert_at TEXT,
    nkkrep_signert_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_rapport_versjoner_prove ON rapport_versjoner(prove_id);
  CREATE INDEX IF NOT EXISTS idx_rapport_versjoner_type ON rapport_versjoner(rapport_type);

  -- VK-bedømming (Vinnerklasse kritikkskjema)
  CREATE TABLE IF NOT EXISTS vk_bedomming (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prove_id TEXT NOT NULL,
    parti TEXT NOT NULL,
    dommer_telefon TEXT REFERENCES brukere(telefon),
    vk_type TEXT DEFAULT '1dag' CHECK(vk_type IN ('1dag', 'kval', 'finale')),
    current_slipp INTEGER DEFAULT 1,
    current_round INTEGER DEFAULT 1,
    plasseringer TEXT DEFAULT '{}',
    tid_til_gode TEXT DEFAULT '{}',
    dog_data TEXT DEFAULT '{}',
    slipp_comments TEXT DEFAULT '{}',
    slipp_dogs TEXT DEFAULT '{}',
    round_pairings TEXT DEFAULT '{}',
    opponents TEXT DEFAULT '{}',
    judged_this_round TEXT DEFAULT '{}',
    round_snapshots TEXT DEFAULT '{}',
    premietildelinger TEXT DEFAULT '{}',
    status TEXT DEFAULT 'aktiv' CHECK(status IN ('aktiv', 'fullfort', 'innsendt', 'godkjent')),
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(prove_id, parti)
  );
  CREATE INDEX IF NOT EXISTS idx_vk_bedomming_prove ON vk_bedomming(prove_id);
  CREATE INDEX IF NOT EXISTS idx_vk_bedomming_dommer ON vk_bedomming(dommer_telefon);

  -- Dommer-notater (individuelle notater per dommer, per hund, per slipp)
  -- Tillater at hver dommer i et parti har sine egne notater
  CREATE TABLE IF NOT EXISTS dommer_notater (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prove_id TEXT NOT NULL,
    parti TEXT NOT NULL,
    hund_id INTEGER REFERENCES hunder(id),
    dommer_telefon TEXT REFERENCES brukere(telefon),
    slipp_nr INTEGER DEFAULT 1,
    -- Statistikk for dette slippet
    slipptid INTEGER DEFAULT 0,
    stand_m INTEGER DEFAULT 0,
    stand_u INTEGER DEFAULT 0,
    tomstand INTEGER DEFAULT 0,
    makker_stand INTEGER DEFAULT 0,
    sjanse INTEGER DEFAULT 0,
    -- Egenskaper (1-6 skala)
    jaktlyst INTEGER DEFAULT NULL,
    fart INTEGER DEFAULT NULL,
    selvstendighet INTEGER DEFAULT NULL,
    soksbredde INTEGER DEFAULT NULL,
    reviering INTEGER DEFAULT NULL,
    samarbeid INTEGER DEFAULT NULL,
    -- Fuglebehandling
    presisjon INTEGER DEFAULT NULL,
    reising INTEGER DEFAULT NULL,
    apport INTEGER DEFAULT NULL,
    -- Notater
    notater TEXT DEFAULT '',
    -- Metadata
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(prove_id, parti, hund_id, dommer_telefon, slipp_nr)
  );
  CREATE INDEX IF NOT EXISTS idx_dommer_notater_prove ON dommer_notater(prove_id);
  CREATE INDEX IF NOT EXISTS idx_dommer_notater_parti ON dommer_notater(prove_id, parti);
  CREATE INDEX IF NOT EXISTS idx_dommer_notater_dommer ON dommer_notater(dommer_telefon);

  -- Dokumentarkiv (alle dokumenter knyttet til en prøve)
  CREATE TABLE IF NOT EXISTS prove_dokumenter (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prove_id TEXT NOT NULL,
    klubb_id TEXT,
    dokument_type TEXT NOT NULL,
    tittel TEXT NOT NULL,
    filnavn TEXT,
    innhold_json TEXT,
    opprettet_av TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_prove_dokumenter_prove ON prove_dokumenter(prove_id);
  CREATE INDEX IF NOT EXISTS idx_prove_dokumenter_type ON prove_dokumenter(dokument_type);

  -- Klubb-dokumentarkiv (generelle dokumenter ikke knyttet til prøver)
  CREATE TABLE IF NOT EXISTS klubb_dokumenter (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    klubb_id TEXT NOT NULL,
    dokument_type TEXT NOT NULL,
    tittel TEXT NOT NULL,
    beskrivelse TEXT,
    filnavn TEXT,
    innhold_json TEXT,
    opprettet_av TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_klubb_dokumenter_klubb ON klubb_dokumenter(klubb_id);
  CREATE INDEX IF NOT EXISTS idx_klubb_dokumenter_type ON klubb_dokumenter(dokument_type);

  -- Dommerforespørsler (invitasjon til dommere fra prøveleder)
  CREATE TABLE IF NOT EXISTS dommer_foresporsler (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prove_id TEXT NOT NULL REFERENCES prover(id),
    dommer_telefon TEXT NOT NULL,
    dommer_navn TEXT NOT NULL,
    dommer_epost TEXT DEFAULT '',
    parti TEXT DEFAULT '',
    melding TEXT DEFAULT '',
    reise_bil INTEGER DEFAULT 0,
    reise_fly INTEGER DEFAULT 0,
    reise_leiebil INTEGER DEFAULT 0,
    reise_annet TEXT DEFAULT '',
    status TEXT DEFAULT 'sendt' CHECK(status IN ('sendt', 'sett', 'akseptert', 'avslatt', 'kansellert')),
    svar_melding TEXT DEFAULT '',
    sendt_av TEXT NOT NULL REFERENCES brukere(telefon),
    sendt_dato TEXT DEFAULT (datetime('now')),
    sett_dato TEXT DEFAULT NULL,
    svar_dato TEXT DEFAULT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(prove_id, dommer_telefon)
  );
  CREATE INDEX IF NOT EXISTS idx_dommer_foresporsler_prove ON dommer_foresporsler(prove_id);
  CREATE INDEX IF NOT EXISTS idx_dommer_foresporsler_dommer ON dommer_foresporsler(dommer_telefon);
  CREATE INDEX IF NOT EXISTS idx_dommer_foresporsler_status ON dommer_foresporsler(status);

  -- Dommeroppgjør (økonomi etter gjennomført prøve)
  CREATE TABLE IF NOT EXISTS dommer_oppgjor (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prove_id TEXT NOT NULL REFERENCES prover(id),
    dommer_telefon TEXT NOT NULL,
    dommer_navn TEXT NOT NULL,

    -- Reisekostnader
    reise_km INTEGER DEFAULT 0,
    reise_km_sats REAL DEFAULT 3.50,
    reise_km_belop REAL DEFAULT 0,
    reise_bom INTEGER DEFAULT 0,
    reise_ferge INTEGER DEFAULT 0,
    reise_fly INTEGER DEFAULT 0,
    reise_leiebil INTEGER DEFAULT 0,
    reise_annet INTEGER DEFAULT 0,
    reise_annet_beskrivelse TEXT DEFAULT '',

    -- Diett og overnatting
    diett_dager INTEGER DEFAULT 0,
    diett_sats REAL DEFAULT 350,
    diett_belop REAL DEFAULT 0,
    overnatting_netter INTEGER DEFAULT 0,
    overnatting_belop REAL DEFAULT 0,

    -- Honorar
    honorar_dager INTEGER DEFAULT 0,
    honorar_sats REAL DEFAULT 0,
    honorar_belop REAL DEFAULT 0,

    -- FKF Dommerutdanningsfond (trekkes)
    fkf_fond_belop REAL DEFAULT 0,

    -- Totalt
    total_belop REAL DEFAULT 0,

    -- Betalingsinformasjon
    kontonummer TEXT DEFAULT '',
    betalt INTEGER DEFAULT 0,
    betalt_dato TEXT DEFAULT NULL,
    betalt_av TEXT DEFAULT NULL,

    -- Status
    status TEXT DEFAULT 'utkast' CHECK(status IN ('utkast', 'innsendt', 'godkjent', 'utbetalt', 'avvist')),
    kommentar TEXT DEFAULT '',

    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(prove_id, dommer_telefon)
  );
  CREATE INDEX IF NOT EXISTS idx_dommer_oppgjor_prove ON dommer_oppgjor(prove_id);
  CREATE INDEX IF NOT EXISTS idx_dommer_oppgjor_status ON dommer_oppgjor(status);

  -- Meldinger mellom deltakere og prøveledelse
  CREATE TABLE IF NOT EXISTS meldinger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prove_id TEXT NOT NULL,

    -- Avsender/mottaker
    fra_telefon TEXT NOT NULL,
    fra_navn TEXT NOT NULL,
    til_type TEXT NOT NULL CHECK(til_type IN ('proveledelse', 'deltaker')),

    -- Hvilken hund meldingen gjelder (valgfritt)
    hund_id INTEGER REFERENCES hunder(id),
    hund_regnr TEXT,
    hund_navn TEXT,

    -- Meldingsinnhold
    emne TEXT NOT NULL,
    melding TEXT NOT NULL,

    -- Tråding (for svar)
    parent_id INTEGER REFERENCES meldinger(id),

    -- Status
    lest INTEGER DEFAULT 0,
    lest_av TEXT DEFAULT NULL,
    lest_dato TEXT DEFAULT NULL,

    -- Metadata
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_meldinger_prove ON meldinger(prove_id);
  CREATE INDEX IF NOT EXISTS idx_meldinger_fra ON meldinger(fra_telefon);
  CREATE INDEX IF NOT EXISTS idx_meldinger_parent ON meldinger(parent_id);
  CREATE INDEX IF NOT EXISTS idx_meldinger_lest ON meldinger(lest);

  -- Partifordelingsregler (systemkonfigurasjon for hvordan hunder fordeles på partier)
  CREATE TABLE IF NOT EXISTS partifordeling_regler (
    id INTEGER PRIMARY KEY DEFAULT 1,
    -- Eier/fører-regel: Alle hunder fra samme eier/fører på samme parti
    eier_samme_parti INTEGER DEFAULT 1,
    -- Slipp-regel: Hunder fra samme eier ikke i samme slipp (pos 1+2, 3+4, osv)
    eier_ikke_samme_slipp INTEGER DEFAULT 1,
    -- Identifisering av eier: 'telefon' = bruk telefonnr, 'navn' = bruk navn, 'begge' = telefon først, så navn
    eier_identifikator TEXT DEFAULT 'begge',
    -- Maks hunder per parti (UK/AK)
    maks_per_parti_ukak INTEGER DEFAULT 14,
    -- Maks hunder per parti (VK)
    maks_per_parti_vk INTEGER DEFAULT 20,
    -- Beskrivelse for admin (vises i UI)
    beskrivelse TEXT DEFAULT 'Hunder fra samme eier/fører plasseres på samme parti, men ikke i samme slipp.',
    -- Metadata
    oppdatert_av TEXT DEFAULT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  );
  INSERT OR IGNORE INTO partifordeling_regler (id) VALUES (1);

  -- Jegermiddag-påmeldinger (sosial middag under prøvehelgen)
  CREATE TABLE IF NOT EXISTS jegermiddag_pameldinger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prove_id TEXT NOT NULL REFERENCES prover(id),
    bruker_telefon TEXT NOT NULL REFERENCES brukere(telefon),
    -- Antall personer (inkl. hovedperson)
    antall_personer INTEGER NOT NULL DEFAULT 1,
    -- Spesielle hensyn
    allergier TEXT DEFAULT '',
    vegetar INTEGER DEFAULT 0,
    annen_info TEXT DEFAULT '',
    -- Status og betaling
    status TEXT DEFAULT 'pameldt' CHECK(status IN ('pameldt', 'bekreftet', 'avmeldt', 'betalt')),
    betalt INTEGER DEFAULT 0,
    betalt_dato TEXT DEFAULT NULL,
    belop INTEGER DEFAULT 0,
    -- Metadata
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(prove_id, bruker_telefon)
  );
  CREATE INDEX IF NOT EXISTS idx_jegermiddag_prove ON jegermiddag_pameldinger(prove_id);
  CREATE INDEX IF NOT EXISTS idx_jegermiddag_bruker ON jegermiddag_pameldinger(bruker_telefon);

  -- Avmeldinger (frafall fra prøve med årsak)
  CREATE TABLE IF NOT EXISTS avmeldinger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pamelding_id INTEGER NOT NULL REFERENCES pameldinger(id),
    prove_id TEXT NOT NULL REFERENCES prover(id),
    hund_id INTEGER NOT NULL REFERENCES hunder(id),
    forer_telefon TEXT NOT NULL,
    -- Årsak til avmelding
    arsak TEXT NOT NULL CHECK(arsak IN ('sykdom_hund', 'sykdom_forer', 'lopetid', 'annet')),
    arsak_beskrivelse TEXT DEFAULT '',
    -- Dokumentasjon (filsti til opplastet dokument)
    dokumentasjon TEXT DEFAULT NULL,
    dokumentasjon_type TEXT DEFAULT NULL,
    -- Status og behandling
    status TEXT DEFAULT 'mottatt' CHECK(status IN ('mottatt', 'behandlet', 'godkjent', 'avvist')),
    behandlet_av TEXT DEFAULT NULL,
    behandlet_dato TEXT DEFAULT NULL,
    behandlet_kommentar TEXT DEFAULT '',
    -- Refusjon
    refusjon_belop INTEGER DEFAULT 0,
    refusjon_prosent INTEGER DEFAULT 0,
    refusjon_utbetalt INTEGER DEFAULT 0,
    -- Venteliste-opprykk som følge av avmeldingen
    opprykk_pamelding_id INTEGER DEFAULT NULL,
    opprykk_varslet INTEGER DEFAULT 0,
    -- Metadata
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_avmeldinger_prove ON avmeldinger(prove_id);
  CREATE INDEX IF NOT EXISTS idx_avmeldinger_status ON avmeldinger(status);

  -- Fratatte aversjonsbevis (rapport til NJFF)
  CREATE TABLE IF NOT EXISTS fratatte_aversjonsbevis (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prove_id TEXT NOT NULL REFERENCES prover(id),
    hund_id INTEGER NOT NULL REFERENCES hunder(id),
    eier_navn TEXT NOT NULL,
    eier_telefon TEXT DEFAULT NULL,
    eier_adresse TEXT DEFAULT '',
    -- Hundens info på tidspunkt for fratakelse
    hund_navn TEXT NOT NULL,
    hund_regnr TEXT NOT NULL,
    hund_rase TEXT DEFAULT '',
    hund_chip_id TEXT DEFAULT '',
    -- Årsak til fratakelse
    arsak TEXT NOT NULL,
    hendelsesdato TEXT NOT NULL,
    registrert_av TEXT NOT NULL,
    -- Ekstra info
    kommentar TEXT DEFAULT '',
    meldt_njff INTEGER DEFAULT 0,
    meldt_njff_dato TEXT DEFAULT NULL,
    -- Metadata
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_fratatte_prove ON fratatte_aversjonsbevis(prove_id);
  CREATE INDEX IF NOT EXISTS idx_fratatte_hund ON fratatte_aversjonsbevis(hund_id);

  -- SMS sendt for prøveroller (for å unngå duplikater)
  CREATE TABLE IF NOT EXISTS rolle_sms_sendt (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prove_id TEXT NOT NULL REFERENCES prover(id),
    rolle TEXT NOT NULL CHECK(rolle IN ('proveleder', 'nkkrep', 'nkkvara', 'dvk')),
    telefon TEXT NOT NULL,
    sendt_av TEXT DEFAULT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(prove_id, rolle, telefon)
  );
  CREATE INDEX IF NOT EXISTS idx_rolle_sms_prove ON rolle_sms_sendt(prove_id);

  -- Team-medlemmer for prøver (admin-tilgang)
  CREATE TABLE IF NOT EXISTS prove_team (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prove_id TEXT NOT NULL REFERENCES prover(id),
    telefon TEXT NOT NULL,
    navn TEXT NOT NULL,
    epost TEXT DEFAULT NULL,
    rolle TEXT NOT NULL CHECK(rolle IN ('admin', 'sekretariat', 'hjelper')),
    beskrivelse TEXT DEFAULT NULL,
    invitert_av TEXT DEFAULT NULL,
    invitasjon_sendt INTEGER DEFAULT 0,
    akseptert INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(prove_id, telefon)
  );
  CREATE INDEX IF NOT EXISTS idx_prove_team_prove ON prove_team(prove_id);
  CREATE INDEX IF NOT EXISTS idx_prove_team_telefon ON prove_team(telefon);
`);

// --- Migrations for existing databases ---
const migrations = [
  // SMS-logg knyttet til prøve (for prøvedokumenter-eksport)
  "ALTER TABLE sms_log ADD COLUMN prove_id TEXT DEFAULT NULL",
  "ALTER TABLE sms_log ADD COLUMN mottaker_navn TEXT DEFAULT NULL",
  "CREATE INDEX IF NOT EXISTS idx_sms_log_prove ON sms_log(prove_id)",
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
  // Utvidede aversjonsbevis-felter med AI-avlest data
  "ALTER TABLE hunder ADD COLUMN aversjonsbevis_dyretype TEXT DEFAULT NULL",
  "ALTER TABLE hunder ADD COLUMN aversjonsbevis_chip_id TEXT DEFAULT NULL",
  "ALTER TABLE hunder ADD COLUMN aversjonsbevis_avlest_navn TEXT DEFAULT NULL",
  "ALTER TABLE hunder ADD COLUMN aversjonsbevis_avlest_regnr TEXT DEFAULT NULL",
  "ALTER TABLE hunder ADD COLUMN aversjonsbevis_avlest_rase TEXT DEFAULT NULL",
  "ALTER TABLE hunder ADD COLUMN aversjonsbevis_gyldig INTEGER DEFAULT NULL",
  "ALTER TABLE hunder ADD COLUMN aversjonsbevis_bekreftet INTEGER DEFAULT 0",
  "ALTER TABLE hunder ADD COLUMN aversjonsbevis_bekreftet_av TEXT DEFAULT NULL",
  "ALTER TABLE hunder ADD COLUMN aversjonsbevis_bekreftet_dato TEXT DEFAULT NULL",
  // Vipps-integrasjon for klubber
  "ALTER TABLE klubber ADD COLUMN vipps_nummer TEXT DEFAULT NULL",
  // Bilde-kolonne for hunder
  "ALTER TABLE hunder ADD COLUMN bilde TEXT DEFAULT NULL",
  // Fri-tekst eier-navn for hunder uten Norge-bruker (NKK-import o.l.)
  "ALTER TABLE hunder ADD COLUMN eier_navn TEXT DEFAULT NULL",
  // Manuell bedømming på prøven (vs digital). Når på, kan admin tildele en
  // 'live_admin' på VK-partier som får dommer-vk-flyten KUN for live
  // rangering — ingen kritikker sendes til NKK.
  "ALTER TABLE prove_config ADD COLUMN manuell_bedomming INTEGER DEFAULT 0",
  // Marker kritikk-rader som er laget av live_admin (ikke skal til NKK)
  "ALTER TABLE kritikker ADD COLUMN intern_kun INTEGER DEFAULT 0",
  // Marker vk_bedomming-rader som live-only (ikke send-inn-flyt)
  "ALTER TABLE vk_bedomming ADD COLUMN live_modus INTEGER DEFAULT 0",
  // Hvilke hunder som er valgt i nåværende slipp (for refresh-restoring)
  "ALTER TABLE vk_bedomming ADD COLUMN selected_dogs TEXT DEFAULT '{}'",
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
  // Begrunnelse ved manuell tildeling av dommer som ikke står på FKF-lista
  // (f.eks. dommerelev eller forsinket oppdatering av listen)
  "ALTER TABLE dommer_tildelinger ADD COLUMN begrunnelse_type TEXT DEFAULT NULL",
  "ALTER TABLE dommer_tildelinger ADD COLUMN begrunnelse TEXT DEFAULT NULL",
  // SMS-samtykke med tidspunkt
  "ALTER TABLE brukere ADD COLUMN sms_samtykke INTEGER DEFAULT 0",
  "ALTER TABLE brukere ADD COLUMN sms_samtykke_tidspunkt TEXT DEFAULT NULL",
  // Klubb-id for prove_dokumenter (for dokumentarkiv)
  "ALTER TABLE prove_dokumenter ADD COLUMN klubb_id TEXT DEFAULT NULL",
  // Nye felter for dommeroppgjør (utvidet skjema)
  "ALTER TABLE dommer_oppgjor ADD COLUMN reise_fra TEXT DEFAULT NULL",
  "ALTER TABLE dommer_oppgjor ADD COLUMN reise_til TEXT DEFAULT NULL",
  "ALTER TABLE dommer_oppgjor ADD COLUMN reisedekning TEXT DEFAULT 'tur_retur'",
  "ALTER TABLE dommer_oppgjor ADD COLUMN reise_passasjerer INTEGER DEFAULT 0",
  "ALTER TABLE dommer_oppgjor ADD COLUMN bompenger TEXT DEFAULT '[]'",
  "ALTER TABLE dommer_oppgjor ADD COLUMN parkeringer TEXT DEFAULT '[]'",
  "ALTER TABLE dommer_oppgjor ADD COLUMN kollektivreiser TEXT DEFAULT '[]'",
  "ALTER TABLE dommer_oppgjor ADD COLUMN diett3_6_antall INTEGER DEFAULT 0",
  "ALTER TABLE dommer_oppgjor ADD COLUMN diett6_12_antall INTEGER DEFAULT 0",
  "ALTER TABLE dommer_oppgjor ADD COLUMN diett_over12_antall INTEGER DEFAULT 0",
  "ALTER TABLE dommer_oppgjor ADD COLUMN bor_utenfor_hk_antall INTEGER DEFAULT 0",
  "ALTER TABLE dommer_oppgjor ADD COLUMN dommer_dager INTEGER DEFAULT 0",
  "ALTER TABLE dommer_oppgjor ADD COLUMN fradrag TEXT DEFAULT '[]'",
  "ALTER TABLE dommer_oppgjor ADD COLUMN signatur_dato TEXT DEFAULT NULL",
  "ALTER TABLE dommer_oppgjor ADD COLUMN signatur_sted TEXT DEFAULT ''",
  "ALTER TABLE dommer_oppgjor ADD COLUMN signatur TEXT DEFAULT ''",
  // Eierbevis og vaksinasjon for hunder
  "ALTER TABLE hunder ADD COLUMN eierbevis TEXT DEFAULT NULL",
  "ALTER TABLE hunder ADD COLUMN eierbevis_dato TEXT DEFAULT NULL",
  "ALTER TABLE hunder ADD COLUMN vaksinasjon TEXT DEFAULT NULL",
  "ALTER TABLE hunder ADD COLUMN vaksinasjon_dato TEXT DEFAULT NULL",
  // Kilde og NKK-id for hunder
  "ALTER TABLE hunder ADD COLUMN kilde TEXT DEFAULT 'manuell'",
  "ALTER TABLE hunder ADD COLUMN nkk_id TEXT DEFAULT NULL",
  // VK godkjenningsflyt
  "ALTER TABLE vk_bedomming ADD COLUMN submitted_at TEXT DEFAULT NULL",
  "ALTER TABLE vk_bedomming ADD COLUMN approved_at TEXT DEFAULT NULL",
  "ALTER TABLE vk_bedomming ADD COLUMN approved_by TEXT DEFAULT NULL",
  // Logo for klubber og prøver (lagres som base64 i database for persistens)
  "ALTER TABLE klubber ADD COLUMN logo TEXT DEFAULT NULL",
  "ALTER TABLE klubber ADD COLUMN logo_oppdatert TEXT DEFAULT NULL",
  "ALTER TABLE prover ADD COLUMN logo TEXT DEFAULT NULL",
  "ALTER TABLE prover ADD COLUMN logo_oppdatert TEXT DEFAULT NULL",
  // Kontaktinfo for klubber (fra Brønnøysund eller manuelt)
  "ALTER TABLE klubber ADD COLUMN epost TEXT DEFAULT NULL",
  "ALTER TABLE klubber ADD COLUMN telefon TEXT DEFAULT NULL",
  "ALTER TABLE klubber ADD COLUMN nettside TEXT DEFAULT NULL",
  "ALTER TABLE klubber ADD COLUMN adresse TEXT DEFAULT NULL",
  "ALTER TABLE klubber ADD COLUMN postnummer TEXT DEFAULT NULL",
  "ALTER TABLE klubber ADD COLUMN sted TEXT DEFAULT NULL",
  // Kontaktinfo fra Brønnøysund på klubb_foresporsel
  "ALTER TABLE klubb_foresporsel ADD COLUMN nettside TEXT DEFAULT ''",
  "ALTER TABLE klubb_foresporsel ADD COLUMN klubb_telefon TEXT DEFAULT ''",
  "ALTER TABLE klubb_foresporsel ADD COLUMN klubb_epost TEXT DEFAULT ''",
  // Vipps ePayment API-integrasjon for klubber
  "ALTER TABLE klubber ADD COLUMN vipps_client_id TEXT DEFAULT NULL",
  "ALTER TABLE klubber ADD COLUMN vipps_client_secret TEXT DEFAULT NULL",
  "ALTER TABLE klubber ADD COLUMN vipps_subscription_key TEXT DEFAULT NULL",
  "ALTER TABLE klubber ADD COLUMN vipps_merchant_serial TEXT DEFAULT NULL",
  "ALTER TABLE klubber ADD COLUMN vipps_api_modus TEXT DEFAULT 'enkel'",  // 'enkel' eller 'api'
  // Vipps payment reference for mottakere (for å kunne sjekke status via API)
  "ALTER TABLE vipps_mottakere ADD COLUMN vipps_reference TEXT DEFAULT NULL",
  // Flerdommersstøtte: hvem eier live-rangeringen i VK
  "ALTER TABLE vk_bedomming ADD COLUMN live_rangering_eier TEXT DEFAULT NULL",
  // Innstilling for om slipp-kommentarer skal inkluderes i live-rangering
  "ALTER TABLE vk_bedomming ADD COLUMN inkluder_slipp_kommentarer INTEGER DEFAULT 0",
  // Kritikk-bekreftelse fra meddommer
  "ALTER TABLE kritikker ADD COLUMN meddommer_telefon TEXT DEFAULT NULL",
  "ALTER TABLE kritikker ADD COLUMN meddommer_bekreftet_at TEXT DEFAULT NULL",
  // NKK-vara og DVK-roller for prøver
  "ALTER TABLE prover ADD COLUMN nkkvara_telefon TEXT DEFAULT NULL",
  "ALTER TABLE prover ADD COLUMN dvk_telefon TEXT DEFAULT NULL",
  "ALTER TABLE prover ADD COLUMN dvk_navn TEXT DEFAULT ''",
  // Navnefelter for roller (for inviterte personer som ikke er registrert ennå)
  "ALTER TABLE prover ADD COLUMN proveleder_navn TEXT DEFAULT NULL",
  "ALTER TABLE prover ADD COLUMN nkkrep_navn TEXT DEFAULT NULL",
  "ALTER TABLE prover ADD COLUMN nkkvara_navn TEXT DEFAULT NULL",
  // Prøvetype (høyfjell_host, høyfjell_vinter, lavland_host, skogsfugl_host, skogsfugl_vinter, fullkombinert, apport)
  "ALTER TABLE prover ADD COLUMN prove_type TEXT DEFAULT 'høyfjell_host'",
  // Arrangør-navn (per-prøve override, fall tilbake til klubb_navn hvis ikke satt)
  "ALTER TABLE prover ADD COLUMN arrangor_navn TEXT DEFAULT NULL",
  // Automatisk venteliste-opprykk konfigurasjon
  "ALTER TABLE prove_config ADD COLUMN auto_venteliste_opprykk INTEGER DEFAULT 1",
  // Løpetid-egenerklæring (JSON med skjemadata)
  "ALTER TABLE avmeldinger ADD COLUMN lopetid_egenerklaring TEXT DEFAULT NULL",
  // Jegermiddag-konfigurasjon for prøver
  "ALTER TABLE prove_config ADD COLUMN jegermiddag_aktivert INTEGER DEFAULT 0",
  "ALTER TABLE prove_config ADD COLUMN jegermiddag_dato TEXT DEFAULT NULL",
  "ALTER TABLE prove_config ADD COLUMN jegermiddag_tid TEXT DEFAULT '19:00'",
  "ALTER TABLE prove_config ADD COLUMN jegermiddag_sted TEXT DEFAULT ''",
  "ALTER TABLE prove_config ADD COLUMN jegermiddag_pris INTEGER DEFAULT 350",
  "ALTER TABLE prove_config ADD COLUMN jegermiddag_maks_personer INTEGER DEFAULT 100",
  "ALTER TABLE prove_config ADD COLUMN jegermiddag_info TEXT DEFAULT ''",
  "ALTER TABLE prove_config ADD COLUMN jegermiddag_frist TEXT DEFAULT NULL",
  // VK-konfigurasjon for fler-dagers VK
  "ALTER TABLE prove_config ADD COLUMN vk_type TEXT DEFAULT '1dag' CHECK(vk_type IN ('1dag', '2dag', '3dag'))",
  "ALTER TABLE prove_config ADD COLUMN vk_kval_dag INTEGER DEFAULT NULL",
  "ALTER TABLE prove_config ADD COLUMN vk_semi_dag INTEGER DEFAULT NULL",
  "ALTER TABLE prove_config ADD COLUMN vk_finale_dag INTEGER DEFAULT NULL",
  // Forbedret fullmakt-matching med epost
  "ALTER TABLE ventende_fullmakter ADD COLUMN eier_epost TEXT DEFAULT NULL",
  "ALTER TABLE ventende_fullmakter ADD COLUMN forer_epost TEXT DEFAULT NULL",
  // SMS-køsystem
  `CREATE TABLE IF NOT EXISTS sms_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telefon TEXT NOT NULL,
    melding TEXT NOT NULL,
    type TEXT DEFAULT 'general',
    klubb_id INTEGER,
    prove_id TEXT,
    priority INTEGER DEFAULT 5,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'sent', 'failed', 'cancelled')),
    attempts INTEGER DEFAULT 0,
    max_attempts INTEGER DEFAULT 3,
    error_message TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    processed_at TEXT,
    scheduled_for TEXT DEFAULT (datetime('now'))
  )`,
  "CREATE INDEX IF NOT EXISTS idx_sms_queue_status ON sms_queue(status, scheduled_for)",
  // Uønsket adferd i kritikker (for NJFF-rapportering)
  "ALTER TABLE kritikker ADD COLUMN uonsket_adferd INTEGER DEFAULT 0",
  "ALTER TABLE kritikker ADD COLUMN uonsket_adferd_tekst TEXT DEFAULT ''",
];
for (const sql of migrations) {
  try { db.exec(sql); } catch (e) { /* column already exists */ }
}

// Create indexes that depend on migrated columns
try {
  db.exec("CREATE INDEX IF NOT EXISTS idx_prove_dokumenter_klubb ON prove_dokumenter(klubb_id)");
} catch (e) { /* index already exists or column missing */ }

// --- Performance indexes for frequently queried tables ---
const performanceIndexes = [
  // OTP - søkes ved innlogging
  "CREATE INDEX IF NOT EXISTS idx_otp_telefon_used ON otp_codes(telefon, used)",
  "CREATE INDEX IF NOT EXISTS idx_otp_expires ON otp_codes(expires_at)",

  // Hunder - søkes ved navn, eier, rase
  "CREATE INDEX IF NOT EXISTS idx_hunder_eier ON hunder(eier_telefon)",
  "CREATE INDEX IF NOT EXISTS idx_hunder_navn ON hunder(navn)",
  "CREATE INDEX IF NOT EXISTS idx_hunder_rase ON hunder(rase)",

  // Kritikker - søkes ved hund, prøve, dommer
  "CREATE INDEX IF NOT EXISTS idx_kritikker_hund ON kritikker(hund_id)",
  "CREATE INDEX IF NOT EXISTS idx_kritikker_prove ON kritikker(prove_id)",
  "CREATE INDEX IF NOT EXISTS idx_kritikker_dommer ON kritikker(dommer_telefon)",
  "CREATE INDEX IF NOT EXISTS idx_kritikker_status ON kritikker(status)",

  // Påmeldinger - søkes ved prøve, hund, eier
  "CREATE INDEX IF NOT EXISTS idx_pameldinger_prove ON pameldinger(prove_id)",
  "CREATE INDEX IF NOT EXISTS idx_pameldinger_hund ON pameldinger(hund_id)",
  "CREATE INDEX IF NOT EXISTS idx_pameldinger_eier ON pameldinger(eier_telefon)",
  "CREATE INDEX IF NOT EXISTS idx_pameldinger_status ON pameldinger(status)",

  // Dommer-tildelinger - søkes ved prøve og dommer
  "CREATE INDEX IF NOT EXISTS idx_dommer_tildelinger_prove ON dommer_tildelinger(prove_id)",
  "CREATE INDEX IF NOT EXISTS idx_dommer_tildelinger_dommer ON dommer_tildelinger(dommer_telefon)",

  // Prøver - søkes ved klubb og status
  "CREATE INDEX IF NOT EXISTS idx_prover_klubb ON prover(klubb_id)",
  "CREATE INDEX IF NOT EXISTS idx_prover_status ON prover(status)",
  "CREATE INDEX IF NOT EXISTS idx_prover_dato ON prover(start_dato)",

  // Resultater - søkes ved hund
  "CREATE INDEX IF NOT EXISTS idx_resultater_hund ON resultater(hund_id)",

  // Klubb-medlemmer - søkes ved klubb og telefon
  "CREATE INDEX IF NOT EXISTS idx_klubb_medlemmer_klubb ON klubb_medlemmer(klubb_id)",
  "CREATE INDEX IF NOT EXISTS idx_klubb_medlemmer_telefon ON klubb_medlemmer(telefon_normalized)",
];

for (const sql of performanceIndexes) {
  try { db.exec(sql); } catch (e) { /* index already exists */ }
}

// System-bruker for NKK-importerte påmeldinger. Brukes som forer_telefon-sentinel
// på pameldinger-rader som er projisert fra parti_deltakere (NKK-fil-flyten).
// pameldinger.forer_telefon er NOT NULL, og inntil digital påmelding er aktivert
// har vi ikke deltakerens faktiske telefonnummer. Denne raden skal aldri slettes.
try {
  db.prepare(`
    INSERT OR IGNORE INTO brukere (telefon, fornavn, etternavn, rolle, verifisert)
    VALUES ('NKK_IMPORT', 'NKK', 'Import', '', 0)
  `).run();
} catch (e) { console.warn('Kunne ikke opprette NKK_IMPORT-bruker:', e); }

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

// Fix dommer_tildelinger UNIQUE constraint (allow same dommer on multiple parties)
try {
  const tableInfo = db.prepare("PRAGMA table_info(dommer_tildelinger)").all();
  if (tableInfo.length > 0) {
    // Check if the UNIQUE constraint needs to be fixed by looking at index info
    const indexList = db.prepare("PRAGMA index_list(dommer_tildelinger)").all();
    const hasOldConstraint = indexList.some(idx => {
      const indexInfo = db.prepare(`PRAGMA index_info(${idx.name})`).all();
      // Old constraint: (prove_id, dommer_telefon) without parti
      return indexInfo.length === 2 && !indexInfo.find(i => i.name === 'parti');
    });

    if (hasOldConstraint) {
      console.log("🔧 Migrating dommer_tildelinger UNIQUE constraint...");
      db.pragma("foreign_keys = OFF");
      db.exec("BEGIN TRANSACTION");
      db.exec("ALTER TABLE dommer_tildelinger RENAME TO dommer_tildelinger_old");
      db.exec(`
        CREATE TABLE dommer_tildelinger (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          prove_id TEXT REFERENCES prover(id),
          dommer_telefon TEXT REFERENCES brukere(telefon),
          parti TEXT NOT NULL,
          dommer_rolle INTEGER DEFAULT NULL,
          UNIQUE(prove_id, parti, dommer_telefon)
        )
      `);
      db.exec("INSERT INTO dommer_tildelinger (id, prove_id, dommer_telefon, parti, dommer_rolle) SELECT id, prove_id, dommer_telefon, parti, dommer_rolle FROM dommer_tildelinger_old");
      db.exec("DROP TABLE dommer_tildelinger_old");
      db.exec("COMMIT");
      db.pragma("foreign_keys = ON");
      console.log("✅ Migrated dommer_tildelinger: UNIQUE constraint now includes parti");
    }
  }
} catch (e) {
  try { db.exec("ROLLBACK"); } catch {}
  db.pragma("foreign_keys = ON");
  if (!e.message.includes('already exists') && !e.message.includes('no such table')) {
    console.error("dommer_tildelinger migration warning:", e.message);
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
  const insertBruker = db.prepare("INSERT INTO brukere (telefon, fornavn, etternavn, epost, adresse, postnummer, sted, rolle, medlem_siden, sms_samtykke, sms_samtykke_tidspunkt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))");
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

// --- Body size limit for large files (PDF documents, images) ---
// Default Hono limit is 256KB, we need 10MB for documents
app.use('/api/*', bodyLimit({
  maxSize: 10 * 1024 * 1024, // 10 MB
  onError: (c) => {
    console.error('Body too large');
    return c.json({ error: 'Filen er for stor (maks 10MB)' }, 413);
  }
}));

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
  return jwt.sign(payload, JWT_SECRET_FINAL, { expiresIn: JWT_EXPIRES_IN });
}

// Verifiser JWT token
function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET_FINAL);
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
// PASSWORD HELPERS (bcrypt med SHA256-fallback)
// ============================================

// Bcrypt cost factor (10-12 er anbefalt for produksjon)
const BCRYPT_ROUNDS = 10;

// Hash passord med bcrypt (async)
async function hashPasswordAsync(password) {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

// Synkron versjon for bakoverkompatibilitet (bruker bcrypt sync)
function hashPassword(password) {
  return bcrypt.hashSync(password, BCRYPT_ROUNDS);
}

// Verifiser passord - støtter både bcrypt og legacy SHA256
async function verifyPasswordAsync(password, storedHash) {
  if (!storedHash) return false;

  // Bcrypt-hasher starter med $2a$ eller $2b$
  if (storedHash.startsWith('$2')) {
    return bcrypt.compare(password, storedHash);
  }

  // Legacy SHA256 format: salt:hash
  return verifyPasswordLegacy(password, storedHash);
}

// Synkron versjon for enklere bruk
function verifyPassword(password, storedHash) {
  if (!storedHash) return false;

  // Bcrypt-hasher starter med $2a$ eller $2b$
  if (storedHash.startsWith('$2')) {
    return bcrypt.compareSync(password, storedHash);
  }

  // Legacy SHA256 format: salt:hash
  return verifyPasswordLegacy(password, storedHash);
}

// Legacy SHA256 verifisering (for gamle passord)
function verifyPasswordLegacy(password, storedHash) {
  const [salt, hash] = storedHash.split(':');
  if (!salt || !hash) return false;
  const checkHash = createHash('sha256').update(password + salt).digest('hex');
  return hash === checkHash;
}

// Sjekk om passord-hash bør oppgraderes til bcrypt
function needsHashUpgrade(storedHash) {
  if (!storedHash) return false;
  // SHA256 hasher har formatet salt:hash, bcrypt starter med $2
  return !storedHash.startsWith('$2');
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

// Hash OTP-kode for sikker lagring i database
function hashOTP(code, telefon) {
  // Bruker telefon som salt for å forhindre rainbow table angrep
  return createHash('sha256').update(code + telefon).digest('hex');
}

// Rate limiting lagret i database (overlever restart)
function checkOTPRate(telefon) {
  const now = Date.now();
  const tenMinutesAgo = new Date(now - 10 * 60 * 1000).toISOString();

  // Tell forsøk siste 10 minutter fra database
  const countResult = db.prepare(
    "SELECT COUNT(*) as count FROM otp_codes WHERE telefon = ? AND created_at > ?"
  ).get(telefon, tenMinutesAgo);

  if (countResult.count >= 5) return false;
  return true;
}

// Logg SMS til database for statistikk og prøvedokumenter
function logSMS(retning, fra, til, type, melding, twilio_sid = null, status = 'sent', klubb_id = null, prove_id = null, mottaker_navn = null) {
  try {
    db.prepare(`
      INSERT INTO sms_log (retning, fra, til, type, melding, twilio_sid, status, klubb_id, prove_id, mottaker_navn, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(retning, fra, til, type, melding || null, twilio_sid, status, klubb_id, prove_id, mottaker_navn);
  } catch (e) {
    console.error('SMS logging error:', e.message);
  }
}

async function sendSMS(telefon, message, options = {}) {
  const { type = 'verifisering', klubb_id = null, prove_id = null, mottaker_navn = null } = options;

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
    logSMS('ut', fromNumber, phoneFormatted, type, message, null, 'dev', klubb_id, prove_id, mottaker_navn);
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
        logSMS('ut', fromNumber, phoneFormatted, type, message, data.sid, 'sent', klubb_id, prove_id, mottaker_navn);
        return { success: true, provider: 'twilio', sid: data.sid };
      } else {
        console.error("Twilio SMS error:", data);
        logSMS('ut', fromNumber, phoneFormatted, type, message, null, 'failed', klubb_id, prove_id, mottaker_navn);
        return { success: false, error: data.message || 'Twilio error', provider: 'twilio' };
      }
    } catch (err) {
      console.error("Twilio SMS fetch error:", err.message);
      logSMS('ut', fromNumber, phoneFormatted, type, message, null, 'error', klubb_id, prove_id, mottaker_navn);
      return { success: false, error: err.message, provider: 'twilio' };
    }
  }

  // Sveve (primær SMS-leverandør)
  if (smsProvider === "sveve") {
    // Bruk norsk format uten +47 for Sveve
    let svevePhone = telefon.replace(/\s/g, '').replace(/^\+47/, '');
    if (svevePhone.length !== 8) {
      svevePhone = phoneFormatted.replace(/^\+47/, '');
    }

    const url = new URL("https://sveve.no/SMS/SendMessage");
    url.searchParams.set("user", SVEVE_USER);
    url.searchParams.set("passwd", SVEVE_PASS);
    url.searchParams.set("to", svevePhone);
    url.searchParams.set("msg", message);
    url.searchParams.set("from", SVEVE_FROM);
    url.searchParams.set("f", "json"); // JSON-respons

    try {
      const resp = await fetch(url.toString());
      const data = await resp.json();

      // Sveve kan returnere data direkte eller pakket i "response"-objekt
      const sveveData = data.response || data;

      if (sveveData.msgOkCount && sveveData.msgOkCount > 0) {
        const msgId = sveveData.ids ? sveveData.ids[0] : null;
        console.log(`📱 [Sveve] SMS sendt til ${svevePhone} (ID: ${msgId})`);
        logSMS('ut', SVEVE_FROM, phoneFormatted, type, message, msgId, 'sent', klubb_id, prove_id, mottaker_navn);
        return { success: true, provider: 'sveve', id: msgId };
      } else {
        const errorMsg = sveveData.errors ? sveveData.errors.join(', ') : JSON.stringify(data);
        console.error("Sveve SMS error:", errorMsg);
        logSMS('ut', SVEVE_FROM, phoneFormatted, type, message, null, 'failed', klubb_id, prove_id, mottaker_navn);
        return { success: false, error: errorMsg, provider: 'sveve' };
      }
    } catch (err) {
      console.error("Sveve SMS fetch error:", err.message);
      logSMS('ut', SVEVE_FROM, phoneFormatted, type, message, null, 'error', klubb_id, prove_id, mottaker_navn);
      return { success: false, error: err.message, provider: 'sveve' };
    }
  }

  return { success: false, error: 'No SMS provider configured' };
}

// ============================================
// SMS-KØSYSTEM
// ============================================

// Legg til SMS i køen (returnerer umiddelbart)
function queueSMS(telefon, melding, options = {}) {
  const {
    type = 'general',
    klubb_id = null,
    prove_id = null,
    priority = 5, // 1 = høyest, 10 = lavest
    scheduledFor = null
  } = options;

  try {
    const result = db.prepare(`
      INSERT INTO sms_queue (telefon, melding, type, klubb_id, prove_id, priority, scheduled_for)
      VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
    `).run(telefon, melding, type, klubb_id, prove_id, priority, scheduledFor);

    return { success: true, queueId: result.lastInsertRowid };
  } catch (err) {
    console.error('[SMS Queue] Feil ved kølegging:', err.message);
    return { success: false, error: err.message };
  }
}

// Legg til flere SMS i køen (for masse-utsending)
function queueBulkSMS(mottakere, melding, options = {}) {
  const { type = 'masse_sms', klubb_id = null, prove_id = null, priority = 7 } = options;

  const insert = db.prepare(`
    INSERT INTO sms_queue (telefon, melding, type, klubb_id, prove_id, priority)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  let queued = 0;
  let failed = 0;

  const transaction = db.transaction(() => {
    for (const mottaker of mottakere) {
      try {
        const telefon = typeof mottaker === 'string' ? mottaker : mottaker.telefon;
        insert.run(telefon, melding, type, klubb_id, prove_id, priority);
        queued++;
      } catch (e) {
        failed++;
      }
    }
  });

  transaction();

  console.log(`[SMS Queue] ${queued} SMS lagt i kø, ${failed} feilet`);
  return { queued, failed };
}

// Prosesser SMS-køen (kjøres periodisk)
async function processSmsQueue() {
  if (smsQueueProcessing) return; // Unngå overlapp
  smsQueueProcessing = true;

  try {
    // Hent ventende SMS som er klare for sending
    const pending = db.prepare(`
      SELECT * FROM sms_queue
      WHERE status = 'pending'
        AND scheduled_for <= datetime('now')
        AND attempts < max_attempts
      ORDER BY priority ASC, created_at ASC
      LIMIT ?
    `).all(SMS_QUEUE_BATCH_SIZE);

    if (pending.length === 0) {
      smsQueueProcessing = false;
      return;
    }

    console.log(`[SMS Queue] Prosesserer ${pending.length} SMS...`);

    for (const sms of pending) {
      // Marker som processing
      db.prepare("UPDATE sms_queue SET status = 'processing', attempts = attempts + 1 WHERE id = ?").run(sms.id);

      try {
        const result = await sendSMS(sms.telefon, sms.melding, {
          type: sms.type,
          klubb_id: sms.klubb_id
        });

        if (result.success) {
          db.prepare(`
            UPDATE sms_queue SET status = 'sent', processed_at = datetime('now') WHERE id = ?
          `).run(sms.id);
        } else {
          const newStatus = sms.attempts + 1 >= sms.max_attempts ? 'failed' : 'pending';
          db.prepare(`
            UPDATE sms_queue SET status = ?, error_message = ? WHERE id = ?
          `).run(newStatus, result.error || 'Ukjent feil', sms.id);
        }
      } catch (err) {
        const newStatus = sms.attempts + 1 >= sms.max_attempts ? 'failed' : 'pending';
        db.prepare(`
          UPDATE sms_queue SET status = ?, error_message = ? WHERE id = ?
        `).run(newStatus, err.message, sms.id);
      }

      // Kort delay mellom hver SMS for å unngå rate limiting hos leverandør
      await new Promise(resolve => setTimeout(resolve, SMS_QUEUE_BATCH_DELAY_MS));
    }
  } catch (err) {
    console.error('[SMS Queue] Feil ved prosessering:', err.message);
  } finally {
    smsQueueProcessing = false;
  }
}

// Start SMS-køprosessering
setInterval(processSmsQueue, SMS_QUEUE_INTERVAL_MS);

// Hent køstatus (for admin)
function getSmsQueueStats() {
  return db.prepare(`
    SELECT
      status,
      COUNT(*) as count,
      MIN(created_at) as oldest
    FROM sms_queue
    GROUP BY status
  `).all();
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
// ROLLE SMS-VARSLING (med duplikatbeskyttelse)
// ============================================

// Sjekk om SMS allerede er sendt for en rolle
app.get("/api/prover/:id/rolle-sms/:rolle", requireAdmin, (c) => {
  const proveId = c.req.param("id");
  const rolle = c.req.param("rolle");

  const validRoller = ['proveleder', 'nkkrep', 'nkkvara', 'dvk'];
  if (!validRoller.includes(rolle)) {
    return c.json({ error: "Ugyldig rolle" }, 400);
  }

  // Hent alle SMS sendt for denne rollen på denne prøven
  const sendte = db.prepare(`
    SELECT telefon, created_at FROM rolle_sms_sendt
    WHERE prove_id = ? AND rolle = ?
  `).all(proveId, rolle);

  return c.json({
    success: true,
    sendte: sendte.map(s => ({ telefon: s.telefon, sendt: s.created_at }))
  });
});

// Hent alle sendte rolle-SMS for en prøve
app.get("/api/prover/:id/rolle-sms", requireAdmin, (c) => {
  const proveId = c.req.param("id");

  const sendte = db.prepare(`
    SELECT rolle, telefon, created_at FROM rolle_sms_sendt
    WHERE prove_id = ?
  `).all(proveId);

  // Grupper etter rolle
  const grouped = {};
  for (const s of sendte) {
    if (!grouped[s.rolle]) grouped[s.rolle] = [];
    grouped[s.rolle].push(s.telefon);
  }

  return c.json({ success: true, sendte: grouped });
});

// Send SMS-varsling for en rolle
app.post("/api/prover/:id/rolle-sms", requireAdmin, async (c) => {
  const proveId = c.req.param("id");
  const body = await c.req.json();
  const user = c.get("user");

  const { rolle, telefon, navn } = body;

  const validRoller = ['proveleder', 'nkkrep', 'nkkvara', 'dvk'];
  if (!validRoller.includes(rolle)) {
    return c.json({ error: "Ugyldig rolle" }, 400);
  }

  const cleanTelefon = (telefon || "").replace(/\s/g, "");
  if (!cleanTelefon || cleanTelefon.length < 8) {
    return c.json({ error: "Ugyldig telefonnummer" }, 400);
  }

  // Hent prøveinfo med klubbnavn
  const prove = db.prepare(`
    SELECT p.navn, k.navn as klubb_navn
    FROM prover p
    LEFT JOIN klubber k ON p.klubb_id = k.id
    WHERE p.id = ?
  `).get(proveId);
  if (!prove) {
    return c.json({ error: "Prøve ikke funnet" }, 404);
  }

  // Sjekk om SMS allerede er sendt til dette nummeret for denne rollen
  const eksisterende = db.prepare(`
    SELECT id FROM rolle_sms_sendt
    WHERE prove_id = ? AND rolle = ? AND telefon = ?
  `).get(proveId, rolle, cleanTelefon);

  if (eksisterende) {
    return c.json({
      success: false,
      alleredeSendt: true,
      message: "SMS er allerede sendt til dette nummeret for denne rollen"
    });
  }

  // Lag SMS-melding basert på rolle
  const rolleNavn = {
    'proveleder': 'prøveleder',
    'nkkrep': 'NKK-representant',
    'nkkvara': 'NKK-vara',
    'dvk': 'Dyrevelferdskontrollør (DVK)'
  }[rolle];

  const fornavn = (navn || "").split(" ")[0] || "Hei";
  const klubbHilsen = prove.klubb_navn ? `\n\nVennlig hilsen ${prove.klubb_navn}` : '';
  const smsMessage = `Hei ${fornavn}! Du har fått tildelt rollen som ${rolleNavn} for ${prove.navn}. Opprett bruker eller logg inn på fuglehundprove.no for å se din rolle.${klubbHilsen}`;

  try {
    const smsResult = await sendSMS(cleanTelefon, smsMessage, { type: `rolle_${rolle}` });

    if (!smsResult.success) {
      console.error(`[Rolle-SMS] SMS feilet til ${cleanTelefon}:`, smsResult.error);
      return c.json({ error: smsResult.error || "Kunne ikke sende SMS" }, 500);
    }

    // Registrer at SMS er sendt
    db.prepare(`
      INSERT INTO rolle_sms_sendt (prove_id, rolle, telefon, sendt_av)
      VALUES (?, ?, ?, ?)
    `).run(proveId, rolle, cleanTelefon, user?.telefon || null);

    console.log(`[Rolle-SMS] SMS sendt til ${cleanTelefon} for rolle ${rolle} på prøve ${proveId}`);

    return c.json({
      success: true,
      message: "SMS sendt",
      rolle: rolleNavn
    });

  } catch (err) {
    console.error(`[Rolle-SMS] Feil:`, err);
    return c.json({ error: "Feil ved sending av SMS" }, 500);
  }
});

// ============================================
// TEAM MEDLEMMER API
// ============================================

// Hent team-medlemmer for en prøve
app.get("/api/prover/:id/team", requireAdmin, (c) => {
  const proveId = c.req.param("id");

  // Hent team-medlemmer fra prove_team tabellen
  const team = db.prepare(`
    SELECT * FROM prove_team
    WHERE prove_id = ?
    ORDER BY rolle, navn
  `).all(proveId);

  // Hent roller fra prøvedetaljer (prøveleder, NKK-rep, NKK-vara, DVK)
  const prove = db.prepare(`
    SELECT proveleder_telefon, proveleder_navn,
           nkkrep_telefon, nkkrep_navn,
           nkkvara_telefon, nkkvara_navn,
           dvk_telefon, dvk_navn
    FROM prover WHERE id = ?
  `).get(proveId);

  const roller = [];
  if (prove) {
    // Hjelpefunksjon for å slå opp bruker basert på telefon
    const hentBrukerNavn = (telefon, fallbackNavn) => {
      if (!telefon) return null;
      const bruker = db.prepare(`SELECT fornavn, etternavn FROM brukere WHERE telefon = ?`).get(telefon);
      if (bruker) {
        return `${bruker.fornavn} ${bruker.etternavn}`;
      }
      return fallbackNavn || `(${telefon})`;
    };

    if (prove.proveleder_telefon) {
      roller.push({
        id: 'rolle_proveleder',
        telefon: prove.proveleder_telefon,
        navn: hentBrukerNavn(prove.proveleder_telefon, prove.proveleder_navn),
        rolle: 'proveleder',
        fra_provedetaljer: true
      });
    }
    if (prove.nkkrep_telefon) {
      roller.push({
        id: 'rolle_nkkrep',
        telefon: prove.nkkrep_telefon,
        navn: hentBrukerNavn(prove.nkkrep_telefon, prove.nkkrep_navn),
        rolle: 'nkkrep',
        fra_provedetaljer: true
      });
    }
    if (prove.nkkvara_telefon) {
      roller.push({
        id: 'rolle_nkkvara',
        telefon: prove.nkkvara_telefon,
        navn: hentBrukerNavn(prove.nkkvara_telefon, prove.nkkvara_navn),
        rolle: 'nkkvara',
        fra_provedetaljer: true
      });
    }
    if (prove.dvk_telefon) {
      roller.push({
        id: 'rolle_dvk',
        telefon: prove.dvk_telefon,
        navn: hentBrukerNavn(prove.dvk_telefon, prove.dvk_navn),
        rolle: 'dvk',
        fra_provedetaljer: true
      });
    }
  }

  return c.json({ success: true, team, roller });
});

// Legg til team-medlem
app.post("/api/prover/:id/team", requireAdmin, async (c) => {
  const proveId = c.req.param("id");
  const body = await c.req.json();
  const user = c.get("user");

  const { telefon, navn, epost, rolle, beskrivelse, sendSms } = body;

  const cleanTelefon = (telefon || "").replace(/\s/g, "");
  if (!cleanTelefon || cleanTelefon.length < 8) {
    return c.json({ error: "Ugyldig telefonnummer" }, 400);
  }
  if (!navn) {
    return c.json({ error: "Navn er påkrevd" }, 400);
  }
  if (!rolle || !['admin', 'sekretariat', 'hjelper'].includes(rolle)) {
    return c.json({ error: "Ugyldig rolle" }, 400);
  }

  // Hent prøveinfo
  const prove = db.prepare(`
    SELECT p.navn, k.navn as klubb_navn
    FROM prover p
    LEFT JOIN klubber k ON p.klubb_id = k.id
    WHERE p.id = ?
  `).get(proveId);
  if (!prove) {
    return c.json({ error: "Prøve ikke funnet" }, 404);
  }

  // Sjekk om medlem allerede finnes
  const eksisterende = db.prepare(`
    SELECT id FROM prove_team WHERE prove_id = ? AND telefon = ?
  `).get(proveId, cleanTelefon);

  if (eksisterende) {
    return c.json({ error: "Denne personen er allerede lagt til i teamet" }, 409);
  }

  try {
    // Legg til team-medlem
    const result = db.prepare(`
      INSERT INTO prove_team (prove_id, telefon, navn, epost, rolle, beskrivelse, invitert_av, invitasjon_sendt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(proveId, cleanTelefon, navn, epost || null, rolle, beskrivelse || null, user?.telefon || null, sendSms ? 1 : 0);

    // Send SMS hvis ønsket
    if (sendSms) {
      const rolleNavn = {
        'admin': 'administrator',
        'sekretariat': 'sekretariat',
        'hjelper': 'hjelper'
      }[rolle];

      const fornavn = (navn || "").split(" ")[0] || "Hei";
      const klubbHilsen = prove.klubb_navn ? `\n\nVennlig hilsen ${prove.klubb_navn}` : '';
      const smsMessage = `Hei ${fornavn}! Du er lagt til som ${rolleNavn} for ${prove.navn}. ${rolle === 'admin' ? 'Du har nå admin-tilgang til prøven. ' : ''}Logg inn på fuglehundprove.no for å se din rolle.${klubbHilsen}`;

      await sendSMS(cleanTelefon, smsMessage, { type: `team_${rolle}` });
    }

    console.log(`[Team] Lagt til ${navn} (${cleanTelefon}) som ${rolle} for prøve ${proveId}`);

    return c.json({
      success: true,
      message: "Team-medlem lagt til",
      id: result.lastInsertRowid
    });

  } catch (err) {
    console.error(`[Team] Feil:`, err);
    return c.json({ error: "Kunne ikke legge til team-medlem" }, 500);
  }
});

// Fjern team-medlem
app.delete("/api/prover/:id/team/:teamId", requireAdmin, (c) => {
  const proveId = c.req.param("id");
  const teamId = c.req.param("teamId");

  const result = db.prepare(`
    DELETE FROM prove_team WHERE id = ? AND prove_id = ?
  `).run(teamId, proveId);

  if (result.changes === 0) {
    return c.json({ error: "Team-medlem ikke funnet" }, 404);
  }

  return c.json({ success: true, message: "Team-medlem fjernet" });
});

// Oppdater team-medlem rolle
app.patch("/api/prover/:id/team/:teamId", requireAdmin, async (c) => {
  const proveId = c.req.param("id");
  const teamId = c.req.param("teamId");
  const body = await c.req.json();

  const { rolle, beskrivelse } = body;

  if (rolle && !['admin', 'sekretariat', 'hjelper'].includes(rolle)) {
    return c.json({ error: "Ugyldig rolle" }, 400);
  }

  db.prepare(`
    UPDATE prove_team SET
      rolle = COALESCE(?, rolle),
      beskrivelse = COALESCE(?, beskrivelse),
      updated_at = datetime('now')
    WHERE id = ? AND prove_id = ?
  `).run(rolle || null, beskrivelse || null, teamId, proveId);

  return c.json({ success: true, message: "Team-medlem oppdatert" });
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

  // Admin-bypass: telefon 90852833 med kode 1234 (Aleksander Roel)
  const isTestBypass = (telefon === "90852833" && kode === "1234");

  if (isTestBypass) {
    // Test-bypass: Godkjent direkte
  } else if (isDevMode) {
    // I dev-mode: godta "1234" som gyldig kode
    if (kode !== validDevCode) {
      return c.json({ error: "Feil kode" }, 401);
    }
  } else {
    // I produksjon: Verifiser mot OTP-tabellen (koder er hashet)
    const kodeHash = hashOTP(kode, telefon);
    const otp = db.prepare(
      "SELECT rowid FROM otp_codes WHERE telefon = ? AND code = ? AND used = 0 AND expires_at > datetime('now') ORDER BY created_at DESC LIMIT 1"
    ).get(telefon, kodeHash);

    if (!otp) {
      return c.json({ error: "Feil kode" }, 401);
    }

    // Marker koden som brukt
    db.prepare("UPDATE otp_codes SET used = 1 WHERE rowid = ?").run(otp.rowid);
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
  const codeHash = hashOTP(code, telefon);
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  db.prepare("INSERT INTO otp_codes (telefon, code, expires_at) VALUES (?, ?, ?)").run(telefon, codeHash, expiresAt);

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

  // Bypass for utvikler (Aleksander Roel): telefon 90852833 med kode 1234
  const isTestBypass = (telefon === "90852833" && code === "1234");

  // Hash koden før sammenligning (OTP lagres hashet i databasen)
  const codeHash = hashOTP(code, telefon);
  const otp = isTestBypass ? { rowid: -1 } : db.prepare(
    "SELECT rowid, * FROM otp_codes WHERE telefon = ? AND code = ? AND used = 0 AND expires_at > datetime('now') ORDER BY created_at DESC LIMIT 1"
  ).get(telefon, codeHash);

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

  // Bypass for utvikler (Aleksander Roel): telefon 90852833 med kode 1234
  const isTestBypass = (telefon === "90852833" && code === "1234");

  // Hash koden før sammenligning
  const codeHash = hashOTP(code, telefon);
  const otp = isTestBypass ? { rowid: -1 } : db.prepare(
    "SELECT rowid, * FROM otp_codes WHERE telefon = ? AND code = ? AND used = 0 AND expires_at > datetime('now') ORDER BY created_at DESC LIMIT 1"
  ).get(telefon, codeHash);

  if (!otp) {
    return c.json({ error: "Ugyldig eller utløpt kode" }, 401);
  }

  // Ikke oppdater OTP-tabell for test-bypass
  if (otp.rowid !== -1) {
    db.prepare("UPDATE otp_codes SET used = 1 WHERE rowid = ?").run(otp.rowid);
  }

  let bruker = db.prepare("SELECT * FROM brukere WHERE telefon = ?").get(telefon);

  // Sjekk om dette er en FKF-godkjent dommer
  // Først prøv match på telefonnummer
  const normalized = normalizePhone(telefon);
  let fkfDommer = db.prepare(`
    SELECT id, fornavn, etternavn, adresse, postnummer, sted, epost, linked_bruker_telefon
    FROM fkf_godkjente_dommere
    WHERE aktiv = 1 AND (telefon1_normalized = ? OR telefon2_normalized = ?)
  `).get(normalized, normalized);

  // Hvis ingen telefon-match og bruker finnes, prøv match på navn
  if (!fkfDommer && bruker && bruker.fornavn && bruker.etternavn) {
    fkfDommer = db.prepare(`
      SELECT id, fornavn, etternavn, adresse, postnummer, sted, epost, linked_bruker_telefon
      FROM fkf_godkjente_dommere
      WHERE aktiv = 1
        AND linked_bruker_telefon IS NULL
        AND LOWER(fornavn) = LOWER(?)
        AND LOWER(etternavn) = LOWER(?)
    `).get(bruker.fornavn.trim(), bruker.etternavn.trim());

    if (fkfDommer) {
      console.log(`[Auto-dommer] Matchet på navn ved innlogging: ${bruker.fornavn} ${bruker.etternavn} -> FKF-dommer ID ${fkfDommer.id}`);
    }
  }

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

  // FKF-dommer uten brukerkonto - krev fullstendig registrering med samtykke
  if (fkfDommer) {
    console.log(`[FKF-dommer] ${fkfDommer.fornavn} ${fkfDommer.etternavn} (${telefon}) må fullføre registrering`);
    return c.json({
      requiresRegistration: true,
      isFkfDommer: true,
      fkfDommerInfo: {
        fornavn: fkfDommer.fornavn,
        etternavn: fkfDommer.etternavn,
        epost: fkfDommer.epost || ''
      },
      message: "Du er registrert som FKF-dommer, men må fullføre registrering med SMS-samtykke."
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

// Registrer samtykke (GDPR) - oppdaterer både gamle og nye samtykke-felt
app.post("/api/auth/consent", requireAuth, (c) => {
  const payload = c.get("bruker");
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE brukere
    SET samtykke_gitt = datetime('now'),
        sms_samtykke = 1,
        sms_samtykke_tidspunkt = ?
    WHERE telefon = ?
  `).run(now, payload.telefon);
  return c.json({ ok: true, samtykke_gitt: now, sms_samtykke: true });
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
  const codeHash = hashOTP(code, telefon);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 min
  db.prepare("INSERT INTO otp_codes (telefon, code, expires_at) VALUES (?, ?, ?)").run(telefon, codeHash, expiresAt);

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

  // Verifiser OTP (hash koden først)
  const codeHash = hashOTP(code, telefon);
  const otp = db.prepare(
    "SELECT rowid, * FROM otp_codes WHERE telefon = ? AND code = ? AND used = 0 AND expires_at > datetime('now') ORDER BY created_at DESC LIMIT 1"
  ).get(telefon, codeHash);

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
  // Først prøv match på telefonnummer
  const normalized = normalizePhone(telefon);
  let fkfDommer = db.prepare(`
    SELECT id, fornavn, etternavn, linked_bruker_telefon
    FROM fkf_godkjente_dommere
    WHERE aktiv = 1 AND (telefon1_normalized = ? OR telefon2_normalized = ?)
  `).get(normalized, normalized);

  // Hvis ingen telefon-match, prøv match på navn (for dommere med kun fastnummer)
  if (!fkfDommer && fornavn && etternavn) {
    fkfDommer = db.prepare(`
      SELECT id, fornavn, etternavn, linked_bruker_telefon
      FROM fkf_godkjente_dommere
      WHERE aktiv = 1
        AND linked_bruker_telefon IS NULL
        AND LOWER(fornavn) = LOWER(?)
        AND LOWER(etternavn) = LOWER(?)
    `).get(fornavn.trim(), etternavn.trim());

    if (fkfDommer) {
      console.log(`[Auto-dommer] Matchet på navn: ${fornavn} ${etternavn} -> FKF-dommer ID ${fkfDommer.id}`);
    }
  }

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

  // ============================================
  // AUTO-KOBLE HUNDER FRA DELTAKERLISTE
  // Når eier og fører er samme person i deltakerlisten,
  // kobles hunden automatisk til brukerens "Mine hunder"
  // ============================================
  let hunderKoblet = 0;
  try {
    const fullNavn = `${fornavn} ${etternavn}`.trim().toLowerCase();

    // Finn påmeldinger der brukerens navn matcher eier ELLER fører
    // (mange deltakerlister har samme navn på begge)
    const matchendePameldinger = db.prepare(`
      SELECT pd.hund_regnr, pd.hund_navn, pd.rase, pd.eier_navn, pd.forer_navn, pd.prove_id
      FROM parti_deltakere pd
      WHERE (LOWER(pd.eier_navn) LIKE ? OR LOWER(pd.forer_navn) LIKE ?)
        AND pd.hund_regnr IS NOT NULL
        AND pd.hund_regnr != ''
    `).all(`%${fullNavn}%`, `%${fullNavn}%`);

    for (const pm of matchendePameldinger) {
      // Sjekk om hunden allerede finnes i systemet
      let hund = db.prepare("SELECT id, eier_telefon FROM hunder WHERE regnr = ?").get(pm.hund_regnr);

      if (hund) {
        // Hund finnes - oppdater eier hvis ikke satt
        if (!hund.eier_telefon) {
          db.prepare("UPDATE hunder SET eier_telefon = ? WHERE id = ?").run(telefon, hund.id);
          hunderKoblet++;
          console.log(`[Auto-koble] Hund ${pm.hund_regnr} (${pm.hund_navn}) koblet til bruker ${telefon}`);
        }
      } else {
        // Hund finnes ikke - opprett den med denne brukeren som eier
        const result = db.prepare(`
          INSERT INTO hunder (regnr, navn, rase, eier_telefon)
          VALUES (?, ?, ?, ?)
        `).run(pm.hund_regnr, pm.hund_navn || 'Ukjent', pm.rase || '', telefon);
        hunderKoblet++;
        console.log(`[Auto-koble] Ny hund ${pm.hund_regnr} (${pm.hund_navn}) opprettet for bruker ${telefon}`);
      }
    }

    if (hunderKoblet > 0) {
      db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").run(
        "auto_koble_hunder",
        `${hunderKoblet} hund(er) automatisk koblet til bruker ${telefon} (${fornavn} ${etternavn}) fra deltakerliste`
      );
    }
  } catch (e) {
    console.error("[Auto-koble] Feil ved kobling av hunder:", e.message);
  }

  // Generer JWT
  const token = jwt.sign(
    {
      telefon: bruker.telefon,
      fornavn: bruker.fornavn,
      etternavn: bruker.etternavn,
      rolle: bruker.rolle || "deltaker"
    },
    JWT_SECRET_FINAL,
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

  // Hent verifisert bruker
  const bruker = db.prepare("SELECT * FROM brukere WHERE telefon = ? AND verifisert = 1").get(telefon);

  if (!bruker) {
    return c.json({ error: "Bruker ikke funnet eller ikke verifisert" }, 401);
  }

  // Sjekk passord
  if (!verifyPassword(passord, bruker.passord_hash)) {
    return c.json({ error: "Feil passord" }, 401);
  }

  // Oppgrader passord-hash til bcrypt hvis det er legacy SHA256
  if (needsHashUpgrade(bruker.passord_hash)) {
    try {
      const newHash = hashPassword(passord);
      db.prepare("UPDATE brukere SET passord_hash = ? WHERE telefon = ?").run(newHash, telefon);
      console.log(`[Auth] Oppgradert passord-hash til bcrypt for ${telefon}`);
    } catch (e) {
      console.error(`[Auth] Feil ved oppgradering av passord-hash: ${e.message}`);
    }
  }

  // Sjekk om re-verifisering kreves (>60 dager)
  if (needsReverification(bruker.siste_innlogging)) {
    return c.json({
      requiresVerification: true,
      message: "Det er over 60 dager siden siste innlogging. Verifiser med SMS-kode.",
      telefon
    }, 200);
  }

  // Oppdater siste innlogging og logg vellykket pålogging
  db.prepare("UPDATE brukere SET siste_innlogging = datetime('now') WHERE telefon = ?").run(telefon);
  db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").run(
    "bruker_innlogget", JSON.stringify({ telefon, rolle: bruker.rolle || 'deltaker', metode: 'passord' })
  );

  const token = jwt.sign(
    {
      telefon: bruker.telefon,
      fornavn: bruker.fornavn,
      etternavn: bruker.etternavn,
      rolle: bruker.rolle || "deltaker"
    },
    JWT_SECRET_FINAL,
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
  const codeHash = hashOTP(code, telefon);
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  db.prepare("INSERT INTO otp_codes (telefon, code, expires_at) VALUES (?, ?, ?)").run(telefon, codeHash, expiresAt);

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

  const codeHash = hashOTP(code, telefon);
  const otp = db.prepare(
    "SELECT rowid, * FROM otp_codes WHERE telefon = ? AND code = ? AND used = 0 AND expires_at > datetime('now') ORDER BY created_at DESC LIMIT 1"
  ).get(telefon, codeHash);

  if (!otp) {
    return c.json({ error: "Ugyldig eller utløpt kode" }, 401);
  }

  db.prepare("UPDATE otp_codes SET used = 1 WHERE rowid = ?").run(otp.rowid);

  const bruker = db.prepare("SELECT * FROM brukere WHERE telefon = ?").get(telefon);
  if (!bruker) {
    return c.json({ error: "Bruker ikke funnet" }, 404);
  }

  // Oppdater siste innlogging og logg vellykket pålogging
  db.prepare("UPDATE brukere SET siste_innlogging = datetime('now') WHERE telefon = ?").run(telefon);
  db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").run(
    "bruker_innlogget", JSON.stringify({ telefon, rolle: bruker.rolle || 'deltaker', metode: 'sms_otp' })
  );

  const token = jwt.sign(
    {
      telefon: bruker.telefon,
      fornavn: bruker.fornavn,
      etternavn: bruker.etternavn,
      rolle: bruker.rolle || "deltaker"
    },
    JWT_SECRET_FINAL,
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
  const codeHash = hashOTP(code, telefon);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 min
  db.prepare("INSERT INTO otp_codes (telefon, code, expires_at) VALUES (?, ?, ?)").run(telefon, codeHash, expiresAt);

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

  const kodeHash = hashOTP(kode, telefon);
  const otp = db.prepare(
    "SELECT rowid, * FROM otp_codes WHERE telefon = ? AND code = ? AND used = 0 AND expires_at > datetime('now') ORDER BY created_at DESC LIMIT 1"
  ).get(telefon, kodeHash);

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
    JWT_SECRET_FINAL,
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
  const codeHash = hashOTP(code, telefon);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  db.prepare("INSERT INTO otp_codes (telefon, code, expires_at) VALUES (?, ?, ?)").run(telefon, codeHash, expiresAt);

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

  const codeHash = hashOTP(code, telefon);
  const otp = db.prepare(
    "SELECT rowid, * FROM otp_codes WHERE telefon = ? AND code = ? AND used = 0 AND expires_at > datetime('now') ORDER BY created_at DESC LIMIT 1"
  ).get(telefon, codeHash);

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
      INSERT INTO brukere (telefon, fornavn, etternavn, epost, passord_hash, verifisert, siste_innlogging, rolle, sms_samtykke, sms_samtykke_tidspunkt)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, 1, ?)
    `).run(telefon, fornavn, etternavn, epost, passordHash, now, rolle, now);
    brukerOpprettet = true;
    console.log(`📱 Brukerprofil opprettet for klubbleder: ${lederNavn} (${telefon})${fkfDommer ? ' [FKF-dommer]' : ''} (SMS-samtykke: Ja)`);

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
    JWT_SECRET_FINAL,
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
    JWT_SECRET_FINAL,
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
  const codeHash = hashOTP(code, telefon);
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  db.prepare("INSERT INTO otp_codes (telefon, code, expires_at) VALUES (?, ?, ?)").run(telefon, codeHash, expiresAt);

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

  const codeHash = hashOTP(code, telefon);
  const otp = db.prepare(
    "SELECT rowid, * FROM otp_codes WHERE telefon = ? AND code = ? AND used = 0 AND expires_at > datetime('now') ORDER BY created_at DESC LIMIT 1"
  ).get(telefon, codeHash);

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
    JWT_SECRET_FINAL,
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

// Liste alle keys (for admin-panel data explorer)
app.get("/api/storage", (c) => {
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

// --- Admin log (for admin-panel) ---
app.get("/api/admin/log", (c) => {
  const limit = Number(c.req.query("limit") || 100);
  const klubbId = c.req.query("klubb_id") || "";
  const proveId = c.req.query("prove_id") || "";
  const type = c.req.query("type") || "";

  let whereClause = "1=1";
  const params = [];

  // Hent klubber og prøver for filter-dropdowns
  const klubber = db.prepare("SELECT id, navn FROM klubber ORDER BY navn").all();
  const alleProver = db.prepare("SELECT id, navn, klubb_id FROM prover ORDER BY start_dato DESC").all();

  // Filter på klubb - finn alle prøve-IDer for denne klubben
  if (klubbId) {
    const klubbProver = alleProver.filter(p => p.klubb_id === klubbId);
    const klubbNavn = klubber.find(k => k.id === klubbId)?.navn || '';

    if (klubbProver.length > 0) {
      // Søk etter klubb-id, klubbnavn, eller prøve-IDer som tilhører klubben
      const proveIds = klubbProver.map(p => p.id);
      const proveNavner = klubbProver.map(p => p.navn);
      const searchTerms = [klubbId, klubbNavn, ...proveIds, ...proveNavner].filter(t => t);
      const likeClauses = searchTerms.map(() => "detail LIKE ?").join(" OR ");
      whereClause += ` AND (${likeClauses})`;
      searchTerms.forEach(t => params.push(`%${t}%`));
    } else {
      // Bare søk på klubb-id og klubbnavn
      whereClause += " AND (detail LIKE ? OR detail LIKE ?)";
      params.push(`%${klubbId}%`, `%${klubbNavn}%`);
    }
  }

  // Filter på prøve
  if (proveId) {
    const prove = alleProver.find(p => p.id === proveId);
    const proveNavn = prove?.navn || '';
    whereClause += " AND (detail LIKE ? OR detail LIKE ?)";
    params.push(`%${proveId}%`, `%${proveNavn}%`);
  }

  // Filter på type
  if (type === "innlogging") {
    whereClause += " AND action LIKE '%innlogg%'";
  } else if (type === "prove") {
    whereClause += " AND (action LIKE '%prove%' OR action LIKE '%prøve%' OR action LIKE '%pamelding%' OR action LIKE '%kritikk%' OR action LIKE '%trial%')";
  } else if (type === "bruker") {
    // Bruker-endringer: registrering, sletting, rolle-endring, samtykke - MEN IKKE innlogging
    whereClause += " AND (action IN ('bruker_registrert', 'bruker_slettet', 'bruker_rolle_endret', 'samtykke_registrert', 'samtykke_registrert_admin', 'samtykke_trukket') OR (action LIKE '%dommer%' AND action NOT LIKE '%innlogg%'))";
  } else if (type === "klubb") {
    whereClause += " AND (action LIKE '%klubb%' OR action IN ('klubb_foresporsel', 'klubb_godkjent', 'klubb_avslatt', 'klubb_opprettet'))";
  } else if (type === "sms") {
    whereClause += " AND action LIKE '%sms%'";
  }

  const rows = db.prepare(`SELECT * FROM admin_log WHERE ${whereClause} ORDER BY id DESC LIMIT ?`).all(...params, limit);

  // For prøve-dropdown: filtrer basert på valgt klubb
  let prover = alleProver;
  if (klubbId) {
    prover = alleProver.filter(p => p.klubb_id === klubbId);
  }

  return c.json({ items: rows, klubber, prover });
});

// ============================================
// PARTIFORDELINGSREGLER API
// ============================================

// Hent partifordelingsregler (åpen for alle - brukes av frontend)
app.get("/api/partifordeling/regler", (c) => {
  const row = db.prepare("SELECT * FROM partifordeling_regler WHERE id = 1").get();
  if (!row) {
    // Returner standardverdier om ingen rad finnes
    return c.json({
      eier_samme_parti: true,
      eier_ikke_samme_slipp: true,
      eier_identifikator: 'begge',
      maks_per_parti_ukak: 14,
      maks_per_parti_vk: 20,
      beskrivelse: 'Hunder fra samme eier/fører plasseres på samme parti, men ikke i samme slipp.'
    });
  }
  return c.json({
    eier_samme_parti: !!row.eier_samme_parti,
    eier_ikke_samme_slipp: !!row.eier_ikke_samme_slipp,
    eier_identifikator: row.eier_identifikator || 'begge',
    maks_per_parti_ukak: row.maks_per_parti_ukak || 14,
    maks_per_parti_vk: row.maks_per_parti_vk || 20,
    beskrivelse: row.beskrivelse || '',
    oppdatert_av: row.oppdatert_av,
    updated_at: row.updated_at
  });
});

// Oppdater partifordelingsregler (krever admin)
app.put("/api/partifordeling/regler", requireAdmin, async (c) => {
  try {
    const body = await c.req.json();
    const {
      eier_samme_parti,
      eier_ikke_samme_slipp,
      eier_identifikator,
      maks_per_parti_ukak,
      maks_per_parti_vk,
      beskrivelse
    } = body;

    // Valider eier_identifikator
    const validIdentifikatorer = ['telefon', 'navn', 'begge'];
    const ident = validIdentifikatorer.includes(eier_identifikator) ? eier_identifikator : 'begge';

    // Hent bruker fra auth (hvis tilgjengelig)
    const oppdatertAv = c.get('user')?.telefon || 'ukjent';

    db.prepare(`
      UPDATE partifordeling_regler SET
        eier_samme_parti = ?,
        eier_ikke_samme_slipp = ?,
        eier_identifikator = ?,
        maks_per_parti_ukak = ?,
        maks_per_parti_vk = ?,
        beskrivelse = ?,
        oppdatert_av = ?,
        updated_at = datetime('now')
      WHERE id = 1
    `).run(
      eier_samme_parti ? 1 : 0,
      eier_ikke_samme_slipp ? 1 : 0,
      ident,
      maks_per_parti_ukak || 14,
      maks_per_parti_vk || 20,
      beskrivelse || '',
      oppdatertAv
    );

    // Logg endringen
    db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").run(
      "partifordeling_regler_oppdatert",
      `Regler oppdatert av ${oppdatertAv}: eier_samme_parti=${eier_samme_parti}, eier_ikke_samme_slipp=${eier_ikke_samme_slipp}`
    );

    return c.json({ ok: true, message: "Partifordelingsregler oppdatert" });
  } catch (err) {
    console.error("Feil ved oppdatering av partifordelingsregler:", err);
    return c.json({ error: "Kunne ikke oppdatere regler" }, 500);
  }
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

// Sanntids prøve-dashboard statistikk for prøveleder
app.get("/api/stats/prove/:proveId", (c) => {
  const proveId = c.req.param("proveId");

  // Prøve-info
  const prove = db.prepare("SELECT * FROM prover WHERE id = ?").get(proveId);

  // Kritikk-statistikk
  const kritikkStats = db.prepare(`
    SELECT
      COUNT(*) as totalt,
      SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) as utkast,
      SUM(CASE WHEN status = 'submitted' THEN 1 ELSE 0 END) as innsendt,
      SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) as godkjent
    FROM kritikker
    WHERE prove_id = ?
  `).get(proveId);

  // Premiefordeling
  const premiefordeling = db.prepare(`
    SELECT premie, klasse, COUNT(*) as antall
    FROM kritikker
    WHERE prove_id = ? AND premie IS NOT NULL AND premie != ''
    GROUP BY premie, klasse
    ORDER BY klasse, premie
  `).all(proveId);

  // Siste aktivitet
  const sisteAktivitet = db.prepare(`
    SELECT k.*, h.navn as hund_navn, h.regnr
    FROM kritikker k
    LEFT JOIN hunder h ON k.hund_id = h.id
    WHERE k.prove_id = ?
    ORDER BY k.updated_at DESC
    LIMIT 10
  `).all(proveId);

  // Per-parti statistikk
  const partiStats = db.prepare(`
    SELECT
      parti,
      COUNT(*) as antall_kritikker,
      SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) as godkjente,
      SUM(CASE WHEN status = 'submitted' THEN 1 ELSE 0 END) as ventende
    FROM kritikker
    WHERE prove_id = ?
    GROUP BY parti
  `).all(proveId);

  // DVK-kontroller
  const dvkStats = db.prepare(`
    SELECT COUNT(*) as antall,
           SUM(CASE WHEN tiltak_advarsel = 1 OR tiltak_diskvalifikasjon = 1 THEN 1 ELSE 0 END) as alvorlige
    FROM dvk_kontroller
    WHERE prove_id = ?
  `).get(proveId);

  return c.json({
    prove,
    kritikker: kritikkStats,
    premiefordeling,
    sisteAktivitet,
    partiStats,
    dvk: dvkStats,
    oppdatert: new Date().toISOString()
  });
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

// Hent alle brukere - KUN superadmin, og ALDRI passord_hash
app.get("/api/brukere", requireAuth, (c) => {
  const bruker = c.get("bruker");
  if (!hasAnyRole(bruker.rolle, ["superadmin"])) {
    return c.json({ error: "Krever superadmin-tilgang" }, 403);
  }
  const rows = db.prepare(`
    SELECT telefon, fornavn, etternavn, epost, adresse, postnummer, sted,
           rolle, medlem_siden, profilbilde, samtykke_gitt, created_at, updated_at,
           siste_innlogging, verifisert, sms_samtykke, sms_samtykke_tidspunkt
    FROM brukere ORDER BY etternavn, fornavn
  `).all();
  return c.json(rows);
});

// Søk etter brukere (for autocomplete) - krever innlogging
app.get("/api/brukere/sok", requireAuth, (c) => {
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

// Hent én bruker på telefon - ALDRI eksponer passord_hash
app.get("/api/brukere/:telefon", (c) => {
  const telefon = c.req.param("telefon");
  const row = db.prepare(`
    SELECT telefon, fornavn, etternavn, epost, adresse, postnummer, sted,
           rolle, medlem_siden, profilbilde, samtykke_gitt, created_at, updated_at,
           siste_innlogging, verifisert, sms_samtykke, sms_samtykke_tidspunkt
    FROM brukere WHERE telefon = ?
  `).get(telefon);
  if (!row) return c.json({ error: "Bruker ikke funnet" }, 404);

  // Hent alle klubber brukeren er admin for
  const klubbAdmins = db.prepare(`
    SELECT ka.rolle as klubb_rolle, k.id as klubb_id, k.navn as klubb_navn
    FROM klubb_admins ka
    JOIN klubber k ON ka.klubb_id = k.id
    WHERE ka.telefon = ?
  `).all(telefon);

  // Bakoverkompatibilitet: klubbAdmin = første klubb (eller null)
  const klubbAdmin = klubbAdmins.length > 0 ? klubbAdmins[0] : null;

  return c.json({ ...row, klubbAdmin, klubbAdmins });
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
    // Opprett ny - sms_samtykke = 0 fordi admin-opprettelse krever at brukeren selv avgir samtykke senere
    db.prepare(`
      INSERT INTO brukere (telefon, fornavn, etternavn, epost, adresse, postnummer, sted, rolle, sms_samtykke)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
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
    console.log(`[Admin] Ny bruker opprettet: ${telefon} (SMS-samtykke: Nei - må avgis av bruker)`);
  }

  const row = db.prepare(`
    SELECT telefon, fornavn, etternavn, epost, adresse, postnummer, sted,
           rolle, medlem_siden, profilbilde, samtykke_gitt, created_at, updated_at,
           siste_innlogging, verifisert, sms_samtykke, sms_samtykke_tidspunkt
    FROM brukere WHERE telefon = ?
  `).get(telefon);
  return c.json(row);
});

// Sjekk om bruker er dommer for en prøve
app.get("/api/brukere/:telefon/dommer-info", (c) => {
  const telefon = c.req.param("telefon");
  const proveId = c.req.query("prove_id");

  // LEFT JOIN partier-tabellen så vi får parti.type/dato/id når tildelingens `parti`
  // matcher partier.navn (typisk NKK-fil-format "UK/AK Parti 1"). Eldre tildelinger
  // med digital-pamelding-format ("ukak1", "vkfinale") matcher ikke og får NULL.
  let query = `
    SELECT dt.*, p.navn as prove_navn, p.sted as prove_sted, p.start_dato, p.slutt_dato,
           b.fornavn, b.etternavn,
           pt.id as parti_id, pt.type as parti_type, pt.dato as parti_dato,
           (SELECT COUNT(*) FROM parti_deltakere pd WHERE pd.parti_id = pt.id) as antall_hunder
    FROM dommer_tildelinger dt
    JOIN prover p ON dt.prove_id = p.id
    JOIN brukere b ON dt.dommer_telefon = b.telefon
    LEFT JOIN partier pt ON pt.prove_id = dt.prove_id AND pt.navn = dt.parti
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
      partiId: r.parti_id,
      partiType: r.parti_type,
      partiDato: r.parti_dato,
      antallHunder: r.antall_hunder || 0,
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
  const { regnr, navn, rase, kjonn, fodselsdato, eier_telefon, klubb_id, bilde,
          eierbevis, eierbevis_dato, aversjonsbevis, aversjonsbevis_dato,
          vaksinasjon, vaksinasjon_dato } = body;

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
      INSERT INTO hunder (regnr, navn, rase, kjonn, fodt, eier_telefon, klubb_id, bilde,
                          eierbevis, eierbevis_dato, aversjonsbevis, aversjonsbevis_dato,
                          vaksinasjon, vaksinasjon_dato)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(regnr || null, navn, rase ? normalizeRase(rase) : null, kjonn || null, fodselsdato || null, eier_telefon, klubb_id || null, bilde || null,
           eierbevis || null, eierbevis_dato || null, aversjonsbevis || null, aversjonsbevis_dato || null,
           vaksinasjon || null, vaksinasjon_dato || null);

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
    fodselsdato: "fodt", fodt: "fodt", klubb_id: "klubb_id", bilde: "bilde",
    eier_telefon: "eier_telefon", eier_navn: "eier_navn",
    eierbevis: "eierbevis", eierbevis_dato: "eierbevis_dato",
    vaksinasjon: "vaksinasjon", vaksinasjon_dato: "vaksinasjon_dato",
    aversjonsbevis: "aversjonsbevis", aversjonsbevis_dato: "aversjonsbevis_dato"
  };
  // Spesialhåndter eier_telefon: tomt → NULL (FK godtar ikke ''), og
  // ikke-eksisterende telefon → avvis med tydelig feilmelding så vi
  // ikke bryter brukere(telefon) FK-en.
  if ('eier_telefon' in body) {
    const tlf = (body.eier_telefon || '').trim();
    if (!tlf) {
      body.eier_telefon = null;
    } else {
      const finnes = db.prepare("SELECT 1 FROM brukere WHERE telefon = ?").get(tlf);
      if (!finnes) {
        return c.json({
          error: `Telefon "${tlf}" er ikke registrert som bruker. Opprett brukeren først, eller la eier-telefon stå tom.`
        }, 400);
      }
      body.eier_telefon = tlf;
    }
  }

  const sets = [];
  const vals = [];

  for (const [bodyKey, dbCol] of Object.entries(fieldMap)) {
    if (bodyKey in body) {
      sets.push(`${dbCol} = ?`);
      // Normaliser rase så skrivefeil og eldre format blir kanonisk
      vals.push(bodyKey === 'rase' && body[bodyKey] ? normalizeRase(body[bodyKey]) : body[bodyKey]);
    }
  }

  // Hvis regnr endres, sjekk at det ikke kolliderer med en annen hund
  if (body.regnr && body.regnr !== existing.regnr) {
    const collide = db.prepare("SELECT id FROM hunder WHERE regnr = ? AND id != ?").get(body.regnr, id);
    if (collide) {
      return c.json({ error: `regnr "${body.regnr}" er allerede registrert på en annen hund (id ${collide.id})` }, 409);
    }
  }

  if (sets.length === 0) {
    return c.json({ error: "Ingen felter å oppdatere" }, 400);
  }

  // Kjør hele oppdateringen i transaksjon så hund og denormaliserte
  // parti_deltakere-rader endres atomisk.
  const tx = db.transaction(() => {
    if (sets.length > 0) {
      vals.push(id);
      db.prepare(`UPDATE hunder SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
    }

    // Propager til parti_deltakere som har denormaliserte kopier av
    // hund-data. Vi finner radene via eksisterende regnr (eller nytt
    // regnr hvis det nettopp ble endret).
    const oldRegnr = existing.regnr;
    const newRegnr = body.regnr || oldRegnr;

    const partiSets = [];
    const partiVals = [];
    if ('navn' in body) { partiSets.push("hund_navn = ?"); partiVals.push(body.navn); }
    if ('rase' in body) { partiSets.push("rase = ?"); partiVals.push(normalizeRase(body.rase)); }
    if ('kjonn' in body) { partiSets.push("kjonn = ?"); partiVals.push(body.kjonn); }
    if ('eier_navn' in body) { partiSets.push("eier_navn = ?"); partiVals.push(body.eier_navn || ''); }
    if (newRegnr !== oldRegnr) { partiSets.push("hund_regnr = ?"); partiVals.push(newRegnr); }

    if (partiSets.length > 0 && oldRegnr) {
      partiVals.push(oldRegnr);
      db.prepare(`UPDATE parti_deltakere SET ${partiSets.join(", ")} WHERE hund_regnr = ?`).run(...partiVals);
    }
  });

  try {
    tx();
  } catch (err) {
    console.error("Hund-oppdatering feilet:", err);
    return c.json({ error: err.message }, 500);
  }

  // Audit-logg endringen
  const endredeFelt = Object.keys(body).filter(k => fieldMap[k] || k === 'eier_navn');
  if (endredeFelt.length > 0) {
    db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").run(
      "hund_oppdatert",
      `Hund ${id} (${existing.navn} ${existing.regnr}) oppdatert: ${endredeFelt.join(', ')}`
    );
  }

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
// HUND-SØK PÅ REGNR (for bruker-registrering)
// ============================================

// Batch-oppslag av hunder basert på regnr-liste (for import-overstyring)
app.post("/api/hunder/lookup", async (c) => {
  try {
    const body = await c.req.json();
    const regnrList = body.regnrList || [];
    if (!Array.isArray(regnrList) || regnrList.length === 0) {
      return c.json({});
    }
    const result = {};
    const stmt = db.prepare("SELECT regnr, navn, rase FROM hunder WHERE regnr = ?");
    for (const regnr of regnrList.slice(0, 500)) {
      const hund = stmt.get(regnr);
      if (hund) {
        result[regnr] = { navn: hund.navn, rase: hund.rase };
      }
    }
    return c.json(result);
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// Søk etter hund basert på registreringsnummer
// Normaliserer regnr for å håndtere variasjoner (mellomrom, case)
app.get("/api/hunder/sok/regnr", (c) => {
  const regnrQuery = (c.req.query("q") || "").trim().toUpperCase().replace(/\s+/g, '');

  if (!regnrQuery || regnrQuery.length < 3) {
    return c.json({ error: "Søkestreng må være minst 3 tegn" }, 400);
  }

  // Søk med normalisert regnr (fjerner mellomrom og konverterer til uppercase)
  // Støtter både eksakt match og partial match
  const hunder = db.prepare(`
    SELECT h.id, h.regnr, h.navn, h.rase, h.fodt, h.eier_telefon,
           b.fornavn || ' ' || b.etternavn as eier_navn,
           o.eier_navn as import_eier_navn, o.forer_navn as import_forer_navn
    FROM hunder h
    LEFT JOIN brukere b ON h.eier_telefon = b.telefon
    LEFT JOIN eier_oppslag o ON h.regnr = o.regnr
    WHERE UPPER(REPLACE(h.regnr, ' ', '')) = ?
       OR UPPER(REPLACE(h.regnr, ' ', '')) LIKE ?
    LIMIT 10
  `).all(regnrQuery, `%${regnrQuery}%`);

  return c.json({
    results: hunder.map(h => ({
      id: h.id,
      regnr: h.regnr,
      navn: h.navn,
      rase: h.rase,
      fodt: h.fodt,
      harEier: !!h.eier_telefon,
      eierNavn: h.eier_navn || h.import_eier_navn || null,
      forerNavn: h.import_forer_navn || null
    }))
  });
});

// Koble bruker til hund basert på regnr (bruker-initiert)
app.post("/api/hunder/koble", requireAuth, async (c) => {
  try {
    const bruker = c.get("bruker");
    const body = await c.req.json();
    const { regnr, fodselsdato } = body;

    if (!regnr) {
      return c.json({ error: "Registreringsnummer er påkrevd" }, 400);
    }

    if (!fodselsdato) {
      return c.json({ error: "Fødselsdato er påkrevd" }, 400);
    }

    // Normaliser regnr
    const normalizedRegnr = regnr.trim().toUpperCase().replace(/\s+/g, '');

    // Valider at fødselsdato matcher årstall i regnr
    const regnrYearMatch = normalizedRegnr.match(/\/(\d{2,4})$/);
    if (regnrYearMatch) {
      let regnrYear = regnrYearMatch[1];
      if (regnrYear.length === 2) {
        regnrYear = (parseInt(regnrYear) > 50 ? '19' : '20') + regnrYear;
      }
      const fodtYear = new Date(fodselsdato).getFullYear().toString();
      if (fodtYear !== regnrYear) {
        return c.json({
          error: `Fødselsdato (${fodtYear}) matcher ikke årstall i regnr (${regnrYear})`
        }, 400);
      }
    }

    // Finn hunden
    const hund = db.prepare(`
      SELECT id, regnr, navn, eier_telefon
      FROM hunder
      WHERE UPPER(REPLACE(regnr, ' ', '')) = ?
    `).get(normalizedRegnr);

    if (!hund) {
      return c.json({ error: "Hund ikke funnet med dette regnr" }, 404);
    }

    // Sjekk om hunden allerede har eier
    if (hund.eier_telefon && hund.eier_telefon !== bruker.telefon) {
      return c.json({
        error: "Denne hunden er allerede registrert på en annen bruker",
        hint: "Kontakt administrator hvis dette er feil"
      }, 409);
    }

    // Oppdater hunden med eier og fødselsdato
    db.prepare(`
      UPDATE hunder
      SET eier_telefon = ?, fodt = ?
      WHERE id = ?
    `).run(bruker.telefon, fodselsdato, hund.id);

    // Sjekk om det finnes fullmakter som skal opprettes fra eier_oppslag
    const oppslag = db.prepare(`
      SELECT eier_navn, forer_navn FROM eier_oppslag WHERE regnr = ?
    `).get(hund.regnr);

    if (oppslag && oppslag.forer_navn && oppslag.forer_navn !== oppslag.eier_navn) {
      // Fører er forskjellig fra eier - logg for manuell fullmakt-opprettelse
      // (fullmakt opprettes når fører registrerer seg og matcher)
      console.log(`Fullmakt kan opprettes: ${oppslag.eier_navn} → ${oppslag.forer_navn} for hund ${hund.regnr}`);
    }

    return c.json({
      success: true,
      message: `Hunden "${hund.navn}" er nå koblet til din profil`,
      hund: {
        id: hund.id,
        regnr: hund.regnr,
        navn: hund.navn,
        fodt: fodselsdato
      }
    });

  } catch (err) {
    console.error("Feil ved kobling av hund:", err);
    return c.json({ error: "Feil ved kobling: " + err.message }, 500);
  }
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
      hjemmeside: data.hjemmeside || null,
      epostadresse: data.epostadresse || null,
      telefon: data.telefon || null,
      mobil: data.mobil || null,
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
// Helper: Fjern sensitive Vipps-nøkler fra klubb-objekt før retur til frontend
function sanitizeKlubbForResponse(klubb) {
  if (!klubb) return klubb;
  const { vipps_client_secret, vipps_subscription_key, ...safe } = klubb;
  // Returner kun om nøkler er konfigurert (ikke selve nøklene)
  return {
    ...safe,
    vipps_configured: !!(klubb.vipps_client_id && klubb.vipps_client_secret && klubb.vipps_subscription_key)
  };
}

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

  // Fjern sensitive Vipps-nøkler fra respons
  return c.json({ ...sanitizeKlubbForResponse(row), admins });
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
  if (body.vipps_nummer !== undefined) {
    // STRENG validering: Vipps-bedriftsnummer må være 5-6 siffer (eller null/tom)
    // Dette hindrer at telefonnummer fra browser-autofill blir lagret ved en feil
    const vippsNr = body.vipps_nummer;
    if (vippsNr !== null && vippsNr !== '' && !/^\d{5,6}$/.test(String(vippsNr).trim())) {
      return c.json({
        error: `Ugyldig Vipps-nummer: "${vippsNr}". Må være 5-6 siffer.`
      }, 400);
    }
    updates.push("vipps_nummer = ?");
    params.push(vippsNr || null);
  }
  if (body.epost !== undefined) { updates.push("epost = ?"); params.push(body.epost); }
  if (body.telefon !== undefined) { updates.push("telefon = ?"); params.push(body.telefon); }
  if (body.nettside !== undefined) { updates.push("nettside = ?"); params.push(body.nettside); }
  if (body.adresse !== undefined) { updates.push("adresse = ?"); params.push(body.adresse); }
  if (body.sted !== undefined) { updates.push("sted = ?"); params.push(body.sted); }
  // Vipps Business API-felter (sensitive data krypteres)
  if (body.vipps_client_id !== undefined) {
    updates.push("vipps_client_id = ?");
    params.push(body.vipps_client_id ? encryptSensitive(body.vipps_client_id) : null);
  }
  if (body.vipps_client_secret !== undefined) {
    updates.push("vipps_client_secret = ?");
    params.push(body.vipps_client_secret ? encryptSensitive(body.vipps_client_secret) : null);
  }
  if (body.vipps_subscription_key !== undefined) {
    updates.push("vipps_subscription_key = ?");
    params.push(body.vipps_subscription_key ? encryptSensitive(body.vipps_subscription_key) : null);
  }
  if (body.vipps_merchant_serial !== undefined) { updates.push("vipps_merchant_serial = ?"); params.push(body.vipps_merchant_serial); }
  if (body.vipps_api_modus !== undefined) { updates.push("vipps_api_modus = ?"); params.push(body.vipps_api_modus); }
  if (body.logo !== undefined) {
    updates.push("logo = ?");
    params.push(body.logo);
    updates.push("logo_oppdatert = datetime('now')");
  }

  if (updates.length === 0) return c.json({ error: "Ingen felt å oppdatere" }, 400);

  params.push(id);
  db.prepare(`UPDATE klubber SET ${updates.join(", ")} WHERE id = ?`).run(...params);

  const updated = db.prepare("SELECT * FROM klubber WHERE id = ?").get(id);
  return c.json(updated);
});

// Last opp logo for klubb (FormData)
app.post("/api/klubber/:id/logo", async (c) => {
  const id = c.req.param("id");

  const klubb = db.prepare("SELECT * FROM klubber WHERE id = ?").get(id);
  if (!klubb) return c.json({ error: "Klubb ikke funnet" }, 404);

  try {
    const formData = await c.req.formData();
    const file = formData.get("logo");

    if (!file || !(file instanceof File)) {
      return c.json({ error: "Ingen fil mottatt" }, 400);
    }

    // Sjekk filtype
    const ext = file.name.split(".").pop().toLowerCase();
    if (!["png", "jpg", "jpeg", "svg", "webp"].includes(ext)) {
      return c.json({ error: "Ugyldig filformat. Bruk PNG, JPG, SVG eller WebP." }, 400);
    }

    // Konverter til base64 og lagre i database
    const buffer = Buffer.from(await file.arrayBuffer());
    const base64 = `data:image/${ext === 'svg' ? 'svg+xml' : ext};base64,${buffer.toString('base64')}`;

    db.prepare(`
      UPDATE klubber
      SET logo = ?, logo_oppdatert = datetime('now')
      WHERE id = ?
    `).run(base64, id);

    console.log(`[Klubb-logo] Lastet opp logo for klubb ${id} (${(buffer.length / 1024).toFixed(1)} KB)`);

    return c.json({
      success: true,
      message: "Logo lastet opp og lagret i database",
      size: buffer.length
    });
  } catch (err) {
    console.error("[Klubb-logo] Feil:", err);
    return c.json({ error: "Feil ved opplasting: " + err.message }, 500);
  }
});

// Hent logo for klubb
app.get("/api/klubber/:id/logo", (c) => {
  const id = c.req.param("id");

  const klubb = db.prepare("SELECT logo FROM klubber WHERE id = ?").get(id);
  if (!klubb) return c.json({ error: "Klubb ikke funnet" }, 404);

  if (!klubb.logo) {
    return c.json({ error: "Ingen logo lastet opp" }, 404);
  }

  return c.json({
    logo: klubb.logo,
    hasLogo: true
  });
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
  // Data fra Brønnøysundregisteret (valgfrie)
  const nettside = body.nettside || '';
  const klubbTelefon = body.klubb_telefon || '';
  const klubbEpost = body.klubb_epost || '';

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

  // Opprett brukerprofil umiddelbart (hvis ikke finnes) - med SMS-samtykke og verifisert siden de har bekreftet via SMS
  const existingUser = db.prepare("SELECT telefon FROM brukere WHERE telefon = ?").get(normalizedPhone);
  if (!existingUser) {
    const nameParts = lederNavn.trim().split(' ');
    const fornavn = nameParts[0] || '';
    const etternavn = nameParts.slice(1).join(' ') || '';
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO brukere (telefon, fornavn, etternavn, epost, rolle, passord_hash, sms_samtykke, sms_samtykke_tidspunkt, verifisert)
      VALUES (?, ?, ?, ?, 'deltaker', ?, 1, ?, 1)
    `).run(normalizedPhone, fornavn, etternavn, lederEpost, passordHash, now);
  } else if (passordHash) {
    // Oppdater passord og sett verifisert hvis bruker finnes men ikke har passord
    db.prepare(`
      UPDATE brukere SET passord_hash = ?, verifisert = 1 WHERE telefon = ? AND (passord_hash IS NULL OR passord_hash = '')
    `).run(passordHash, normalizedPhone);
  }

  const result = db.prepare(`
    INSERT INTO klubb_foresporsel (orgnummer, navn, postnummer, sted, adresse, leder_navn, leder_telefon, leder_epost, leder_rolle, passord_hash, ekstra_admins, nettside, klubb_telefon, klubb_epost)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    typeof ekstraAdmins === 'string' ? ekstraAdmins : JSON.stringify(ekstraAdmins),
    nettside,
    klubbTelefon,
    klubbEpost
  );

  db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").run(
    "klubb_foresporsel",
    `Ny klubb-forespørsel: ${navn} (org.nr: ${orgnummer})`
  );

  // Send SMS-varsling til superadmin (Aleksander Roel)
  const superadminTelefon = "90852833"; // Aleksander Roel
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

  // Generer JWT-token slik at bruker kan logge inn direkte uten ny verifisering
  const brukerData = db.prepare("SELECT * FROM brukere WHERE telefon = ?").get(normalizedPhone);
  const token = brukerData ? generateToken(brukerData) : null;

  return c.json({
    success: true,
    id: result.lastInsertRowid,
    telefon: normalizedPhone,
    token,
    bruker: brukerData ? {
      telefon: brukerData.telefon,
      fornavn: brukerData.fornavn,
      etternavn: brukerData.etternavn,
      rolle: brukerData.rolle
    } : null
  });
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

  // Generer klubb-ID fra navn - med unikkhetssjekk
  let baseKlubbId = foresporsel.navn
    .toLowerCase()
    .replace(/[^a-zæøå0-9\s]/g, '')
    .replace(/\s+/g, '-')
    .substring(0, 30);

  let klubbId = baseKlubbId;
  let suffix = 1;
  while (db.prepare("SELECT id FROM klubber WHERE id = ?").get(klubbId)) {
    klubbId = `${baseKlubbId}-${suffix}`;
    suffix++;
  }

  // Opprett klubb med passord_hash fra forespørselen og kontaktinfo fra Brønnøysund
  db.prepare(`
    INSERT INTO klubber (id, orgnummer, navn, region, passord_hash, admin_telefon, admin_epost,
                        epost, telefon, nettside, adresse, postnummer, sted)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    klubbId,
    foresporsel.orgnummer,
    foresporsel.navn,
    '',
    foresporsel.passord_hash || '',
    foresporsel.leder_telefon,
    foresporsel.leder_epost,
    foresporsel.klubb_epost || foresporsel.leder_epost || null,
    foresporsel.klubb_telefon || null,
    foresporsel.nettside || null,
    foresporsel.adresse || null,
    foresporsel.postnummer || null,
    foresporsel.sted || null
  );

  // Opprett bruker for leder hvis ikke finnes
  const existingUser = db.prepare("SELECT telefon, passord_hash, rolle, verifisert FROM brukere WHERE telefon = ?").get(foresporsel.leder_telefon);
  if (!existingUser) {
    const nameParts = foresporsel.leder_navn.split(' ');
    const fornavn = nameParts[0] || '';
    const etternavn = nameParts.slice(1).join(' ') || '';
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO brukere (telefon, fornavn, etternavn, epost, rolle, passord_hash, sms_samtykke, sms_samtykke_tidspunkt, verifisert)
      VALUES (?, ?, ?, ?, 'deltaker,klubbleder', ?, 1, ?, 1)
    `).run(foresporsel.leder_telefon, fornavn, etternavn, foresporsel.leder_epost, foresporsel.passord_hash || '', now);
  } else {
    // Legg til klubbleder-rolle hvis den ikke finnes (deduplisert) + sett verifisert
    const eksisterendeRoller = (existingUser.rolle || '').split(',').map(r => r.trim()).filter(r => r);
    if (!eksisterendeRoller.includes('klubbleder')) {
      eksisterendeRoller.push('klubbleder');
      const nyRolle = [...new Set(eksisterendeRoller)].join(',');

      if (!existingUser.passord_hash && foresporsel.passord_hash) {
        db.prepare(`UPDATE brukere SET rolle = ?, passord_hash = ?, verifisert = 1 WHERE telefon = ?`).run(nyRolle, foresporsel.passord_hash, foresporsel.leder_telefon);
      } else {
        db.prepare(`UPDATE brukere SET rolle = ?, verifisert = 1 WHERE telefon = ?`).run(nyRolle, foresporsel.leder_telefon);
      }
    } else if (!existingUser.passord_hash && foresporsel.passord_hash) {
      // Brukeren har allerede klubbleder-rolle, men mangler passord - oppdater passord og sett verifisert
      db.prepare(`UPDATE brukere SET passord_hash = ?, verifisert = 1 WHERE telefon = ?`).run(foresporsel.passord_hash, foresporsel.leder_telefon);
    } else if (!existingUser.verifisert) {
      // Sørg for at brukeren er verifisert
      db.prepare(`UPDATE brukere SET verifisert = 1 WHERE telefon = ?`).run(foresporsel.leder_telefon);
    }
  }

  // Legg til leder som klubb-admin med rolle fra forespørsel
  const lederRolle = foresporsel.leder_rolle || 'leder';
  db.prepare(`
    INSERT OR IGNORE INTO klubb_admins (telefon, klubb_id, rolle)
    VALUES (?, ?, ?)
  `).run(foresporsel.leder_telefon, klubbId, lederRolle);

  // Behandle ekstra admins - opprett brukerprofil hvis de ikke finnes
  try {
    const ekstraAdmins = JSON.parse(foresporsel.ekstra_admins || '[]');
    const now = new Date().toISOString();
    for (const admin of ekstraAdmins) {
      if (admin.phone) {
        const adminTlf = normalizePhone(admin.phone);

        // Opprett brukerprofil hvis den ikke finnes
        const eksisterendeAdmin = db.prepare("SELECT telefon FROM brukere WHERE telefon = ?").get(adminTlf);
        if (!eksisterendeAdmin) {
          db.prepare(`
            INSERT INTO brukere (telefon, fornavn, rolle, sms_samtykke, sms_samtykke_tidspunkt)
            VALUES (?, '', 'deltaker', 1, ?)
          `).run(adminTlf, now);
          console.log(`📱 Brukerprofil opprettet for ekstra admin: ${adminTlf}`);
        }

        db.prepare(`
          INSERT OR IGNORE INTO klubb_admins (telefon, klubb_id, rolle)
          VALUES (?, ?, 'admin')
        `).run(adminTlf, klubbId);
      }
    }
  } catch (e) {
    console.error("Feil ved behandling av ekstra admins:", e);
  }

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
      `Gratulerer! "${foresporsel.navn}" er nå godkjent på fuglehundprove.no. Logg inn med ditt mobilnummer og passord for å administrere klubben og opprette prøver. Velkommen!`,
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

  // Send SMS til søker om avslag
  try {
    let smsText = `Hei! Din forespørsel om å opprette "${foresporsel.navn}" på fuglehundprove.no ble dessverre ikke godkjent.`;
    if (grunn) {
      smsText += ` Begrunnelse: ${grunn}`;
    }
    smsText += ` Ta kontakt på post@fuglehundprove.no ved spørsmål.`;

    await sendSMS(
      foresporsel.leder_telefon,
      smsText,
      { type: 'klubb_avslatt' }
    );
    console.log(`📱 SMS sendt til ${foresporsel.leder_telefon} om avslått klubb: ${foresporsel.navn}`);
  } catch (smsErr) {
    console.error("Kunne ikke sende avslags-SMS:", smsErr);
  }

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

// Hent alle hunder (kun superadmin)
app.get("/api/superadmin/hunder", (c) => {
  const search = c.req.query("search") || '';
  const rase = c.req.query("rase") || '';
  const limit = parseInt(c.req.query("limit") || '50');
  const offset = parseInt(c.req.query("offset") || '0');

  let whereConditions = [];
  let params = [];

  if (search) {
    whereConditions.push("(h.navn LIKE ? OR h.regnr LIKE ? OR h.nkk_id LIKE ? OR h.eier_navn LIKE ? OR b.fornavn LIKE ? OR b.etternavn LIKE ?)");
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }

  if (rase) {
    if (rase === 'annen') {
      whereConditions.push("(h.rase NOT IN ('Engelsk Setter', 'Gordon Setter', 'Irsk Setter', 'Pointer', 'Breton', 'Tysk Korthåret Hønsehund') OR h.rase IS NULL)");
    } else {
      whereConditions.push("h.rase = ?");
      params.push(rase);
    }
  }

  const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(" AND ")}` : "";

  const rows = db.prepare(`
    SELECT h.id, h.regnr, h.nkk_id, h.navn, h.rase, h.kjonn, h.fodt, h.eier_telefon, h.created_at, h.kilde,
           COALESCE(NULLIF(h.eier_navn, ''), NULLIF(b.fornavn || ' ' || b.etternavn, ' ')) as eier_navn
    FROM hunder h
    LEFT JOIN brukere b ON h.eier_telefon = b.telefon
    ${whereClause}
    ORDER BY h.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const totalQuery = db.prepare(`
    SELECT COUNT(*) as n
    FROM hunder h
    LEFT JOIN brukere b ON h.eier_telefon = b.telefon
    ${whereClause}
  `).get(...params);

  return c.json({ hunder: rows, total: totalQuery.n });
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
// Bruker sms_samtykke (settes ved registrering) som primært samtykke-felt
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

  // Filter - bruk sms_samtykke som primært felt
  if (filter === "med_samtykke") {
    whereClause += " AND sms_samtykke = 1";
  } else if (filter === "uten_samtykke") {
    whereClause += " AND (sms_samtykke IS NULL OR sms_samtykke = 0)";
  }

  const brukere = db.prepare(`
    SELECT telefon, fornavn, etternavn, epost, rolle,
           sms_samtykke, sms_samtykke_tidspunkt,
           CASE WHEN sms_samtykke = 1 THEN sms_samtykke_tidspunkt ELSE NULL END as samtykke_gitt,
           created_at
    FROM brukere
    WHERE ${whereClause}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...params, limit);

  // Statistikk
  const total = db.prepare("SELECT COUNT(*) as n FROM brukere").get().n;
  const medSamtykke = db.prepare("SELECT COUNT(*) as n FROM brukere WHERE sms_samtykke = 1").get().n;

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

  const now = new Date().toISOString();
  db.prepare("UPDATE brukere SET sms_samtykke = 1, sms_samtykke_tidspunkt = ? WHERE telefon = ?").run(now, telefon);

  return c.json({ ok: true, samtykke_gitt: now, sms_samtykke: true });
});

// Trekk samtykke (superadmin)
app.delete("/api/superadmin/samtykke/:telefon", (c) => {
  const telefon = c.req.param("telefon");

  const bruker = db.prepare("SELECT * FROM brukere WHERE telefon = ?").get(telefon);
  if (!bruker) return c.json({ error: "Bruker ikke funnet" }, 404);

  db.prepare("UPDATE brukere SET sms_samtykke = 0, sms_samtykke_tidspunkt = NULL WHERE telefon = ?").run(telefon);

  return c.json({ ok: true });
});

// Eksporter samtykker til CSV
app.get("/api/superadmin/samtykker/eksport", (c) => {
  const brukere = db.prepare(`
    SELECT telefon, fornavn, etternavn, epost, rolle, sms_samtykke, sms_samtykke_tidspunkt, created_at
    FROM brukere
    ORDER BY sms_samtykke_tidspunkt DESC NULLS LAST, created_at DESC
  `).all();

  const header = "Telefon,Fornavn,Etternavn,E-post,Rolle,SMS-samtykke,Samtykke tidspunkt,Bruker opprettet";
  const rows = brukere.map(b => {
    return [
      b.telefon,
      b.fornavn || '',
      b.etternavn || '',
      b.epost || '',
      b.rolle || 'deltaker',
      b.sms_samtykke ? 'Ja' : 'Nei',
      b.sms_samtykke_tidspunkt || 'Mangler',
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

// Hent SMS-kø status
app.get("/api/superadmin/sms-queue", (c) => {
  const stats = getSmsQueueStats();

  // Hent de siste 20 køede/feilede
  const recent = db.prepare(`
    SELECT id, telefon, type, status, attempts, error_message, created_at, processed_at
    FROM sms_queue
    ORDER BY created_at DESC
    LIMIT 20
  `).all();

  return c.json({
    stats,
    recent,
    config: {
      batchSize: SMS_QUEUE_BATCH_SIZE,
      batchDelay: SMS_QUEUE_BATCH_DELAY_MS,
      interval: SMS_QUEUE_INTERVAL_MS
    }
  });
});

// Tøm feilede SMS fra kø
app.delete("/api/superadmin/sms-queue/failed", (c) => {
  const result = db.prepare("DELETE FROM sms_queue WHERE status = 'failed'").run();
  return c.json({ deleted: result.changes });
});

// Retry feilede SMS
app.post("/api/superadmin/sms-queue/retry-failed", (c) => {
  const result = db.prepare(`
    UPDATE sms_queue SET status = 'pending', attempts = 0, error_message = NULL
    WHERE status = 'failed'
  `).run();
  return c.json({ reset: result.changes });
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

// Opprett ny Vipps-forespørsel (med valgfri automatisk SMS-utsending)
app.post("/api/prover/:id/vipps-foresporsler", async (c) => {
  const proveId = c.req.param("id");
  const body = await c.req.json();
  const { opprettet_av, beskrivelse, belop, vipps_nummer, mottakere, send_sms } = body;

  if (!opprettet_av || !beskrivelse || !belop || !vipps_nummer || !mottakere?.length) {
    return c.json({ error: "Mangler påkrevde felt" }, 400);
  }

  // Hent klubbnavn fra prøven
  const prove = db.prepare(`
    SELECT p.navn as prove_navn, k.navn as klubb_navn
    FROM prover p
    LEFT JOIN klubber k ON p.klubb_id = k.id
    WHERE p.id = ?
  `).get(proveId);
  const klubbNavn = prove?.klubb_navn || 'Klubben';

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

  // Generer Vipps-lenke og SMS-melding
  const vippsLenke = `https://qr.vipps.no/28/2/01/031/${vipps_nummer}?v=1&s=${belop}`;
  const smsMelding = `Hei fra ${klubbNavn}! Vennligst betal ${belop} kr for "${beskrivelse}". Trykk her: ${vippsLenke}`;

  // Send SMS automatisk hvis send_sms=true
  let smsSendt = 0;
  let smsFeil = [];

  if (send_sms) {
    console.log(`[Vipps] Sender SMS til ${mottakere.length} mottakere for "${beskrivelse}"`);

    for (const m of mottakere) {
      if (!m.telefon) continue;

      try {
        // Formater telefonnummer
        let phone = m.telefon.replace(/\s/g, '');
        if (!phone.startsWith('+')) {
          phone = phone.startsWith('47') ? `+${phone}` : `+47${phone}`;
        }

        const smsResult = await sendSMS(phone, smsMelding, { type: 'vipps' });
        if (smsResult.success) {
          smsSendt++;
        } else {
          console.error(`[Vipps SMS] Feil til ${m.telefon}:`, smsResult.error);
          smsFeil.push({ telefon: m.telefon, feil: smsResult.error || 'Ukjent feil' });
        }
      } catch (err) {
        console.error(`[Vipps SMS] Exception til ${m.telefon}:`, err.message);
        smsFeil.push({ telefon: m.telefon, feil: err.message });
      }
    }

    console.log(`[Vipps] SMS-utsending fullført: ${smsSendt}/${mottakere.length} sendt${smsFeil.length > 0 ? `, ${smsFeil.length} feilet` : ''}`);
  }

  return c.json({
    id: foresporselId,
    beskrivelse,
    belop,
    antall_mottakere: mottakere.length,
    sms_sendt: smsSendt,
    sms_feil: smsFeil,
    vipps_lenke: vippsLenke,
    melding: smsMelding
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

// Slett én mottaker fra en Vipps-forespørsel
app.delete("/api/vipps-foresporsler/:id/mottakere/:telefon", (c) => {
  const foresporselId = c.req.param("id");
  const telefon = c.req.param("telefon");

  // Sjekk om det er flere mottakere igjen
  const count = db.prepare("SELECT COUNT(*) as count FROM vipps_mottakere WHERE foresporsel_id = ?").get(foresporselId);

  if (count.count <= 1) {
    // Hvis dette er siste mottaker, slett hele forespørselen
    db.prepare("DELETE FROM vipps_foresporsler WHERE id = ?").run(foresporselId);
  } else {
    // Slett bare denne mottakeren
    db.prepare("DELETE FROM vipps_mottakere WHERE foresporsel_id = ? AND deltaker_telefon = ?").run(foresporselId, telefon);
  }

  return c.json({ success: true });
});

// Slett en Vipps-forespørsel
app.delete("/api/vipps-foresporsler/:id", (c) => {
  const id = c.req.param("id");
  db.prepare("DELETE FROM vipps_foresporsler WHERE id = ?").run(id);
  return c.json({ success: true });
});

// Hent Vipps-betalingsstatistikk for økonomimodulen
app.get("/api/prover/:id/vipps-statistikk", (c) => {
  const proveId = c.req.param("id");

  // Hent alle Vipps-forespørsler for prøven med betalingsstatus
  const foresporsler = db.prepare(`
    SELECT
      vf.id,
      vf.beskrivelse,
      vf.belop,
      vf.created_at,
      COUNT(vm.id) as antall_mottakere,
      SUM(CASE WHEN vm.status = 'betalt' THEN 1 ELSE 0 END) as antall_betalt,
      SUM(CASE WHEN vm.status = 'betalt' THEN vf.belop ELSE 0 END) as sum_betalt,
      SUM(CASE WHEN vm.status = 'venter' THEN vf.belop ELSE 0 END) as sum_venter
    FROM vipps_foresporsler vf
    LEFT JOIN vipps_mottakere vm ON vf.id = vm.foresporsel_id
    WHERE vf.prove_id = ?
    GROUP BY vf.id
    ORDER BY vf.created_at DESC
  `).all(proveId);

  // Beregn totaler og grupper per kategori
  let totalBetalt = 0;
  let totalVenter = 0;
  let totalForventet = 0;

  // Grupper betalinger per kategori (basert på beskrivelse)
  const perKategori = {
    parkering: { betalt: 0, venter: 0, antall: 0 },
    loddsalg: { betalt: 0, venter: 0, antall: 0 },
    semifinale: { betalt: 0, venter: 0, antall: 0 },
    finale: { betalt: 0, venter: 0, antall: 0 },
    jegermiddag: { betalt: 0, venter: 0, antall: 0 },
    annet: { betalt: 0, venter: 0, antall: 0 }
  };

  foresporsler.forEach(f => {
    totalBetalt += f.sum_betalt || 0;
    totalVenter += f.sum_venter || 0;
    totalForventet += (f.antall_mottakere || 0) * f.belop;

    // Kategoriser basert på beskrivelse
    const beskrivelse = (f.beskrivelse || '').toLowerCase();
    let kategori = 'annet';

    if (beskrivelse.includes('parkering')) {
      kategori = 'parkering';
    } else if (beskrivelse.includes('lodd')) {
      kategori = 'loddsalg';
    } else if (beskrivelse.includes('semifinale')) {
      kategori = 'semifinale';
    } else if (beskrivelse.includes('finale') || beskrivelse.includes('vk-finale')) {
      kategori = 'finale';
    } else if (beskrivelse.includes('jegermiddag') || beskrivelse.includes('middag')) {
      kategori = 'jegermiddag';
    }

    perKategori[kategori].betalt += f.sum_betalt || 0;
    perKategori[kategori].venter += f.sum_venter || 0;
    perKategori[kategori].antall += f.antall_betalt || 0;
  });

  // Hent også betalte påmeldinger (startavgifter)
  const pameldinger = db.prepare(`
    SELECT
      klasse,
      COUNT(*) as antall,
      SUM(CASE WHEN betalt = 1 THEN 1 ELSE 0 END) as antall_betalt,
      SUM(CASE WHEN betalt = 1 THEN betalt_belop ELSE 0 END) as sum_betalt
    FROM pameldinger
    WHERE prove_id = ? AND status IN ('pameldt', 'bekreftet', 'betalt')
    GROUP BY klasse
  `).all(proveId);

  let startavgifterBetalt = 0;
  const startavgifterPerKlasse = {};
  pameldinger.forEach(p => {
    startavgifterBetalt += p.sum_betalt || 0;
    startavgifterPerKlasse[p.klasse] = {
      antall: p.antall,
      antallBetalt: p.antall_betalt,
      sumBetalt: p.sum_betalt || 0
    };
  });

  // Hent jegermiddag-betalinger
  const jegermiddag = db.prepare(`
    SELECT
      COUNT(*) as antall_pameldinger,
      SUM(antall_personer) as antall_personer,
      SUM(CASE WHEN betalt = 1 THEN belop ELSE 0 END) as sum_betalt,
      SUM(CASE WHEN betalt = 0 THEN belop ELSE 0 END) as sum_venter
    FROM jegermiddag_pameldinger
    WHERE prove_id = ? AND status != 'avmeldt'
  `).get(proveId);

  return c.json({
    vippsForesporsler: foresporsler,
    vippsTotaler: {
      betalt: totalBetalt,
      venter: totalVenter,
      forventet: totalForventet
    },
    perKategori: perKategori,
    startavgifter: {
      perKlasse: startavgifterPerKlasse,
      totalBetalt: startavgifterBetalt
    },
    jegermiddag: {
      antallPameldinger: jegermiddag?.antall_pameldinger || 0,
      antallPersoner: jegermiddag?.antall_personer || 0,
      sumBetalt: jegermiddag?.sum_betalt || 0,
      sumVenter: jegermiddag?.sum_venter || 0
    },
    totaltMottatt: totalBetalt + startavgifterBetalt + (jegermiddag?.sum_betalt || 0)
  });
});

// ============================================
// VIPPS ePAYMENT API INTEGRASJON
// ============================================

// Cache for Vipps access tokens per klubb (MSN)
const vippsTokenCache = new Map();

// Hent Vipps access token for en klubb
async function getVippsAccessToken(klubb) {
  const cacheKey = klubb.vipps_merchant_serial;
  const cached = vippsTokenCache.get(cacheKey);

  // Bruk cached token hvis den er gyldig (med 5 min margin)
  if (cached && cached.expiresAt > Date.now() + 300000) {
    return cached.token;
  }

  const baseUrl = process.env.VIPPS_ENV === 'production'
    ? 'https://api.vipps.no'
    : 'https://apitest.vipps.no';

  try {
    // Dekrypter Vipps-nøkler (støtter både krypterte og ukrypterte verdier)
    const clientId = decryptSensitive(klubb.vipps_client_id);
    const clientSecret = decryptSensitive(klubb.vipps_client_secret);
    const subscriptionKey = decryptSensitive(klubb.vipps_subscription_key);

    const response = await fetch(`${baseUrl}/accesstoken/get`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'client_id': clientId,
        'client_secret': clientSecret,
        'Ocp-Apim-Subscription-Key': subscriptionKey,
        'Merchant-Serial-Number': klubb.vipps_merchant_serial
      },
      body: ''
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('[Vipps] Token-feil:', err);
      throw new Error('Kunne ikke hente Vipps access token');
    }

    const data = await response.json();
    const expiresIn = parseInt(data.expires_in) || 3600;

    // Cache token
    vippsTokenCache.set(cacheKey, {
      token: data.access_token,
      expiresAt: Date.now() + (expiresIn * 1000)
    });

    return data.access_token;
  } catch (err) {
    console.error('[Vipps] Token-exception:', err.message);
    throw err;
  }
}

// Opprett Vipps ePayment betaling for én mottaker
async function createVippsPayment(klubb, mottaker, belop, beskrivelse, returnUrl) {
  const accessToken = await getVippsAccessToken(klubb);

  const baseUrl = process.env.VIPPS_ENV === 'production'
    ? 'https://api.vipps.no'
    : 'https://apitest.vipps.no';

  // Generer unik referanse
  const reference = `fp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  // Formater telefonnummer (Vipps krever format 47XXXXXXXX)
  let phoneNumber = mottaker.telefon.replace(/\s/g, '').replace(/^\+/, '');
  if (!phoneNumber.startsWith('47')) {
    phoneNumber = '47' + phoneNumber;
  }

  const payload = {
    amount: {
      currency: 'NOK',
      value: belop * 100  // Vipps bruker øre
    },
    paymentMethod: {
      type: 'WALLET'
    },
    customer: {
      phoneNumber: phoneNumber
    },
    reference: reference,
    returnUrl: returnUrl,
    userFlow: 'WEB_REDIRECT',
    paymentDescription: beskrivelse
  };

  try {
    const subscriptionKey = decryptSensitive(klubb.vipps_subscription_key);
    const response = await fetch(`${baseUrl}/epayment/v1/payments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
        'Ocp-Apim-Subscription-Key': subscriptionKey,
        'Merchant-Serial-Number': klubb.vipps_merchant_serial,
        'Idempotency-Key': reference,
        'Vipps-System-Name': 'Fuglehundprove',
        'Vipps-System-Version': '1.0.0'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const err = await response.json();
      console.error('[Vipps ePayment] Feil:', err);
      throw new Error(err.title || err.message || 'Vipps-feil');
    }

    const data = await response.json();
    return {
      success: true,
      reference: reference,
      redirectUrl: data.redirectUrl
    };
  } catch (err) {
    console.error('[Vipps ePayment] Exception:', err.message);
    return {
      success: false,
      error: err.message
    };
  }
}

// Sjekk betalingsstatus for en Vipps-betaling
async function checkVippsPaymentStatus(klubb, reference) {
  const accessToken = await getVippsAccessToken(klubb);

  const baseUrl = process.env.VIPPS_ENV === 'production'
    ? 'https://api.vipps.no'
    : 'https://apitest.vipps.no';

  try {
    const subscriptionKey = decryptSensitive(klubb.vipps_subscription_key);
    const response = await fetch(`${baseUrl}/epayment/v1/payments/${reference}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Ocp-Apim-Subscription-Key': subscriptionKey,
        'Merchant-Serial-Number': klubb.vipps_merchant_serial
      }
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.title || 'Kunne ikke hente status');
    }

    const data = await response.json();
    return {
      success: true,
      state: data.state,  // CREATED, AUTHORIZED, TERMINATED, EXPIRED, etc.
      aggregate: data.aggregate  // authorizedAmount, capturedAmount, etc.
    };
  } catch (err) {
    return {
      success: false,
      error: err.message
    };
  }
}

// API: Opprett Vipps ePayment forespørsel (Business API-modus)
app.post("/api/prover/:id/vipps-epayment", async (c) => {
  const proveId = c.req.param("id");
  const body = await c.req.json();
  const { opprettet_av, beskrivelse, belop, mottakere } = body;

  if (!opprettet_av || !beskrivelse || !belop || !mottakere?.length) {
    return c.json({ error: "Mangler påkrevde felt" }, 400);
  }

  // Hent prøve og klubb
  const prove = db.prepare(`
    SELECT p.*, k.*
    FROM prover p
    JOIN klubber k ON p.klubb_id = k.id
    WHERE p.id = ?
  `).get(proveId);

  if (!prove) {
    return c.json({ error: "Prøve ikke funnet" }, 404);
  }

  // Sjekk at klubben har API-konfigurasjon
  if (!prove.vipps_client_id || !prove.vipps_merchant_serial) {
    return c.json({ error: "Klubben har ikke konfigurert Vipps Business API" }, 400);
  }

  // Opprett forespørsel i database
  const result = db.prepare(`
    INSERT INTO vipps_foresporsler (prove_id, opprettet_av, beskrivelse, belop, vipps_nummer)
    VALUES (?, ?, ?, ?, ?)
  `).run(proveId, opprettet_av, beskrivelse, belop, prove.vipps_merchant_serial);

  const foresporselId = result.lastInsertRowid;

  // Return URL for Vipps (dit brukeren sendes etter betaling)
  const baseUrl = process.env.BASE_URL || 'https://fuglehundprove.no';
  const returnUrl = `${baseUrl}/vipps-callback.html?fid=${foresporselId}`;

  // Opprett betalinger for hver mottaker
  const insertMottaker = db.prepare(`
    INSERT INTO vipps_mottakere (foresporsel_id, deltaker_telefon, deltaker_navn, vipps_reference)
    VALUES (?, ?, ?, ?)
  `);

  let suksess = 0;
  let feil = [];

  for (const m of mottakere) {
    const paymentResult = await createVippsPayment(
      prove,  // Klubb-data
      m,
      belop,
      `${beskrivelse} - ${prove.klubb_navn || 'Fuglehundprøve'}`,
      returnUrl
    );

    if (paymentResult.success) {
      insertMottaker.run(foresporselId, m.telefon, m.navn, paymentResult.reference);
      suksess++;

      // Send SMS med Vipps-lenke
      if (m.telefon) {
        let phone = m.telefon.replace(/\s/g, '');
        if (!phone.startsWith('+')) {
          phone = phone.startsWith('47') ? `+${phone}` : `+47${phone}`;
        }
        const smsMsg = `Hei fra ${prove.klubb_navn || 'klubben'}! Betal ${belop} kr for "${beskrivelse}". Trykk her: ${paymentResult.redirectUrl}`;
        await sendSMS(phone, smsMsg, { type: 'vipps_epayment' });
      }
    } else {
      // Legg til mottaker uten referanse (mislykket)
      insertMottaker.run(foresporselId, m.telefon, m.navn, null);
      feil.push({ telefon: m.telefon, feil: paymentResult.error });
    }
  }

  console.log(`[Vipps ePayment] Opprettet ${suksess}/${mottakere.length} betalinger for "${beskrivelse}"`);

  return c.json({
    id: foresporselId,
    beskrivelse,
    belop,
    antall_mottakere: mottakere.length,
    suksess: suksess,
    feil: feil
  });
});

// API: Sjekk og oppdater betalingsstatus for alle ventende mottakere i en forespørsel
app.post("/api/vipps-foresporsler/:id/sjekk-status", async (c) => {
  const foresporselId = c.req.param("id");

  // Hent forespørsel med klubb-data
  const foresporsel = db.prepare(`
    SELECT vf.*, p.klubb_id, k.*
    FROM vipps_foresporsler vf
    JOIN prover p ON vf.prove_id = p.id
    JOIN klubber k ON p.klubb_id = k.id
    WHERE vf.id = ?
  `).get(foresporselId);

  if (!foresporsel) {
    return c.json({ error: "Forespørsel ikke funnet" }, 404);
  }

  if (!foresporsel.vipps_client_id) {
    return c.json({ error: "Klubben bruker ikke Business API" }, 400);
  }

  // Hent ventende mottakere med vipps_reference
  const ventende = db.prepare(`
    SELECT * FROM vipps_mottakere
    WHERE foresporsel_id = ? AND status = 'venter' AND vipps_reference IS NOT NULL
  `).all(foresporselId);

  let oppdatert = 0;

  for (const m of ventende) {
    const status = await checkVippsPaymentStatus(foresporsel, m.vipps_reference);

    if (status.success) {
      // AUTHORIZED eller CAPTURED betyr betalt
      if (status.state === 'AUTHORIZED' || status.state === 'CAPTURED') {
        db.prepare(`
          UPDATE vipps_mottakere
          SET status = 'betalt', betalt_dato = datetime('now'), notert_av = 'vipps_api'
          WHERE id = ?
        `).run(m.id);
        oppdatert++;
      } else if (status.state === 'TERMINATED' || status.state === 'EXPIRED') {
        db.prepare(`
          UPDATE vipps_mottakere SET status = 'kansellert' WHERE id = ?
        `).run(m.id);
      }
    }
  }

  return c.json({
    sjekket: ventende.length,
    oppdatert: oppdatert
  });
});

// Offentlig endepunkt for callback-siden å sjekke betalingsstatus
// Returnerer kun status, ingen sensitiv info
app.get("/api/vipps/foresporsel/:id/status", async (c) => {
  const foresporselId = c.req.param("id");

  // Hent mottaker-info for denne forespørselen
  const mottaker = db.prepare(`
    SELECT vm.status, vm.betalt_dato, vf.belop
    FROM vipps_mottakere vm
    JOIN vipps_foresporsler vf ON vm.foresporsel_id = vf.id
    WHERE vm.vipps_reference = ? OR vf.id = ?
    LIMIT 1
  `).get(foresporselId, foresporselId);

  if (!mottaker) {
    // Prøv å finne direkte i forespørsler-tabellen
    const foresporsel = db.prepare(`
      SELECT belop FROM vipps_foresporsler WHERE id = ?
    `).get(foresporselId);

    if (!foresporsel) {
      return c.json({ error: "Forespørsel ikke funnet", status: "ukjent" }, 404);
    }

    // Returner pending hvis vi ikke har mottaker-status ennå
    return c.json({ status: "venter", belop: foresporsel.belop });
  }

  // Map intern status til brukervenlig status
  let statusText = mottaker.status;
  if (mottaker.status === 'betalt') {
    statusText = 'PAID';
  } else if (mottaker.status === 'venter') {
    statusText = 'PENDING';
  } else if (mottaker.status === 'kansellert' || mottaker.status === 'avbrutt') {
    statusText = 'CANCELLED';
  }

  return c.json({
    status: statusText,
    belop: mottaker.belop || null,
    betaltDato: mottaker.betalt_dato || null
  });
});

// Webhook-endepunkt for Vipps (mottar statusoppdateringer automatisk)
app.post("/api/vipps/webhook", async (c) => {
  const body = await c.req.json();

  console.log('[Vipps Webhook] Mottatt:', JSON.stringify(body).substring(0, 500));

  // Vipps sender reference i webhook-payload
  const reference = body.reference;
  const state = body.state || body.pspReference;

  if (!reference) {
    return c.json({ received: true });
  }

  // Finn mottaker med denne referansen
  const mottaker = db.prepare(`
    SELECT * FROM vipps_mottakere WHERE vipps_reference = ?
  `).get(reference);

  if (mottaker && mottaker.status === 'venter') {
    if (state === 'AUTHORIZED' || state === 'CAPTURED' || state === 'SALE') {
      db.prepare(`
        UPDATE vipps_mottakere
        SET status = 'betalt', betalt_dato = datetime('now'), notert_av = 'vipps_webhook'
        WHERE id = ?
      `).run(mottaker.id);
      console.log(`[Vipps Webhook] Oppdatert mottaker ${mottaker.id} til betalt`);
    }
  }

  return c.json({ received: true });
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
           dt.begrunnelse_type, dt.begrunnelse,
           b.fornavn, b.etternavn, b.telefon
    FROM dommer_tildelinger dt
    JOIN brukere b ON dt.dommer_telefon = b.telefon
    WHERE dt.prove_id = ?
    ORDER BY dt.parti, dt.dommer_rolle
  `).all(proveId);
  return c.json(tildelinger);
});

// Hjelpefunksjon: bestem om en bruker har admin-rolle (for å kunne være
// live_admin på et VK-parti). Aksepterer admin/proveleder/klubbleder/
// sekretær/superadmin — samme settet som requireAdmin selv tillater.
function harAdminRolle(telefon) {
  if (!telefon) return false;
  const bruker = db.prepare("SELECT rolle FROM brukere WHERE telefon = ?").get(telefon);
  if (!bruker?.rolle) return false;
  const roller = String(bruker.rolle).split(/[,\s]+/).map(r => r.trim().toLowerCase()).filter(Boolean);
  const adminRoller = new Set(['admin', 'superadmin', 'klubbleder', 'proveleder', 'sekretær', 'sekretar']);
  return roller.some(r => adminRoller.has(r));
}

// Hjelpefunksjon: er prøven satt til manuell bedømming?
// Source of truth er praktiskInfo.bedommingUtenforSystemet (settes ved
// prøveopprettelse i admin.html "prøvedetaljer"). prove_config.manuell_-
// bedomming er en speilet kopi for raskere oppslag i rene endepunkter.
function erManuellBedomming(proveId) {
  // 1) praktiskInfo (kanonisk kilde) — settes ved prøveopprettelse
  try {
    const row = db.prepare("SELECT value FROM kv_store WHERE key = ?").get(`praktiskInfo_${proveId}`);
    if (row?.value) {
      const pi = JSON.parse(row.value);
      if (typeof pi.bedommingUtenforSystemet === 'boolean') {
        return pi.bedommingUtenforSystemet === true;
      }
    }
  } catch (e) { /* fall gjennom til prove_config */ }

  // 2) prove_config (fallback / mirror)
  const config = db.prepare("SELECT manuell_bedomming FROM prove_config WHERE prove_id = ?").get(proveId);
  return config?.manuell_bedomming === 1;
}

// Hjelpefunksjon: validerer at live_admin-rolle er gyldig for et parti.
// Returnerer { ok: true } eller { ok: false, error: '...' }.
function validerLiveAdminRolle(proveId, parti) {
  // Må være VK-parti
  const partiRad = db.prepare("SELECT type FROM partier WHERE prove_id = ? AND navn = ?").get(proveId, parti);
  if (!partiRad) return { ok: false, error: `Parti "${parti}" finnes ikke på prøven` };
  if (partiRad.type !== 'vk') {
    return { ok: false, error: "live_admin kan kun tildeles VK-partier" };
  }
  // Prøven må være satt til manuell bedømming (source: praktiskInfo)
  if (!erManuellBedomming(proveId)) {
    return { ok: false, error: "Manuell bedømming må være på for prøven før du kan tildele administrator" };
  }
  return { ok: true };
}

// Tildel dommer til parti
app.post("/api/prover/:id/dommer-tildelinger", requireAdmin, async (c) => {
  const proveId = c.req.param("id");
  const body = await c.req.json();
  const { parti, dommer_telefon, dommer_rolle, begrunnelse_type, begrunnelse } = body;

  if (!parti || !dommer_telefon) {
    return c.json({ error: "Parti og dommer_telefon er påkrevd" }, 400);
  }

  const prove = db.prepare("SELECT id FROM prover WHERE id = ?").get(proveId);
  if (!prove) return c.json({ error: "Prøve ikke funnet" }, 404);

  const erLiveAdmin = dommer_rolle === 'live_admin';

  // live_admin har egne valideringsregler (VK + manuell + admin-rolle).
  // Hopper over FKF-sjekk og 2-dommer-grensen for live_admin.
  if (erLiveAdmin) {
    const v = validerLiveAdminRolle(proveId, parti);
    if (!v.ok) return c.json({ error: v.error }, 400);

    if (!harAdminRolle(dommer_telefon)) {
      return c.json({
        error: "Personen må ha admin-rolle på prøven for å kunne være live-administrator (admin, proveleder, klubbleder, sekretær eller superadmin)"
      }, 400);
    }
  } else {
    const partiType = parti.toLowerCase().startsWith('vk') ? 'VK' : 'UKAK';
    // Tell kun ekte dommere (ikke live_admin) mot 2-grensen
    const eksisterende = db.prepare(`
      SELECT COUNT(*) as antall FROM dommer_tildelinger
      WHERE prove_id = ? AND parti = ? AND dommer_telefon != ?
        AND (dommer_rolle IS NULL OR dommer_rolle != 'live_admin')
    `).get(proveId, parti, dommer_telefon);

    if (partiType === 'VK' && eksisterende.antall >= 2) {
      return c.json({ error: "VK-partier kan maksimalt ha 2 dommere" }, 400);
    }
    if (partiType === 'UKAK' && eksisterende.antall >= 2) {
      return c.json({ error: "UK/AK-partier kan maksimalt ha 2 dommere" }, 400);
    }

    // Krav om begrunnelse for dommere som ikke står på FKF-lista
    const erFkf = erFkfKoblet(dommer_telefon);
    if (!erFkf && (!begrunnelse_type || !begrunnelse)) {
      return c.json({
        error: "Denne personen står ikke på FKF sin liste over godkjente dommere i systemet. Legg ved begrunnelse_type og begrunnelse for å kunne tildele.",
        krever_begrunnelse: true
      }, 400);
    }
  }

  try {
    const erFkf = erLiveAdmin ? false : erFkfKoblet(dommer_telefon);
    db.prepare(`
      INSERT INTO dommer_tildelinger (prove_id, dommer_telefon, parti, dommer_rolle, begrunnelse_type, begrunnelse)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(prove_id, parti, dommer_telefon) DO UPDATE SET
        dommer_rolle = excluded.dommer_rolle,
        begrunnelse_type = excluded.begrunnelse_type,
        begrunnelse = excluded.begrunnelse
    `).run(proveId, dommer_telefon, parti, dommer_rolle || null,
           (erLiveAdmin || erFkf) ? null : begrunnelse_type,
           (erLiveAdmin || erFkf) ? null : begrunnelse);

    db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").run(
      erLiveAdmin ? "live_admin_tildelt" : "dommer_tildelt",
      `${erLiveAdmin ? 'Live-admin' : 'Dommer'} ${dommer_telefon} tildelt ${parti} på prøve ${proveId}` + (!erLiveAdmin && !erFkf ? ` [manuell: ${begrunnelse_type}]` : '')
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

// Sjekk om en telefon er koblet til en FKF-godkjent dommer
function erFkfKoblet(telefon) {
  if (!telefon) return false;
  const rad = db.prepare(`
    SELECT 1 FROM fkf_godkjente_dommere
    WHERE aktiv = 1 AND (
      linked_bruker_telefon = ?
      OR telefon1_normalized = ?
      OR telefon2_normalized = ?
    )
    LIMIT 1
  `).get(telefon, telefon, telefon);
  return !!rad;
}

// Opprett bruker-rad manuelt for dommer/dommerelev som ikke står på FKF-lista.
// Brukes når prøveledelsen må tildele noen som ikke er oppdatert i FKF-listen
// (f.eks. nylig godkjent dommer, dommerelev, eller spesialtilfelle).
app.post("/api/dommere/opprett-manuelt", requireAdmin, async (c) => {
  const body = await c.req.json();
  const { telefon, fornavn, etternavn } = body;
  if (!telefon || !fornavn || !etternavn) {
    return c.json({ error: "telefon, fornavn og etternavn er påkrevd" }, 400);
  }
  // Normaliser telefon: fjern mellomrom, behold + eller ikke
  const telefonNormalisert = String(telefon).replace(/\s/g, '');

  try {
    const eksisterende = db.prepare("SELECT telefon, rolle FROM brukere WHERE telefon = ?").get(telefonNormalisert);
    if (eksisterende) {
      // Bruker finnes — utvid rolle med 'dommer' hvis ikke allerede satt
      const roller = (eksisterende.rolle || '').split(',').map(r => r.trim()).filter(Boolean);
      if (!roller.includes('dommer')) {
        roller.push('dommer');
        db.prepare("UPDATE brukere SET rolle = ? WHERE telefon = ?").run(roller.join(','), telefonNormalisert);
      }
      return c.json({ success: true, telefon: telefonNormalisert, opprettet: false });
    }

    db.prepare(`
      INSERT INTO brukere (telefon, fornavn, etternavn, rolle, verifisert)
      VALUES (?, ?, ?, 'dommer', 0)
    `).run(telefonNormalisert, fornavn, etternavn);

    db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").run(
      "dommer_opprettet_manuelt",
      `Manuell opprettelse: ${fornavn} ${etternavn} (${telefonNormalisert})`
    );

    return c.json({ success: true, telefon: telefonNormalisert, opprettet: true });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// Bulk-oppdater dommere for et parti (tillater tom array for å fjerne alle)
app.put("/api/prover/:id/dommer-tildelinger/parti/:parti", requireAdmin, async (c) => {
  const proveId = c.req.param("id");
  const parti = c.req.param("parti");
  const body = await c.req.json();
  const { dommere } = body;

  if (!Array.isArray(dommere)) return c.json({ error: "dommere må være en array" }, 400);

  // Splitt i ekte dommere vs live_admin — har ulike valideringsregler
  const liveAdminer = dommere.filter(d => d.rolle === 'live_admin');
  const ekteDommere = dommere.filter(d => d.rolle !== 'live_admin');

  // Valider live_admin: VK-parti, manuell bedømming på, admin-rolle
  if (liveAdminer.length > 0) {
    const v = validerLiveAdminRolle(proveId, parti);
    if (!v.ok) return c.json({ error: v.error }, 400);
    for (const d of liveAdminer) {
      if (!d.telefon) return c.json({ error: "Hver tildeling må ha telefon" }, 400);
      if (!harAdminRolle(d.telefon)) {
        return c.json({
          error: `${d.telefon} har ikke admin-rolle og kan ikke være live-administrator`,
          telefon: d.telefon
        }, 400);
      }
    }
  }

  // Valider ekte dommere: 2-grensen, FKF-sjekk
  if (ekteDommere.length > 0) {
    const partiType = parti.toLowerCase().startsWith('vk') ? 'VK' : 'UKAK';
    if (partiType === 'VK' && ekteDommere.length > 2) return c.json({ error: "VK-partier kan maksimalt ha 2 dommere" }, 400);
    if (partiType === 'UKAK' && ekteDommere.length > 2) return c.json({ error: "UK/AK-partier kan maksimalt ha 2 dommere" }, 400);

    for (const d of ekteDommere) {
      if (!d.telefon) return c.json({ error: "Hver dommer må ha telefon" }, 400);
      if (!erFkfKoblet(d.telefon)) {
        if (!d.begrunnelse_type || !d.begrunnelse) {
          return c.json({
            error: `Dommer ${d.telefon} står ikke på FKF sin liste over godkjente dommere. Legg ved begrunnelse_type (f.eks. 'dommerelev') og begrunnelse.`,
            krever_begrunnelse: true,
            telefon: d.telefon
          }, 400);
        }
      }
    }
  }

  try {
    db.prepare("DELETE FROM dommer_tildelinger WHERE prove_id = ? AND parti = ?").run(proveId, parti);
    if (dommere.length > 0) {
      const insert = db.prepare(`
        INSERT INTO dommer_tildelinger (prove_id, dommer_telefon, parti, dommer_rolle, begrunnelse_type, begrunnelse)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const d of dommere) {
        const erLA = d.rolle === 'live_admin';
        const fkf = erLA ? false : erFkfKoblet(d.telefon);
        insert.run(proveId, d.telefon, parti, d.rolle || null,
                   (erLA || fkf) ? null : (d.begrunnelse_type || null),
                   (erLA || fkf) ? null : (d.begrunnelse || null));
      }
    }
    db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").run(
      "dommer_parti_oppdatert",
      `${parti}: ${dommere.length > 0 ? dommere.map(d => (d.rolle === 'live_admin' ? '[live] ' : '') + d.telefon + (d.rolle === 'live_admin' ? '' : (erFkfKoblet(d.telefon) ? '' : ' [manuell:' + (d.begrunnelse_type || '?') + ']'))).join(', ') : '(fjernet alle)'}`
    );
    return c.json({ success: true });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// Hent alle tildelinger for en dommer (basert på telefon)
app.get("/api/dommer/:telefon/tildelinger", (c) => {
  const telefon = c.req.param("telefon");
  const normalized = normalizePhone(telefon);

  if (!normalized) {
    return c.json({ error: "Ugyldig telefonnummer" }, 400);
  }

  const tildelinger = db.prepare(`
    SELECT dt.id, dt.parti, dt.dommer_rolle, dt.prove_id,
           p.navn as prove_navn, p.start_dato, p.slutt_dato, p.sted,
           k.navn as klubb_navn
    FROM dommer_tildelinger dt
    JOIN prover p ON dt.prove_id = p.id
    LEFT JOIN klubber k ON p.klubb_id = k.id
    WHERE dt.dommer_telefon = ?
    ORDER BY p.start_dato DESC
  `).all(normalized);

  return c.json(tildelinger);
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
// DOMMERFORESPØRSEL API
// ============================================

// Hent alle forespørsler for en prøve
app.get("/api/prover/:id/dommer-foresporsler", (c) => {
  const proveId = c.req.param("id");
  const foresporsler = db.prepare(`
    SELECT df.*, b.fornavn || ' ' || b.etternavn as sendt_av_navn
    FROM dommer_foresporsler df
    LEFT JOIN brukere b ON df.sendt_av = b.telefon
    WHERE df.prove_id = ?
    ORDER BY df.sendt_dato DESC
  `).all(proveId);
  return c.json(foresporsler);
});

// Hent forespørsler sendt til en dommer (for dommeren selv)
app.get("/api/dommer-foresporsler/mine", requireAuth, (c) => {
  const telefon = c.get("user")?.telefon;
  if (!telefon) return c.json({ error: "Ikke autentisert" }, 401);

  const foresporsler = db.prepare(`
    SELECT df.*, p.navn as prove_navn, p.start_dato, p.slutt_dato, p.sted as prove_sted,
           k.navn as klubb_navn, b.fornavn || ' ' || b.etternavn as sendt_av_navn
    FROM dommer_foresporsler df
    JOIN prover p ON df.prove_id = p.id
    LEFT JOIN klubber k ON p.klubb_id = k.id
    LEFT JOIN brukere b ON df.sendt_av = b.telefon
    WHERE df.dommer_telefon = ?
    ORDER BY df.sendt_dato DESC
  `).all(telefon);
  return c.json(foresporsler);
});

// Send ny dommerforespørsel
app.post("/api/prover/:id/dommer-foresporsler", requireAuth, async (c) => {
  const proveId = c.req.param("id");
  const body = await c.req.json();
  const user = c.get("user");
  const { dommer_telefon, dommer_navn, dommer_epost, parti, melding, reise_bil, reise_fly, reise_leiebil, reise_annet } = body;

  if (!dommer_telefon || !dommer_navn) {
    return c.json({ error: "Dommer telefon og navn er påkrevd" }, 400);
  }

  const prove = db.prepare("SELECT * FROM prover WHERE id = ?").get(proveId);
  if (!prove) return c.json({ error: "Prøve ikke funnet" }, 404);

  try {
    const result = db.prepare(`
      INSERT INTO dommer_foresporsler
        (prove_id, dommer_telefon, dommer_navn, dommer_epost, parti, melding,
         reise_bil, reise_fly, reise_leiebil, reise_annet, sendt_av)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      proveId, dommer_telefon, dommer_navn, dommer_epost || '', parti || '',
      melding || '', reise_bil ? 1 : 0, reise_fly ? 1 : 0, reise_leiebil ? 1 : 0,
      reise_annet || '', user.telefon
    );

    db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").run(
      "dommer_forespurt", `Forespørsel sendt til ${dommer_navn} (${dommer_telefon}) for prøve ${prove.navn}`
    );

    // Sjekk om bedømming er utenfor systemet (manuell bedømming med penn og papir)
    let bedommingUtenforSystemet = false;
    try {
      const praktiskInfoRow = db.prepare("SELECT value FROM kv_store WHERE key = ?").get(`praktiskInfo_${proveId}`);
      if (praktiskInfoRow && praktiskInfoRow.value) {
        const praktiskInfo = JSON.parse(praktiskInfoRow.value);
        bedommingUtenforSystemet = praktiskInfo.bedommingUtenforSystemet === true;
      }
    } catch (e) {
      console.warn("Kunne ikke sjekke bedømmingsmetode:", e.message);
    }

    // Send SMS til dommer hvis konfigurert OG bedømming er i systemet
    if (smsProvider !== 'dev' && !bedommingUtenforSystemet) {
      const smsText = `Hei ${dommer_navn.split(' ')[0]}! Du er forespurt som dommer på ${prove.navn} (${prove.start_dato}). Logg inn på fuglehundprove.no for å svare. Mvh ${user.fornavn || 'Prøveleder'}`;
      try {
        await sendSms(dommer_telefon, smsText);
        db.prepare("INSERT INTO sms_log (retning, fra, til, type, melding) VALUES (?, ?, ?, ?, ?)").run(
          'ut', 'system', dommer_telefon, 'dommer_forespørsel', smsText
        );
      } catch (smsErr) {
        console.error("SMS-feil:", smsErr.message);
      }
    } else if (bedommingUtenforSystemet) {
      console.log(`[SMS SKIP] Bedømming utenfor systemet - ingen SMS til dommer ${dommer_telefon} for prøve ${proveId}`);
    }

    return c.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    if (err.message.includes('UNIQUE constraint')) {
      return c.json({ error: "Denne dommeren har allerede fått forespørsel til denne prøven" }, 400);
    }
    return c.json({ error: err.message }, 500);
  }
});

// Svar på dommerforespørsel (aksepter/avslå)
app.put("/api/dommer-foresporsler/:id/svar", requireAuth, async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  const user = c.get("user");
  const { status, svar_melding } = body;

  if (!['akseptert', 'avslatt'].includes(status)) {
    return c.json({ error: "Ugyldig status. Må være 'akseptert' eller 'avslatt'" }, 400);
  }

  const foresporsel = db.prepare("SELECT * FROM dommer_foresporsler WHERE id = ?").get(id);
  if (!foresporsel) return c.json({ error: "Forespørsel ikke funnet" }, 404);

  // Sjekk at brukeren er den forespurte dommeren
  if (foresporsel.dommer_telefon !== user.telefon) {
    return c.json({ error: "Du kan kun svare på forespørsler sendt til deg" }, 403);
  }

  db.prepare(`
    UPDATE dommer_foresporsler
    SET status = ?, svar_melding = ?, svar_dato = datetime('now')
    WHERE id = ?
  `).run(status, svar_melding || '', id);

  // Hvis akseptert, legg til dommer-tildeling
  if (status === 'akseptert' && foresporsel.parti) {
    try {
      db.prepare(`
        INSERT OR IGNORE INTO dommer_tildelinger (prove_id, dommer_telefon, parti)
        VALUES (?, ?, ?)
      `).run(foresporsel.prove_id, foresporsel.dommer_telefon, foresporsel.parti);
    } catch (e) {
      console.log("Dommer allerede tildelt:", e.message);
    }
  }

  db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").run(
    `dommer_${status}`, `${foresporsel.dommer_navn} ${status} forespørsel for prøve ${foresporsel.prove_id}`
  );

  // Send varsel-SMS til prøveleder
  if (smsProvider !== 'dev') {
    const prove = db.prepare("SELECT navn FROM prover WHERE id = ?").get(foresporsel.prove_id);
    const statusTekst = status === 'akseptert' ? 'akseptert' : 'avslått';
    const smsText = `${foresporsel.dommer_navn} har ${statusTekst} dommerforespørselen til ${prove?.navn || foresporsel.prove_id}.`;
    try {
      await sendSms(foresporsel.sendt_av, smsText);
    } catch (smsErr) {
      console.error("SMS-feil:", smsErr.message);
    }
  }

  return c.json({ success: true });
});

// Marker forespørsel som sett
app.put("/api/dommer-foresporsler/:id/sett", requireAuth, (c) => {
  const id = c.req.param("id");
  const user = c.get("user");

  const foresporsel = db.prepare("SELECT * FROM dommer_foresporsler WHERE id = ?").get(id);
  if (!foresporsel) return c.json({ error: "Forespørsel ikke funnet" }, 404);

  if (foresporsel.dommer_telefon !== user.telefon) {
    return c.json({ error: "Ikke tilgang" }, 403);
  }

  if (foresporsel.status === 'sendt') {
    db.prepare("UPDATE dommer_foresporsler SET status = 'sett', sett_dato = datetime('now') WHERE id = ?").run(id);
  }

  return c.json({ success: true });
});

// Kanseller forespørsel (prøveleder)
app.delete("/api/prover/:proveId/dommer-foresporsler/:id", requireAuth, (c) => {
  const proveId = c.req.param("proveId");
  const id = c.req.param("id");

  const result = db.prepare("UPDATE dommer_foresporsler SET status = 'kansellert' WHERE id = ? AND prove_id = ?").run(id, proveId);
  if (result.changes === 0) return c.json({ error: "Forespørsel ikke funnet" }, 404);

  return c.json({ success: true });
});

// ============================================
// DOMMEROPPGJØR API
// ============================================

// Hent alle oppgjør for en prøve
app.get("/api/prover/:id/dommer-oppgjor", (c) => {
  const proveId = c.req.param("id");
  const oppgjor = db.prepare(`
    SELECT * FROM dommer_oppgjor WHERE prove_id = ? ORDER BY dommer_navn
  `).all(proveId);
  return c.json(oppgjor);
});

// Hent mine oppgjør (for dommer)
app.get("/api/dommer-oppgjor/mine", requireAuth, (c) => {
  const telefon = c.get("user")?.telefon;
  if (!telefon) return c.json({ error: "Ikke autentisert" }, 401);

  const oppgjor = db.prepare(`
    SELECT do.*, p.navn as prove_navn, p.start_dato, p.slutt_dato, k.navn as klubb_navn
    FROM dommer_oppgjor do
    JOIN prover p ON do.prove_id = p.id
    LEFT JOIN klubber k ON p.klubb_id = k.id
    WHERE do.dommer_telefon = ?
    ORDER BY do.created_at DESC
  `).all(telefon);
  return c.json(oppgjor);
});

// Opprett eller oppdater oppgjør
app.post("/api/prover/:id/dommer-oppgjor", requireAuth, async (c) => {
  const proveId = c.req.param("id");
  const body = await c.req.json();
  const user = c.get("user");

  const {
    dommer_telefon, dommer_navn,
    // Reisevarighet
    reise_fra, reise_til, reisedekning,
    // Kjøregodtgjørelse
    reise_km, reise_km_sats, reise_passasjerer,
    // Dynamiske lister (lagret som JSON)
    bompenger, parkeringer, kollektivreiser, fradrag,
    // Diett (nye satser)
    diett3_6_antall, diett6_12_antall, diett_over12_antall, bor_utenfor_hk_antall,
    // Dommergodtgjørelse
    dommer_dager,
    // Signatur
    signatur_dato, signatur_sted, signatur,
    kontonummer, kommentar, status
  } = body;

  if (!dommer_telefon || !dommer_navn) {
    return c.json({ error: "Dommer telefon og navn er påkrevd" }, 400);
  }

  // Satser
  const SATSER = {
    km: 3.50,
    passasjer: 1.00,
    diett3_6: 150,
    diett6_12: 200,
    diettOver12: 400,
    borUtenforHK: 500,
    dommer: 500
  };

  // Beregn beløp
  const km = reise_km || 0;
  const passasjerer = reise_passasjerer || 0;
  const kmBelop = (km * SATSER.km) + (km * passasjerer * SATSER.passasjer);

  // Parse JSON-lister
  const bompengerListe = typeof bompenger === 'string' ? JSON.parse(bompenger || '[]') : (bompenger || []);
  const parkeringerListe = typeof parkeringer === 'string' ? JSON.parse(parkeringer || '[]') : (parkeringer || []);
  const kollektivListe = typeof kollektivreiser === 'string' ? JSON.parse(kollektivreiser || '[]') : (kollektivreiser || []);
  const fradragListe = typeof fradrag === 'string' ? JSON.parse(fradrag || '[]') : (fradrag || []);

  const bomSum = bompengerListe.reduce((sum, b) => sum + (parseFloat(b.belop) || 0), 0);
  const parkSum = parkeringerListe.reduce((sum, p) => sum + (parseFloat(p.belop) || 0), 0);
  const kollektivSum = kollektivListe.reduce((sum, k) => sum + (parseFloat(k.belop) || 0), 0);
  const fradragSum = fradragListe.reduce((sum, f) => sum + (parseFloat(f.belop) || 0), 0);

  // Diett
  const diett3_6 = (diett3_6_antall || 0) * SATSER.diett3_6;
  const diett6_12 = (diett6_12_antall || 0) * SATSER.diett6_12;
  const diettOver12 = (diett_over12_antall || 0) * SATSER.diettOver12;
  const borUtenforHK = (bor_utenfor_hk_antall || 0) * SATSER.borUtenforHK;
  const diettSum = diett3_6 + diett6_12 + diettOver12 + borUtenforHK;

  // Dommergodtgjørelse
  const dommerBelop = (dommer_dager || 0) * SATSER.dommer;

  // Total
  const total_belop = kmBelop + bomSum + parkSum + kollektivSum + diettSum + dommerBelop - fradragSum;

  try {
    const result = db.prepare(`
      INSERT INTO dommer_oppgjor
        (prove_id, dommer_telefon, dommer_navn,
         reise_fra, reise_til, reisedekning,
         reise_km, reise_km_sats, reise_passasjerer,
         bompenger, parkeringer, kollektivreiser,
         diett3_6_antall, diett6_12_antall, diett_over12_antall, bor_utenfor_hk_antall,
         dommer_dager, fradrag,
         signatur_dato, signatur_sted, signatur,
         kontonummer, kommentar, total_belop, status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(prove_id, dommer_telefon) DO UPDATE SET
        dommer_navn = excluded.dommer_navn,
        reise_fra = excluded.reise_fra, reise_til = excluded.reise_til, reisedekning = excluded.reisedekning,
        reise_km = excluded.reise_km, reise_km_sats = excluded.reise_km_sats, reise_passasjerer = excluded.reise_passasjerer,
        bompenger = excluded.bompenger, parkeringer = excluded.parkeringer, kollektivreiser = excluded.kollektivreiser,
        diett3_6_antall = excluded.diett3_6_antall, diett6_12_antall = excluded.diett6_12_antall,
        diett_over12_antall = excluded.diett_over12_antall, bor_utenfor_hk_antall = excluded.bor_utenfor_hk_antall,
        dommer_dager = excluded.dommer_dager, fradrag = excluded.fradrag,
        signatur_dato = excluded.signatur_dato, signatur_sted = excluded.signatur_sted, signatur = excluded.signatur,
        kontonummer = excluded.kontonummer, kommentar = excluded.kommentar,
        total_belop = excluded.total_belop, status = excluded.status, updated_at = datetime('now')
    `).run(
      proveId, dommer_telefon, dommer_navn,
      reise_fra || null, reise_til || null, reisedekning || 'tur_retur',
      km, SATSER.km, passasjerer,
      JSON.stringify(bompengerListe), JSON.stringify(parkeringerListe), JSON.stringify(kollektivListe),
      diett3_6_antall || 0, diett6_12_antall || 0, diett_over12_antall || 0, bor_utenfor_hk_antall || 0,
      dommer_dager || 0, JSON.stringify(fradragListe),
      signatur_dato || null, signatur_sted || '', signatur || '',
      kontonummer || '', kommentar || '', total_belop, status || 'utkast'
    );

    return c.json({ success: true, id: result.lastInsertRowid, total_belop });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// Oppdater oppgjør-status
app.put("/api/dommer-oppgjor/:id/status", requireAuth, async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  const user = c.get("user");
  const { status, betalt_dato } = body;

  if (!['utkast', 'innsendt', 'godkjent', 'utbetalt', 'avvist'].includes(status)) {
    return c.json({ error: "Ugyldig status" }, 400);
  }

  const oppgjor = db.prepare("SELECT * FROM dommer_oppgjor WHERE id = ?").get(id);
  if (!oppgjor) return c.json({ error: "Oppgjør ikke funnet" }, 404);

  const updates = { status };
  if (status === 'utbetalt') {
    updates.betalt = 1;
    updates.betalt_dato = betalt_dato || new Date().toISOString().split('T')[0];
    updates.betalt_av = user.telefon;
  }

  db.prepare(`
    UPDATE dommer_oppgjor
    SET status = ?, betalt = COALESCE(?, betalt), betalt_dato = COALESCE(?, betalt_dato), betalt_av = COALESCE(?, betalt_av), updated_at = datetime('now')
    WHERE id = ?
  `).run(status, updates.betalt, updates.betalt_dato, updates.betalt_av, id);

  db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").run(
    "dommer_oppgjor_status", `Oppgjør ${id} for ${oppgjor.dommer_navn}: ${status}`
  );

  return c.json({ success: true });
});

// Slett oppgjør
app.delete("/api/dommer-oppgjor/:id", requireAuth, (c) => {
  const id = c.req.param("id");
  const result = db.prepare("DELETE FROM dommer_oppgjor WHERE id = ?").run(id);
  if (result.changes === 0) return c.json({ error: "Oppgjør ikke funnet" }, 404);
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
           nr.fornavn || ' ' || nr.etternavn as nkkrep_navn,
           nv.fornavn || ' ' || nv.etternavn as nkkvara_navn,
           COALESCE(p.dvk_navn, dv.fornavn || ' ' || dv.etternavn) as dvk_navn_display
    FROM prover p
    LEFT JOIN klubber k ON p.klubb_id = k.id
    LEFT JOIN brukere pl ON p.proveleder_telefon = pl.telefon
    LEFT JOIN brukere nr ON p.nkkrep_telefon = nr.telefon
    LEFT JOIN brukere nv ON p.nkkvara_telefon = nv.telefon
    LEFT JOIN brukere dv ON p.dvk_telefon = dv.telefon
    ORDER BY p.start_dato DESC
  `).all();
  return c.json(rows);
});

// Alle prøver (for superadmin) - MÅ komme FØR /api/prover/:id
app.get("/api/prover/alle", (c) => {
  try {
    const prover = db.prepare(`
      SELECT p.*, k.navn as klubb_navn,
             (SELECT COUNT(*) FROM pameldinger WHERE prove_id = p.id) as antall_pameldte
      FROM prover p
      LEFT JOIN klubber k ON p.klubb_id = k.id
      ORDER BY p.start_dato DESC
    `).all();
    return c.json({ prover });
  } catch (err) {
    console.error("Feil ved henting av prøver:", err);
    return c.json({ prover: [], error: err.message });
  }
});

// Hent KUN prøver for innlogget brukers klubber (for admin.html terminliste)
// Støtter ?klubbId=X for å filtrere på spesifikk klubb (med tilgangskontroll)
// Superadmin ser alle prøver hvis ikke klubbId er spesifisert
app.get("/api/prover/mine", requireAuth, (c) => {
  const bruker = c.get("bruker");
  const erSuperadmin = hasRole(bruker.rolle, "superadmin");
  const filterKlubbId = c.req.query("klubbId") || null;

  try {
    let prover;

    // Hvis klubbId er spesifisert, filtrer KUN på den klubben (med tilgangskontroll)
    if (filterKlubbId) {
      // Sjekk at brukeren har tilgang til denne klubben (admin eller superadmin)
      const harTilgang = erSuperadmin || db.prepare(
        "SELECT 1 FROM klubb_admins WHERE telefon = ? AND klubb_id = ?"
      ).get(bruker.telefon, filterKlubbId);

      if (!harTilgang) {
        return c.json({ prover: [], error: "Ingen tilgang til denne klubben" }, 403);
      }

      prover = db.prepare(`
        SELECT p.*, k.navn as klubb_navn,
               (SELECT COUNT(*) FROM pameldinger WHERE prove_id = p.id) as antall_pameldte
        FROM prover p
        LEFT JOIN klubber k ON p.klubb_id = k.id
        WHERE p.klubb_id = ?
        ORDER BY p.start_dato DESC
      `).all(filterKlubbId);
      return c.json({ prover });
    }

    // Hvis ingen klubbId-filter: superadmin ser alle, andre ser sine klubber
    if (erSuperadmin) {
      prover = db.prepare(`
        SELECT p.*, k.navn as klubb_navn,
               (SELECT COUNT(*) FROM pameldinger WHERE prove_id = p.id) as antall_pameldte
        FROM prover p
        LEFT JOIN klubber k ON p.klubb_id = k.id
        ORDER BY p.start_dato DESC
      `).all();
    } else {
      // Hent klubber der brukeren er admin
      const klubber = db.prepare("SELECT klubb_id FROM klubb_admins WHERE telefon = ?").all(bruker.telefon);
      const klubbIds = klubber.map(k => k.klubb_id);

      if (klubbIds.length === 0) {
        return c.json({ prover: [] });
      }

      const placeholders = klubbIds.map(() => '?').join(',');
      prover = db.prepare(`
        SELECT p.*, k.navn as klubb_navn,
               (SELECT COUNT(*) FROM pameldinger WHERE prove_id = p.id) as antall_pameldte
        FROM prover p
        LEFT JOIN klubber k ON p.klubb_id = k.id
        WHERE p.klubb_id IN (${placeholders})
        ORDER BY p.start_dato DESC
      `).all(...klubbIds);
    }
    return c.json({ prover });
  } catch (err) {
    console.error("Feil ved henting av mine prøver:", err);
    return c.json({ prover: [], error: err.message }, 500);
  }
});

// Hent én prøve
app.get("/api/prover/:id", (c) => {
  const id = c.req.param("id");
  const row = db.prepare(`
    SELECT p.*, k.navn as klubb_navn,
           pl.fornavn || ' ' || pl.etternavn as proveleder_navn, pl.telefon as proveleder_telefon,
           nr.fornavn || ' ' || nr.etternavn as nkkrep_navn, nr.telefon as nkkrep_telefon,
           nv.fornavn || ' ' || nv.etternavn as nkkvara_navn, nv.telefon as nkkvara_telefon,
           COALESCE(p.dvk_navn, dv.fornavn || ' ' || dv.etternavn) as dvk_navn_display, dv.telefon as dvk_telefon
    FROM prover p
    LEFT JOIN klubber k ON p.klubb_id = k.id
    LEFT JOIN brukere pl ON p.proveleder_telefon = pl.telefon
    LEFT JOIN brukere nr ON p.nkkrep_telefon = nr.telefon
    LEFT JOIN brukere nv ON p.nkkvara_telefon = nv.telefon
    LEFT JOIN brukere dv ON p.dvk_telefon = dv.telefon
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
      nkkvara_telefon = null,
      dvk_telefon = null,
      dvk_navn = '',
      klasser = { uk: true, ak: true, vk: true },
      partier = {},
      prove_type = 'høyfjell_host',
      arrangor_navn = null
    } = body;

    if (!navn) {
      return c.json({ error: "Prøvenavn er påkrevd" }, 400);
    }
    if (!start_dato) {
      return c.json({ error: "Startdato er påkrevd" }, 400);
    }

    db.prepare(`
      INSERT INTO prover (id, navn, sted, start_dato, slutt_dato, klubb_id, proveleder_telefon, nkkrep_telefon, nkkvara_telefon, dvk_telefon, dvk_navn, klasser, partier, status, prove_type, arrangor_navn)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planlagt', ?, ?)
    `).run(
      id,
      navn,
      sted,
      start_dato,
      slutt_dato || start_dato,
      klubb_id,
      proveleder_telefon,
      nkkrep_telefon,
      nkkvara_telefon,
      dvk_telefon,
      dvk_navn,
      JSON.stringify(klasser),
      JSON.stringify(partier),
      prove_type,
      arrangor_navn
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

    const fields = ["navn", "sted", "start_dato", "slutt_dato", "klubb_id", "proveleder_telefon", "proveleder_navn", "nkkrep_telefon", "nkkrep_navn", "nkkvara_telefon", "nkkvara_navn", "dvk_telefon", "dvk_navn", "status", "prove_type", "arrangor_navn"];
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
    // Logo (base64)
    if ('logo' in body) {
      sets.push("logo = ?");
      vals.push(body.logo);
      sets.push("logo_oppdatert = datetime('now')");
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

// Last opp logo for prøve (FormData)
app.post("/api/prover/:id/logo", async (c) => {
  const id = c.req.param("id");

  const prove = db.prepare("SELECT * FROM prover WHERE id = ?").get(id);
  if (!prove) return c.json({ error: "Prøve ikke funnet" }, 404);

  try {
    const formData = await c.req.formData();
    const file = formData.get("logo");

    if (!file || !(file instanceof File)) {
      return c.json({ error: "Ingen fil mottatt" }, 400);
    }

    // Sjekk filtype
    const ext = file.name.split(".").pop().toLowerCase();
    if (!["png", "jpg", "jpeg", "svg", "webp"].includes(ext)) {
      return c.json({ error: "Ugyldig filformat. Bruk PNG, JPG, SVG eller WebP." }, 400);
    }

    // Konverter til base64 og lagre i database
    const buffer = Buffer.from(await file.arrayBuffer());
    const base64 = `data:image/${ext === 'svg' ? 'svg+xml' : ext};base64,${buffer.toString('base64')}`;

    db.prepare(`
      UPDATE prover
      SET logo = ?, logo_oppdatert = datetime('now')
      WHERE id = ?
    `).run(base64, id);

    console.log(`[Prøve-logo] Lastet opp logo for prøve ${id} (${(buffer.length / 1024).toFixed(1)} KB)`);

    return c.json({
      success: true,
      message: "Logo lastet opp og lagret i database",
      size: buffer.length
    });
  } catch (err) {
    console.error("[Prøve-logo] Feil:", err);
    return c.json({ error: "Feil ved opplasting: " + err.message }, 500);
  }
});

// Hent logo for prøve
app.get("/api/prover/:id/logo", (c) => {
  const id = c.req.param("id");

  const prove = db.prepare("SELECT logo FROM prover WHERE id = ?").get(id);
  if (!prove) return c.json({ error: "Prøve ikke funnet" }, 404);

  if (!prove.logo) {
    // Fallback: sjekk om klubben har logo
    const proveData = db.prepare("SELECT klubb_id FROM prover WHERE id = ?").get(id);
    if (proveData?.klubb_id) {
      const klubb = db.prepare("SELECT logo FROM klubber WHERE id = ?").get(proveData.klubb_id);
      if (klubb?.logo) {
        return c.json({
          logo: klubb.logo,
          hasLogo: true,
          source: "klubb"
        });
      }
    }
    return c.json({ error: "Ingen logo lastet opp" }, 404);
  }

  return c.json({
    logo: prove.logo,
    hasLogo: true,
    source: "prove"
  });
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
// Returnerer liste over påmeldinger som rykket opp (for varsling)
function oppdaterVenteliste(proveId, klasse) {
  const config = db.prepare("SELECT * FROM prove_config WHERE prove_id = ?").get(proveId);
  if (!config) return [];

  // Sjekk om automatisk opprykk er aktivert (default: ja)
  const autoOpprykk = config.auto_venteliste_opprykk !== 0;
  if (!autoOpprykk) {
    console.log(`[Venteliste] Automatisk opprykk er deaktivert for prøve ${proveId}`);
    return [];
  }

  const maksField = klasse === 'UK' ? 'maks_deltakere_uk' : klasse === 'AK' ? 'maks_deltakere_ak' : 'maks_deltakere_vk';
  const maks = config[maksField] || 40;

  // Tell bekreftede/påmeldte
  const antallPameldt = db.prepare(`
    SELECT COUNT(*) as n FROM pameldinger
    WHERE prove_id = ? AND klasse = ? AND status IN ('pameldt', 'bekreftet')
  `).get(proveId, klasse).n;

  const opprykkListe = [];

  if (antallPameldt < maks) {
    // Rykk opp fra venteliste
    const ledigePlasser = maks - antallPameldt;
    const venteliste = db.prepare(`
      SELECT p.id, p.forer_telefon, p.hund_id, h.navn as hund_navn
      FROM pameldinger p
      JOIN hunder h ON p.hund_id = h.id
      WHERE p.prove_id = ? AND p.klasse = ? AND p.status = 'venteliste'
      ORDER BY p.venteliste_plass ASC
      LIMIT ?
    `).all(proveId, klasse, ledigePlasser);

    for (const p of venteliste) {
      db.prepare(`
        UPDATE pameldinger SET status = 'pameldt', venteliste_plass = NULL, updated_at = datetime('now')
        WHERE id = ?
      `).run(p.id);

      opprykkListe.push({
        pamelding_id: p.id,
        forer_telefon: p.forer_telefon,
        hund_id: p.hund_id,
        hund_navn: p.hund_navn,
        klasse: klasse
      });

      console.log(`📱 Opprykk fra venteliste: ${p.forer_telefon} (${p.hund_navn}) rykket opp til ${klasse}`);
    }
  }

  return opprykkListe;
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

// ============================================
// MASSE-SMS TIL DELTAKERE
// ============================================
app.post("/api/prover/:id/sms/masse", requireAdmin, async (c) => {
  const proveId = c.req.param("id");
  const body = await c.req.json();
  const bruker = c.get("bruker");
  const { melding, mottakere, mottakerliste } = body;

  if (!melding || !melding.trim()) {
    return c.json({ error: "Melding er påkrevd" }, 400);
  }

  // Rate limiting - beskytt mot utilsiktet spam
  const now = Date.now();
  const rateLimitKey = `prove_${proveId}`;
  const rateData = masseSmsRateLimit.get(rateLimitKey) || { lastSent: 0, timestamps: [] };

  // Fjern gamle timestamps (eldre enn 1 time)
  rateData.timestamps = rateData.timestamps.filter(t => now - t < 60 * 60 * 1000);

  // Sjekk cooldown siden siste utsendelse
  if (now - rateData.lastSent < MASSE_SMS_COOLDOWN_MS) {
    const gjenstår = Math.ceil((MASSE_SMS_COOLDOWN_MS - (now - rateData.lastSent)) / 1000);
    return c.json({
      error: `Vent ${gjenstår} sekunder før neste utsendelse. Dette beskytter mot utilsiktet dobbelt-sending.`,
      cooldown: gjenstår
    }, 429);
  }

  // Sjekk maks antall utsendelser per time
  if (rateData.timestamps.length >= MASSE_SMS_MAX_PER_HOUR) {
    return c.json({
      error: `Maks ${MASSE_SMS_MAX_PER_HOUR} masse-SMS utsendelser per time. Prøv igjen senere.`,
      maxReached: true
    }, 429);
  }

  // Hent prøve for logging
  const prove = db.prepare("SELECT navn FROM prover WHERE id = ?").get(proveId);
  if (!prove) {
    return c.json({ error: "Prøve ikke funnet" }, 404);
  }

  // Bruk mottakerliste fra frontend hvis tilgjengelig (cached partiliste)
  // Dette sikrer at listen er "frosset" til tidspunktet den ble lastet
  const unikeTelefoner = new Map();

  if (mottakerliste && Array.isArray(mottakerliste) && mottakerliste.length > 0) {
    // Bruk den forhåndsinnlastede listen fra frontend
    for (const m of mottakerliste) {
      if (m.telefon && !unikeTelefoner.has(m.telefon)) {
        unikeTelefoner.set(m.telefon, m.navn || 'Deltaker');
      }
    }
  } else if (mottakere === 'waitlist') {
    // Venteliste hentes alltid fra database
    const venteliste = db.prepare(`
      SELECT DISTINCT p.forer_telefon as telefon, b.fornavn || ' ' || b.etternavn as navn
      FROM pameldinger p
      LEFT JOIN brukere b ON p.forer_telefon = b.telefon
      WHERE p.prove_id = ? AND p.status = 'venteliste'
        AND p.forer_telefon IS NOT NULL AND p.forer_telefon != ''
    `).all(proveId);

    for (const v of venteliste) {
      if (v.telefon) {
        unikeTelefoner.set(v.telefon, v.navn || 'Deltaker');
      }
    }
  } else {
    // Fallback: Hent alle fra parti_deltakere (for bakoverkompatibilitet)
    const deltakere = db.prepare(`
      SELECT DISTINCT forer_telefon as telefon, forer_navn as navn
      FROM parti_deltakere
      WHERE prove_id = ? AND forer_telefon IS NOT NULL AND forer_telefon != ''
    `).all(proveId);

    for (const d of deltakere) {
      if (d.telefon && !unikeTelefoner.has(d.telefon)) {
        unikeTelefoner.set(d.telefon, d.navn || 'Deltaker');
      }
    }
  }

  if (unikeTelefoner.size === 0) {
    return c.json({ error: "Ingen mottakere funnet. Sjekk at partilister er lastet inn.", sendt: 0, feilet: 0 }, 400);
  }

  // Send SMS til alle
  let sendt = 0;
  let feilet = 0;

  for (const [telefon, navn] of unikeTelefoner) {
    try {
      // Formater telefonnummer
      let phone = telefon.replace(/\s/g, '');
      if (!phone.startsWith('+')) {
        phone = phone.startsWith('47') ? `+${phone}` : `+47${phone}`;
      }

      const result = await sendSMS(phone, melding, {
        type: 'masse_sms',
        prove_id: proveId,
        mottaker_navn: navn || null
      });
      if (result.success) {
        sendt++;
      } else {
        feilet++;
        console.error(`[Masse-SMS] Feil til ${telefon}:`, result.error);
      }
    } catch (e) {
      feilet++;
      console.error(`[Masse-SMS] Exception til ${telefon}:`, e.message);
    }
  }

  // Oppdater rate limiting etter vellykket utsendelse
  rateData.lastSent = now;
  rateData.timestamps.push(now);
  masseSmsRateLimit.set(rateLimitKey, rateData);

  // Logg utsendelsen
  db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").run(
    "masse_sms_sendt",
    JSON.stringify({
      prove_id: proveId,
      prove_navn: prove.navn,
      mottakere: mottakere,
      antall_mottakere: unikeTelefoner.size,
      sendt: sendt,
      feilet: feilet,
      melding: melding.substring(0, 100),
      utfort_av: bruker.telefon
    })
  );

  console.log(`[Masse-SMS] ${prove.navn}: ${sendt}/${unikeTelefoner.size} sendt, ${feilet} feilet`);

  return c.json({
    success: true,
    sendt,
    feilet,
    totalt: unikeTelefoner.size
  });
});

// Hent SMS-historikk for en prøve (for prøvedokumenter)
app.get("/api/prover/:id/sms-historikk", requireAdmin, (c) => {
  const proveId = c.req.param("id");
  const rows = db.prepare(`
    SELECT id, retning, fra, til, type, melding, status, mottaker_navn, created_at
    FROM sms_log
    WHERE prove_id = ?
    ORDER BY created_at DESC
  `).all(proveId);
  return c.json(rows);
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

// ============================================
// AVMELDING MED ÅRSAK (ny, forbedret avmelding)
// ============================================

// Meld av hund fra prøve med årsak (sendes til prøveledelsens innboks)
app.post("/api/prover/:proveId/avmeldinger", requireAuth, async (c) => {
  const proveId = c.req.param("proveId");
  const body = await c.req.json();
  const bruker = c.get("bruker");

  const { pamelding_id, arsak, arsak_beskrivelse, lopetid_egenerklaring } = body;

  // Valider påkrevde felt
  if (!pamelding_id || !arsak) {
    return c.json({ error: "Mangler påkrevde felt (pamelding_id, arsak)" }, 400);
  }

  // Valider løpetid-egenerklæring hvis årsak er løpetid
  if (arsak === 'lopetid') {
    if (!lopetid_egenerklaring) {
      return c.json({ error: "Løpetid krever utfylt egenerklæring" }, 400);
    }
    const { startgebyr, kontonummer, digital_signatur } = lopetid_egenerklaring;
    if (!startgebyr || !kontonummer || !digital_signatur) {
      return c.json({ error: "Egenerklæring mangler påkrevde felt (startgebyr, kontonummer, signatur)" }, 400);
    }
    // Valider kontonummer (11 siffer)
    const kontoRen = kontonummer.replace(/\s/g, '');
    if (kontoRen.length !== 11 || !/^\d+$/.test(kontoRen)) {
      return c.json({ error: "Ugyldig kontonummer (må være 11 siffer)" }, 400);
    }
  }

  // Valider årsak
  const gyldigeArsaker = ['sykdom_hund', 'sykdom_forer', 'lopetid', 'annet'];
  if (!gyldigeArsaker.includes(arsak)) {
    return c.json({ error: "Ugyldig årsak. Må være: " + gyldigeArsaker.join(', ') }, 400);
  }

  // Hent påmelding med hund-info
  const pamelding = db.prepare(`
    SELECT p.*, h.navn as hund_navn, h.regnr as hund_regnr
    FROM pameldinger p
    JOIN hunder h ON p.hund_id = h.id
    WHERE p.id = ? AND p.prove_id = ?
  `).get(pamelding_id, proveId);

  if (!pamelding) {
    return c.json({ error: "Påmelding ikke funnet" }, 404);
  }

  // Sjekk tilgang (eier, fører, eller admin)
  const hund = db.prepare("SELECT * FROM hunder WHERE id = ?").get(pamelding.hund_id);
  const erEier = hund && hund.eier_telefon === bruker.telefon;
  const erForer = pamelding.forer_telefon === bruker.telefon;
  const erAdmin = ['admin', 'superadmin', 'klubbleder', 'proveleder', 'sekretaer'].includes(bruker.rolle);

  if (!erEier && !erForer && !erAdmin) {
    return c.json({ error: "Du har ikke tilgang til å avmelde denne hunden" }, 403);
  }

  // Sjekk at påmeldingen ikke allerede er avmeldt
  if (pamelding.status === 'avmeldt') {
    return c.json({ error: "Hunden er allerede avmeldt" }, 400);
  }

  // Hent prøve for refusjonsberegning og info
  const prove = db.prepare("SELECT * FROM prover WHERE id = ?").get(proveId);
  const config = db.prepare("SELECT * FROM prove_config WHERE prove_id = ?").get(proveId);

  // Beregn refusjon basert på NKK regler
  let refusjon = { belop: 0, prosent: 0 };
  if (pamelding.betalt && pamelding.betalt_belop > 0) {
    if (pamelding.status === 'venteliste') {
      // 100% refusjon for venteliste som ikke fikk plass
      refusjon = { belop: pamelding.betalt_belop, prosent: 100 };
    } else if (arsak === 'sykdom_hund' || arsak === 'sykdom_forer' || arsak === 'lopetid') {
      // 75% refusjon ved dokumentert sykdom/løpetid (krever dokumentasjon)
      const prosent = config?.refusjon_prosent || 75;
      refusjon = { belop: Math.round(pamelding.betalt_belop * prosent / 100), prosent };
    }
    // 'annet' gir 0% refusjon (frivillig avmelding uten grunn)
  }

  // Opprett avmelding i ny tabell
  const avmeldingResult = db.prepare(`
    INSERT INTO avmeldinger (
      pamelding_id, prove_id, hund_id, forer_telefon,
      arsak, arsak_beskrivelse, refusjon_belop, refusjon_prosent,
      lopetid_egenerklaring
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    pamelding_id, proveId, pamelding.hund_id, bruker.telefon,
    arsak, arsak_beskrivelse || '', refusjon.belop, refusjon.prosent,
    arsak === 'lopetid' && lopetid_egenerklaring ? JSON.stringify(lopetid_egenerklaring) : null
  );

  const avmeldingId = avmeldingResult.lastInsertRowid;

  // Oppdater påmelding-status
  db.prepare(`
    UPDATE pameldinger SET status = 'avmeldt', updated_at = datetime('now')
    WHERE id = ?
  `).run(pamelding_id);

  // Oppdater venteliste og få info om hvem som rykket opp
  const opprykkListe = oppdaterVenteliste(proveId, pamelding.klasse);

  // Registrer opprykk i avmeldingen (hvis noen rykket opp)
  if (opprykkListe.length > 0) {
    db.prepare(`
      UPDATE avmeldinger SET opprykk_pamelding_id = ? WHERE id = ?
    `).run(opprykkListe[0].pamelding_id, avmeldingId);
  }

  // Send melding til prøveledelsens innboks
  const arsakTekst = {
    'sykdom_hund': 'Sykdom hos hund',
    'sykdom_forer': 'Sykdom hos fører',
    'lopetid': 'Løpetid',
    'annet': 'Annen årsak'
  }[arsak];

  const brukerNavn = bruker.fornavn && bruker.etternavn
    ? `${bruker.fornavn} ${bruker.etternavn}`
    : bruker.telefon;

  let meldingTekst = `Avmelding fra ${brukerNavn}:\n\n`;
  meldingTekst += `Hund: ${pamelding.hund_navn} (${pamelding.hund_regnr || 'uten regnr'})\n`;
  meldingTekst += `Klasse: ${pamelding.klasse}\n`;
  meldingTekst += `Årsak: ${arsakTekst}\n`;
  if (arsak_beskrivelse) {
    meldingTekst += `Beskrivelse: ${arsak_beskrivelse}\n`;
  }

  // Legg til løpetid-egenerklæring hvis relevant
  if (arsak === 'lopetid' && lopetid_egenerklaring) {
    meldingTekst += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    meldingTekst += `📋 EGENERKLÆRING LØPETID\n`;
    meldingTekst += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    meldingTekst += `Jeg erklærer herved at min hund ${lopetid_egenerklaring.hund_navn || pamelding.hund_navn}\n`;
    meldingTekst += `med registreringsnummer ${lopetid_egenerklaring.regnr || pamelding.hund_regnr || '-'}\n`;
    meldingTekst += `har fått løpetid og ikke kan starte på prøven\n`;
    meldingTekst += `som starter ${lopetid_egenerklaring.start_dato || '-'}.\n\n`;
    meldingTekst += `Jeg ber om å få tilbakebetalt startgebyret:\n`;
    meldingTekst += `Beløp: ${lopetid_egenerklaring.startgebyr} kr\n`;
    meldingTekst += `Kontonummer: ${lopetid_egenerklaring.kontonummer}\n\n`;
    meldingTekst += `Eier/fører: ${lopetid_egenerklaring.eier_navn || brukerNavn}\n`;
    if (lopetid_egenerklaring.eier_adresse) {
      meldingTekst += `Adresse: ${lopetid_egenerklaring.eier_adresse}\n`;
    }
    if (lopetid_egenerklaring.sted) {
      meldingTekst += `Sted: ${lopetid_egenerklaring.sted}\n`;
    }
    meldingTekst += `Dato: ${lopetid_egenerklaring.signert_dato || new Date().toISOString().split('T')[0]}\n\n`;
    meldingTekst += `✅ Digitalt signert av ${brukerNavn}\n`;
    meldingTekst += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  }

  meldingTekst += `\nRefusjon: ${refusjon.prosent}%`;
  if (refusjon.belop > 0) {
    meldingTekst += ` (${refusjon.belop} kr)`;
  }
  if (arsak !== 'annet' && refusjon.prosent > 0 && arsak !== 'lopetid') {
    meldingTekst += `\n⚠️ Krever dokumentasjon for refusjon.`;
  }
  if (arsak === 'lopetid') {
    meldingTekst += `\n✅ Egenerklæring mottatt som dokumentasjon.`;
  }

  // Opprett melding i innboks
  db.prepare(`
    INSERT INTO meldinger (prove_id, fra_telefon, fra_navn, til_type, hund_id, hund_regnr, hund_navn, emne, melding)
    VALUES (?, ?, ?, 'proveledelse', ?, ?, ?, ?, ?)
  `).run(
    proveId,
    bruker.telefon,
    brukerNavn,
    pamelding.hund_id,
    pamelding.hund_regnr || '',
    pamelding.hund_navn,
    `Avmelding: ${pamelding.hund_navn}`,
    meldingTekst
  );

  // Logg
  db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").run(
    "avmelding_registrert",
    JSON.stringify({
      avmelding_id: avmeldingId,
      pamelding_id,
      hund_navn: pamelding.hund_navn,
      arsak,
      refusjon,
      har_lopetid_egenerklaring: arsak === 'lopetid' && !!lopetid_egenerklaring,
      opprykk: opprykkListe.length > 0 ? opprykkListe[0] : null
    })
  );

  return c.json({
    ok: true,
    avmelding_id: avmeldingId,
    refusjon,
    opprykk: opprykkListe.length > 0 ? {
      hund_navn: opprykkListe[0].hund_navn,
      klasse: opprykkListe[0].klasse
    } : null,
    message: `Avmelding registrert. ${refusjon.prosent > 0 ? `Mulig refusjon: ${refusjon.prosent}% (krever dokumentasjon).` : 'Ingen refusjon.'}`
  });
});

// Hent avmeldinger for en prøve (prøveledelse)
app.get("/api/prover/:proveId/avmeldinger", (c) => {
  const proveId = c.req.param("proveId");
  const status = c.req.query("status"); // 'mottatt', 'behandlet', etc.

  let query = `
    SELECT a.*, h.navn as hund_navn, h.regnr as hund_regnr,
           b.fornavn || ' ' || b.etternavn as forer_navn
    FROM avmeldinger a
    JOIN hunder h ON a.hund_id = h.id
    LEFT JOIN brukere b ON a.forer_telefon = b.telefon
    WHERE a.prove_id = ?
  `;
  const params = [proveId];

  if (status) {
    query += ` AND a.status = ?`;
    params.push(status);
  }

  query += ` ORDER BY a.created_at DESC`;

  const avmeldinger = db.prepare(query).all(...params);
  return c.json({ items: avmeldinger, count: avmeldinger.length });
});

// Behandle avmelding (prøveledelse godkjenner/avviser refusjon)
app.put("/api/prover/:proveId/avmeldinger/:id", requireAdmin, async (c) => {
  const proveId = c.req.param("proveId");
  const id = c.req.param("id");
  const body = await c.req.json();
  const bruker = c.get("bruker");

  const avmelding = db.prepare("SELECT * FROM avmeldinger WHERE id = ? AND prove_id = ?").get(id, proveId);
  if (!avmelding) {
    return c.json({ error: "Avmelding ikke funnet" }, 404);
  }

  const { status, behandlet_kommentar, refusjon_utbetalt } = body;

  // Oppdater avmelding
  db.prepare(`
    UPDATE avmeldinger SET
      status = COALESCE(?, status),
      behandlet_av = ?,
      behandlet_dato = datetime('now'),
      behandlet_kommentar = COALESCE(?, behandlet_kommentar),
      refusjon_utbetalt = COALESCE(?, refusjon_utbetalt),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(status, bruker.telefon, behandlet_kommentar, refusjon_utbetalt ? 1 : 0, id);

  const oppdatert = db.prepare("SELECT * FROM avmeldinger WHERE id = ?").get(id);
  return c.json({ ok: true, avmelding: oppdatert });
});

// Hent mine aktive påmeldinger (for avmeldings-UI)
app.get("/api/mine-pameldinger", requireAuth, (c) => {
  const bruker = c.get("bruker");

  // Hent alle aktive påmeldinger der bruker er eier eller fører
  const pameldinger = db.prepare(`
    SELECT p.*,
           pr.navn as prove_navn, pr.start_dato, pr.slutt_dato, pr.sted as prove_sted,
           h.navn as hund_navn, h.regnr as hund_regnr, h.rase as hund_rase
    FROM pameldinger p
    JOIN prover pr ON p.prove_id = pr.id
    JOIN hunder h ON p.hund_id = h.id
    WHERE (p.forer_telefon = ? OR h.eier_telefon = ?)
      AND p.status IN ('pameldt', 'bekreftet', 'venteliste')
      AND pr.start_dato >= date('now', '-1 day')
    ORDER BY pr.start_dato ASC
  `).all(bruker.telefon, bruker.telefon);

  return c.json({ items: pameldinger, count: pameldinger.length });
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
      vk_type: '1dag',
      vk_kval_dag: null,
      vk_semi_dag: null,
      vk_finale_dag: null,
      pris_hogfjell: 1350,
      pris_lavland: 1050,
      pris_skog: 900,
      pris_apport: 400,
      refusjon_prosent: 75,
      manuell_bedomming: 0
    };
  }

  // manuell_bedomming kan være satt i prove_config eller (kanonisk) i
  // praktiskInfo.bedommingUtenforSystemet — la praktiskInfo overstyre
  // så feltet alltid speiler det admin valgte ved prøveopprettelse.
  config.manuell_bedomming = erManuellBedomming(proveId) ? 1 : 0;

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
    "vk_dag",  // For 1-dags VK: hvilken dag VK går
    "vk_type", // '1dag', '2dag', '3dag'
    "vk_kval_dag", "vk_semi_dag", "vk_finale_dag", // For fler-dagers VK
    "pris_hogfjell", "pris_lavland", "pris_skog", "pris_apport",
    "frist_pamelding", "frist_avmelding", "refusjon_prosent",
    "krever_sauebevis", "krever_vaksinasjon", "krever_rabies",
    "manuell_bedomming" // 0=digital (default), 1=manuell — admin tildeler
                        // live_admin på VK for live rangering uten kritikk-flyt
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
// JEGERMIDDAG API
// ============================================

// Hent jegermiddag-info for en prøve (offentlig)
app.get("/api/prover/:id/jegermiddag", (c) => {
  const proveId = c.req.param("id");

  const config = db.prepare(`
    SELECT jegermiddag_aktivert, jegermiddag_dato, jegermiddag_tid,
           jegermiddag_sted, jegermiddag_pris, jegermiddag_maks_personer,
           jegermiddag_info, jegermiddag_frist
    FROM prove_config
    WHERE prove_id = ?
  `).get(proveId);

  if (!config || !config.jegermiddag_aktivert) {
    return c.json({ aktivert: false });
  }

  // Tell antall påmeldte
  const stats = db.prepare(`
    SELECT COUNT(*) as antall_pameldinger, SUM(antall_personer) as total_personer
    FROM jegermiddag_pameldinger
    WHERE prove_id = ? AND status != 'avmeldt'
  `).get(proveId);

  return c.json({
    aktivert: true,
    dato: config.jegermiddag_dato,
    tid: config.jegermiddag_tid,
    sted: config.jegermiddag_sted,
    pris: config.jegermiddag_pris,
    maks_personer: config.jegermiddag_maks_personer,
    info: config.jegermiddag_info,
    frist: config.jegermiddag_frist,
    antall_pameldinger: stats?.antall_pameldinger || 0,
    total_personer: stats?.total_personer || 0,
    plasser_igjen: config.jegermiddag_maks_personer - (stats?.total_personer || 0)
  });
});

// Oppdater jegermiddag-konfigurasjon (admin)
app.put("/api/prover/:id/jegermiddag/config", requireAdmin, async (c) => {
  const proveId = c.req.param("id");
  const body = await c.req.json();

  // Opprett prove_config hvis den ikke finnes
  db.prepare("INSERT OR IGNORE INTO prove_config (prove_id) VALUES (?)").run(proveId);

  const fields = [
    "jegermiddag_aktivert", "jegermiddag_dato", "jegermiddag_tid",
    "jegermiddag_sted", "jegermiddag_pris", "jegermiddag_maks_personer",
    "jegermiddag_info", "jegermiddag_frist"
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

  return c.json({ ok: true });
});

// Hent alle jegermiddag-påmeldinger for en prøve (admin)
app.get("/api/prover/:id/jegermiddag/pameldinger", requireAdmin, (c) => {
  const proveId = c.req.param("id");

  const pameldinger = db.prepare(`
    SELECT jp.*, b.fornavn, b.etternavn, b.telefon, b.epost
    FROM jegermiddag_pameldinger jp
    JOIN brukere b ON jp.bruker_telefon = b.telefon
    WHERE jp.prove_id = ?
    ORDER BY jp.created_at ASC
  `).all(proveId);

  // Statistikk
  const stats = {
    totalt_pameldinger: pameldinger.length,
    totalt_personer: pameldinger.reduce((sum, p) => sum + (p.antall_personer || 1), 0),
    antall_vegetar: pameldinger.filter(p => p.vegetar).reduce((sum, p) => sum + p.antall_personer, 0),
    antall_med_allergi: pameldinger.filter(p => p.allergier && p.allergier.trim()).length,
    antall_betalt: pameldinger.filter(p => p.betalt).length,
    sum_betalt: pameldinger.filter(p => p.betalt).reduce((sum, p) => sum + (p.belop || 0), 0)
  };

  return c.json({ items: pameldinger, stats });
});

// Meld på til jegermiddag (deltaker)
app.post("/api/prover/:id/jegermiddag/pamelding", requireAuth, async (c) => {
  const proveId = c.req.param("id");
  const body = await c.req.json();
  const bruker = c.get("bruker");

  // Sjekk at brukeren er påmeldt prøven (som fører eller har hund påmeldt)
  const erPameldt = db.prepare(`
    SELECT COUNT(*) as count FROM pameldinger
    WHERE prove_id = ? AND (forer_telefon = ? OR eier_telefon = ?)
  `).get(proveId, bruker.telefon, bruker.telefon);

  // Sjekk også om brukeren er team-medlem eller har en offisiell rolle
  const erTeam = db.prepare(`
    SELECT COUNT(*) as count FROM prove_team
    WHERE prove_id = ? AND telefon = ?
  `).get(proveId, bruker.telefon);

  const prove = db.prepare(`
    SELECT proveleder_telefon, nkkrep_telefon, nkkvara_telefon, dvk_telefon
    FROM prover WHERE id = ?
  `).get(proveId);

  const erOffisiellRolle = prove && (
    prove.proveleder_telefon === bruker.telefon ||
    prove.nkkrep_telefon === bruker.telefon ||
    prove.nkkvara_telefon === bruker.telefon ||
    prove.dvk_telefon === bruker.telefon
  );

  if (!erPameldt?.count && !erTeam?.count && !erOffisiellRolle) {
    return c.json({
      error: "Du må være påmeldt prøven (som deltaker, team-medlem eller med offisiell rolle) for å melde deg på jegermiddag"
    }, 403);
  }

  // Sjekk at jegermiddag er aktivert
  const config = db.prepare(`
    SELECT jegermiddag_aktivert, jegermiddag_maks_personer, jegermiddag_pris, jegermiddag_frist
    FROM prove_config WHERE prove_id = ?
  `).get(proveId);

  if (!config || !config.jegermiddag_aktivert) {
    return c.json({ error: "Jegermiddag er ikke aktivert for denne prøven" }, 400);
  }

  // Sjekk frist
  if (config.jegermiddag_frist) {
    const frist = new Date(config.jegermiddag_frist);
    if (new Date() > frist) {
      return c.json({ error: "Påmeldingsfristen for jegermiddag har gått ut" }, 400);
    }
  }

  // Sjekk om det er plass
  const stats = db.prepare(`
    SELECT SUM(antall_personer) as total
    FROM jegermiddag_pameldinger
    WHERE prove_id = ? AND status != 'avmeldt'
  `).get(proveId);

  const antallPersoner = body.antall_personer || 1;
  if ((stats?.total || 0) + antallPersoner > config.jegermiddag_maks_personer) {
    return c.json({ error: "Det er ikke nok ledige plasser" }, 400);
  }

  // Sjekk om bruker allerede er påmeldt
  const eksisterende = db.prepare(`
    SELECT * FROM jegermiddag_pameldinger
    WHERE prove_id = ? AND bruker_telefon = ?
  `).get(proveId, bruker.telefon);

  if (eksisterende) {
    return c.json({ error: "Du er allerede påmeldt jegermiddag" }, 400);
  }

  const belop = config.jegermiddag_pris * antallPersoner;

  db.prepare(`
    INSERT INTO jegermiddag_pameldinger
    (prove_id, bruker_telefon, antall_personer, allergier, vegetar, annen_info, belop)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    proveId,
    bruker.telefon,
    antallPersoner,
    body.allergier || '',
    body.vegetar ? 1 : 0,
    body.annen_info || '',
    belop
  );

  const pamelding = db.prepare(`
    SELECT * FROM jegermiddag_pameldinger
    WHERE prove_id = ? AND bruker_telefon = ?
  `).get(proveId, bruker.telefon);

  return c.json({ ok: true, pamelding });
});

// Oppdater jegermiddag-påmelding (deltaker)
app.put("/api/prover/:id/jegermiddag/pamelding", requireAuth, async (c) => {
  const proveId = c.req.param("id");
  const body = await c.req.json();
  const bruker = c.get("bruker");

  const eksisterende = db.prepare(`
    SELECT * FROM jegermiddag_pameldinger
    WHERE prove_id = ? AND bruker_telefon = ?
  `).get(proveId, bruker.telefon);

  if (!eksisterende) {
    return c.json({ error: "Du er ikke påmeldt jegermiddag" }, 404);
  }

  // Hent konfig for prisberegning
  const config = db.prepare(`
    SELECT jegermiddag_pris FROM prove_config WHERE prove_id = ?
  `).get(proveId);

  const antallPersoner = body.antall_personer || eksisterende.antall_personer;
  const belop = (config?.jegermiddag_pris || 350) * antallPersoner;

  db.prepare(`
    UPDATE jegermiddag_pameldinger
    SET antall_personer = ?, allergier = ?, vegetar = ?, annen_info = ?, belop = ?, updated_at = datetime('now')
    WHERE prove_id = ? AND bruker_telefon = ?
  `).run(
    antallPersoner,
    body.allergier || eksisterende.allergier,
    body.vegetar ? 1 : 0,
    body.annen_info || eksisterende.annen_info,
    belop,
    proveId,
    bruker.telefon
  );

  const oppdatert = db.prepare(`
    SELECT * FROM jegermiddag_pameldinger
    WHERE prove_id = ? AND bruker_telefon = ?
  `).get(proveId, bruker.telefon);

  return c.json({ ok: true, pamelding: oppdatert });
});

// Meld av fra jegermiddag (deltaker)
app.delete("/api/prover/:id/jegermiddag/pamelding", requireAuth, (c) => {
  const proveId = c.req.param("id");
  const bruker = c.get("bruker");

  const eksisterende = db.prepare(`
    SELECT * FROM jegermiddag_pameldinger
    WHERE prove_id = ? AND bruker_telefon = ?
  `).get(proveId, bruker.telefon);

  if (!eksisterende) {
    return c.json({ error: "Du er ikke påmeldt jegermiddag" }, 404);
  }

  // Marker som avmeldt (beholder historikk)
  db.prepare(`
    UPDATE jegermiddag_pameldinger
    SET status = 'avmeldt', updated_at = datetime('now')
    WHERE prove_id = ? AND bruker_telefon = ?
  `).run(proveId, bruker.telefon);

  return c.json({ ok: true });
});

// Hent min jegermiddag-påmelding for en prøve
app.get("/api/prover/:id/jegermiddag/min-pamelding", requireAuth, (c) => {
  const proveId = c.req.param("id");
  const bruker = c.get("bruker");

  const pamelding = db.prepare(`
    SELECT * FROM jegermiddag_pameldinger
    WHERE prove_id = ? AND bruker_telefon = ? AND status != 'avmeldt'
  `).get(proveId, bruker.telefon);

  return c.json({ pamelding: pamelding || null });
});

// Oppdater betalingsstatus for jegermiddag-påmelding (admin)
app.put("/api/prover/:proveId/jegermiddag/pameldinger/:id/betaling", requireAdmin, async (c) => {
  const proveId = c.req.param("proveId");
  const id = c.req.param("id");
  const body = await c.req.json();

  const pamelding = db.prepare(`
    SELECT * FROM jegermiddag_pameldinger
    WHERE id = ? AND prove_id = ?
  `).get(id, proveId);

  if (!pamelding) {
    return c.json({ error: "Påmelding ikke funnet" }, 404);
  }

  db.prepare(`
    UPDATE jegermiddag_pameldinger
    SET betalt = ?, betalt_dato = ?, status = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(
    body.betalt ? 1 : 0,
    body.betalt ? (body.betalt_dato || new Date().toISOString().split('T')[0]) : null,
    body.betalt ? 'betalt' : 'pameldt',
    id
  );

  return c.json({ ok: true });
});

// Eksporter jegermiddag-liste til Excel (admin)
app.get("/api/prover/:id/jegermiddag/eksport", requireAdmin, (c) => {
  const proveId = c.req.param("id");

  const prove = db.prepare("SELECT navn FROM prover WHERE id = ?").get(proveId);
  const pameldinger = db.prepare(`
    SELECT jp.*, b.fornavn, b.etternavn, b.telefon, b.epost
    FROM jegermiddag_pameldinger jp
    JOIN brukere b ON jp.bruker_telefon = b.telefon
    WHERE jp.prove_id = ? AND jp.status != 'avmeldt'
    ORDER BY jp.created_at ASC
  `).all(proveId);

  // Bygg Excel-data
  const data = pameldinger.map((p, i) => ({
    'Nr': i + 1,
    'Navn': `${p.fornavn} ${p.etternavn}`,
    'Telefon': p.telefon,
    'E-post': p.epost || '',
    'Antall personer': p.antall_personer,
    'Allergier': p.allergier || '',
    'Vegetar': p.vegetar ? 'Ja' : 'Nei',
    'Annen info': p.annen_info || '',
    'Beløp': `${p.belop} kr`,
    'Betalt': p.betalt ? 'Ja' : 'Nei',
    'Status': p.status
  }));

  const worksheet = XLSX.utils.json_to_sheet(data);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Jegermiddag');

  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

  const filename = `jegermiddag_${prove?.navn || proveId}_${new Date().toISOString().split('T')[0]}.xlsx`;

  return new Response(buffer, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`
    }
  });
});

// ============================================
// FRATATTE AVERSJONSBEVIS (NJFF-RAPPORT)
// ============================================

// Registrer fratatt aversjonsbevis
app.post("/api/prover/:id/fratatte-aversjonsbevis", requireAdmin, async (c) => {
  const proveId = c.req.param("id");
  const body = await c.req.json();
  const bruker = c.get("bruker");

  const { hund_id, arsak, hendelsesdato, kommentar } = body;

  if (!hund_id || !arsak) {
    return c.json({ error: "Hund og årsak er påkrevd" }, 400);
  }

  // Hent hund-info
  const hund = db.prepare("SELECT * FROM hunder WHERE id = ?").get(hund_id);
  if (!hund) {
    return c.json({ error: "Hund ikke funnet" }, 404);
  }

  // Hent eier-info
  let eierNavn = hund.eier_navn || 'Ukjent';
  let eierAdresse = '';
  if (hund.eier_telefon) {
    const eier = db.prepare("SELECT * FROM brukere WHERE telefon = ?").get(hund.eier_telefon);
    if (eier) {
      eierNavn = `${eier.fornavn || ''} ${eier.etternavn || ''}`.trim() || eierNavn;
      eierAdresse = eier.adresse || '';
    }
  }

  // Sjekk om allerede registrert
  const eksisterer = db.prepare(`
    SELECT id FROM fratatte_aversjonsbevis WHERE prove_id = ? AND hund_id = ?
  `).get(proveId, hund_id);

  if (eksisterer) {
    return c.json({ error: "Denne hunden er allerede registrert med fratatt aversjonsbevis for denne prøven" }, 400);
  }

  db.prepare(`
    INSERT INTO fratatte_aversjonsbevis
    (prove_id, hund_id, eier_navn, eier_telefon, eier_adresse, hund_navn, hund_regnr, hund_rase, hund_chip_id, arsak, hendelsesdato, registrert_av, kommentar)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    proveId,
    hund_id,
    eierNavn,
    hund.eier_telefon || null,
    eierAdresse,
    hund.navn,
    hund.regnr || '',
    hund.rase || '',
    hund.chip_id || hund.aversjonsbevis_chip_id || '',
    arsak,
    hendelsesdato || new Date().toISOString().split('T')[0],
    bruker.telefon,
    kommentar || ''
  );

  // Marker hundens aversjonsbevis som fratatt i hunder-tabellen
  db.prepare(`
    UPDATE hunder SET aversjonsbevis_godkjent = -1, updated_at = datetime('now')
    WHERE id = ?
  `).run(hund_id);

  return c.json({ ok: true });
});

// Hent alle fratatte aversjonsbevis for en prøve
app.get("/api/prover/:id/fratatte-aversjonsbevis", requireAdmin, (c) => {
  const proveId = c.req.param("id");

  const fratatte = db.prepare(`
    SELECT fa.*, p.navn as prove_navn, p.start_dato as prove_dato
    FROM fratatte_aversjonsbevis fa
    JOIN prover p ON fa.prove_id = p.id
    WHERE fa.prove_id = ?
    ORDER BY fa.created_at DESC
  `).all(proveId);

  return c.json({ items: fratatte, count: fratatte.length });
});

// Slett registrering av fratatt aversjonsbevis
app.delete("/api/prover/:proveId/fratatte-aversjonsbevis/:id", requireAdmin, (c) => {
  const proveId = c.req.param("proveId");
  const id = c.req.param("id");

  const fratatt = db.prepare(`
    SELECT * FROM fratatte_aversjonsbevis WHERE id = ? AND prove_id = ?
  `).get(id, proveId);

  if (!fratatt) {
    return c.json({ error: "Registrering ikke funnet" }, 404);
  }

  // Gjenopprett hundens aversjonsbevis-status
  db.prepare(`
    UPDATE hunder SET aversjonsbevis_godkjent = 1, updated_at = datetime('now')
    WHERE id = ?
  `).run(fratatt.hund_id);

  db.prepare("DELETE FROM fratatte_aversjonsbevis WHERE id = ?").run(id);

  return c.json({ ok: true });
});

// Eksporter NJFF-rapport (Excel)
app.get("/api/prover/:id/fratatte-aversjonsbevis/eksport", requireAdmin, (c) => {
  const proveId = c.req.param("id");

  const prove = db.prepare("SELECT navn, start_dato FROM prover WHERE id = ?").get(proveId);
  const fratatte = db.prepare(`
    SELECT * FROM fratatte_aversjonsbevis WHERE prove_id = ? ORDER BY created_at ASC
  `).all(proveId);

  // Bygg Excel-data
  const data = fratatte.map((f, i) => ({
    'Nr': i + 1,
    'Hundens navn': f.hund_navn,
    'Reg.nr': f.hund_regnr,
    'Rase': f.hund_rase,
    'Chip-ID': f.hund_chip_id || '',
    'Eiers navn': f.eier_navn,
    'Eiers telefon': f.eier_telefon || '',
    'Eiers adresse': f.eier_adresse || '',
    'Årsak til fratakelse': f.arsak,
    'Hendelsesdato': f.hendelsesdato,
    'Kommentar': f.kommentar || '',
    'Registrert dato': f.created_at?.split('T')[0] || ''
  }));

  const worksheet = XLSX.utils.json_to_sheet(data);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Fratatte aversjonsbevis');

  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

  const filename = `njff_fratatte_aversjonsbevis_${prove?.navn || proveId}_${new Date().toISOString().split('T')[0]}.xlsx`;

  return new Response(buffer, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`
    }
  });
});

// Marker som meldt til NJFF
app.put("/api/prover/:proveId/fratatte-aversjonsbevis/:id/meldt", requireAdmin, async (c) => {
  const proveId = c.req.param("proveId");
  const id = c.req.param("id");

  db.prepare(`
    UPDATE fratatte_aversjonsbevis
    SET meldt_njff = 1, meldt_njff_dato = date('now'), updated_at = datetime('now')
    WHERE id = ? AND prove_id = ?
  `).run(id, proveId);

  return c.json({ ok: true });
});

// Hent hunder med uønsket adferd fra kritikker (for NJFF-visning)
app.get("/api/prover/:id/uonsket-adferd", requireAdmin, (c) => {
  const proveId = c.req.param("id");

  // Hent kritikker med uønsket adferd fra denne prøven
  // Vi sjekker både det nye uonsket_adferd-feltet og adferd-tekstfeltet (for bakoverkompatibilitet)
  const kritikker = db.prepare(`
    SELECT
      k.id as kritikk_id,
      k.hund_id,
      k.dato,
      k.klasse,
      k.parti,
      k.uonsket_adferd,
      k.uonsket_adferd_tekst,
      k.adferd,
      k.dommer_telefon,
      h.navn as hund_navn,
      h.regnr as hund_regnr,
      h.rase as hund_rase,
      h.eier_telefon,
      COALESCE(eier.fornavn || ' ' || eier.etternavn, '') as eier_navn,
      b.fornavn as dommer_fornavn,
      b.etternavn as dommer_etternavn
    FROM kritikker k
    JOIN hunder h ON k.hund_id = h.id
    LEFT JOIN brukere eier ON h.eier_telefon = eier.telefon
    LEFT JOIN brukere b ON k.dommer_telefon = b.telefon
    WHERE k.prove_id = ?
      AND (k.uonsket_adferd = 1 OR (k.adferd IS NOT NULL AND k.adferd != ''))
    ORDER BY k.dato DESC, k.parti
  `).all(proveId);

  // Sjekk også hvilke av disse som allerede er registrert som fratatt
  const fratatteIds = db.prepare(`
    SELECT hund_id FROM fratatte_aversjonsbevis WHERE prove_id = ?
  `).all(proveId).map(f => f.hund_id);

  const resultat = kritikker.map(k => ({
    ...k,
    dommer_navn: [k.dommer_fornavn, k.dommer_etternavn].filter(Boolean).join(' ') || 'Ukjent dommer',
    kommentar: k.uonsket_adferd_tekst || k.adferd || '',
    allerede_fratatt: fratatteIds.includes(k.hund_id)
  }));

  return c.json({
    items: resultat,
    count: resultat.length,
    ikke_fratatt_count: resultat.filter(r => !r.allerede_fratatt).length
  });
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

// Hent trekning/partilister (OFFENTLIG - uten telefonnumre)
// GDPR: Dette endepunktet er offentlig tilgjengelig, så telefonnumre fjernes
app.get("/api/prover/:id/partier", (c) => {
  const proveId = c.req.param("id");

  const pameldinger = db.prepare(`
    SELECT p.id, p.prove_id, p.hund_id, p.parti, p.startnummer, p.klasse,
           p.makker_hund_id, p.status, p.created_at,
           h.navn as hund_navn, h.regnr, h.rase,
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

// ========================================
// PARTILISTER - Server-lagring
// ========================================

// Hent alle partier med deltakere for en prøve
// VIKTIG: Dette endepunktet er OFFENTLIG - telefonnumre MÅ IKKE eksponeres!
// Admin-versjonen med telefonnumre er /api/prover/:id/partilister/admin
app.get("/api/prover/:id/partilister", (c) => {
  const proveId = c.req.param("id");

  // Hent partier
  const partier = db.prepare(`
    SELECT * FROM partier WHERE prove_id = ? ORDER BY sortering, dato, navn
  `).all(proveId);

  // Hent deltakere for hvert parti
  const deltakere = db.prepare(`
    SELECT pd.*, p.navn as parti_navn
    FROM parti_deltakere pd
    JOIN partier p ON pd.parti_id = p.id
    WHERE pd.prove_id = ?
    ORDER BY pd.startnummer
  `).all(proveId);

  const prove = db.prepare("SELECT start_dato FROM prover WHERE id = ?").get(proveId);
  const startDato = prove?.start_dato || (partier.map(p => p.dato).filter(Boolean).sort()[0] || null);
  const computeDay = (dato) => {
    if (!dato || !startDato) return null;
    const diff = Math.round((new Date(dato) - new Date(startDato)) / 86400000);
    return diff >= 0 ? diff + 1 : null;
  };

  // Bygg opp struktur som matcher localStorage-formatet
  // GDPR: Telefonnumre fjernes fra offentlig API
  // Trukne hunder (status='trukket') ekskluderes helt fra offentlig API
  const result = partier.map(parti => ({
    id: parti.id,
    name: parti.navn,
    displayName: parti.display_navn || parti.navn,
    type: parti.type,
    date: parti.dato,
    day: computeDay(parti.dato),
    klasse: parti.klasse,
    bedomming_startet: erBedommingStartet(proveId, parti.navn),
    dogs: deltakere
      .filter(d => d.parti_id === parti.id && (d.status || 'aktiv') !== 'trukket')
      .map(d => ({
        regnr: d.hund_regnr,
        hundenavn: d.hund_navn,
        rase: d.rase,
        kjonn: d.kjonn,
        klasse: d.klasse,
        eier: d.eier_navn,
        // eierTelefon fjernet fra offentlig API (GDPR)
        forer: d.forer_navn,
        // forerTelefon fjernet fra offentlig API (GDPR)
        startnummer: d.startnummer,
        confirmed: d.bekreftet === 1,
        status: d.status
      }))
  }));

  return c.json(result);
});

// Admin-versjon med telefonnumre (krever autentisering)
app.get("/api/prover/:id/partilister/admin", requireAdmin, (c) => {
  const proveId = c.req.param("id");

  // Hent partier
  const partier = db.prepare(`
    SELECT * FROM partier WHERE prove_id = ? ORDER BY sortering, dato, navn
  `).all(proveId);

  // Hent deltakere for hvert parti
  const deltakere = db.prepare(`
    SELECT pd.*, p.navn as parti_navn
    FROM parti_deltakere pd
    JOIN partier p ON pd.parti_id = p.id
    WHERE pd.prove_id = ?
    ORDER BY pd.startnummer
  `).all(proveId);

  const prove = db.prepare("SELECT start_dato FROM prover WHERE id = ?").get(proveId);
  const startDato = prove?.start_dato || (partier.map(p => p.dato).filter(Boolean).sort()[0] || null);
  const computeDay = (dato) => {
    if (!dato || !startDato) return null;
    const diff = Math.round((new Date(dato) - new Date(startDato)) / 86400000);
    return diff >= 0 ? diff + 1 : null;
  };

  // Full versjon med telefonnumre for admin
  // dogs[] = aktive hunder (status != 'trukket'), trukne[] = hunder som meldt forfall
  const mapDog = (d) => ({
    regnr: d.hund_regnr,
    hundenavn: d.hund_navn,
    rase: d.rase,
    kjonn: d.kjonn,
    klasse: d.klasse,
    eier: d.eier_navn,
    eierTelefon: d.eier_telefon,
    forer: d.forer_navn,
    forerTelefon: d.forer_telefon,
    startnummer: d.startnummer,
    confirmed: d.bekreftet === 1,
    status: d.status
  });
  const result = partier.map(parti => ({
    id: parti.id,
    name: parti.navn,
    displayName: parti.display_navn || parti.navn,
    type: parti.type,
    date: parti.dato,
    day: computeDay(parti.dato),
    klasse: parti.klasse,
    bedomming_startet: erBedommingStartet(proveId, parti.navn),
    dogs: deltakere
      .filter(d => d.parti_id === parti.id && (d.status || 'aktiv') !== 'trukket')
      .map(mapDog),
    trukne: deltakere
      .filter(d => d.parti_id === parti.id && d.status === 'trukket')
      .map(mapDog)
  }));

  return c.json(result);
});

// Har bedømming startet på et parti? Returnerer true hvis det finnes en kritikk
// (uansett status, inkludert draft) eller en vk_bedomming-rad for partiet.
// Brukes til å låse rekkefølge-endringer i partilister når dommer har begynt.
function erBedommingStartet(proveId, partiNavn) {
  const k = db.prepare("SELECT 1 FROM kritikker WHERE prove_id = ? AND parti = ? LIMIT 1").get(proveId, partiNavn);
  if (k) return true;
  const v = db.prepare("SELECT 1 FROM vk_bedomming WHERE prove_id = ? AND parti = ? LIMIT 1").get(proveId, partiNavn);
  return !!v;
}

// Bro fra Bok B (parti_deltakere) til Bok A (pameldinger).
// Motivasjon: NKK er kilden til påmeldinger. Admin laster opp NKK-fila og lagrer
// parti_deltakere. Dommer-sidene og kritikk-flyten er bygd på pameldinger. Denne
// funksjonen projiserer B → A slik at dommere/kritikk får data uten at den
// eksisterende admin-flyten endres.
//
// Regler:
// - Én pameldinger-rad per (prove_id, hund_id) — aggregerer dager hvis en hund står
//   i partier på flere dager
// - forer_telefon faller tilbake til NKK_IMPORT-sentinel når NKK-fila ikke har tlf
// - betalt/sauebevis/vaksinasjon/rabies antas OK (NKK-håndhevelse utenfor systemet)
// - status = 'bekreftet' for aktive hunder, 'avmeldt' hvis alle parti-rader er trukket
// - En hund som forsvinner fra parti_deltakere (admin sletter/trekker) får status='avmeldt'
//   i pameldinger — vi sletter aldri rader, slik at FK fra kritikker/avmeldinger holder
function syncPameldingerForProve(proveId) {
  const rows = db.prepare(`
    SELECT pd.hund_regnr, pd.hund_navn, pd.rase, pd.kjonn, pd.klasse,
           pd.eier_navn, pd.eier_telefon, pd.forer_navn, pd.forer_telefon,
           pd.status AS pd_status,
           p.dato AS parti_dato, p.navn AS parti_navn
    FROM parti_deltakere pd
    JOIN partier p ON p.id = pd.parti_id
    WHERE pd.prove_id = ?
  `).all(proveId);

  const prove = db.prepare("SELECT start_dato FROM prover WHERE id = ?").get(proveId);
  const startDato = prove?.start_dato || null;

  const byHund = new Map();
  for (const r of rows) {
    if (!r.hund_regnr) continue;
    if (!byHund.has(r.hund_regnr)) {
      byHund.set(r.hund_regnr, {
        regnr: r.hund_regnr,
        navn: r.hund_navn,
        rase: r.rase,
        kjonn: r.kjonn,
        klasse: r.klasse,
        eier_navn: r.eier_navn,
        eier_telefon: r.eier_telefon,
        forer_navn: r.forer_navn,
        forer_telefon: r.forer_telefon,
        partier: [],
        dags: new Set(),
        alleTrukket: true
      });
    }
    const agg = byHund.get(r.hund_regnr);
    agg.partier.push(r.parti_navn);
    if (r.parti_dato && startDato) {
      const diff = Math.round((new Date(r.parti_dato) - new Date(startDato)) / 86400000) + 1;
      if (diff >= 1) agg.dags.add(diff);
    }
    if (r.pd_status !== 'trukket') agg.alleTrukket = false;
  }

  const upsert = db.prepare(`
    INSERT INTO pameldinger (
      prove_id, hund_id, forer_telefon, klasse, dag, status,
      betalt, sauebevis, vaksinasjon_ok, rabies_ok, parti, pameldt_av_telefon
    ) VALUES (?, ?, ?, ?, ?, ?, 1, 1, 1, 1, ?, 'NKK_IMPORT')
    ON CONFLICT(prove_id, hund_id) DO UPDATE SET
      klasse = excluded.klasse,
      dag = excluded.dag,
      status = excluded.status,
      parti = excluded.parti,
      updated_at = datetime('now')
  `);

  const activeHundIds = [];
  let synkronisert = 0;

  for (const [regnr, agg] of byHund) {
    let hund = db.prepare("SELECT id FROM hunder WHERE regnr = ?").get(regnr);
    if (!hund) {
      try {
        const res = db.prepare(`
          INSERT INTO hunder (regnr, navn, rase, kjonn) VALUES (?, ?, ?, ?)
        `).run(regnr, agg.navn || '', agg.rase || '', agg.kjonn || 'male');
        hund = { id: res.lastInsertRowid };
      } catch (e) { console.warn(`[bro] Kunne ikke opprette hund ${regnr}:`, e.message); continue; }
    }

    const forerTlfKandidat = agg.forer_telefon || agg.eier_telefon || '';
    const brukerFinnes = forerTlfKandidat
      ? db.prepare("SELECT 1 FROM brukere WHERE telefon = ?").get(forerTlfKandidat)
      : null;
    const forerTlf = brukerFinnes ? forerTlfKandidat : 'NKK_IMPORT';

    const klasseRaw = (agg.klasse || 'AK').toUpperCase();
    const klasse = ['UK', 'AK', 'VK'].includes(klasseRaw) ? klasseRaw : 'AK';
    const dagJson = JSON.stringify([...agg.dags].sort((a, b) => a - b));
    const status = agg.alleTrukket ? 'avmeldt' : 'bekreftet';
    const parti = agg.partier[0] || null;

    try {
      upsert.run(proveId, hund.id, forerTlf, klasse, dagJson, status, parti);
      activeHundIds.push(hund.id);
      synkronisert++;
    } catch (e) { console.warn(`[bro] Upsert feilet for hund ${regnr}:`, e.message); }
  }

  // Hunder på venteliste er ikke avmeldt — behold status='venteliste'.
  // Viktig: admin flytter ofte hunder fra parti til venteliste. Uten dette
  // sjekket markerte broen hunden som 'avmeldt' i pameldinger, og siden
  // ingen kritikk/resultat-flyt kan starte fra 'avmeldt', måtte admin
  // manuelt gjenopplive hunden for å legge dem tilbake i parti senere.
  const ventelisteHundIds = db.prepare(`
    SELECT DISTINCT h.id
    FROM venteliste v JOIN hunder h ON h.regnr = v.hund_regnr
    WHERE v.prove_id = ?
  `).all(proveId).map(r => r.id);

  // Hunder som var i pameldinger tidligere men ikke lenger i parti_deltakere:
  // - Hvis de står på venteliste: status='venteliste'
  // - Ellers: status='avmeldt'
  // (ikke slett — FK fra kritikker/avmeldinger kan peke hit)
  let avmeldt = 0;
  let venteliste_markert = 0;

  if (ventelisteHundIds.length > 0) {
    const vPh = ventelisteHundIds.map(() => '?').join(',');
    const vr = db.prepare(`
      UPDATE pameldinger SET status = 'venteliste', updated_at = datetime('now')
      WHERE prove_id = ? AND hund_id IN (${vPh}) AND status NOT IN ('venteliste', 'bekreftet', 'pameldt')
    `).run(proveId, ...ventelisteHundIds);
    venteliste_markert = vr.changes;
  }

  const alleAktiveIds = [...activeHundIds, ...ventelisteHundIds];
  if (alleAktiveIds.length > 0) {
    const placeholders = alleAktiveIds.map(() => '?').join(',');
    const r = db.prepare(`
      UPDATE pameldinger SET status = 'avmeldt', updated_at = datetime('now')
      WHERE prove_id = ? AND hund_id NOT IN (${placeholders}) AND status != 'avmeldt'
    `).run(proveId, ...alleAktiveIds);
    avmeldt = r.changes;
  } else {
    const r = db.prepare(`
      UPDATE pameldinger SET status = 'avmeldt', updated_at = datetime('now')
      WHERE prove_id = ? AND status != 'avmeldt'
    `).run(proveId);
    avmeldt = r.changes;
  }

  return { synkronisert, avmeldt, venteliste_markert };
}

// Lagre partilister (erstatter alle eksisterende for prøven)
app.put("/api/prover/:id/partilister", requireAdmin, async (c) => {
  const proveId = c.req.param("id");
  const body = await c.req.json();
  const { partier } = body;

  if (!Array.isArray(partier)) {
    return c.json({ error: "partier må være en array" }, 400);
  }

  // Verifiser at prøven eksisterer
  const prove = db.prepare("SELECT id FROM prover WHERE id = ?").get(proveId);
  if (!prove) {
    return c.json({ error: "Prøve ikke funnet" }, 404);
  }

  // Lås: hvis bedømming har startet på et parti, avvis rekkefølge-endringer.
  // Tillater likevel at hunder legges til eller fjernes — bare at relativ
  // rekkefølge av felles hunder må være uendret. På den måten kan admin trekke
  // en hund eller legge til en etteranmeldt, men ikke omrokkere midt i bedømming.
  const eksisterende = db.prepare(`
    SELECT pt.navn, pd.hund_regnr, pd.startnummer
    FROM partier pt
    LEFT JOIN parti_deltakere pd ON pd.parti_id = pt.id
    WHERE pt.prove_id = ?
    ORDER BY pt.navn, pd.startnummer
  `).all(proveId);
  const gammelPerParti = new Map();
  for (const r of eksisterende) {
    if (!gammelPerParti.has(r.navn)) gammelPerParti.set(r.navn, []);
    if (r.hund_regnr) gammelPerParti.get(r.navn).push(r.hund_regnr);
  }

  for (const parti of partier) {
    if (!erBedommingStartet(proveId, parti.navn)) continue;
    const gammel = gammelPerParti.get(parti.navn) || [];
    const ny = (parti.dogs || []).map(d => d.regnr).filter(Boolean);
    const nySet = new Set(ny);
    const gammelSet = new Set(gammel);
    // Relativ orden av felles hunder må være lik
    const gammelCommon = gammel.filter(r => nySet.has(r));
    const nyCommon = ny.filter(r => gammelSet.has(r));
    const samme = gammelCommon.length === nyCommon.length &&
      gammelCommon.every((v, i) => v === nyCommon[i]);
    if (!samme) {
      return c.json({
        error: `"${parti.navn}" er låst fordi dommer har startet bedømming. Du kan legge til eller trekke hunder, men ikke endre rekkefølgen mellom hundene som allerede er i partiet.`,
        parti_last: parti.navn
      }, 409);
    }
  }

  try {
    // Start transaksjon
    db.exec("BEGIN TRANSACTION");

    // Full snapshot av parti_deltakere før DELETE — gir forensisk recovery
    // hvis klienten sender en delvis liste (f.eks. PDF-parser som mangler en
    // dag) og data ville gått tapt. Arkivet ryddes til siste 20 per prøve.
    const fullSnapshot = db.prepare(`
      SELECT pd.*, p.navn AS parti_navn, p.dato AS parti_dato, p.type AS parti_type, p.klasse AS parti_klasse
      FROM parti_deltakere pd
      JOIN partier p ON p.id = pd.parti_id
      WHERE pd.prove_id = ?
    `).all(proveId);

    if (fullSnapshot.length > 0) {
      // Sammenlign med innkommende data — advar hvis mer enn 10% av hundene
      // forsvinner (kan indikere bug eller ufullstendig PDF-import).
      const gammelAktiv = fullSnapshot.filter(r => (r.status || 'aktiv') !== 'trukket').length;
      const nyAktiv = partier.reduce((s, p) => s + (Array.isArray(p.dogs) ? p.dogs.length : 0), 0);
      const drop = gammelAktiv - nyAktiv;

      db.prepare(`
        INSERT INTO parti_deltakere_arkiv (prove_id, aarsak, gammel_antall, ny_antall, snapshot_json)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        proveId,
        drop > gammelAktiv * 0.1 ? 'put_partilister_stort_fall' : 'put_partilister',
        gammelAktiv,
        nyAktiv,
        JSON.stringify(fullSnapshot)
      );

      // Rydd opp — behold siste 20 arkiver per prøve
      db.prepare(`
        DELETE FROM parti_deltakere_arkiv
        WHERE prove_id = ? AND id NOT IN (
          SELECT id FROM parti_deltakere_arkiv WHERE prove_id = ?
          ORDER BY arkivert_at DESC LIMIT 20
        )
      `).run(proveId, proveId);
    }

    // Bevar trukne parti_deltakere-rader! Klienten sender kun aktive, så en
    // naiv DELETE-alt ville slette alle hunder som har meldt forfall — og
    // sletter dermed hele historikken. Samler disse opp per (parti-navn, regnr)
    // så vi kan gjeninnsette dem etter parti-rekreering.
    const trukneSnapshot = fullSnapshot.filter(r => r.status === 'trukket');

    // Slett eksisterende partier og deltakere for denne prøven
    db.prepare("DELETE FROM parti_deltakere WHERE prove_id = ?").run(proveId);
    db.prepare("DELETE FROM partier WHERE prove_id = ?").run(proveId);

    // Sett inn nye partier
    const insertParti = db.prepare(`
      INSERT INTO partier (prove_id, navn, display_navn, type, dato, klasse, sortering)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const insertDeltaker = db.prepare(`
      INSERT INTO parti_deltakere (parti_id, prove_id, hund_regnr, hund_navn, rase, kjonn, klasse,
                                   eier_navn, eier_telefon, forer_navn, forer_telefon, startnummer, bekreftet, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Map fra gammelt parti-navn → ny parti_id (fylles nedenfor etter hvert som
    // partier settes inn, slik at trukne kan legges tilbake til rett parti)
    const navnTilNyParti = new Map();

    let sortering = 0;
    for (const parti of partier) {
      // Sett inn parti
      const partiResult = insertParti.run(
        proveId,
        parti.name,
        parti.displayName || parti.name,
        parti.type || 'ukak',
        parti.date || null,
        parti.klasse || null,
        sortering++
      );

      const partiId = partiResult.lastInsertRowid;
      navnTilNyParti.set(parti.name, partiId);

      // Sett inn deltakere (hunder) — startnummer tildeles alltid sekvensielt
      // basert på klientens array-rekkefølge, slik at public partiliste
      // (ORDER BY startnummer) speiler den samme UK-øverst/AK-under-ordenen.
      //
      // KRITISK: status er ALLTID 'aktiv' for dogs i parti.dogs[]. Trukne
      // bevares utelukkende via trukneSnapshot-restoring under. Stale
      // localStorage kunne tidligere inneholde trukne med status='trukket'
      // embedded i parti.dogs — da ble de lagret som trukket i stedet for
      // aktiv, og brukeren så "endringer forsvinner" fordi deres aktive
      // dog ble shadow'd av trukne-restore (dup-check på regnr hoppet over
      // aktiv-insertet). Dedupliker også på regnr i samme parti så ikke en
      // stale dobbeltoppføring ender opp som to rader.
      //
      // ENRICHMENT FRA HUNDER-TABELL: Klient-data kan være stale (admin
      // har f.eks. oppdatert eier_navn via admin-panel.html siden client
      // sist hentet partiet). Vi prioriterer derfor verdier fra hunder-
      // tabellen (kanonisk kilde) og faller tilbake til klient-data kun
      // når hunder-tabellen ikke har feltet satt. Dette hindrer at en PUT
      // partilister overskriver nyere endringer fra admin-panel.html.
      const hundLookup = db.prepare("SELECT navn, rase, kjonn, eier_navn, eier_telefon FROM hunder WHERE regnr = ?");

      if (Array.isArray(parti.dogs)) {
        let startnummer = 1;
        const seenRegnrs = new Set();
        for (const dog of parti.dogs) {
          const regnr = dog.regnr || '';
          if (regnr && seenRegnrs.has(regnr)) {
            // Duplikat innen samme parti — hopp over (UNIQUE constraint
            // ville uansett kastet; bedre å ignorere stille).
            continue;
          }
          if (regnr) seenRegnrs.add(regnr);

          const hund = regnr ? hundLookup.get(regnr) : null;

          insertDeltaker.run(
            partiId,
            proveId,
            regnr,
            // hunder.navn er kanonisk; fall tilbake til klient
            (hund?.navn || dog.hundenavn || dog.navn || ''),
            normalizeRase(hund?.rase || dog.rase),
            (hund?.kjonn || dog.kjonn || ''),
            dog.klasse || '',
            // KRITISK for issue: hunder.eier_navn (oppdatert via admin-
            // panel) prioriteres over klient-data. NULL-felt på hunder
            // betyr at admin ikke har endret — bruk klientens (NKK PDF
            // kan ha denormalisert eier_navn uten å fylle hunder-tabellen).
            (hund?.eier_navn || dog.eier || ''),
            (hund?.eier_telefon || dog.eierTelefon || ''),
            dog.forer || '',
            dog.forerTelefon || '',
            startnummer++,
            dog.confirmed ? 1 : 0,
            'aktiv'  // force aktiv — aldri bevare klient-sent trukket
          );
        }
      }
    }

    // Gjeninnsett trukne-rader som ble samlet før DELETE. Sett dem til samme
    // parti-navn om det finnes, ellers hopp over (partiet eksisterer ikke lenger
    // og det gir ingen mening å ha en trukket-rad uten parti).
    // Ikke overskriv hvis klienten har sendt samme regnr som aktiv i samme parti.
    let gjeninnsatt = 0;
    for (const t of trukneSnapshot) {
      const nyId = navnTilNyParti.get(t.parti_navn);
      if (!nyId) continue;
      // Sjekk: er regnr allerede lagt inn som aktiv i det nye partiet?
      const finnes = db.prepare(`
        SELECT 1 FROM parti_deltakere
        WHERE parti_id = ? AND hund_regnr = ? LIMIT 1
      `).get(nyId, t.hund_regnr);
      if (finnes) continue;
      insertDeltaker.run(
        nyId, proveId, t.hund_regnr, t.hund_navn, t.rase, t.kjonn, t.klasse,
        t.eier_navn, t.eier_telefon, t.forer_navn, t.forer_telefon,
        t.startnummer || 99, t.bekreftet || 0, 'trukket'
      );
      gjeninnsatt++;
    }

    db.exec("COMMIT");

    // Bro fra Bok B → Bok A: projiser parti_deltakere til pameldinger slik at
    // dommer-sidene/kritikk-flyten får data. Kjøres utenfor hovedtransaksjonen
    // så en bro-feil ikke ruller tilbake parti-lagringen.
    let broResultat = null;
    try {
      broResultat = syncPameldingerForProve(proveId);
    } catch (e) { console.error('[bro] syncPameldingerForProve feilet:', e); }

    db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").run(
      "partilister_lagret",
      `Lagret ${partier.length} partier med totalt ${partier.reduce((sum, p) => sum + (p.dogs?.length || 0), 0)} deltakere for prøve ${proveId}` +
      (broResultat ? ` (bro: ${broResultat.synkronisert} synk, ${broResultat.avmeldt} avmeldt)` : '')
    );

    return c.json({
      success: true,
      partier: partier.length,
      deltakere: partier.reduce((sum, p) => sum + (p.dogs?.length || 0), 0),
      bro: broResultat
    });

  } catch (err) {
    db.exec("ROLLBACK");
    console.error("Feil ved lagring av partilister:", err);
    return c.json({ error: err.message }, 500);
  }
});

// Hent venteliste for en prøve
app.get("/api/prover/:id/venteliste", (c) => {
  const proveId = c.req.param("id");

  const venteliste = db.prepare(`
    SELECT * FROM venteliste WHERE prove_id = ? ORDER BY dag, klasse, prioritet
  `).all(proveId);

  // Grupper etter dag og klasse (matcher localStorage-format, støtter 1-4 dager)
  const result = {
    dag1: { uk: [], ak: [] },
    dag2: { uk: [], ak: [] },
    dag3: { uk: [], ak: [] },
    dag4: { uk: [], ak: [] },
    vk: []
  };

  for (const v of venteliste) {
    const entry = {
      regnr: v.hund_regnr,
      hundenavn: v.hund_navn,
      rase: v.rase,
      klasse: v.klasse,
      eier: v.eier_navn,
      forer: v.forer_navn
    };

    if (v.klasse === 'VK') {
      result.vk.push(entry);
    } else if (v.dag >= 1 && v.dag <= 4) {
      const dagKey = `dag${v.dag}`;
      if (v.klasse === 'UK') result[dagKey].uk.push(entry);
      else result[dagKey].ak.push(entry);
    }
  }

  return c.json(result);
});

// Lagre venteliste
app.put("/api/prover/:id/venteliste", requireAdmin, async (c) => {
  const proveId = c.req.param("id");
  const body = await c.req.json();
  const { venteliste } = body;

  if (!venteliste || typeof venteliste !== 'object') {
    return c.json({ error: "venteliste må være et objekt" }, 400);
  }

  // Bygg set over (regnr, dag) og (regnr, 'VK') som allerede har plass i et parti —
  // disse skal aldri stå på venteliste samtidig. Uten dette kan gammel/bugget klient-state
  // sende en duplikat som har oppstått fra en tidligere feilklassifisering.
  const prove = db.prepare("SELECT start_dato FROM prover WHERE id = ?").get(proveId);
  const startDato = prove?.start_dato || null;
  const partiRader = db.prepare(`
    SELECT pd.hund_regnr, p.dato, p.type
    FROM parti_deltakere pd
    JOIN partier p ON p.id = pd.parti_id
    WHERE pd.prove_id = ? AND pd.status != 'trukket'
  `).all(proveId);
  const iParti = new Set();
  for (const r of partiRader) {
    if (r.type === 'vk') {
      iParti.add(`${r.hund_regnr}|VK`);
    } else if (r.dato && startDato) {
      const dag = Math.round((new Date(r.dato) - new Date(startDato)) / 86400000) + 1;
      if (dag >= 1) iParti.add(`${r.hund_regnr}|${dag}`);
    }
  }

  try {
    const insert = db.prepare(`
      INSERT INTO venteliste (prove_id, hund_regnr, hund_navn, rase, klasse, dag, eier_navn, forer_navn, prioritet)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let skipped = 0;

    const saveAll = db.transaction(() => {
      db.prepare("DELETE FROM venteliste WHERE prove_id = ?").run(proveId);

      let total = 0;

      for (let d = 1; d <= 4; d++) {
        const dagKey = `dag${d}`;
        if (Array.isArray(venteliste[dagKey]?.uk)) {
          let prio = 0;
          for (const v of venteliste[dagKey].uk) {
            if (v.regnr && iParti.has(`${v.regnr}|${d}`)) { skipped++; continue; }
            insert.run(proveId, v.regnr || '', v.hundenavn || '', v.rase || '', 'UK', d, v.eier || '', v.forer || '', prio++);
            total++;
          }
        }
        if (Array.isArray(venteliste[dagKey]?.ak)) {
          let prio = 0;
          for (const v of venteliste[dagKey].ak) {
            if (v.regnr && iParti.has(`${v.regnr}|${d}`)) { skipped++; continue; }
            insert.run(proveId, v.regnr || '', v.hundenavn || '', v.rase || '', 'AK', d, v.eier || '', v.forer || '', prio++);
            total++;
          }
        }
      }

      if (Array.isArray(venteliste.vk)) {
        let prio = 0;
        for (const v of venteliste.vk) {
          if (v.regnr && iParti.has(`${v.regnr}|VK`)) { skipped++; continue; }
          insert.run(proveId, v.regnr || '', v.hundenavn || '', v.rase || '', 'VK', null, v.eier || '', v.forer || '', prio++);
          total++;
        }
      }

      return total;
    });

    const total = saveAll();

    db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").run(
      "venteliste_lagret",
      `Lagret venteliste med ${total} hunder for prøve ${proveId}${skipped > 0 ? ` (hoppet over ${skipped} som allerede står i parti)` : ''}`
    );

    return c.json({ success: true, total, skipped });

  } catch (err) {
    console.error("Feil ved lagring av venteliste:", err);
    return c.json({ error: err.message }, 500);
  }
});

// Hent prøver for en bruker (der brukeren har en rolle ELLER er påmeldt som deltaker ELLER er team-medlem)
app.get("/api/brukere/:telefon/prover", (c) => {
  const telefon = c.req.param("telefon");

  // Finn prøver der bruker er prøveleder, NKK-rep, dommer, NKK-vara, DVK, DELTAKER, eller TEAM-MEDLEM
  const prover = db.prepare(`
    SELECT DISTINCT p.*, k.navn as klubb_navn,
           CASE
             WHEN p.proveleder_telefon = ? THEN 'proveleder'
             WHEN p.nkkrep_telefon = ? THEN 'nkkrep'
             WHEN p.nkkvara_telefon = ? THEN 'nkkvara'
             WHEN p.dvk_telefon = ? THEN 'dvk'
             ELSE NULL
           END as admin_rolle,
           CASE
             WHEN EXISTS (
               SELECT 1 FROM pameldinger pm
               JOIN hunder h ON pm.hund_id = h.id
               WHERE pm.prove_id = p.id
                 AND (pm.forer_telefon = ? OR h.eier_telefon = ?)
                 AND pm.status NOT IN ('avmeldt')
             ) THEN 1
             WHEN EXISTS (
               SELECT 1 FROM parti_deltakere pd
               WHERE pd.prove_id = p.id AND pd.forer_telefon = ?
             ) THEN 1
             ELSE 0
           END as er_deltaker,
           (SELECT rolle FROM prove_team WHERE prove_id = p.id AND telefon = ?) as team_rolle
    FROM prover p
    LEFT JOIN klubber k ON p.klubb_id = k.id
    WHERE p.proveleder_telefon = ?
       OR p.nkkrep_telefon = ?
       OR p.nkkvara_telefon = ?
       OR p.dvk_telefon = ?
       OR p.id IN (SELECT prove_id FROM dommer_tildelinger WHERE dommer_telefon = ?)
       OR p.id IN (
         SELECT pm.prove_id FROM pameldinger pm
         JOIN hunder h ON pm.hund_id = h.id
         WHERE (pm.forer_telefon = ? OR h.eier_telefon = ?)
           AND pm.status NOT IN ('avmeldt')
       )
       OR p.id IN (
         SELECT pd.prove_id FROM parti_deltakere pd
         WHERE pd.forer_telefon = ?
       )
       OR p.id IN (
         SELECT prove_id FROM prove_team WHERE telefon = ?
       )
    ORDER BY p.start_dato DESC
  `).all(
    telefon, telefon, telefon, telefon, telefon, telefon, telefon, telefon,
    telefon, telefon, telefon, telefon, telefon, telefon, telefon, telefon, telefon
  );

  // Hent dommer-info for hver prøve
  const getDommerInfo = db.prepare("SELECT parti, dommer_rolle FROM dommer_tildelinger WHERE prove_id = ? AND dommer_telefon = ?");

  const result = prover.map(p => {
    const dommerInfo = getDommerInfo.get(p.id, telefon);
    return {
      ...p,
      klasser: JSON.parse(p.klasser || '{}'),
      partier: JSON.parse(p.partier || '{}'),
      dommerInfo: dommerInfo || null,
      erDeltaker: p.er_deltaker === 1,
      teamRolle: p.team_rolle || null
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

// Last opp og analyser aversjonsbevis med AI (utvidet versjon)
app.post("/api/hunder/:id/aversjonsbevis/analyser", async (c) => {
  const id = c.req.param("id");

  // Sjekk at hunden finnes
  const hund = db.prepare("SELECT * FROM hunder WHERE id = ?").get(id);
  if (!hund) return c.json({ error: "Hund ikke funnet" }, 404);

  const body = await c.req.json();
  const { bilde } = body;

  if (!bilde) {
    return c.json({ error: "Bilde er påkrevd" }, 400);
  }

  // Sjekk at bildet er base64 og ikke for stort (maks 10MB for AI-analyse)
  let base64Data = bilde;
  let mediaType = "image/jpeg";

  // Håndter data URL format
  const dataUrlMatch = bilde.match(/^data:(image\/[a-z]+|application\/pdf);base64,(.+)$/i);
  if (dataUrlMatch) {
    mediaType = dataUrlMatch[1];
    base64Data = dataUrlMatch[2];
  }

  const sizeInBytes = (base64Data.length * 3) / 4;
  const maxSize = 10 * 1024 * 1024; // 10MB

  if (sizeInBytes > maxSize) {
    return c.json({ error: "Filen er for stor. Maks 10MB tillatt." }, 400);
  }

  // Hvis AI ikke er konfigurert, returner en melding om manuell utfylling
  if (!aiConfigured) {
    // Lagre bildet uten AI-analyse
    db.prepare(`
      UPDATE hunder
      SET aversjonsbevis = ?,
          aversjonsbevis_dato = ?,
          aversjonsbevis_godkjent = 0,
          aversjonsbevis_bekreftet = 0
      WHERE id = ?
    `).run(bilde, new Date().toISOString().slice(0, 10), id);

    return c.json({
      success: true,
      aiAnalyse: false,
      melding: "Bilde lagret. AI-avlesning er ikke konfigurert - vennligst fyll inn feltene manuelt.",
      avlestData: null
    });
  }

  // Kall Claude API for bildeanalyse
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        messages: [{
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: mediaType,
                data: base64Data
              }
            },
            {
              type: "text",
              text: `Analyser dette aversjonsbeviset for en hund. Trekk ut følgende informasjon og returner som JSON:

{
  "dyretype": "Sau eller Rein (hva hunden har aversjon mot)",
  "gyldig": true/false (om beviset viser at hunden er godkjent/gyldig),
  "chip_id": "Hundens ID-nummer/chip-nummer (15 siffer)",
  "hundenavn": "Hundens fulle navn",
  "regnr": "Registreringsnummer (f.eks. NO12345/2020 eller DK14775/2018)",
  "rase": "Hundens rase",
  "dato_godkjent": "Dato for godkjent aversjon (format: YYYY-MM-DD)",
  "dato_utstedt": "Dagens dato på beviset (format: YYYY-MM-DD)",
  "lesbarhet": "god/middels/dårlig - hvor lesbart er dokumentet",
  "kommentar": "Eventuelle merknader om avlesningen"
}

Returner KUN gyldig JSON, ingen annen tekst. Hvis et felt ikke kan leses, sett verdien til null.`
            }
          ]
        }]
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Claude API feil:", errorText);

      // Lagre bildet uten AI-data ved feil
      db.prepare(`
        UPDATE hunder
        SET aversjonsbevis = ?,
            aversjonsbevis_dato = ?,
            aversjonsbevis_godkjent = 0,
            aversjonsbevis_bekreftet = 0
        WHERE id = ?
      `).run(bilde, new Date().toISOString().slice(0, 10), id);

      return c.json({
        success: true,
        aiAnalyse: false,
        melding: "Bilde lagret, men AI-avlesning feilet. Vennligst fyll inn feltene manuelt.",
        avlestData: null
      });
    }

    const aiResponse = await response.json();
    const aiText = aiResponse.content?.[0]?.text || "";

    // Parse JSON fra AI-respons
    let avlestData = null;
    try {
      // Finn JSON i responsen (kan være pakket inn i markdown code blocks)
      const jsonMatch = aiText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        avlestData = JSON.parse(jsonMatch[0]);
      }
    } catch (parseErr) {
      console.error("Kunne ikke parse AI-respons:", parseErr, aiText);
    }

    // Lagre bildet og AI-avlest data
    db.prepare(`
      UPDATE hunder
      SET aversjonsbevis = ?,
          aversjonsbevis_dato = ?,
          aversjonsbevis_dyretype = ?,
          aversjonsbevis_chip_id = ?,
          aversjonsbevis_avlest_navn = ?,
          aversjonsbevis_avlest_regnr = ?,
          aversjonsbevis_avlest_rase = ?,
          aversjonsbevis_gyldig = ?,
          aversjonsbevis_godkjent = 0,
          aversjonsbevis_bekreftet = 0
      WHERE id = ?
    `).run(
      bilde,
      avlestData?.dato_godkjent || new Date().toISOString().slice(0, 10),
      avlestData?.dyretype || null,
      avlestData?.chip_id || null,
      avlestData?.hundenavn || null,
      avlestData?.regnr || null,
      avlestData?.rase || null,
      avlestData?.gyldig === true ? 1 : (avlestData?.gyldig === false ? 0 : null),
      id
    );

    // Sjekk om avlest data matcher hundens registrerte data
    const matchWarnings = [];
    if (avlestData?.regnr && hund.regnr) {
      const normalizedAvlest = (avlestData.regnr || "").replace(/\s/g, "").toUpperCase();
      const normalizedHund = (hund.regnr || "").replace(/\s/g, "").toUpperCase();
      if (normalizedAvlest !== normalizedHund) {
        matchWarnings.push(`Registreringsnummer på beviset (${avlestData.regnr}) stemmer ikke med hundens registrerte nummer (${hund.regnr})`);
      }
    }
    if (avlestData?.hundenavn && hund.navn) {
      const navnLikhet = avlestData.hundenavn.toLowerCase().includes(hund.navn.toLowerCase()) ||
                         hund.navn.toLowerCase().includes(avlestData.hundenavn.toLowerCase());
      if (!navnLikhet) {
        matchWarnings.push(`Hundenavn på beviset (${avlestData.hundenavn}) kan avvike fra registrert navn (${hund.navn})`);
      }
    }

    return c.json({
      success: true,
      aiAnalyse: true,
      avlestData: avlestData,
      matchWarnings: matchWarnings,
      lesbarhet: avlestData?.lesbarhet || "ukjent",
      melding: avlestData?.lesbarhet === "dårlig"
        ? "Dokumentet var vanskelig å lese. Vennligst kontroller at dataen er riktig."
        : "Aversjonsbevis analysert. Vennligst bekreft at informasjonen er korrekt."
    });

  } catch (err) {
    console.error("AI-analyse feil:", err);

    // Lagre bildet ved feil
    db.prepare(`
      UPDATE hunder
      SET aversjonsbevis = ?,
          aversjonsbevis_dato = ?,
          aversjonsbevis_godkjent = 0,
          aversjonsbevis_bekreftet = 0
      WHERE id = ?
    `).run(bilde, new Date().toISOString().slice(0, 10), id);

    return c.json({
      success: true,
      aiAnalyse: false,
      melding: "Bilde lagret, men AI-avlesning feilet. Vennligst fyll inn feltene manuelt.",
      avlestData: null
    });
  }
});

// Bekreft/oppdater avlest aversjonsbevis-data
app.post("/api/hunder/:id/aversjonsbevis/bekreft", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();

  const {
    dyretype,
    chip_id,
    hundenavn,
    regnr,
    rase,
    dato_godkjent,
    gyldig,
    bekreftet_av
  } = body;

  db.prepare(`
    UPDATE hunder
    SET aversjonsbevis_dyretype = ?,
        aversjonsbevis_chip_id = ?,
        aversjonsbevis_avlest_navn = ?,
        aversjonsbevis_avlest_regnr = ?,
        aversjonsbevis_avlest_rase = ?,
        aversjonsbevis_dato = ?,
        aversjonsbevis_gyldig = ?,
        aversjonsbevis_bekreftet = 1,
        aversjonsbevis_bekreftet_av = ?,
        aversjonsbevis_bekreftet_dato = ?
    WHERE id = ?
  `).run(
    dyretype || null,
    chip_id || null,
    hundenavn || null,
    regnr || null,
    rase || null,
    dato_godkjent || null,
    gyldig === true ? 1 : (gyldig === false ? 0 : null),
    bekreftet_av || null,
    new Date().toISOString(),
    id
  );

  return c.json({ success: true, message: "Aversjonsbevis bekreftet og lagret" });
});

// Hent alle hunder med aversjonsbevis-status (for DVK/admin)
app.get("/api/prover/:proveId/aversjonsbevis-oversikt", (c) => {
  const proveId = c.req.param("proveId");

  // Hent alle deltakere på prøven med aversjonsbevis-info
  const deltakere = db.prepare(`
    SELECT
      h.id,
      h.navn,
      h.regnr,
      h.rase,
      h.aversjonsbevis IS NOT NULL as har_bevis,
      h.aversjonsbevis_dyretype as dyretype,
      h.aversjonsbevis_dato as aversjon_dato,
      h.aversjonsbevis_gyldig as gyldig,
      h.aversjonsbevis_bekreftet as bekreftet,
      h.aversjonsbevis_godkjent as godkjent,
      pd.klasse,
      p.navn as parti,
      pd.eier_navn,
      pd.eier_telefon
    FROM parti_deltakere pd
    LEFT JOIN hunder h ON pd.hund_regnr = h.regnr
    LEFT JOIN partier p ON pd.parti_id = p.id
    WHERE pd.prove_id = ?
    ORDER BY h.aversjonsbevis IS NULL DESC, h.navn ASC
  `).all(proveId);

  // Beregn statistikk
  const total = deltakere.length;
  const medBevis = deltakere.filter(d => d.har_bevis).length;
  const utenBevis = total - medBevis;
  const bekreftet = deltakere.filter(d => d.bekreftet).length;
  const godkjent = deltakere.filter(d => d.godkjent).length;

  return c.json({
    deltakere,
    statistikk: {
      total,
      medBevis,
      utenBevis,
      bekreftet,
      godkjent
    }
  });
});

// Hent utvidet aversjonsbevis-info for en hund
app.get("/api/hunder/:id/aversjonsbevis/detaljer", (c) => {
  const id = c.req.param("id");
  const hund = db.prepare(`
    SELECT
      id, navn, regnr, rase,
      aversjonsbevis,
      aversjonsbevis_dato,
      aversjonsbevis_dyretype,
      aversjonsbevis_chip_id,
      aversjonsbevis_avlest_navn,
      aversjonsbevis_avlest_regnr,
      aversjonsbevis_avlest_rase,
      aversjonsbevis_gyldig,
      aversjonsbevis_godkjent,
      aversjonsbevis_bekreftet,
      aversjonsbevis_bekreftet_av,
      aversjonsbevis_bekreftet_dato
    FROM hunder WHERE id = ?
  `).get(id);

  if (!hund) return c.json({ error: "Hund ikke funnet" }, 404);

  return c.json({
    harBevis: !!hund.aversjonsbevis,
    bilde: hund.aversjonsbevis,
    datoGodkjent: hund.aversjonsbevis_dato,
    dyretype: hund.aversjonsbevis_dyretype,
    chipId: hund.aversjonsbevis_chip_id,
    avlestNavn: hund.aversjonsbevis_avlest_navn,
    avlestRegnr: hund.aversjonsbevis_avlest_regnr,
    avlestRase: hund.aversjonsbevis_avlest_rase,
    gyldig: hund.aversjonsbevis_gyldig === 1,
    godkjent: hund.aversjonsbevis_godkjent === 1,
    bekreftet: hund.aversjonsbevis_bekreftet === 1,
    bekreftetAv: hund.aversjonsbevis_bekreftet_av,
    bekreftetDato: hund.aversjonsbevis_bekreftet_dato,
    // Registrert data for sammenligning
    registrert: {
      navn: hund.navn,
      regnr: hund.regnr,
      rase: hund.rase
    }
  });
});

// ============================================
// EIERBEVIS API
// ============================================

// Last opp eierbevis for en hund
app.post("/api/hunder/:id/eierbevis", async (c) => {
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
    SET eierbevis = ?,
        eierbevis_dato = ?
    WHERE id = ?
  `).run(bilde, dato || new Date().toISOString().slice(0, 10), id);

  console.log(`[Eierbevis] Lastet opp for hund ${id} (${hund.navn})`);

  return c.json({
    success: true,
    message: "Eierbevis lastet opp og lagret."
  });
});

// Hent eierbevis for en hund
app.get("/api/hunder/:id/eierbevis", (c) => {
  const id = c.req.param("id");
  const hund = db.prepare(`
    SELECT id, navn, regnr, eierbevis, eierbevis_dato
    FROM hunder WHERE id = ?
  `).get(id);

  if (!hund) return c.json({ error: "Hund ikke funnet" }, 404);

  return c.json({
    harEierbevis: !!hund.eierbevis,
    bilde: hund.eierbevis,
    dato: hund.eierbevis_dato
  });
});

// Slett eierbevis
app.delete("/api/hunder/:id/eierbevis", (c) => {
  const id = c.req.param("id");

  db.prepare(`
    UPDATE hunder
    SET eierbevis = NULL,
        eierbevis_dato = NULL
    WHERE id = ?
  `).run(id);

  return c.json({ success: true });
});

// ============================================
// PARTILISTE API
// ============================================

// Hent partiliste med hunder for et parti
app.get("/api/partiliste/:partyId", (c) => {
  const partyId = c.req.param("partyId");
  const proveId = c.req.query("prove_id");

  // Finn aktiv prøve hvis ikke spesifisert
  let prove = null;
  if (proveId) {
    prove = db.prepare("SELECT * FROM prover WHERE id = ?").get(proveId);
  } else {
    // Finn nyeste aktive prøve (støtter både norsk og engelsk status)
    prove = db.prepare("SELECT * FROM prover WHERE status IN ('aktiv', 'active', 'publisert', 'published', 'pagaende', 'ongoing') ORDER BY created_at DESC LIMIT 1").get();
  }

  if (!prove) {
    return c.json({ error: "Ingen aktiv prøve funnet" }, 404);
  }

  // Primærkilde: parti_deltakere (NKK-fil-basert, authoritativ for partirekkefølge).
  // Joiner pameldinger for påmelding-felter (pamelding_id, status) og hunder for hund_id/kjønn/fodt.
  // ORDER BY pd.startnummer sikrer UK-øverst/AK-under-rekkefølgen som er normalisert der.
  let hunder = db.prepare(`
    SELECT
      pm.id as pamelding_id,
      pd.klasse,
      pt.navn as parti,
      pm.forer_telefon,
      h.id as hund_id,
      COALESCE(h.navn, pd.hund_navn) as navn,
      pd.hund_regnr as regnr,
      COALESCE(h.rase, pd.rase) as rase,
      COALESCE(h.kjonn, pd.kjonn) as kjonn,
      h.fodt,
      pd.eier_navn,
      pd.forer_navn,
      pd.startnummer
    FROM parti_deltakere pd
    JOIN partier pt ON pt.id = pd.parti_id
    LEFT JOIN hunder h ON h.regnr = pd.hund_regnr
    LEFT JOIN pameldinger pm ON pm.prove_id = pd.prove_id AND pm.hund_id = h.id
    WHERE pd.prove_id = ? AND pt.navn = ? AND COALESCE(pd.status, 'aktiv') != 'trukket'
    ORDER BY pd.startnummer
  `).all(prove.id, partyId);

  // Fallback: hvis parti_deltakere er tom (prøve som kun bruker digital pamelding-flyt),
  // les direkte fra pameldinger. Beholder bakoverkompatibilitet med legacy-flyten.
  if (hunder.length === 0) {
    hunder = db.prepare(`
      SELECT
        p.id as pamelding_id,
        p.klasse,
        p.parti,
        p.forer_telefon,
        h.id as hund_id,
        h.navn,
        h.regnr,
        h.rase,
        h.kjonn,
        h.fodt,
        b_eier.fornavn || ' ' || b_eier.etternavn as eier_navn,
        b_forer.fornavn || ' ' || b_forer.etternavn as forer_navn,
        p.startnummer
      FROM pameldinger p
      JOIN hunder h ON p.hund_id = h.id
      LEFT JOIN brukere b_eier ON h.eier_telefon = b_eier.telefon
      LEFT JOIN brukere b_forer ON p.forer_telefon = b_forer.telefon
      WHERE p.prove_id = ? AND p.parti = ? AND p.status = 'bekreftet'
      ORDER BY
        CASE p.klasse WHEN 'UK' THEN 1 WHEN 'AK' THEN 2 WHEN 'VK' THEN 3 ELSE 4 END,
        p.startnummer, p.id
    `).all(prove.id, partyId);
  }

  return c.json({
    prove_id: prove.id,
    prove_navn: prove.navn,
    parti: partyId,
    parti_navn: partyId.toUpperCase().replace('UKAK', 'UK/AK Parti ').replace('VK', 'VK Parti '),
    hunder
  });
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
  const { dommerTelefon, dommerNavn } = body;

  if (!dommerTelefon) {
    return c.json({ error: "Mangler dommerTelefon" }, 400);
  }

  // Sjekk om signatur allerede finnes
  const existing = db.prepare(`
    SELECT * FROM parti_signaturer
    WHERE prove_id = ? AND parti = ? AND dommer_telefon = ?
  `).get(proveId, parti, dommerTelefon);

  if (existing) {
    // Oppdater eksisterende - inkluder dommer_navn hvis oppgitt
    if (dommerNavn) {
      db.prepare(`
        UPDATE parti_signaturer
        SET dommer_signert_at = datetime('now'), dommer_navn = ?
        WHERE id = ?
      `).run(dommerNavn, existing.id);
    } else {
      db.prepare(`
        UPDATE parti_signaturer
        SET dommer_signert_at = datetime('now')
        WHERE id = ?
      `).run(existing.id);
    }
  } else {
    // Opprett ny - inkluder dommer_navn hvis oppgitt
    if (dommerNavn) {
      db.prepare(`
        INSERT INTO parti_signaturer (prove_id, parti, dommer_telefon, dommer_navn, dommer_signert_at)
        VALUES (?, ?, ?, ?, datetime('now'))
      `).run(proveId, parti, dommerTelefon, dommerNavn);
    } else {
      db.prepare(`
        INSERT INTO parti_signaturer (prove_id, parti, dommer_telefon, dommer_signert_at)
        VALUES (?, ?, ?, datetime('now'))
      `).run(proveId, parti, dommerTelefon);
    }
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

// Hent alle kritikker for en hund (støtter både id og regnr)
app.get("/api/hunder/:id/kritikker", (c) => {
  const idParam = c.req.param("id");

  // Prøv først å finne hund via regnr (for kompatibilitet med frontend)
  let hund = null;
  if (isNaN(parseInt(idParam))) {
    // Ikke et tall, sannsynligvis regnr
    hund = db.prepare("SELECT id FROM hunder WHERE regnr = ?").get(idParam);
  }

  // Bruk hund_id direkte, eller funnet hund-ID fra regnr
  const hundId = hund ? hund.id : idParam;

  const kritikker = db.prepare(`
    SELECT k.*,
           h.navn as hund_navn, h.regnr,
           p.navn as prove_navn, p.sted as prove_sted,
           b.fornavn || ' ' || b.etternavn as dommer_navn
    FROM kritikker k
    LEFT JOIN hunder h ON k.hund_id = h.id
    LEFT JOIN prover p ON k.prove_id = p.id
    LEFT JOIN brukere b ON k.dommer_telefon = b.telefon
    WHERE k.hund_id = ? OR h.regnr = ?
    ORDER BY k.dato DESC
  `).all(hundId, idParam);
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

// Hent full data for PDF-visning av kritikk — matcher FKF-jaktprøveskjemaets layout.
// Samler kritikk, hund (inkl. foreldre), eier/fører, prøve-info, ref.nr fra
// nkkRapportDraft, alle dommere for partiet, og startnummer hvis i parti_deltakere.
app.get("/api/kritikker/:id/visning", (c) => {
  const id = c.req.param("id");
  const k = db.prepare(`
    SELECT k.*,
           h.navn as hund_navn, h.regnr, h.rase, h.kjonn, h.fodt,
           h.far_regnr, h.mor_regnr, h.eier_telefon,
           p.navn as prove_navn, p.sted as prove_sted,
           p.start_dato, p.slutt_dato,
           b.fornavn || ' ' || b.etternavn as dommer_navn
    FROM kritikker k
    LEFT JOIN hunder h ON k.hund_id = h.id
    LEFT JOIN prover p ON k.prove_id = p.id
    LEFT JOIN brukere b ON k.dommer_telefon = b.telefon
    WHERE k.id = ?
  `).get(id);
  if (!k) return c.json({ error: "Kritikk ikke funnet" }, 404);

  // Hundens foreldre (far/mor navn) fra hunder-tabellen hvis regnr er registrert
  const far = k.far_regnr ? db.prepare("SELECT navn, regnr FROM hunder WHERE regnr = ?").get(k.far_regnr) : null;
  const mor = k.mor_regnr ? db.prepare("SELECT navn, regnr FROM hunder WHERE regnr = ?").get(k.mor_regnr) : null;

  // Eier fra hunder.eier_telefon → brukere. Fallback til parti_deltakere.eier_navn
  // hvis bruker ikke er koblet (typisk for NKK-importerte hunder)
  let eier = null;
  if (k.eier_telefon) {
    eier = db.prepare(`
      SELECT fornavn, etternavn, adresse, postnummer, sted, telefon
      FROM brukere WHERE telefon = ?
    `).get(k.eier_telefon);
  }
  // Fører + eier fra parti_deltakere (samme rad, siden NKK-fila gir denormalisert info)
  const pd = db.prepare(`
    SELECT pd.eier_navn, pd.eier_telefon as pd_eier_tlf,
           pd.forer_navn, pd.forer_telefon as pd_forer_tlf,
           pd.startnummer
    FROM parti_deltakere pd
    JOIN partier pt ON pt.id = pd.parti_id
    WHERE pd.prove_id = ? AND pd.hund_regnr = ? AND pt.navn = ?
    LIMIT 1
  `).get(k.prove_id, k.regnr, k.parti);

  // Alle dommere tildelt dette partiet (i signaturlinjer-formålet)
  const dommere = db.prepare(`
    SELECT dt.dommer_telefon, dt.dommer_rolle, dt.begrunnelse_type,
           b.fornavn || ' ' || b.etternavn as navn
    FROM dommer_tildelinger dt
    JOIN brukere b ON dt.dommer_telefon = b.telefon
    WHERE dt.prove_id = ? AND dt.parti = ?
    ORDER BY dt.dommer_rolle NULLS LAST, b.etternavn
  `).all(k.prove_id, k.parti);

  // NKK-referansenummer fra nkkRapportDraft kv_store
  let nkkRefNr = null;
  const draftRow = db.prepare("SELECT value FROM kv_store WHERE key = ?").get(`nkkRapportDraft_${k.prove_id}`);
  if (draftRow?.value) {
    try {
      const draft = JSON.parse(draftRow.value);
      nkkRefNr = draft.refNr || null;
    } catch (e) {}
  }

  return c.json({
    kritikk: {
      id: k.id,
      dato: k.dato,
      klasse: k.klasse,
      parti: k.parti,
      sted: k.sted,
      presisjon: k.presisjon,
      reising: k.reising,
      godkjent_reising: k.godkjent_reising,
      stand_m: k.stand_m, stand_u: k.stand_u,
      tomstand: k.tomstand, makker_stand: k.makker_stand,
      sjanse: k.sjanse, slipptid: k.slipptid,
      jaktlyst: k.jaktlyst, fart: k.fart,
      selvstendighet: k.selvstendighet, soksbredde: k.soksbredde,
      reviering: k.reviering, samarbeid: k.samarbeid,
      sek_spontan: k.sek_spontan, sek_forbi: k.sek_forbi,
      apport: k.apport, rapport_spontan: k.rapport_spontan,
      adferd: k.adferd, premie: k.premie,
      kritikk_tekst: k.kritikk_tekst,
      status: k.status, approved_at: k.approved_at
    },
    hund: {
      id: k.hund_id,
      navn: k.hund_navn,
      regnr: k.regnr,
      rase: k.rase,
      kjonn: k.kjonn,
      fodt: k.fodt,
      far: far ? `${far.navn}${far.regnr ? ' (' + far.regnr + ')' : ''}` : null,
      mor: mor ? `${mor.navn}${mor.regnr ? ' (' + mor.regnr + ')' : ''}` : null,
      far_regnr: k.far_regnr,
      mor_regnr: k.mor_regnr
    },
    eier: {
      navn: eier ? `${eier.fornavn} ${eier.etternavn}` : (pd?.eier_navn || null),
      adresse: eier?.adresse || null,
      postnummer: eier?.postnummer || null,
      sted: eier?.sted || null,
      telefon: eier?.telefon || pd?.pd_eier_tlf || null
    },
    forer: {
      navn: pd?.forer_navn || null,
      telefon: pd?.pd_forer_tlf || null
    },
    prove: {
      id: k.prove_id,
      navn: k.prove_navn,
      sted: k.prove_sted,
      start_dato: k.start_dato,
      slutt_dato: k.slutt_dato,
      nkk_ref_nr: nkkRefNr
    },
    parti: {
      navn: k.parti,
      startnummer: pd?.startnummer || null
    },
    dommere: dommere.map(d => ({
      navn: d.navn,
      rolle: d.dommer_rolle,
      telefon: d.dommer_telefon
    })),
    dommer_hovedansvarlig: k.dommer_navn
  });
});

// Opprett kritikk (krever dommer)
app.post("/api/kritikker", requireDommer, async (c) => {
  const body = await c.req.json();
  const bruker = c.get("bruker");

  // Bruk innlogget dommers telefon
  const dommer_telefon = bruker.telefon;

  // Slå opp hund_id fra regnr hvis ikke oppgitt direkte
  let hund_id = body.hund_id;
  if (!hund_id && body.hund_regnr) {
    const hund = db.prepare("SELECT id FROM hunder WHERE regnr = ?").get(body.hund_regnr);
    if (hund) {
      hund_id = hund.id;
    }
  }

  // Hvis vi fortsatt ikke har hund_id, opprett hund basert på info vi har
  if (!hund_id && body.hund_navn) {
    try {
      const insertHund = db.prepare(`
        INSERT INTO hunder (navn, regnr, rase) VALUES (?, ?, ?)
      `).run(body.hund_navn, body.hund_regnr || '', body.rase || '');
      hund_id = insertHund.lastInsertRowid;
    } catch (e) {
      // Hund finnes kanskje allerede, ignorer feil
      console.log('Kunne ikke opprette hund:', e.message);
    }
  }

  // DUPLIKATSJEKK: Sjekk om det allerede finnes kritikk for denne hunden DENNE DAGEN
  // En hund kan ha flere kritikker per prøve (flere dager), men kun én per dag
  const kritikkDato = body.dato || new Date().toISOString().split('T')[0];
  const existingKritikk = db.prepare(`
    SELECT id, dommer_telefon, status FROM kritikker
    WHERE (hund_id = ? OR (hund_id IS NULL AND prove_id = ? AND parti = ?))
    AND dato = ?
    AND prove_id = ?
  `).get(hund_id, body.prove_id, body.parti, kritikkDato, body.prove_id);

  if (existingKritikk) {
    // Kritikk finnes allerede for denne dagen
    if (existingKritikk.dommer_telefon === dommer_telefon) {
      // Samme dommer - oppdater eksisterende kritikk i stedet
      console.log(`[Kritikk] Oppdaterer eksisterende kritikk ${existingKritikk.id} for hund ${hund_id} på dato ${kritikkDato}`);
      db.prepare(`
        UPDATE kritikker SET
          presisjon = ?, reising = ?, godkjent_reising = ?,
          stand_m = ?, stand_u = ?, tomstand = ?, makker_stand = ?, sjanse = ?, slipptid = ?,
          jaktlyst = ?, fart = ?, selvstendighet = ?, soksbredde = ?, reviering = ?, samarbeid = ?,
          sek_spontan = ?, sek_forbi = ?, apport = ?, rapport_spontan = ?,
          adferd = ?, premie = ?, kritikk_tekst = ?,
          uonsket_adferd = ?, uonsket_adferd_tekst = ?,
          status = ?, submitted_at = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(
        body.presisjon, body.reising, body.godkjent_reising ? 1 : 0,
        body.stand_m, body.stand_u, body.tomstand, body.makker_stand, body.sjanse, body.slipptid,
        body.jaktlyst, body.fart, body.selvstendighet, body.soksbredde, body.reviering, body.samarbeid,
        body.sek_spontan || 0, body.sek_forbi || 0, body.apport, body.rapport_spontan ? 1 : 0,
        body.adferd || '', body.premie, body.kritikk_tekst,
        body.uonsket_adferd ? 1 : 0, body.uonsket_adferd_tekst || '',
        body.status || 'submitted', new Date().toISOString(),
        existingKritikk.id
      );
      return c.json({ id: existingKritikk.id, ok: true, updated: true });
    } else {
      // Annen dommer har allerede kritikk for denne hunden denne dagen
      return c.json({
        error: "Duplikat kritikk",
        message: `Hunden har allerede en kritikk for denne dagen (${kritikkDato}). En hund kan kun ha én kritikk per dag i samme prøve.`,
        existing_id: existingKritikk.id
      }, 409);
    }
  }

  const result = db.prepare(`
    INSERT INTO kritikker (
      hund_id, prove_id, dommer_telefon, dato, klasse, parti, sted,
      presisjon, reising, godkjent_reising,
      stand_m, stand_u, tomstand, makker_stand, sjanse, slipptid,
      jaktlyst, fart, selvstendighet, soksbredde, reviering, samarbeid,
      sek_spontan, sek_forbi, apport, rapport_spontan,
      adferd, premie, kritikk_tekst, uonsket_adferd, uonsket_adferd_tekst,
      status, submitted_at, submitted_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    hund_id, body.prove_id, dommer_telefon, body.dato, body.klasse, body.parti, body.sted,
    body.presisjon, body.reising, body.godkjent_reising ? 1 : 0,
    body.stand_m, body.stand_u, body.tomstand, body.makker_stand, body.sjanse, body.slipptid,
    body.jaktlyst, body.fart, body.selvstendighet, body.soksbredde, body.reviering, body.samarbeid,
    body.sek_spontan || 0, body.sek_forbi || 0, body.apport, body.rapport_spontan ? 1 : 0,
    body.adferd || '', body.premie, body.kritikk_tekst,
    body.uonsket_adferd ? 1 : 0, body.uonsket_adferd_tekst || '',
    body.status || 'submitted', new Date().toISOString(), dommer_telefon
  );

  db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").run(
    "kritikk_opprettet",
    JSON.stringify({ kritikk_id: result.lastInsertRowid, dommer: dommer_telefon, hund_id: hund_id })
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
    "adferd", "premie", "kritikk_tekst",
    "uonsket_adferd", "uonsket_adferd_tekst"
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

// Hent godkjente kritikker
app.get("/api/kritikker/approved", (c) => {
  const rows = db.prepare(`
    SELECT k.*, h.navn as hund_navn, h.regnr, h.rase,
           b.fornavn || ' ' || b.etternavn as dommer_navn,
           p.navn as prove_navn, p.sted as prove_sted
    FROM kritikker k
    LEFT JOIN hunder h ON k.hund_id = h.id
    LEFT JOIN brukere b ON k.dommer_telefon = b.telefon
    LEFT JOIN prover p ON k.prove_id = p.id
    WHERE k.status = 'approved'
    ORDER BY k.approved_at DESC
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

// ============================================
// RAPPORT-LOGG API
// ============================================

// Logg en generert/sendt rapport
app.post("/api/prover/:id/rapport-logg", async (c) => {
  const proveId = c.req.param("id");
  const body = await c.req.json();

  const {
    rapport_type,  // 'NKK', 'FKF', 'raseklubb', 'NJFF'
    mottaker,
    generert_av,
    filnavn,
    antall_kritikker,
    detaljer
  } = body;

  if (!rapport_type) {
    return c.json({ error: "rapport_type er påkrevd" }, 400);
  }

  try {
    const stmt = db.prepare(`
      INSERT INTO rapport_logg (prove_id, rapport_type, mottaker, generert_av, filnavn, antall_kritikker, detaljer)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      proveId,
      rapport_type,
      mottaker || '',
      generert_av || '',
      filnavn || '',
      antall_kritikker || 0,
      typeof detaljer === 'object' ? JSON.stringify(detaljer) : (detaljer || '')
    );

    return c.json({ success: true, id: result.lastInsertRowid });
  } catch (e) {
    console.error("Feil ved logging av rapport:", e);
    return c.json({ error: e.message }, 500);
  }
});

// Hent rapport-logg for en prøve
app.get("/api/prover/:id/rapport-logg", (c) => {
  const proveId = c.req.param("id");

  try {
    const logg = db.prepare(`
      SELECT * FROM rapport_logg
      WHERE prove_id = ?
      ORDER BY created_at DESC
    `).all(proveId);

    return c.json(logg);
  } catch (e) {
    console.error("Feil ved henting av rapport-logg:", e);
    return c.json({ error: e.message }, 500);
  }
});

// Hent all rapport-logg (for oversikt)
app.get("/api/rapport-logg", (c) => {
  try {
    const logg = db.prepare(`
      SELECT rl.*, p.navn as prove_navn
      FROM rapport_logg rl
      LEFT JOIN prover p ON rl.prove_id = p.id
      ORDER BY rl.created_at DESC
      LIMIT 100
    `).all();

    return c.json(logg);
  } catch (e) {
    console.error("Feil ved henting av rapport-logg:", e);
    return c.json({ error: e.message }, 500);
  }
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
// Kanoniske rasenavn for stående fuglehunder (må holdes i sync med raser.js).
// Brukes til å normalisere rase ved NKK-import. Frontend bruker raser.js med en
// rikere alias-liste; her holder en case-insensitiv match mot kanonisk form
// for 95% av NKK-filene som allerede bruker riktig navn.
const KANONISKE_RASER_SERVER = [
  'Breton', 'Engelsk Setter', 'Gordon Setter', 'Grosser Münsterländer',
  'Irsk Rød og Hvit Setter', 'Irsk Setter', 'Italiensk Spinone',
  'Kleiner Münsterländer', 'Pointer', 'Ungarsk Vizsla Korthåret',
  'Ungarsk Vizsla Strihåret', 'Vorstehhund Korthåret', 'Vorstehhund Langhåret',
  'Vorstehhund Strihåret', 'Weimaraner Korthåret', 'Weimaraner Langhåret'
];
const RASE_ALIAS_SERVER = {
  // Eldre "Korthår Vorsteh"-format → NKK-format
  'korthår vorsteh': 'Vorstehhund Korthåret',
  'korthaar vorsteh': 'Vorstehhund Korthåret',
  'strihår vorsteh': 'Vorstehhund Strihåret',
  'strihaar vorsteh': 'Vorstehhund Strihåret',
  'langhår vorsteh': 'Vorstehhund Langhåret',
  'langhaar vorsteh': 'Vorstehhund Langhåret',
  // Tyske navn
  'deutsch kurzhaar': 'Vorstehhund Korthåret',
  'deutsch drahthaar': 'Vorstehhund Strihåret',
  'deutsch langhaar': 'Vorstehhund Langhåret',
  // Engelske navn som kan dukke opp i eldre filer
  'english setter': 'Engelsk Setter',
  'irish setter': 'Irsk Setter',
  'weimaraner': 'Weimaraner Korthåret',
  'vizsla': 'Ungarsk Vizsla Korthåret',
  'spinone italiano': 'Italiensk Spinone'
};
function normalizeRase(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  const key = raw.toLowerCase().replace(/\s+/g, ' ');
  // Eksakt match mot kanonisk form
  for (const r of KANONISKE_RASER_SERVER) {
    if (r.toLowerCase() === key) return r;
  }
  // Alias-treff
  if (RASE_ALIAS_SERVER[key]) return RASE_ALIAS_SERVER[key];
  // Ukjent — returner som-er (med trim), så blir synlig i UI som "ikke i listen"
  return raw;
}

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
              rase: normalizeRase(match[3]),
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
      INSERT INTO hunder (regnr, navn, rase, kjonn, eier_telefon, kilde)
      VALUES (?, ?, ?, ?, ?, 'import')
    `);

    const updateHund = db.prepare(`
      UPDATE hunder SET navn = ?, rase = ?, eier_telefon = COALESCE(eier_telefon, ?), kilde = COALESCE(kilde, 'import')
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

    // Opprett tabell for ventende fullmakter (fra deltakerlister)
    db.exec(`
      CREATE TABLE IF NOT EXISTS ventende_fullmakter (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        prove_id TEXT,
        hund_regnr TEXT NOT NULL,
        hund_navn TEXT,
        eier_navn TEXT NOT NULL,
        forer_navn TEXT NOT NULL,
        eier_telefon TEXT,
        forer_telefon TEXT,
        eier_epost TEXT,
        forer_epost TEXT,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(prove_id, hund_regnr, forer_navn)
      )
    `);

    const insertVentendeFullmakt = db.prepare(`
      INSERT OR IGNORE INTO ventende_fullmakter (prove_id, hund_regnr, hund_navn, eier_navn, forer_navn, eier_epost, forer_epost)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    let fullmakterOpprettet = 0;

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

        const normalisertRase = p.rase ? normalizeRase(p.rase) : null;

        if (existing) {
          // Oppdater eksisterende hund (kun hvis ikke allerede har eier)
          updateHund.run(
            p.hundenavn || p.navn,
            normalisertRase,
            null, // Ikke overskrive eksisterende eier_telefon
            regnr
          );
          results.updated++;
        } else {
          // Opprett ny hund (uten eier_telefon foreløpig)
          insertHund.run(
            regnr,
            p.hundenavn || p.navn,
            normalisertRase,
            null, // Kjønn ikke i deltakerliste
            null  // Eier kobles senere når bruker registrerer seg
          );
          results.created++;
        }

        // Opprett ventende fullmakt hvis fører er forskjellig fra eier
        const eierNavn = (p.eier || '').trim();
        const forerNavn = (p.forer || '').trim();
        const eierEpost = (p.eier_epost || p.eierEpost || '').trim().toLowerCase();
        const forerEpost = (p.forer_epost || p.forerEpost || '').trim().toLowerCase();

        if (eierNavn && forerNavn && eierNavn.toLowerCase() !== forerNavn.toLowerCase()) {
          try {
            insertVentendeFullmakt.run(
              proveId || null,
              regnr,
              p.hundenavn || p.navn,
              eierNavn,
              forerNavn,
              eierEpost || null,
              forerEpost || null
            );
            fullmakterOpprettet++;
          } catch (e) {
            // Ignorer duplikater
          }
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
      message: `Importert ${results.created} nye hunder, oppdatert ${results.updated}. ${fullmakterOpprettet} ventende fullmakter opprettet.`,
      fullmakterOpprettet,
      ...results
    });

  } catch (err) {
    console.error("Import error:", err);
    return c.json({ error: "Feil ved import: " + err.message }, 500);
  }
});

// --- Koble bruker til hunder basert på e-post/telefon/navn ---
// Denne kalles IKKE automatisk lenger - brukeren kobler manuelt via regnr-søk
// Men vi beholder den for bakoverkompatibilitet og for å aktivere ventende fullmakter
app.post("/api/koble-hunder", requireAuth, async (c) => {
  try {
    const bruker = c.get("bruker");
    const telefon = bruker.telefon;
    const epost = (bruker.epost || '').trim().toLowerCase();
    const fullNavn = `${bruker.fornavn || ''} ${bruker.etternavn || ''}`.trim();
    const navnLower = fullNavn.toLowerCase();

    // 1. Sjekk om brukeren er FØRER i noen ventende fullmakter
    // Matching-prioritet: 1) Telefon (eksakt), 2) Epost (eksakt), 3) Navn (fuzzy)
    // Når fører registrerer seg, opprettes fullmakt automatisk
    const ventendeForForer = db.prepare(`
      SELECT vf.*, h.id as hund_id, h.eier_telefon
      FROM ventende_fullmakter vf
      LEFT JOIN hunder h ON h.regnr = vf.hund_regnr
      WHERE vf.status = 'pending'
        AND (
          vf.forer_telefon = ?
          OR (? != '' AND LOWER(vf.forer_epost) = ?)
          OR LOWER(REPLACE(vf.forer_navn, ' ', '')) = LOWER(REPLACE(?, ' ', ''))
        )
    `).all(telefon, epost, epost, fullNavn);

    let fullmakterAktivert = 0;

    // Opprett fullmakter-tabell hvis ikke finnes
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

    const insertFullmakt = db.prepare(`
      INSERT INTO fullmakter (type, giver_telefon, mottaker_telefon, mottaker_navn, hund_id, dog_name, trial, permissions, status)
      VALUES ('given', ?, ?, ?, ?, ?, ?, '["run","results"]', 'active')
    `);

    const updateVentendeFullmakt = db.prepare(`
      UPDATE ventende_fullmakter SET status = 'activated', forer_telefon = ? WHERE id = ?
    `);

    for (const vf of ventendeForForer) {
      // Fører er denne brukeren - sjekk om eier finnes
      if (vf.eier_telefon && vf.hund_id) {
        try {
          // Opprett fullmakt fra eier til denne føreren
          insertFullmakt.run(
            vf.eier_telefon,     // giver (eier)
            telefon,             // mottaker (fører)
            fullNavn,            // mottaker_navn
            vf.hund_id,          // hund_id
            vf.hund_navn,        // dog_name
            vf.prove_id          // trial
          );
          updateVentendeFullmakt.run(telefon, vf.id);
          fullmakterAktivert++;
        } catch (e) {
          console.error('Feil ved aktivering av fullmakt:', e);
        }
      }
    }

    // 2. Sjekk om brukeren er EIER - oppdater ventende fullmakter med eier_telefon
    // Matching-prioritet: 1) Telefon (eksakt), 2) Epost (eksakt), 3) Navn (eksakt uten mellomrom)
    const ventendeForEier = db.prepare(`
      SELECT vf.id, vf.hund_regnr, vf.forer_navn, vf.forer_telefon
      FROM ventende_fullmakter vf
      WHERE vf.status = 'pending'
        AND (
          vf.eier_telefon = ?
          OR (? != '' AND LOWER(vf.eier_epost) = ?)
          OR LOWER(REPLACE(vf.eier_navn, ' ', '')) = LOWER(REPLACE(?, ' ', ''))
        )
    `).all(telefon, epost, epost, fullNavn);

    const updateVentendeEier = db.prepare(`
      UPDATE ventende_fullmakter SET eier_telefon = ? WHERE id = ?
    `);

    for (const vf of ventendeForEier) {
      updateVentendeEier.run(telefon, vf.id);

      // Hvis fører allerede er registrert, opprett fullmakt
      if (vf.forer_telefon) {
        const hund = db.prepare("SELECT id, navn FROM hunder WHERE regnr = ?").get(vf.hund_regnr);
        if (hund) {
          try {
            insertFullmakt.run(
              telefon,             // giver (eier)
              vf.forer_telefon,    // mottaker (fører)
              vf.forer_navn,       // mottaker_navn
              hund.id,             // hund_id
              hund.navn,           // dog_name
              null                 // trial
            );
            updateVentendeFullmakt.run(vf.forer_telefon, vf.id);
            fullmakterAktivert++;
          } catch (e) {
            console.error('Feil ved aktivering av fullmakt for eier:', e);
          }
        }
      }
    }

    return c.json({
      success: true,
      fullmakterAktivert,
      message: fullmakterAktivert > 0
        ? `${fullmakterAktivert} fullmakt${fullmakterAktivert === 1 ? '' : 'er'} aktivert automatisk`
        : 'Ingen ventende fullmakter funnet'
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
  c.header("Cache-Control", "no-cache, no-store, must-revalidate");
  c.header("Pragma", "no-cache");
  c.header("Expires", "0");
  return c.body(readFileSync(join(__dirname, "auth.js"), "utf-8"));
});

app.get("/site-lock.js", (c) => {
  c.header("Content-Type", "application/javascript");
  return c.body(readFileSync(join(__dirname, "site-lock.js"), "utf-8"));
});

app.get("/raser.js", (c) => {
  c.header("Content-Type", "application/javascript");
  return c.body(readFileSync(join(__dirname, "raser.js"), "utf-8"));
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
  injected += `<script src="/auth.js"></script>\n<script src="/storage-shim.js"></script>\n<script src="/raser.js"></script>\n<script src="/error-handler.js"></script>\n<script src="/navbar.js" defer></script>`;

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

// Clean URL for dommer-testsider
// BLOKKERT I PRODUKSJON - disse sidene hopper over autentisering
const blockTestPagesInProd = (c) => {
  if (process.env.NODE_ENV === 'production') {
    return c.text("Test-sider er deaktivert i produksjon", 403);
  }
  return null;
};

app.get("/dommertest", (c) => {
  const blocked = blockTestPagesInProd(c);
  if (blocked) return blocked;
  return serveWithShim(join(__dirname, "dommertest.html"), c);
});

app.get("/dommertestvk", (c) => {
  const blocked = blockTestPagesInProd(c);
  if (blocked) return blocked;
  return serveWithShim(join(__dirname, "dommer-vk-test.html"), c);
});

app.get("/dommertestukak", (c) => {
  const blocked = blockTestPagesInProd(c);
  if (blocked) return blocked;
  return serveWithShim(join(__dirname, "dommer-ukak-dual.html"), c);
});

// Test-filer som blokkeres i produksjon (unntatt demo-sider for salg/visning)
const TEST_PAGES = ['dommertest.html'];
// dommer-ukak-test.html og dommer-vk-test.html er tillatt for demo/testing

app.get("/:page{.+\\.html}", (c) => {
  const page = c.req.param("page");

  // Blokker test-sider i produksjon
  if (process.env.NODE_ENV === 'production' && TEST_PAGES.includes(page)) {
    return c.text("Test-sider er deaktivert i produksjon", 403);
  }

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

// =============================================
// MELDINGER (deltaker <-> prøveledelse)
// =============================================

// Hent meldinger for admin (innboks)
app.get("/api/meldinger", requireAdmin, (c) => {
  try {
    const proveId = c.req.query("prove_id");
    const uleste = c.req.query("uleste") === "true";

    let query = `
      SELECT m.*,
        (SELECT COUNT(*) FROM meldinger r WHERE r.parent_id = m.id) as svar_count
      FROM meldinger m
      WHERE m.parent_id IS NULL
    `;
    const params = [];

    if (proveId) {
      query += " AND m.prove_id = ?";
      params.push(proveId);
    }

    // Filtrer på uleste (inkluderer meldinger der minst én er ulest)
    if (uleste) {
      query += " AND (m.lest = 0 OR EXISTS (SELECT 1 FROM meldinger r WHERE r.parent_id = m.id AND r.lest = 0))";
    }

    query += " ORDER BY m.created_at DESC";

    const meldinger = db.prepare(query).all(...params);

    // Hent svar for hver melding
    const result = meldinger.map(m => {
      const svar = db.prepare(`
        SELECT * FROM meldinger
        WHERE parent_id = ?
        ORDER BY created_at ASC
      `).all(m.id);
      return { ...m, svar };
    });

    return c.json({ success: true, meldinger: result });
  } catch (err) {
    console.error("Hent meldinger feil:", err);
    return c.json({ success: false, error: err.message }, 500);
  }
});

// Hent brukerens aktive påmeldinger med hunder (for meldingssystem)
app.get("/api/meldinger/mine-pameldinger", requireAuth, (c) => {
  try {
    const telefon = c.get("user").telefon;

    // Hent påmeldinger der brukeren er fører (aktive prøver)
    const pameldinger = db.prepare(`
      SELECT p.prove_id, p.hund_id, p.klasse, p.status,
             pr.navn as prove_navn, pr.start_dato, pr.slutt_dato, pr.sted, pr.klubb_id,
             h.navn as hund_navn, h.regnr as hund_regnr,
             'egen' as type
      FROM pameldinger p
      JOIN prover pr ON p.prove_id = pr.id
      JOIN hunder h ON p.hund_id = h.id
      WHERE p.forer_telefon = ?
        AND p.status NOT IN ('avmeldt')
        AND pr.slutt_dato >= date('now')
      ORDER BY pr.start_dato ASC
    `).all(telefon);

    // Hent fullmakter der brukeren er mottaker (hunder andre har gitt fullmakt til)
    const fullmaktHunder = db.prepare(`
      SELECT f.hund_id, f.dog_name as hund_navn, f.trial as prove_navn,
             f.giver_telefon, h.regnr as hund_regnr,
             'fullmakt' as type
      FROM fullmakter f
      LEFT JOIN hunder h ON f.hund_id = h.id
      WHERE f.mottaker_telefon = ?
        AND f.status = 'active'
        AND (f.valid_to IS NULL OR f.valid_to >= date('now'))
    `).all(telefon);

    // Grupper etter prøve
    const proverMap = new Map();

    pameldinger.forEach(p => {
      if (!proverMap.has(p.prove_id)) {
        proverMap.set(p.prove_id, {
          prove_id: p.prove_id,
          prove_navn: p.prove_navn,
          start_dato: p.start_dato,
          slutt_dato: p.slutt_dato,
          sted: p.sted,
          klubb_id: p.klubb_id,
          hunder: []
        });
      }
      proverMap.get(p.prove_id).hunder.push({
        hund_id: p.hund_id,
        hund_navn: p.hund_navn,
        hund_regnr: p.hund_regnr,
        klasse: p.klasse,
        type: p.type
      });
    });

    // Legg til fullmaktshunder (hvis de ikke allerede er med)
    fullmaktHunder.forEach(f => {
      // Finn prøve basert på prøvenavn (kan være upresist, men bedre enn ingenting)
      for (const [proveId, prove] of proverMap) {
        if (f.hund_id && !prove.hunder.some(h => h.hund_id === f.hund_id)) {
          prove.hunder.push({
            hund_id: f.hund_id,
            hund_navn: f.hund_navn,
            hund_regnr: f.hund_regnr,
            klasse: null,
            type: 'fullmakt'
          });
        }
      }
    });

    const prover = Array.from(proverMap.values());

    return c.json({ success: true, prover });
  } catch (err) {
    console.error("Hent mine påmeldinger feil:", err);
    return c.json({ success: false, error: err.message }, 500);
  }
});

// Hent meldinger for deltaker
app.get("/api/meldinger/mine", requireAuth, (c) => {
  try {
    const telefon = c.get("bruker")?.telefon;
    if (!telefon) return c.json({ error: "Ikke autentisert" }, 401);

    // Hent alle meldinger der brukeren er avsender ELLER mottaker av svar
    const meldinger = db.prepare(`
      SELECT m.*,
        (SELECT COUNT(*) FROM meldinger r WHERE r.parent_id = m.id) as svar_count
      FROM meldinger m
      WHERE m.fra_telefon = ? AND m.parent_id IS NULL
      ORDER BY m.created_at DESC
    `).all(telefon);

    // Hent svar for hver melding
    const result = meldinger.map(m => {
      const svar = db.prepare(`
        SELECT * FROM meldinger
        WHERE parent_id = ?
        ORDER BY created_at ASC
      `).all(m.id);
      return { ...m, svar };
    });

    return c.json({ success: true, meldinger: result });
  } catch (err) {
    console.error("Hent mine meldinger feil:", err);
    return c.json({ success: false, error: err.message }, 500);
  }
});

// Send ny melding fra deltaker til prøveledelse
app.post("/api/meldinger", requireAuth, async (c) => {
  try {
    const user = c.get("user");
    const body = await c.req.json();
    const { prove_id, hund_id, emne, melding } = body;

    if (!prove_id || !emne || !melding) {
      return c.json({ success: false, error: "Mangler påkrevde felt" }, 400);
    }

    // Hent hund-info hvis angitt
    let hundRegnr = null;
    let hundNavn = null;
    if (hund_id) {
      const hund = db.prepare("SELECT regnr, navn FROM hunder WHERE id = ?").get(hund_id);
      if (hund) {
        hundRegnr = hund.regnr;
        hundNavn = hund.navn;
      }
    }

    const stmt = db.prepare(`
      INSERT INTO meldinger (prove_id, fra_telefon, fra_navn, til_type, hund_id, hund_regnr, hund_navn, emne, melding)
      VALUES (?, ?, ?, 'proveledelse', ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      prove_id,
      user.telefon,
      user.navn || "Ukjent",
      hund_id || null,
      hundRegnr,
      hundNavn,
      emne,
      melding
    );

    // Logg
    db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").run(
      "melding_sendt",
      `Ny melding fra ${user.navn || user.telefon}: ${emne}`
    );

    // Auto-backup ved ny melding (viktig kommunikasjon)
    autoBackup("melding_sendt");

    // Checkpoint WAL for å sikre at meldingen er skrevet til disk
    try {
      db.pragma("wal_checkpoint(PASSIVE)");
    } catch (e) {
      console.error("WAL checkpoint error:", e.message);
    }

    return c.json({
      success: true,
      melding_id: result.lastInsertRowid,
      message: "Meldingen er sendt til prøveledelsen"
    });
  } catch (err) {
    console.error("Send melding feil:", err);
    return c.json({ success: false, error: err.message }, 500);
  }
});

// Svar på melding (fra prøveledelse)
app.post("/api/meldinger/:id/svar", requireAdmin, async (c) => {
  try {
    const meldingId = c.req.param("id");
    const body = await c.req.json();
    const { melding: svarTekst, avsender_navn } = body;

    if (!svarTekst) {
      return c.json({ success: false, error: "Mangler svar-tekst" }, 400);
    }

    // Hent original melding
    const original = db.prepare("SELECT * FROM meldinger WHERE id = ?").get(meldingId);
    if (!original) {
      return c.json({ success: false, error: "Finner ikke meldingen" }, 404);
    }

    // Opprett svar
    const stmt = db.prepare(`
      INSERT INTO meldinger (prove_id, fra_telefon, fra_navn, til_type, hund_id, hund_regnr, hund_navn, emne, melding, parent_id)
      VALUES (?, 'proveledelse', ?, 'deltaker', ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      original.prove_id,
      avsender_navn || "Prøveledelsen",
      original.hund_id,
      original.hund_regnr,
      original.hund_navn,
      `Svar: ${original.emne}`,
      svarTekst,
      meldingId
    );

    // Marker original som lest
    db.prepare("UPDATE meldinger SET lest = 1, lest_dato = datetime('now') WHERE id = ?").run(meldingId);

    // Send SMS-varsling til deltaker
    const smsResult = await sendSMS(
      original.fra_telefon,
      `Du har fått svar fra prøveledelsen på din henvendelse "${original.emne}". Logg inn på fuglehundprove.no for å se svaret.`,
      { type: "melding_svar", klubb_id: null }
    );

    // Logg
    db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").run(
      "melding_besvart",
      `Svar sendt til ${original.fra_navn} (${original.fra_telefon}). SMS: ${smsResult.success ? 'OK' : 'Feilet'}`
    );

    // Auto-backup ved svar på melding (viktig kommunikasjon)
    autoBackup("melding_besvart");

    // Checkpoint WAL for å sikre at svaret er skrevet til disk
    try {
      db.pragma("wal_checkpoint(PASSIVE)");
    } catch (e) {
      console.error("WAL checkpoint error:", e.message);
    }

    return c.json({
      success: true,
      svar_id: result.lastInsertRowid,
      sms_sendt: smsResult.success,
      message: "Svar er sendt" + (smsResult.success ? " og deltaker er varslet på SMS" : " (SMS-varsling feilet)")
    });
  } catch (err) {
    console.error("Svar på melding feil:", err);
    return c.json({ success: false, error: err.message }, 500);
  }
});

// Marker melding som lest
app.put("/api/meldinger/:id/lest", requireAdmin, (c) => {
  try {
    const meldingId = c.req.param("id");

    db.prepare(`
      UPDATE meldinger
      SET lest = 1, lest_dato = datetime('now')
      WHERE id = ?
    `).run(meldingId);

    return c.json({ success: true });
  } catch (err) {
    return c.json({ success: false, error: err.message }, 500);
  }
});

// Slett melding (kun admin)
app.delete("/api/meldinger/:id", requireAdmin, (c) => {
  try {
    const meldingId = c.req.param("id");

    // Slett svar først
    db.prepare("DELETE FROM meldinger WHERE parent_id = ?").run(meldingId);
    // Slett hovedmelding
    db.prepare("DELETE FROM meldinger WHERE id = ?").run(meldingId);

    return c.json({ success: true });
  } catch (err) {
    return c.json({ success: false, error: err.message }, 500);
  }
});

// Hent antall uleste meldinger (for badge)
app.get("/api/meldinger/uleste", requireAdmin, (c) => {
  try {
    const proveId = c.req.query("prove_id");

    let query = "SELECT COUNT(*) as antall FROM meldinger WHERE lest = 0 AND til_type = 'proveledelse'";
    const params = [];

    if (proveId) {
      query += " AND prove_id = ?";
      params.push(proveId);
    }

    const result = db.prepare(query).get(...params);
    return c.json({ success: true, antall: result.antall });
  } catch (err) {
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
// TESTMODUS - For å teste hele flyten
// ==========================================

// Sjekk status for testmodus
app.get("/api/superadmin/testmodus/status", (c) => {
  try {
    // Finn testprøver (de som starter med [TEST])
    const prove = db.prepare("SELECT * FROM prover WHERE navn LIKE '[TEST]%' ORDER BY created_at DESC LIMIT 1").get();

    if (!prove) {
      return c.json({ aktiv: false });
    }

    // Tell deltakere og kritikker
    const deltakere = db.prepare("SELECT COUNT(*) as count FROM paameldinger WHERE prove_id = ?").get(prove.id)?.count || 0;
    const kritikker = db.prepare("SELECT COUNT(*) as count FROM kritikker WHERE prove_id = ?").get(prove.id)?.count || 0;

    return c.json({
      aktiv: true,
      prove: {
        id: prove.id,
        navn: prove.navn,
        created_at: prove.created_at
      },
      deltakere,
      kritikker
    });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// Opprett testprøve med fiktive data
app.post("/api/superadmin/testmodus/opprett", (c) => {
  try {
    // Sjekk om det allerede finnes en testprøve
    const eksisterende = db.prepare("SELECT id FROM prover WHERE navn LIKE '[TEST]%'").get();
    if (eksisterende) {
      return c.json({ error: "Det finnes allerede en testprøve. Slett den først." }, 400);
    }

    // Finn eller opprett en testklubb
    let klubbId = db.prepare("SELECT id FROM klubber WHERE navn = 'Testklubben'").get()?.id;
    if (!klubbId) {
      // Generer en unik ID for klubben (tabellen bruker TEXT id, ikke autoincrement)
      klubbId = 'test-klubb-' + Date.now();
      db.prepare(`
        INSERT INTO klubber (id, navn, orgnummer, region)
        VALUES (?, 'Testklubben', '999999999', 'Test')
      `).run(klubbId);
    }

    // Opprett testprøve
    const nesteDag = new Date();
    nesteDag.setDate(nesteDag.getDate() + 7);
    const startDato = nesteDag.toISOString().split('T')[0];
    const proveId = 'test-prove-' + Date.now();

    db.prepare(`
      INSERT INTO prover (
        id, navn, sted, start_dato, slutt_dato, klubb_id, klasser, status
      ) VALUES (
        ?, '[TEST] Testprøve 2026', 'Testfjellet', ?, ?, ?,
        '{"uk":true,"ak":true,"vk":true}', 'aktiv'
      )
    `).run(proveId, startDato, startDato, klubbId);

    // Opprett en testdommer (NKK-rep) som skal motta kritikkene
    const dommerTelefon = '99900000';
    const nkkrepTelefon = '99900099';

    const dommerExists = db.prepare("SELECT telefon FROM brukere WHERE telefon = ?").get(dommerTelefon);
    if (!dommerExists) {
      db.prepare(`
        INSERT INTO brukere (telefon, fornavn, etternavn, epost, rolle, sms_samtykke, sms_samtykke_tidspunkt)
        VALUES (?, 'Test', 'Dommer', 'test.dommer@test.no', 'dommer', 1, datetime('now'))
      `).run(dommerTelefon);
    }

    const nkkrepExists = db.prepare("SELECT telefon FROM brukere WHERE telefon = ?").get(nkkrepTelefon);
    if (!nkkrepExists) {
      db.prepare(`
        INSERT INTO brukere (telefon, fornavn, etternavn, epost, rolle, sms_samtykke, sms_samtykke_tidspunkt)
        VALUES (?, 'Test', 'NKK-Rep', 'test.nkkrep@test.no', 'admin', 1, datetime('now'))
      `).run(nkkrepTelefon);
    }

    // Sett NKK-rep på prøven
    db.prepare("UPDATE prover SET nkkrep_telefon = ? WHERE id = ?").run(nkkrepTelefon, proveId);

    // Fiktive hunder og førere - UK/AK går sammen i "ukak1", VK i "vk1"
    const testData = [
      { hund: 'TEST-Duke', regnr: 'NO99999/01', rase: 'Engelsk Setter', klasse: 'UK', parti: 'ukak1', forer: 'Test Testesen', telefon: '99900001' },
      { hund: 'TEST-Bella', regnr: 'NO99999/02', rase: 'Pointer', klasse: 'UK', parti: 'ukak1', forer: 'Kari Testmann', telefon: '99900002' },
      { hund: 'TEST-Max', regnr: 'NO99999/03', rase: 'Gordon Setter', klasse: 'AK', parti: 'ukak1', forer: 'Per Testvik', telefon: '99900003' },
      { hund: 'TEST-Luna', regnr: 'NO99999/04', rase: 'Irsk Setter', klasse: 'AK', parti: 'ukak1', forer: 'Anne Testberg', telefon: '99900004' },
      { hund: 'TEST-Rex', regnr: 'NO99999/05', rase: 'Engelsk Setter', klasse: 'VK', parti: 'vk1', forer: 'Ole Testgård', telefon: '99900005' },
      { hund: 'TEST-Tara', regnr: 'NO99999/06', rase: 'Pointer', klasse: 'VK', parti: 'vk1', forer: 'Lise Testmo', telefon: '99900006' }
    ];

    // Opprett testbrukere, hunder og påmeldinger
    let deltakereOpprettet = 0;
    const opprettedeHunder = [];

    for (const td of testData) {
      // Opprett bruker hvis ikke eksisterer - testbrukere har samtykke
      const brukerExists = db.prepare("SELECT telefon FROM brukere WHERE telefon = ?").get(td.telefon);
      if (!brukerExists) {
        db.prepare(`
          INSERT INTO brukere (telefon, fornavn, etternavn, epost, rolle, sms_samtykke, sms_samtykke_tidspunkt)
          VALUES (?, ?, '', ?, 'deltaker', 1, datetime('now'))
        `).run(td.telefon, td.forer, `${td.forer.toLowerCase().replace(' ', '.')}@test.no`);
      }

      // Opprett hund (bruk regnr-kolonnen)
      const eksisterendeHund = db.prepare("SELECT id FROM hunder WHERE regnr = ?").get(td.regnr);
      let hundId;
      if (!eksisterendeHund) {
        const hundResult = db.prepare(`
          INSERT INTO hunder (regnr, navn, rase, fodt, eier_telefon)
          VALUES (?, ?, ?, '2022-01-01', ?)
        `).run(td.regnr, td.hund, td.rase, td.telefon);
        hundId = hundResult.lastInsertRowid;
      } else {
        hundId = eksisterendeHund.id;
      }

      opprettedeHunder.push({ ...td, hundId });

      // Opprett påmelding (bruk riktig tabellstruktur - parti er ukak1 eller vk1)
      db.prepare(`
        INSERT INTO pameldinger (
          prove_id, hund_id, forer_telefon, klasse, parti, status
        ) VALUES (?, ?, ?, ?, ?, 'bekreftet')
      `).run(proveId, hundId, td.telefon, td.klasse, td.parti);

      deltakereOpprettet++;
    }

    // Tildel testdommer til partiet ukak1 (UK/AK går sammen)
    // Merk: UNIQUE constraint på (prove_id, dommer_telefon), så vi må velge ett parti
    db.prepare(`
      INSERT INTO dommer_tildelinger (prove_id, dommer_telefon, parti)
      VALUES (?, ?, 'ukak1')
    `).run(proveId, dommerTelefon);

    // IKKE opprett ferdigutfylte kritikkskjema - la testdommeren fylle ut selv
    // slik at vi kan teste hele flyten fra start til slutt

    // Logg
    db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").run(
      "testmodus_opprettet", `Testprøve opprettet med ID ${proveId}, ${deltakereOpprettet} deltakere, dommer: ${dommerTelefon}, NKK-rep: ${nkkrepTelefon}`
    );

    return c.json({
      success: true,
      prove_id: proveId,
      deltakere: deltakereOpprettet,
      dommer: dommerTelefon,
      nkkrep: nkkrepTelefon,
      melding: `Testprøve opprettet! Logg inn som dommer med tlf ${dommerTelefon}. NKK-rep er ${nkkrepTelefon}.`
    });

  } catch (err) {
    console.error('Feil ved opprettelse av testprøve:', err);
    return c.json({ error: err.message }, 500);
  }
});

// Slett all testdata
app.delete("/api/superadmin/testmodus/slett", (c) => {
  try {
    // Finn alle testprøver
    const testProver = db.prepare("SELECT id FROM prover WHERE navn LIKE '[TEST]%'").all();
    const proveIds = testProver.map(p => p.id);

    if (proveIds.length === 0) {
      return c.json({ error: "Ingen testdata å slette" }, 404);
    }

    let kritikkerSlettet = 0;
    let deltagereSlettet = 0;
    let proverSlettet = 0;

    for (const proveId of proveIds) {
      // Slett kritikker
      const k = db.prepare("DELETE FROM kritikker WHERE prove_id = ?").run(proveId);
      kritikkerSlettet += k.changes;

      // Slett påmeldinger
      const p = db.prepare("DELETE FROM pameldinger WHERE prove_id = ?").run(proveId);
      deltagereSlettet += p.changes;

      // Slett dommer-tildelinger
      db.prepare("DELETE FROM dommer_tildelinger WHERE prove_id = ?").run(proveId);

      // Slett prøven
      db.prepare("DELETE FROM prover WHERE id = ?").run(proveId);
      proverSlettet++;
    }

    // Slett testbrukere (99900001-99900006)
    db.prepare("DELETE FROM brukere WHERE telefon LIKE '999000%'").run();

    // Slett testhunder
    db.prepare("DELETE FROM hunder WHERE regnr LIKE 'NO99999%'").run();

    // Slett testklubb
    db.prepare("DELETE FROM klubber WHERE id LIKE 'test-klubb-%'").run();

    // Logg
    db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").run(
      "testmodus_slettet", `Testdata slettet: ${proverSlettet} prøver, ${deltagereSlettet} deltakere, ${kritikkerSlettet} kritikker`
    );

    return c.json({
      success: true,
      prover_slettet: proverSlettet,
      deltakere_slettet: deltagereSlettet,
      kritikker_slettet: kritikkerSlettet
    });

  } catch (err) {
    console.error('Feil ved sletting av testdata:', err);
    return c.json({ error: err.message }, 500);
  }
});

// ==========================================
// GDPR BILDEANALYSE
// ==========================================

// Analyser bilde for personopplysninger (simulert AI-analyse)
app.post("/api/gdpr/analyser-bilde", async (c) => {
  try {
    const body = await c.req.json();
    const { image } = body;

    if (!image) {
      return c.json({ error: "Mangler bilde" }, 400);
    }

    // For nå: Returner en instruks om manuell beskrivelse
    // I fremtiden kan dette kobles til en AI-tjeneste (f.eks. OpenAI Vision, Google Cloud Vision)
    // som faktisk analyserer bildet for personopplysninger

    // Simulert respons - ber brukeren beskrive bildet
    const beskrivelse = "Bildet er lastet opp. For nøyaktig GDPR-analyse, beskriv følgende i tekstfeltet:\n" +
      "• Hvilke personer er synlige (ansikter, barn, gjenkjennelige)\n" +
      "• Tekst som er synlig i bildet (navn, adresser, telefonnumre)\n" +
      "• Kjøretøy med synlige skiltnummer\n" +
      "• Andre identifiserende detaljer (uniformer, logoer, steder)";

    return c.json({
      beskrivelse: beskrivelse,
      manuell_analyse_kreves: true
    });

  } catch (err) {
    console.error('Feil ved bildeanalyse:', err);
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
    const { partyId, partyName, judgeName, dogCount, proveId } = body;

    if (!partyId || !judgeName) {
      return c.json({ error: "Mangler påkrevde felter" }, 400);
    }

    // Hent prøve-info for navn og klubb
    let proveNavn = '';
    let klubbNavn = '';
    if (proveId) {
      const prove = db.prepare(`
        SELECT p.navn, k.navn as klubb_navn
        FROM prover p
        LEFT JOIN klubber k ON p.klubb_id = k.id
        WHERE p.id = ?
      `).get(proveId);
      if (prove) {
        proveNavn = prove.navn || '';
        klubbNavn = prove.klubb_navn || '';
      }
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

    // Lag SMS-melding med prøvenavn og klubb
    let message = '';
    if (proveNavn) {
      message = `${proveNavn}: Kritikker fra ${partyName || partyId} er klare for godkjenning. `;
    } else {
      message = `Kritikker fra ${partyName || partyId} er klare for godkjenning. `;
    }
    message += `Dommer: ${judgeName}. `;
    if (dogCount) {
      message += `${dogCount} hunder. `;
    }
    message += `Logg inn: fuglehundprove.no/nkk-godkjenning`;

    // Legg til signatur med klubbnavn (maks 160 tegn for SMS)
    if (klubbNavn && message.length + klubbNavn.length + 10 <= 160) {
      message += ` - ${klubbNavn}`;
    }

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
// RAPPORT-VERSJONER API (Audit-trail)
// =============================================

// Lagre ny versjon av rapport
app.post("/api/rapport-versjoner", requireAuth, async (c) => {
  try {
    const body = await c.req.json();
    const user = c.get('user');
    const { prove_id, rapport_type, data, endring_beskrivelse } = body;

    if (!prove_id || !rapport_type) {
      return c.json({ error: "prove_id og rapport_type er påkrevd" }, 400);
    }

    // Finn neste versjonsnummer
    const lastVersion = db.prepare(`
      SELECT MAX(versjon) as max_versjon FROM rapport_versjoner
      WHERE prove_id = ? AND rapport_type = ?
    `).get(prove_id, rapport_type);

    const nyVersjon = (lastVersion?.max_versjon || 0) + 1;

    // Lagre ny versjon
    const result = db.prepare(`
      INSERT INTO rapport_versjoner (prove_id, rapport_type, versjon, data_json, endret_av, endret_av_navn, endring_beskrivelse)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      prove_id,
      rapport_type,
      nyVersjon,
      JSON.stringify(data || {}),
      user?.telefon || null,
      user ? `${user.fornavn || ''} ${user.etternavn || ''}`.trim() : 'Ukjent',
      endring_beskrivelse || null
    );

    // Logg til admin_log
    db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").run(
      "rapport_versjon",
      JSON.stringify({ prove_id, rapport_type, versjon: nyVersjon, endret_av: user?.telefon })
    );

    return c.json({
      success: true,
      id: result.lastInsertRowid,
      versjon: nyVersjon
    });
  } catch (err) {
    console.error("Rapport-versjon POST error:", err);
    return c.json({ error: err.message }, 500);
  }
});

// Hent alle versjoner for en rapport
app.get("/api/rapport-versjoner/:prove_id/:rapport_type", (c) => {
  try {
    const { prove_id, rapport_type } = c.req.param();

    const versjoner = db.prepare(`
      SELECT id, versjon, endret_av, endret_av_navn, endring_beskrivelse,
             signatur_status, proveleder_signert_at, nkkrep_signert_at, created_at
      FROM rapport_versjoner
      WHERE prove_id = ? AND rapport_type = ?
      ORDER BY versjon DESC
    `).all(prove_id, rapport_type);

    return c.json({ versjoner });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// Hent én spesifikk versjon med full data
app.get("/api/rapport-versjoner/:prove_id/:rapport_type/:versjon", (c) => {
  try {
    const { prove_id, rapport_type, versjon } = c.req.param();

    const ver = db.prepare(`
      SELECT * FROM rapport_versjoner
      WHERE prove_id = ? AND rapport_type = ? AND versjon = ?
    `).get(prove_id, rapport_type, parseInt(versjon));

    if (!ver) {
      return c.json({ error: "Versjon ikke funnet" }, 404);
    }

    return c.json({
      ...ver,
      data: JSON.parse(ver.data_json || '{}')
    });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// Oppdater signaturstatus for rapport-versjon
app.post("/api/rapport-versjoner/:id/signer", requireAuth, async (c) => {
  try {
    const id = c.req.param("id");
    const body = await c.req.json();
    const user = c.get('user');
    const { rolle } = body; // 'proveleder' eller 'nkkrep'

    if (!rolle || !['proveleder', 'nkkrep'].includes(rolle)) {
      return c.json({ error: "Ugyldig rolle" }, 400);
    }

    const versjon = db.prepare("SELECT * FROM rapport_versjoner WHERE id = ?").get(id);
    if (!versjon) {
      return c.json({ error: "Versjon ikke funnet" }, 404);
    }

    // Oppdater riktig signatur-felt
    const signertAt = new Date().toISOString();
    if (rolle === 'proveleder') {
      db.prepare("UPDATE rapport_versjoner SET proveleder_signert_at = ? WHERE id = ?").run(signertAt, id);
    } else {
      db.prepare("UPDATE rapport_versjoner SET nkkrep_signert_at = ? WHERE id = ?").run(signertAt, id);
    }

    // Sjekk om begge har signert
    const oppdatert = db.prepare("SELECT proveleder_signert_at, nkkrep_signert_at FROM rapport_versjoner WHERE id = ?").get(id);
    let nyStatus = 'usignert';
    if (oppdatert.proveleder_signert_at && oppdatert.nkkrep_signert_at) {
      nyStatus = 'fullstendig_signert';
    } else if (oppdatert.proveleder_signert_at || oppdatert.nkkrep_signert_at) {
      nyStatus = 'delvis_signert';
    }

    db.prepare("UPDATE rapport_versjoner SET signatur_status = ? WHERE id = ?").run(nyStatus, id);

    // Logg signatur
    db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").run(
      "rapport_signert",
      JSON.stringify({ id, prove_id: versjon.prove_id, rapport_type: versjon.rapport_type, rolle, signert_av: user?.telefon })
    );

    return c.json({
      success: true,
      signatur_status: nyStatus
    });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// Send notifikasjon til NKK-rep om ventende rapport
app.post("/api/rapport-versjoner/:prove_id/varsle-nkkrep", requireAuth, async (c) => {
  try {
    const { prove_id } = c.req.param();
    const body = await c.req.json();
    const user = c.get('user');
    const { rapport_type } = body;

    // Hent prøve med NKK-rep info
    const prove = db.prepare(`
      SELECT p.*, nr.fornavn as nkkrep_fornavn, nr.etternavn as nkkrep_etternavn
      FROM prover p
      LEFT JOIN brukere nr ON p.nkkrep_telefon = nr.telefon
      WHERE p.id = ?
    `).get(prove_id);

    if (!prove) {
      return c.json({ error: "Prøve ikke funnet" }, 404);
    }

    if (!prove.nkkrep_telefon) {
      return c.json({ error: "Ingen NKK-representant er tildelt prøven" }, 400);
    }

    // Bestem rapporttype-navn
    const rapportNavn = {
      'nkk': 'NKK-rapport',
      'fkf': 'FKF-rapport',
      'kritikker': 'Kritikk-sammendrag'
    }[rapport_type] || 'Rapport';

    // Send SMS
    const melding = `Hei ${prove.nkkrep_fornavn || ''}! ${rapportNavn} for ${prove.navn} er klar for din signatur. Logg inn på fuglehundprove.no for å gjennomgå og signere.`;

    const smsResult = await sendSMS(prove.nkkrep_telefon, melding, { type: "rapport_signatur_varsling" });

    // Logg varsling
    db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").run(
      "nkkrep_varslet",
      JSON.stringify({ prove_id, rapport_type, nkkrep_telefon: prove.nkkrep_telefon, varslet_av: user?.telefon })
    );

    return c.json({
      success: smsResult.success,
      message: smsResult.success ? "SMS sendt til NKK-representant" : "Kunne ikke sende SMS",
      error: smsResult.error || null
    });
  } catch (err) {
    console.error("Varsle NKK-rep error:", err);
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

// =============================================
// KLUBB-DOKUMENTARKIV API
// =============================================

// Hent alle dokumenter for en klubb (både prøve-dokumenter og generelle)
app.get("/api/klubber/:klubb_id/dokumenter", (c) => {
  const { klubb_id } = c.req.param();
  const type = c.req.query("type"); // Filtrer på type
  const prove_id = c.req.query("prove_id"); // Filtrer på prøve

  try {
    // Hent generelle klubb-dokumenter
    let generalQuery = `
      SELECT id, klubb_id, NULL as prove_id, dokument_type, tittel, beskrivelse, filnavn, opprettet_av, created_at, 'general' as kilde
      FROM klubb_dokumenter
      WHERE klubb_id = ?
    `;
    const generalParams = [klubb_id];

    if (type) {
      generalQuery += ` AND dokument_type = ?`;
      generalParams.push(type);
    }

    // Hent prøve-dokumenter for denne klubben
    let proveQuery = `
      SELECT pd.id, pd.klubb_id, pd.prove_id, pd.dokument_type, pd.tittel, NULL as beskrivelse, pd.filnavn, pd.opprettet_av, pd.created_at, 'prove' as kilde
      FROM prove_dokumenter pd
      WHERE pd.klubb_id = ?
    `;
    const proveParams = [klubb_id];

    if (type) {
      proveQuery += ` AND pd.dokument_type = ?`;
      proveParams.push(type);
    }

    if (prove_id) {
      proveQuery += ` AND pd.prove_id = ?`;
      proveParams.push(prove_id);
    }

    const generalDocs = db.prepare(generalQuery).all(...generalParams);
    const proveDocs = db.prepare(proveQuery).all(...proveParams);

    // Kombiner og sorter etter dato
    const allDocs = [...generalDocs, ...proveDocs].sort((a, b) =>
      new Date(b.created_at) - new Date(a.created_at)
    );

    return c.json(allDocs);
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// Hent prøver med dokumentstatistikk for en klubb
app.get("/api/klubber/:klubb_id/dokumenter/prover", (c) => {
  const { klubb_id } = c.req.param();

  try {
    // Hent alle prøver for klubben med dokumenttelling
    const prover = db.prepare(`
      SELECT
        p.id,
        p.navn,
        p.start_dato,
        p.status,
        (SELECT COUNT(*) FROM prove_dokumenter WHERE prove_id = p.id OR prove_id = p.navn) as dok_count,
        (SELECT COUNT(*) FROM dvk_journaler WHERE prove_id = p.id OR prove_id = p.navn) as dvk_count
      FROM prover p
      WHERE p.klubb_id = ?
      ORDER BY p.start_dato DESC
    `).all(klubb_id);

    return c.json(prover);
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// Hent ett klubb-dokument
app.get("/api/klubber/:klubb_id/dokumenter/:id", (c) => {
  const { klubb_id, id } = c.req.param();
  const kilde = c.req.query("kilde") || "general";

  try {
    let dok;
    if (kilde === "prove") {
      dok = db.prepare(`SELECT * FROM prove_dokumenter WHERE id = ? AND klubb_id = ?`).get(id, klubb_id);
    } else {
      dok = db.prepare(`SELECT * FROM klubb_dokumenter WHERE id = ? AND klubb_id = ?`).get(id, klubb_id);
    }

    if (!dok) {
      return c.json({ error: "Dokument ikke funnet" }, 404);
    }

    return c.json(dok);
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// Legg til generelt klubb-dokument
app.post("/api/klubber/:klubb_id/dokumenter", async (c) => {
  const { klubb_id } = c.req.param();

  try {
    const body = await c.req.json();
    const { dokument_type, tittel, beskrivelse, filnavn, innhold, opprettet_av } = body;

    if (!dokument_type || !tittel) {
      return c.json({ error: "Mangler påkrevde felt" }, 400);
    }

    const result = db.prepare(`
      INSERT INTO klubb_dokumenter (klubb_id, dokument_type, tittel, beskrivelse, filnavn, innhold_json, opprettet_av)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      klubb_id, dokument_type, tittel, beskrivelse || null, filnavn || null,
      innhold ? JSON.stringify(innhold) : null,
      opprettet_av || null
    );

    autoBackup("klubb-dokument-lagt-til");
    return c.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// Slett klubb-dokument
app.delete("/api/klubber/:klubb_id/dokumenter/:id", (c) => {
  const { klubb_id, id } = c.req.param();
  const kilde = c.req.query("kilde") || "general";

  try {
    let result;
    if (kilde === "prove") {
      result = db.prepare(`DELETE FROM prove_dokumenter WHERE id = ? AND klubb_id = ?`).run(id, klubb_id);
    } else {
      result = db.prepare(`DELETE FROM klubb_dokumenter WHERE id = ? AND klubb_id = ?`).run(id, klubb_id);
    }

    if (result.changes === 0) {
      return c.json({ error: "Dokument ikke funnet" }, 404);
    }

    autoBackup("klubb-dokument-slettet");
    return c.json({ success: true });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// ============================================
// VK-BEDØMMING API (Vinnerklasse kritikkskjema)
// ============================================

// Hent VK-bedømming for et parti
app.get("/api/vk-bedomming/:proveId/:parti", (c) => {
  try {
    const { proveId, parti } = c.req.param();

    const bedomming = db.prepare(`
      SELECT * FROM vk_bedomming WHERE prove_id = ? AND parti = ?
    `).get(proveId, parti);

    if (!bedomming) {
      return c.json({ exists: false });
    }

    return c.json({
      exists: true,
      data: {
        id: bedomming.id,
        prove_id: bedomming.prove_id,
        parti: bedomming.parti,
        dommer_telefon: bedomming.dommer_telefon,
        vk_type: bedomming.vk_type,
        current_slipp: bedomming.current_slipp,
        current_round: bedomming.current_round,
        plasseringer: JSON.parse(bedomming.plasseringer || '{}'),
        tid_til_gode: JSON.parse(bedomming.tid_til_gode || '{}'),
        dog_data: JSON.parse(bedomming.dog_data || '{}'),
        slipp_comments: JSON.parse(bedomming.slipp_comments || '{}'),
        slipp_dogs: JSON.parse(bedomming.slipp_dogs || '{}'),
        round_pairings: JSON.parse(bedomming.round_pairings || '{}'),
        opponents: JSON.parse(bedomming.opponents || '{}'),
        judged_this_round: JSON.parse(bedomming.judged_this_round || '{}'),
        round_snapshots: JSON.parse(bedomming.round_snapshots || '{}'),
        premietildelinger: JSON.parse(bedomming.premietildelinger || '{}'),
        selected_dogs: JSON.parse(bedomming.selected_dogs || '{}'),
        status: bedomming.status,
        live_modus: bedomming.live_modus || 0,
        updated_at: bedomming.updated_at
      }
    });
  } catch (err) {
    console.error("VK-bedomming GET error:", err);
    return c.json({ error: err.message }, 500);
  }
});

// Lagre/oppdater VK-bedømming
app.put("/api/vk-bedomming/:proveId/:parti", async (c) => {
  try {
    const { proveId, parti } = c.req.param();
    const body = await c.req.json();

    // Sjekk om det finnes fra før
    const existing = db.prepare(`
      SELECT id FROM vk_bedomming WHERE prove_id = ? AND parti = ?
    `).get(proveId, parti);

    // live_modus = 1 hvis bedømmingen er kjørt av live_admin (manuell
    // bedømming, kun for live rangering — ingen kritikker til NKK).
    // Auto-detekteres fra dommer-tildeling hvis ikke eksplisitt sendt.
    let liveModus = body.live_modus === 1 || body.live_modus === true ? 1 : 0;
    if (!liveModus && body.dommer_telefon) {
      const tildeling = db.prepare(`
        SELECT dommer_rolle FROM dommer_tildelinger
        WHERE prove_id = ? AND parti = ? AND dommer_telefon = ?
      `).get(proveId, parti, body.dommer_telefon);
      if (tildeling?.dommer_rolle === 'live_admin') liveModus = 1;
    }

    if (existing) {
      // Oppdater
      db.prepare(`
        UPDATE vk_bedomming SET
          dommer_telefon = ?,
          vk_type = ?,
          current_slipp = ?,
          current_round = ?,
          plasseringer = ?,
          tid_til_gode = ?,
          dog_data = ?,
          slipp_comments = ?,
          slipp_dogs = ?,
          round_pairings = ?,
          opponents = ?,
          judged_this_round = ?,
          round_snapshots = ?,
          premietildelinger = ?,
          selected_dogs = ?,
          status = ?,
          live_modus = ?,
          updated_at = datetime('now')
        WHERE prove_id = ? AND parti = ?
      `).run(
        body.dommer_telefon || null,
        body.vk_type || '1dag',
        body.current_slipp || 1,
        body.current_round || 1,
        JSON.stringify(body.plasseringer || {}),
        JSON.stringify(body.tid_til_gode || {}),
        JSON.stringify(body.dog_data || {}),
        JSON.stringify(body.slipp_comments || {}),
        JSON.stringify(body.slipp_dogs || {}),
        JSON.stringify(body.round_pairings || {}),
        JSON.stringify(body.opponents || {}),
        JSON.stringify(body.judged_this_round || {}),
        JSON.stringify(body.round_snapshots || {}),
        JSON.stringify(body.premietildelinger || {}),
        JSON.stringify(body.selected_dogs || {}),
        body.status || 'aktiv',
        liveModus,
        proveId,
        parti
      );
    } else {
      // Opprett ny
      db.prepare(`
        INSERT INTO vk_bedomming (
          prove_id, parti, dommer_telefon, vk_type,
          current_slipp, current_round, plasseringer, tid_til_gode,
          dog_data, slipp_comments, slipp_dogs, round_pairings,
          opponents, judged_this_round, round_snapshots, premietildelinger, selected_dogs, status, live_modus
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        proveId,
        parti,
        body.dommer_telefon || null,
        body.vk_type || '1dag',
        body.current_slipp || 1,
        body.current_round || 1,
        JSON.stringify(body.plasseringer || {}),
        JSON.stringify(body.tid_til_gode || {}),
        JSON.stringify(body.dog_data || {}),
        JSON.stringify(body.slipp_comments || {}),
        JSON.stringify(body.slipp_dogs || {}),
        JSON.stringify(body.round_pairings || {}),
        JSON.stringify(body.opponents || {}),
        JSON.stringify(body.judged_this_round || {}),
        JSON.stringify(body.round_snapshots || {}),
        JSON.stringify(body.premietildelinger || {}),
        JSON.stringify(body.selected_dogs || {}),
        body.status || 'aktiv',
        liveModus
      );
    }

    autoBackup("vk-bedomming-oppdatert");
    return c.json({ success: true });
  } catch (err) {
    console.error("VK-bedomming PUT error:", err);
    return c.json({ error: err.message }, 500);
  }
});

// Avslutt live rangering (manuell bedømming) — ingen kritikk-flyt til NKK.
// Brukes av live_admin når partiet er ferdig "bedømt" for live-visningens
// skyld. Setter vk_bedomming.status='avsluttet' og markerer evt. lagrede
// kritikk-utkast som intern_kun=1 så de aldri kan sendes til NKK.
app.post("/api/vk-bedomming/:proveId/:parti/avslutt", async (c) => {
  try {
    const { proveId, parti } = c.req.param();

    const bedomming = db.prepare(`
      SELECT id, dommer_telefon, live_modus FROM vk_bedomming
      WHERE prove_id = ? AND parti = ?
    `).get(proveId, parti);

    if (!bedomming) return c.json({ error: "VK-bedømming ikke funnet" }, 404);

    // Sikkerhets-sjekk: dette endepunktet er kun for live_modus.
    // Hvis bedømmingen IKKE er live, må send-inn brukes.
    if (bedomming.live_modus !== 1) {
      return c.json({
        error: "Avslutt er kun gyldig for live rangering (manuell bedømming). Bruk send-inn-flyten for digital bedømming."
      }, 400);
    }

    // Bruker 'fullfort' (gyldig per CHECK-constraint) + live_modus=1 som
    // skiller live-rangering-avslutning fra digital "send-inn"-flyt. Klienten
    // tolker kombinasjonen som "Bedømming ferdig for dagen".
    db.prepare(`
      UPDATE vk_bedomming
      SET status = 'fullfort', submitted_at = datetime('now'), updated_at = datetime('now')
      WHERE prove_id = ? AND parti = ?
    `).run(proveId, parti);

    // Marker evt. mellomlagrede kritikker som intern_kun så de aldri går
    // til NKK. Brukeren kan ha skrevet noter underveis — vi sletter dem
    // ikke (admin kan ha bruk for dem internt) men skiller dem ut.
    db.prepare(`
      UPDATE kritikker SET intern_kun = 1, updated_at = datetime('now')
      WHERE prove_id = ? AND parti_navn = ?
    `).run(proveId, parti);

    db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").run(
      "live_rangering_avsluttet",
      `Live rangering avsluttet for ${parti} på prøve ${proveId}`
    );

    autoBackup("vk-bedomming-live-avsluttet");
    return c.json({ success: true, message: "Live rangering avsluttet" });
  } catch (err) {
    console.error("VK-bedomming avslutt error:", err);
    return c.json({ error: err.message }, 500);
  }
});

// Send inn VK-bedømming for godkjenning
app.post("/api/vk-bedomming/:proveId/:parti/send-inn", async (c) => {
  try {
    const { proveId, parti } = c.req.param();

    // Sjekk at bedømming finnes og er fullført
    const bedomming = db.prepare(`
      SELECT id, status, dommer_telefon, live_modus FROM vk_bedomming WHERE prove_id = ? AND parti = ?
    `).get(proveId, parti);

    if (!bedomming) {
      return c.json({ error: "VK-bedømming ikke funnet" }, 404);
    }

    // Live rangering (manuell bedømming) skal ikke sendes inn til NKK —
    // bruk /avslutt-endepunktet i stedet.
    if (bedomming.live_modus === 1) {
      return c.json({
        error: "Dette er en live rangering. Bruk 'Avslutt live rangering' i stedet for 'Send inn'."
      }, 400);
    }

    if (bedomming.status !== 'fullfort') {
      return c.json({ error: "VK-bedømming må være fullført før innsending" }, 400);
    }

    // Oppdater status til innsendt
    db.prepare(`
      UPDATE vk_bedomming
      SET status = 'innsendt', submitted_at = datetime('now'), updated_at = datetime('now')
      WHERE prove_id = ? AND parti = ?
    `).run(proveId, parti);

    // Varsle NKK-rep om ny innsending
    const prove = db.prepare("SELECT nkkrep_telefon, navn FROM prover WHERE id = ?").get(proveId);
    if (prove?.nkkrep_telefon) {
      const dommer = db.prepare("SELECT fornavn, etternavn FROM brukere WHERE telefon = ?").get(bedomming.dommer_telefon);
      const dommerNavn = dommer ? `${dommer.fornavn} ${dommer.etternavn}` : 'Dommer';

      await sendSMS(prove.nkkrep_telefon,
        `VK-bedømming fra ${dommerNavn} (parti ${parti}) er klar for godkjenning. Prøve: ${prove.navn}. Logg inn på fuglehundprove.no/nkk-godkjenning.html`,
        { type: 'vk_godkjenning' }
      );
    }

    autoBackup("vk-bedomming-innsendt");
    return c.json({ success: true, message: "VK-bedømming sendt inn for godkjenning" });
  } catch (err) {
    console.error("VK-bedomming send-inn error:", err);
    return c.json({ error: err.message }, 500);
  }
});

// Godkjenn VK-bedømming (kun NKK-rep/admin)
app.post("/api/vk-bedomming/:proveId/:parti/godkjenn", requireAdmin, async (c) => {
  try {
    const { proveId, parti } = c.req.param();
    const user = c.get('user');

    const bedomming = db.prepare(`
      SELECT id, status FROM vk_bedomming WHERE prove_id = ? AND parti = ?
    `).get(proveId, parti);

    if (!bedomming) {
      return c.json({ error: "VK-bedømming ikke funnet" }, 404);
    }

    if (bedomming.status !== 'innsendt') {
      return c.json({ error: "VK-bedømming må være innsendt før godkjenning" }, 400);
    }

    // Oppdater til godkjent
    db.prepare(`
      UPDATE vk_bedomming
      SET status = 'godkjent', approved_at = datetime('now'), approved_by = ?, updated_at = datetime('now')
      WHERE prove_id = ? AND parti = ?
    `).run(user?.telefon || 'admin', proveId, parti);

    autoBackup("vk-bedomming-godkjent");
    return c.json({ success: true, message: "VK-bedømming godkjent" });
  } catch (err) {
    console.error("VK-bedomming godkjenn error:", err);
    return c.json({ error: err.message }, 500);
  }
});

// Hent innsendte VK-bedømminger for godkjenning
app.get("/api/vk-bedomming/innsendte", (c) => {
  try {
    const innsendte = db.prepare(`
      SELECT vb.*, p.navn as prove_navn, p.sted,
             b.fornavn || ' ' || b.etternavn as dommer_navn
      FROM vk_bedomming vb
      JOIN prover p ON vb.prove_id = p.id
      LEFT JOIN brukere b ON vb.dommer_telefon = b.telefon
      WHERE vb.status = 'innsendt'
      ORDER BY vb.submitted_at DESC
    `).all();

    return c.json(innsendte);
  } catch (err) {
    console.error("VK-bedomming innsendte error:", err);
    return c.json({ error: err.message }, 500);
  }
});

// Hent live rangering for VK (offentlig tilgjengelig)
app.get("/api/vk-rangering/:proveId/:parti", (c) => {
  try {
    const { proveId, parti } = c.req.param();

    const bedomming = db.prepare(`
      SELECT plasseringer, premietildelinger, dog_data, tid_til_gode, round_snapshots,
             vk_type, current_round, status, live_modus, live_rangering_eier, updated_at
      FROM vk_bedomming WHERE prove_id = ? AND parti = ?
    `).get(proveId, parti);

    if (!bedomming) {
      return c.json({ exists: false });
    }

    // Primærkilde: parti_deltakere (matcher rekkefølge admin/partilister viser).
    // nr = idx+1 korrelerer med pd.startnummer siden den er 1..n sekvensiell per parti.
    let hunder = db.prepare(`
      SELECT pd.hund_regnr, pd.hund_navn, pd.rase, pd.forer_navn,
             h.id as hund_id
      FROM parti_deltakere pd
      JOIN partier pt ON pt.id = pd.parti_id
      LEFT JOIN hunder h ON h.regnr = pd.hund_regnr
      WHERE pd.prove_id = ? AND pt.navn = ? AND COALESCE(pd.status, 'aktiv') != 'trukket'
      ORDER BY pd.startnummer
    `).all(proveId, parti);

    // Fallback: pameldinger (digital pamelding uten parti_deltakere)
    if (hunder.length === 0) {
      hunder = db.prepare(`
        SELECT p.hund_id, p.parti, h.navn as hund_navn, h.rase,
               b.fornavn || ' ' || b.etternavn as forer_navn
        FROM pameldinger p
        JOIN hunder h ON p.hund_id = h.id
        LEFT JOIN brukere b ON p.forer_telefon = b.telefon
        WHERE p.prove_id = ? AND p.parti = ? AND p.klasse = 'VK' AND p.status != 'avmeldt'
        ORDER BY COALESCE(p.startnummer, 999), p.id
      `).all(proveId, parti);
    }

    // Bygg mapping fra nr til hundeinfo (nr er 1-basert indeks i partilisten)
    const nrToHund = {};
    hunder.forEach((p, idx) => {
      nrToHund[idx + 1] = {
        hund_id: p.hund_id,
        hund_navn: p.hund_navn,
        rase: p.rase,
        forer: p.forer_navn
      };
    });

    const plasseringer = JSON.parse(bedomming.plasseringer || '{}');
    const premietildelinger = JSON.parse(bedomming.premietildelinger || '{}');
    const dogData = JSON.parse(bedomming.dog_data || '{}');

    // Aggreger statistikk per hund på tvers av alle slipp så live-rangeringen
    // viser samlet FMR/FUR/slått/sjanser/TS og slipptid for hver hund.
    // dogData har struktur: { hundNr: { slipps: { 1: { fmr, fur, slat, ... } } } }
    function aggregerStats(hundNr) {
      const data = dogData[hundNr];
      if (!data?.slipps) return null;
      const sum = { fmr: 0, fur: 0, slatt: 0, sjanse: 0, ts: 0, slipptid: 0 };
      for (const slipp of Object.values(data.slipps)) {
        if (!slipp) continue;
        sum.fmr += parseInt(slipp.fmr) || 0;
        sum.fur += parseInt(slipp.fur) || 0;
        sum.slatt += parseInt(slipp.slat) || 0;
        sum.sjanse += parseInt(slipp.sjanse) || 0;
        sum.ts += parseInt(slipp.ts) || 0;
        sum.slipptid += parseInt(slipp.slipptid) || 0;
      }
      // Returnerer null hvis alle teller er 0 og slipptid er 0 — sparer
      // klienten for å rendre tomme bokser.
      const harData = sum.fmr || sum.fur || sum.slatt || sum.sjanse || sum.ts || sum.slipptid;
      return harData ? sum : null;
    }

    // Bygg rangering med hundeinfo - plasseringer bruker nr (startnummer) som nøkkel
    const rangering = Object.entries(plasseringer)
      .filter(([_, plass]) => plass !== 'avsluttet')
      .sort((a, b) => parseInt(a[1]) - parseInt(b[1]))
      .map(([nr, plass]) => {
        const hund = nrToHund[parseInt(nr)];
        return {
          plass: parseInt(plass),
          nr: parseInt(nr),
          hund_id: hund?.hund_id || null,
          hund_navn: hund?.hund_navn || `Hund #${nr}`,
          rase: hund?.rase || '',
          forer: hund?.forer || '',
          premie: premietildelinger[nr] || null,
          stats: aggregerStats(parseInt(nr))
        };
      });

    const avsluttet = Object.entries(plasseringer)
      .filter(([_, plass]) => plass === 'avsluttet')
      .map(([nr, _]) => {
        const hund = nrToHund[parseInt(nr)];
        return {
          nr: parseInt(nr),
          hund_id: hund?.hund_id || null,
          hund_navn: hund?.hund_navn || `Hund #${nr}`,
          rase: hund?.rase || '',
          forer: hund?.forer || '',
          stats: aggregerStats(parseInt(nr))
        };
      });

    // Hunder med "Tid til gode" — venter på ny makker eller mer slipptid.
    // Vises på offentlig partiliste mellom rangerte og avsluttede hunder.
    const tidTilGodeRaw = JSON.parse(bedomming.tid_til_gode || '{}');
    const tidTilGode = Object.entries(tidTilGodeRaw)
      .filter(([_, hasTTG]) => hasTTG)
      .map(([nr, _]) => {
        const hund = nrToHund[parseInt(nr)];
        return {
          nr: parseInt(nr),
          hund_id: hund?.hund_id || null,
          hund_navn: hund?.hund_navn || `Hund #${nr}`,
          rase: hund?.rase || '',
          forer: hund?.forer || '',
          stats: aggregerStats(parseInt(nr))
        };
      });

    // Forrige rundes rangering fra snapshot — vises på offentlig partiliste
    // som referanse-liste under avsluttede når runde 2+ pågår.
    let previousRoundRanking = [];
    let previousRoundNumber = null;
    if ((bedomming.current_round || 1) > 1) {
      try {
        const snapshots = JSON.parse(bedomming.round_snapshots || '{}');
        const prevRound = bedomming.current_round - 1;
        const prevSnap = snapshots[prevRound];
        if (prevSnap?.plasseringer) {
          previousRoundNumber = prevRound;
          previousRoundRanking = Object.entries(prevSnap.plasseringer)
            .filter(([_, plass]) => plass !== 'avsluttet')
            .sort((a, b) => parseInt(a[1]) - parseInt(b[1]))
            .map(([nr, plass]) => {
              const hund = nrToHund[parseInt(nr)];
              return {
                plass: parseInt(plass),
                nr: parseInt(nr),
                hund_navn: hund?.hund_navn || `Hund #${nr}`,
                rase: hund?.rase || ''
              };
            });
        }
      } catch (e) { /* ignorer parse-feil */ }
    }

    return c.json({
      exists: true,
      vk_type: bedomming.vk_type,
      current_round: bedomming.current_round,
      status: bedomming.status,
      live_modus: bedomming.live_modus || 0,
      live_rangering_eier: bedomming.live_rangering_eier || null,
      updated_at: bedomming.updated_at,
      rangering,
      tidTilGode,
      avsluttet,
      previousRoundNumber,
      previousRoundRanking
    });
  } catch (err) {
    console.error("VK-rangering GET error:", err);
    return c.json({ error: err.message }, 500);
  }
});

// Hent partiliste for VK-bedømming (for dommer)
app.get("/api/vk-partiliste/:proveId/:parti", (c) => {
  try {
    const { proveId, parti } = c.req.param();

    // Primærkilde: parti_deltakere — samme logikk som /api/partiliste.
    let hunder = db.prepare(`
      SELECT pd.hund_regnr, pd.hund_navn, pd.rase, pd.forer_navn, pd.forer_telefon,
             h.id as hund_id
      FROM parti_deltakere pd
      JOIN partier pt ON pt.id = pd.parti_id
      LEFT JOIN hunder h ON h.regnr = pd.hund_regnr
      WHERE pd.prove_id = ? AND pt.navn = ? AND COALESCE(pd.status, 'aktiv') != 'trukket'
      ORDER BY pd.startnummer
    `).all(proveId, parti);

    let partiliste;
    if (hunder.length > 0) {
      partiliste = hunder.map((p, idx) => ({
        nr: idx + 1,
        hund_id: p.hund_id,
        race: p.rase || '',
        name: p.hund_navn,
        regnr: p.hund_regnr || '',
        owner: p.forer_navn,
        owner_telefon: p.forer_telefon
      }));
    } else {
      // Fallback til pameldinger
      const pameldinger = db.prepare(`
        SELECT p.id, p.hund_id, p.parti, h.navn as hund_navn, h.rase, h.regnr,
               b.fornavn || ' ' || b.etternavn as forer_navn, b.telefon as forer_telefon
        FROM pameldinger p
        JOIN hunder h ON p.hund_id = h.id
        LEFT JOIN brukere b ON p.forer_telefon = b.telefon
        WHERE p.prove_id = ? AND p.parti = ? AND p.klasse = 'VK' AND p.status != 'avmeldt'
        ORDER BY COALESCE(p.startnummer, 999), p.id
      `).all(proveId, parti);
      partiliste = pameldinger.map((p, idx) => ({
        nr: idx + 1,
        hund_id: p.hund_id,
        race: p.rase || '',
        name: p.hund_navn,
        regnr: p.regnr || '',
        owner: p.forer_navn,
        owner_telefon: p.forer_telefon
      }));
    }

    return c.json({ partiliste });
  } catch (err) {
    console.error("VK-partiliste GET error:", err);
    return c.json({ error: err.message }, 500);
  }
});

// ============ DOMMER-NOTATER API (individuelle notater per dommer) ============

// Hent dommerens notater for et parti
app.get("/api/dommer-notater/:proveId/:parti", requireAuth, (c) => {
  try {
    const { proveId, parti } = c.req.param();
    const user = c.get('user');
    const dommer_telefon = user?.telefon;

    if (!dommer_telefon) {
      return c.json({ error: "Ikke autentisert" }, 401);
    }

    const notater = db.prepare(`
      SELECT * FROM dommer_notater
      WHERE prove_id = ? AND parti = ? AND dommer_telefon = ?
      ORDER BY hund_id, slipp_nr
    `).all(proveId, parti, dommer_telefon);

    return c.json({ notater });
  } catch (err) {
    console.error("Dommer-notater GET error:", err);
    return c.json({ error: err.message }, 500);
  }
});

// Lagre/oppdater dommerens notater for en hund
app.put("/api/dommer-notater/:proveId/:parti/:hundId", requireAuth, async (c) => {
  try {
    const { proveId, parti, hundId } = c.req.param();
    const body = await c.req.json();
    const user = c.get('user');
    const dommer_telefon = user?.telefon;

    if (!dommer_telefon) {
      return c.json({ error: "Ikke autentisert" }, 401);
    }

    const slipp_nr = body.slipp_nr || 1;

    // Sjekk om det finnes fra før
    const existing = db.prepare(`
      SELECT id FROM dommer_notater
      WHERE prove_id = ? AND parti = ? AND hund_id = ? AND dommer_telefon = ? AND slipp_nr = ?
    `).get(proveId, parti, hundId, dommer_telefon, slipp_nr);

    if (existing) {
      // Oppdater
      db.prepare(`
        UPDATE dommer_notater SET
          slipptid = ?, stand_m = ?, stand_u = ?, tomstand = ?, makker_stand = ?, sjanse = ?,
          jaktlyst = ?, fart = ?, selvstendighet = ?, soksbredde = ?, reviering = ?, samarbeid = ?,
          presisjon = ?, reising = ?, apport = ?, notater = ?,
          updated_at = datetime('now')
        WHERE id = ?
      `).run(
        body.slipptid || 0, body.stand_m || 0, body.stand_u || 0, body.tomstand || 0, body.makker_stand || 0, body.sjanse || 0,
        body.jaktlyst, body.fart, body.selvstendighet, body.soksbredde, body.reviering, body.samarbeid,
        body.presisjon, body.reising, body.apport, body.notater || '',
        existing.id
      );
    } else {
      // Opprett ny
      db.prepare(`
        INSERT INTO dommer_notater (
          prove_id, parti, hund_id, dommer_telefon, slipp_nr,
          slipptid, stand_m, stand_u, tomstand, makker_stand, sjanse,
          jaktlyst, fart, selvstendighet, soksbredde, reviering, samarbeid,
          presisjon, reising, apport, notater
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        proveId, parti, hundId, dommer_telefon, slipp_nr,
        body.slipptid || 0, body.stand_m || 0, body.stand_u || 0, body.tomstand || 0, body.makker_stand || 0, body.sjanse || 0,
        body.jaktlyst, body.fart, body.selvstendighet, body.soksbredde, body.reviering, body.samarbeid,
        body.presisjon, body.reising, body.apport, body.notater || ''
      );
    }

    return c.json({ success: true });
  } catch (err) {
    console.error("Dommer-notater PUT error:", err);
    return c.json({ error: err.message }, 500);
  }
});

// Hent alle dommere på et parti (for å vise hvem som er meddommer)
app.get("/api/parti-dommere/:proveId/:parti", (c) => {
  try {
    const { proveId, parti } = c.req.param();

    const dommere = db.prepare(`
      SELECT dt.dommer_telefon, dt.dommer_rolle, b.fornavn, b.etternavn
      FROM dommer_tildelinger dt
      JOIN brukere b ON dt.dommer_telefon = b.telefon
      WHERE dt.prove_id = ? AND dt.parti = ?
      ORDER BY dt.dommer_rolle
    `).all(proveId, parti);

    return c.json({ dommere });
  } catch (err) {
    console.error("Parti-dommere GET error:", err);
    return c.json({ error: err.message }, 500);
  }
});

// ============ LIVE-RANGERING EIER (VK) ============

// Sett hvem som eier live-rangeringen for et VK-parti
app.post("/api/vk-bedomming/:proveId/:parti/set-live-eier", requireAuth, async (c) => {
  try {
    const { proveId, parti } = c.req.param();
    const body = await c.req.json();
    const user = c.get('user');

    // Sjekk at brukeren er en av dommerne på partiet
    const dommer = db.prepare(`
      SELECT dommer_telefon FROM dommer_tildelinger
      WHERE prove_id = ? AND parti = ? AND dommer_telefon = ?
    `).get(proveId, parti, user?.telefon);

    if (!dommer) {
      return c.json({ error: "Du er ikke tildelt dette partiet" }, 403);
    }

    // Sjekk om live-eier allerede er satt
    const existing = db.prepare(`
      SELECT live_rangering_eier FROM vk_bedomming WHERE prove_id = ? AND parti = ?
    `).get(proveId, parti);

    if (existing && existing.live_rangering_eier) {
      return c.json({ error: "Live-rangering eier er allerede valgt", eier: existing.live_rangering_eier }, 409);
    }

    // Sett live-eier og innstillinger
    const eierTelefon = body.eier_telefon || user.telefon;
    const inkluderSlippKommentarer = body.inkluder_slipp_kommentarer ? 1 : 0;

    if (existing) {
      db.prepare(`
        UPDATE vk_bedomming SET
          live_rangering_eier = ?,
          inkluder_slipp_kommentarer = ?,
          updated_at = datetime('now')
        WHERE prove_id = ? AND parti = ?
      `).run(eierTelefon, inkluderSlippKommentarer, proveId, parti);
    } else {
      // Opprett ny vk_bedomming rad med live-eier
      db.prepare(`
        INSERT INTO vk_bedomming (prove_id, parti, dommer_telefon, live_rangering_eier, inkluder_slipp_kommentarer)
        VALUES (?, ?, ?, ?, ?)
      `).run(proveId, parti, user.telefon, eierTelefon, inkluderSlippKommentarer);
    }

    return c.json({
      success: true,
      live_rangering_eier: eierTelefon,
      inkluder_slipp_kommentarer: inkluderSlippKommentarer === 1
    });
  } catch (err) {
    console.error("Set live-eier error:", err);
    return c.json({ error: err.message }, 500);
  }
});

// Hent live-rangering eier status
app.get("/api/vk-bedomming/:proveId/:parti/live-eier", (c) => {
  try {
    const { proveId, parti } = c.req.param();

    const bedomming = db.prepare(`
      SELECT live_rangering_eier, dommer_telefon, inkluder_slipp_kommentarer
      FROM vk_bedomming WHERE prove_id = ? AND parti = ?
    `).get(proveId, parti);

    if (!bedomming) {
      return c.json({ eier_valgt: false, live_rangering_eier: null, inkluder_slipp_kommentarer: false });
    }

    return c.json({
      eier_valgt: !!bedomming.live_rangering_eier,
      live_rangering_eier: bedomming.live_rangering_eier,
      inkluder_slipp_kommentarer: bedomming.inkluder_slipp_kommentarer === 1
    });
  } catch (err) {
    console.error("Get live-eier error:", err);
    return c.json({ error: err.message }, 500);
  }
});

// ============ MEDDOMMER-BEKREFTELSE FOR KRITIKKER ============

// Hent kritikker som venter på meddommer-bekreftelse
app.get("/api/kritikker/venter-meddommer/:telefon", requireAuth, (c) => {
  try {
    const telefon = c.req.param("telefon");

    const kritikker = db.prepare(`
      SELECT k.*, h.navn as hund_navn, h.rase, p.navn as prove_navn
      FROM kritikker k
      JOIN hunder h ON k.hund_id = h.id
      JOIN prover p ON k.prove_id = p.id
      WHERE k.meddommer_telefon = ? AND k.status = 'venter_meddommer'
      ORDER BY k.created_at DESC
    `).all(telefon);

    return c.json({ kritikker });
  } catch (err) {
    console.error("Kritikker venter-meddommer GET error:", err);
    return c.json({ error: err.message }, 500);
  }
});

// Send kritikk til meddommer for bekreftelse
app.post("/api/kritikker/:kritikkId/send-til-meddommer", requireAuth, async (c) => {
  try {
    const kritikkId = c.req.param("kritikkId");
    const body = await c.req.json();
    const user = c.get('user');

    const kritikk = db.prepare("SELECT * FROM kritikker WHERE id = ?").get(kritikkId);
    if (!kritikk) {
      return c.json({ error: "Kritikk ikke funnet" }, 404);
    }

    // Verifiser at bruker er dommer på kritikken
    if (kritikk.dommer_telefon !== user?.telefon) {
      return c.json({ error: "Du har ikke tilgang til denne kritikken" }, 403);
    }

    // Oppdater kritikken med meddommer og status
    db.prepare(`
      UPDATE kritikker SET
        meddommer_telefon = ?,
        status = 'venter_meddommer',
        updated_at = datetime('now')
      WHERE id = ?
    `).run(body.meddommer_telefon, kritikkId);

    return c.json({ success: true });
  } catch (err) {
    console.error("Send til meddommer error:", err);
    return c.json({ error: err.message }, 500);
  }
});

// Meddommer bekrefter kritikk
app.post("/api/kritikker/:kritikkId/bekreft-meddommer", requireAuth, async (c) => {
  try {
    const kritikkId = c.req.param("kritikkId");
    const user = c.get('user');

    const kritikk = db.prepare("SELECT * FROM kritikker WHERE id = ?").get(kritikkId);
    if (!kritikk) {
      return c.json({ error: "Kritikk ikke funnet" }, 404);
    }

    // Verifiser at bruker er meddommer på kritikken
    if (kritikk.meddommer_telefon !== user?.telefon) {
      return c.json({ error: "Du er ikke meddommer på denne kritikken" }, 403);
    }

    if (kritikk.status !== 'venter_meddommer') {
      return c.json({ error: "Kritikken venter ikke på meddommer-bekreftelse" }, 400);
    }

    // Oppdater kritikken til submitted (sendt til NKK-rep)
    db.prepare(`
      UPDATE kritikker SET
        meddommer_bekreftet_at = datetime('now'),
        status = 'submitted',
        submitted_at = datetime('now'),
        updated_at = datetime('now')
      WHERE id = ?
    `).run(kritikkId);

    // === AUTOMATISK MEDDOMMER-SIGNATUR PÅ PARTILISTEN ===
    // Legg til meddommers signatur på partilisten
    if (kritikk.prove_id && kritikk.parti) {
      const meddommerNavn = user?.fornavn && user?.etternavn
        ? `${user.fornavn} ${user.etternavn}`
        : (user?.navn || 'Meddommer');

      // Sjekk om meddommer allerede har signert dette partiet
      const existingMeddommerSig = db.prepare(`
        SELECT * FROM parti_signaturer
        WHERE prove_id = ? AND parti = ? AND dommer_telefon = ?
      `).get(kritikk.prove_id, kritikk.parti, user?.telefon);

      if (existingMeddommerSig) {
        // Oppdater eksisterende signatur
        db.prepare(`
          UPDATE parti_signaturer
          SET dommer_signert_at = datetime('now'), dommer_navn = ?
          WHERE id = ?
        `).run(meddommerNavn, existingMeddommerSig.id);
      } else {
        // Opprett ny signatur for meddommer
        db.prepare(`
          INSERT INTO parti_signaturer (prove_id, parti, dommer_telefon, dommer_navn, dommer_signert_at)
          VALUES (?, ?, ?, ?, datetime('now'))
        `).run(kritikk.prove_id, kritikk.parti, user?.telefon, meddommerNavn);
      }
      console.log(`📝 Meddommer-signatur lagt til for ${meddommerNavn} på parti ${kritikk.parti}`);
    }

    return c.json({ success: true, meddommerSignert: true });
  } catch (err) {
    console.error("Bekreft meddommer error:", err);
    return c.json({ error: err.message }, 500);
  }
});

// Meddommer avviser kritikk (sender tilbake til dommer)
app.post("/api/kritikker/:kritikkId/avvis-meddommer", requireAuth, async (c) => {
  try {
    const kritikkId = c.req.param("kritikkId");
    const body = await c.req.json();
    const user = c.get('user');

    const kritikk = db.prepare("SELECT * FROM kritikker WHERE id = ?").get(kritikkId);
    if (!kritikk) {
      return c.json({ error: "Kritikk ikke funnet" }, 404);
    }

    if (kritikk.meddommer_telefon !== user?.telefon) {
      return c.json({ error: "Du er ikke meddommer på denne kritikken" }, 403);
    }

    // Send tilbake til dommer med kommentar
    db.prepare(`
      UPDATE kritikker SET
        status = 'draft',
        nkk_comment = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(body.kommentar || 'Avvist av meddommer', kritikkId);

    return c.json({ success: true });
  } catch (err) {
    console.error("Avvis meddommer error:", err);
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
