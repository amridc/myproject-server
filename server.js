const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');

const app = express();

// In der Cloud gibt die Plattform den Port vor (process.env.PORT).
// Lokal zum Testen nehmen wir 3000.
const PORT = process.env.PORT || 3000;

// Speicherorte:
// - DATEN_ORDNER: hier liegen die Fotos. In der Cloud ein dauerhafter Pfad,
//   lokal einfach ein Unterordner "daten".
const DATEN_ORDNER = process.env.DATEN_ORDNER || path.join(__dirname, 'daten');
const PROJEKTE_ROOT = path.join(DATEN_ORDNER, 'Projekte');
const USERS = path.join(DATEN_ORDNER, 'benutzer.json');

fs.ensureDirSync(PROJEKTE_ROOT);

app.use(cors());
app.use(express.json());

// ── Hilfsfunktionen ──────────────────────────────────────────
function ladeBenutzer() { try { return fs.readJsonSync(USERS); } catch { return { benutzer: [] }; } }
function speichereBenutzer(b) { fs.writeJsonSync(USERS, b, { spaces: 2 }); }
function hashPasswort(pw, salt) { return crypto.scryptSync(pw, salt, 64).toString('hex'); }
function sicherName(n) { return path.basename((n || '').trim()); }
function heuteDatum() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

async function alleFotos(fotosPfad) {
  const ergebnis = [];
  if (!await fs.pathExists(fotosPfad)) return ergebnis;
  async function gehe(dir, rel) {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const voll = path.join(dir, e.name);
      const rp = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await gehe(voll, rp);
      else if (/\.(jpe?g|png|heic|heif)$/i.test(e.name)) {
        const st = await fs.stat(voll);
        ergebnis.push({ pfad: rp, zeit: st.mtimeMs });
      }
    }
  }
  await gehe(fotosPfad, '');
  ergebnis.sort((a, b) => b.zeit - a.zeit);
  return ergebnis;
}

// ── Anmeldung ────────────────────────────────────────────────
const tokens = new Map();
function auth(req, res, next) {
  const t = (req.headers.authorization || '').replace('Bearer ', '');
  if (t && tokens.has(t)) next(); else res.status(401).json({ fehler: 'Nicht angemeldet' });
}

// Startseite, damit man im Browser sieht, dass der Server lebt
app.get('/', (req, res) => res.send('MyProject Server läuft ✓'));
app.get('/status', (req, res) => res.json({ ok: true, version: 'cloud-1.0' }));

app.post('/login', (req, res) => {
  const { benutzer, passwort } = req.body || {};
  const u = ladeBenutzer().benutzer.find(x => x.name.toLowerCase() === (benutzer || '').toLowerCase());
  if (!u || hashPasswort(passwort || '', u.salt) !== u.hash)
    return res.status(401).json({ fehler: 'Benutzername oder Passwort falsch' });
  const t = crypto.randomBytes(24).toString('hex');
  tokens.set(t, u.name);
  res.json({ erfolg: true, token: t, name: u.name });
});

app.get('/projekte', auth, async (req, res) => {
  await fs.ensureDir(PROJEKTE_ROOT);
  const liste = await fs.readdir(PROJEKTE_ROOT, { withFileTypes: true });
  const projekte = [];
  for (const e of liste) {
    if (!e.isDirectory()) continue;
    const f = await alleFotos(path.join(PROJEKTE_ROOT, e.name, 'Fotos'));
    projekte.push({ name: e.name, anzahlFotos: f.length });
  }
  projekte.sort((a, b) => a.name.localeCompare(b.name));
  res.json({ projekte });
});

app.post('/projekte', auth, async (req, res) => {
  const n = sicherName(req.body && req.body.name);
  if (!n) return res.status(400).json({ fehler: 'Name fehlt' });
  for (const s of ['Auftrag', 'Rechnungen', 'Fotos']) await fs.ensureDir(path.join(PROJEKTE_ROOT, n, s));
  res.json({ erfolg: true, name: n });
});

app.get('/projekte/:p/fotos', auth, async (req, res) => {
  res.json({ fotos: await alleFotos(path.join(PROJEKTE_ROOT, sicherName(req.params.p), 'Fotos')) });
});

app.get('/projekte/:p/foto', auth, async (req, res) => {
  const basis = path.resolve(path.join(PROJEKTE_ROOT, sicherName(req.params.p), 'Fotos'));
  const ziel = path.resolve(basis, req.query.datei || '');
  if (ziel !== basis && !ziel.startsWith(basis + path.sep)) return res.status(400).end();
  if (!await fs.pathExists(ziel)) return res.status(404).end();
  res.sendFile(ziel);
});

const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const z = path.join(PROJEKTE_ROOT, sicherName(req.params.p), 'Fotos', heuteDatum());
    await fs.ensureDir(z); cb(null, z);
  },
  filename: (req, file, cb) =>
    cb(null, `foto_${Date.now()}_${Math.floor(Math.random()*1000)}${path.extname(file.originalname) || '.jpg'}`)
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

app.post('/upload/:p', auth, upload.array('fotos', 20), (req, res) => {
  if (!req.files || !req.files.length) return res.status(400).json({ fehler: 'Keine Fotos' });
  console.log(`[${heuteDatum()}] ${req.files.length} Foto(s) -> ${sicherName(req.params.p)}`);
  res.json({ erfolg: true, anzahl: req.files.length });
});

// Benutzer per Befehl anlegen:  node server.js adduser NAME PASSWORT
if (process.argv[2] === 'adduser') {
  const name = process.argv[3];
  const pass = process.argv[4];
  if (!name || !pass) { console.log('Aufruf: node server.js adduser NAME PASSWORT'); process.exit(1); }
  const db = ladeBenutzer();
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPasswort(pass, salt);
  const vorhanden = db.benutzer.find(u => u.name.toLowerCase() === name.toLowerCase());
  if (vorhanden) { vorhanden.salt = salt; vorhanden.hash = hash; }
  else db.benutzer.push({ name, salt, hash });
  speichereBenutzer(db);
  console.log(`Benutzer "${name}" gespeichert. Insgesamt ${db.benutzer.length}.`);
  process.exit(0);
}

// Automatisch einen Benutzer anlegen, wenn ADMIN_USER/ADMIN_PASS gesetzt sind.
// Praktisch in der Cloud (Render): Variablen eintragen -> beim Start wird der
// Benutzer angelegt oder sein Passwort aktualisiert.
function adminAusUmgebung() {
  const name = process.env.ADMIN_USER;
  const pass = process.env.ADMIN_PASS;
  if (!name || !pass) return;
  const db = ladeBenutzer();
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPasswort(pass, salt);
  const vorhanden = db.benutzer.find(u => u.name.toLowerCase() === name.toLowerCase());
  if (vorhanden) { vorhanden.salt = salt; vorhanden.hash = hash; }
  else db.benutzer.push({ name, salt, hash });
  speichereBenutzer(db);
  console.log(`Benutzer "${name}" aus Umgebungsvariablen bereit.`);
}

adminAusUmgebung();

app.listen(PORT, () => {
  console.log(`MyProject Server laeuft auf Port ${PORT}`);
  console.log(`Datenordner: ${DATEN_ORDNER}`);
});
