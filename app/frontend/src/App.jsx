import { useEffect, useState } from 'react';

// Toujours un chemin relatif : nginx (ou le proxy Vite) relaie /api/ vers l'API.
const API = '/api/tasks';

const FILTERS = [
  { id: 'all', label: 'Toutes' },
  { id: 'todo', label: 'À faire' },
  { id: 'done', label: 'Terminées' },
];

const fmtDate = (iso) =>
  new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export default function App() {
  const [tasks, setTasks] = useState([]);
  const [title, setTitle] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editTitle, setEditTitle] = useState('');
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [filter, setFilter] = useState('all');

  async function request(url, options) {
    const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
    if (!res.ok) throw new Error(`Erreur ${res.status}`);
    return res.status === 204 ? null : res.json();
  }

  async function load() {
    try {
      setTasks(await request(API));
      setError('');
    } catch (e) {
      setError("Impossible de joindre l'API : " + e.message);
    } finally {
      setLoaded(true);
    }
  }

  useEffect(() => { load(); }, []);

  async function act(fn) {
    try { await fn(); await load(); } catch (e) { setError(e.message); }
  }

  const add = (e) => {
    e.preventDefault();
    if (!title.trim()) return;
    act(() => request(API, { method: 'POST', body: JSON.stringify({ title }) }));
    setTitle('');
  };
  const toggle = (t) => act(() => request(`${API}/${t.id}`, { method: 'PUT', body: JSON.stringify({ done: !t.done }) }));
  const remove = (t) => act(() => request(`${API}/${t.id}`, { method: 'DELETE' }));
  const saveEdit = (t) => {
    if (editTitle.trim()) act(() => request(`${API}/${t.id}`, { method: 'PUT', body: JSON.stringify({ title: editTitle }) }));
    setEditingId(null);
  };

  const doneCount = tasks.filter((t) => t.done).length;
  const percent = tasks.length ? Math.round((doneCount / tasks.length) * 100) : 0;
  const visible = tasks.filter((t) => filter === 'all' || (filter === 'done') === t.done);

  return (
    <main className="page">
      <h1>Mes tâches</h1>

      <section className="summary" aria-live="polite">
        <p>
          <strong>{doneCount} sur {tasks.length}</strong> terminée{doneCount > 1 ? 's' : ''}
        </p>
        <div className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label="Progression">
          <span style={{ width: `${percent}%` }} />
        </div>
      </section>

      {error && <div className="error" role="alert">{error}</div>}

      <form className="add" onSubmit={add}>
        <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Que faut-il faire ?" aria-label="Nouvelle tâche" />
        <button className="primary" type="submit">Ajouter</button>
      </form>

      <div className="filters" role="group" aria-label="Filtrer les tâches">
        {FILTERS.map((f) => (
          <button key={f.id} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}</button>
        ))}
      </div>

      {loaded && visible.length === 0 ? (
        <div className="empty">
          {tasks.length === 0 ? 'Aucune tâche pour le moment. Ajoutez la première ci-dessus.' : 'Aucune tâche dans cette vue.'}
        </div>
      ) : (
        <ul>
          {visible.map((t) => (
            <li key={t.id} className={t.done ? 'done' : ''}>
              <input type="checkbox" checked={t.done} onChange={() => toggle(t)} aria-label={`Terminer : ${t.title}`} />
              {editingId === t.id ? (
                <>
                  <input
                    type="text" autoFocus value={editTitle} aria-label="Modifier le titre"
                    onChange={(e) => setEditTitle(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') saveEdit(t); if (e.key === 'Escape') setEditingId(null); }}
                  />
                  <div className="actions">
                    <button className="ghost" onClick={() => saveEdit(t)}>Enregistrer</button>
                    <button className="ghost" onClick={() => setEditingId(null)}>Annuler</button>
                  </div>
                </>
              ) : (
                <>
                  <div className="label">
                    <span>{t.title}</span>
                    <small>Ajoutée le {fmtDate(t.created_at)}</small>
                  </div>
                  <div className="actions">
                    <button className="ghost" onClick={() => { setEditingId(t.id); setEditTitle(t.title); }}>Modifier</button>
                    <button className="ghost danger" onClick={() => remove(t)}>Supprimer</button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
