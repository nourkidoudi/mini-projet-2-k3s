const express = require('express');
const { Pool } = require('pg');

// --- Configuration : uniquement via variables d'environnement ---
const required = ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'API_PORT'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  log('error', `Variables manquantes : ${missing.join(', ')}`);
  process.exit(1);
}

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

// Logs sur la sortie standard (JSON, une ligne par évènement)
function log(level, msg, extra = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra }));
}

// Migration automatique avec nouvelles tentatives (la base peut démarrer après l'API)
async function migrate(retries = 30) {
  for (let i = 1; i <= retries; i++) {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS tasks (
          id SERIAL PRIMARY KEY,
          title TEXT NOT NULL,
          done BOOLEAN NOT NULL DEFAULT FALSE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
      log('info', 'Connexion à la base réussie, table tasks prête');
      return;
    } catch (e) {
      log('warn', `Base injoignable (tentative ${i}/${retries})`, { error: e.message });
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  log('error', 'Impossible de joindre la base, arrêt');
  process.exit(1);
}

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.on('finish', () => log('info', 'request', { method: req.method, path: req.path, status: res.statusCode }));
  next();
});

// --- Points de contrôle ---
app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));
app.get('/ready', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.status(200).json({ status: 'ready' });
  } catch (e) {
    res.status(503).json({ status: 'not ready' });
  }
});

// --- CRUD sur /tasks ---
const wrap = (fn) => (req, res) =>
  fn(req, res).catch((e) => {
    log('error', 'erreur serveur', { error: e.message });
    res.status(500).json({ error: 'Erreur interne' });
  });

app.get('/tasks', wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM tasks ORDER BY id');
  res.json(rows);
}));

app.post('/tasks', wrap(async (req, res) => {
  const { title } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: 'title requis' });
  const { rows } = await pool.query('INSERT INTO tasks (title) VALUES ($1) RETURNING *', [title.trim()]);
  res.status(201).json(rows[0]);
}));

app.put('/tasks/:id', wrap(async (req, res) => {
  const { title, done } = req.body || {};
  const { rows } = await pool.query(
    'UPDATE tasks SET title = COALESCE($1, title), done = COALESCE($2, done) WHERE id = $3 RETURNING *',
    [title ?? null, done ?? null, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'introuvable' });
  res.json(rows[0]);
}));

app.delete('/tasks/:id', wrap(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM tasks WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'introuvable' });
  res.status(204).end();
}));

migrate().then(() => {
  const server = app.listen(Number(process.env.API_PORT), () =>
    log('info', `API à l'écoute sur le port ${process.env.API_PORT}`));
  process.on('SIGTERM', () => {
    log('info', 'SIGTERM reçu, arrêt propre');
    server.close(() => pool.end().then(() => process.exit(0)));
  });
});
