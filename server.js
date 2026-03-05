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

  INSERT OR IGNORE INTO trial_config (id) VALUES (1);
`);

const app = new Hono();

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
  return c.json({ kvEntries: kvCount, adminLogEntries: logCount, trial });
});

// --- Backup ---
app.get("/api/backup", (c) => {
  if (!existsSync(DB_PATH)) return c.text("No database", 404);
  const data = readFileSync(DB_PATH);
  c.header("Content-Type", "application/octet-stream");
  c.header("Content-Disposition", `attachment; filename="fuglehund-${new Date().toISOString().slice(0, 10)}.db"`);
  return c.body(data);
});

// --- Parse participant list (PDF, CSV, Excel) ---
app.post("/api/parse-participants", async (c) => {
  const formData = await c.req.formData();
  const file = formData.get("file");

  if (!file) {
    return c.json({ error: "Ingen fil lastet opp" }, 400);
  }

  const fileName = file.name.toLowerCase();
  const buffer = Buffer.from(await file.arrayBuffer());

  let participants = [];

  try {
    if (fileName.endsWith(".pdf")) {
      // Parse PDF
      const pdfData = await pdfParse(buffer);
      const lines = pdfData.text.split("\n").map(l => l.trim()).filter(l => l.length > 0);

      // Skip header lines and parse data
      // Format: Regnr, Navn, Rase, Eier, Fører, Klasse, Epost
      for (const line of lines) {
        // Try to match registration number pattern (e.g., NO12345/22 or SE12345/22)
        const regMatch = line.match(/([A-Z]{2}\d+\/\d+)/);
        if (regMatch) {
          // Split line by multiple spaces or tabs
          const parts = line.split(/\s{2,}|\t/).map(p => p.trim()).filter(p => p);

          if (parts.length >= 5) {
            const participant = {
              regnr: parts[0] || "",
              hundenavn: parts[1] || "",
              rase: parts[2] || "",
              eier: parts[3] || "",
              forer: parts[4] || parts[3] || "", // Fører, fallback to eier
              klasse: parts[5] || "AK",
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
        const regexPattern = /([A-Z]{2}\d+\/\d+)\s+(.+?)\s{2,}(.+?)\s{2,}(.+?)\s{2,}(.+?)\s{2,}(UK|AK|VK)\s*(.+)?/i;
        for (const line of lines) {
          const match = line.match(regexPattern);
          if (match) {
            participants.push({
              regnr: match[1],
              hundenavn: match[2].trim(),
              rase: match[3].trim(),
              eier: match[4].trim(),
              forer: match[5].trim(),
              klasse: match[6].toUpperCase(),
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
          participants.push({
            regnr: parts[0] || "",
            hundenavn: parts[1] || "",
            rase: parts[2] || "",
            eier: parts[3] || "",
            forer: parts[4] || parts[3] || "",
            klasse: parts[5] || "AK",
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
          participants.push({
            regnr: String(row[0] || ""),
            hundenavn: String(row[1] || ""),
            rase: String(row[2] || ""),
            eier: String(row[3] || ""),
            forer: String(row[4] || row[3] || ""),
            klasse: String(row[5] || "AK").toUpperCase(),
            epost: String(row[6] || "")
          });
        }
      }
    } else {
      return c.json({ error: "Ugyldig filformat. Bruk PDF, CSV eller Excel (.xlsx)" }, 400);
    }

    // Filter out empty entries
    participants = participants.filter(p => p.regnr && p.hundenavn);

    // Categorize by class
    const byClass = {
      UK: participants.filter(p => p.klasse === "UK"),
      AK: participants.filter(p => p.klasse === "AK"),
      VK: participants.filter(p => p.klasse === "VK")
    };

    return c.json({
      success: true,
      total: participants.length,
      byClass: {
        UK: byClass.UK.length,
        AK: byClass.AK.length,
        VK: byClass.VK.length
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

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`🐕 Fuglehundprøve running on http://localhost:${PORT}`);
  console.log(`   Admin: http://localhost:${PORT}/admin-panel.html`);
  console.log(`   Backup: http://localhost:${PORT}/api/backup`);
});
