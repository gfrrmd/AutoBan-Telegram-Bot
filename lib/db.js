const cfg = require('./config');

// Key lama (JWT, awalan eyJ) dikirim juga sebagai Bearer. Key baru (sb_secret_...) hanya boleh lewat header apikey.
function authHeaders(extra) {
  const h = { apikey: cfg.SUPABASE_KEY, ...(extra || {}) };
  if (/^eyJ/.test(cfg.SUPABASE_KEY)) h.Authorization = `Bearer ${cfg.SUPABASE_KEY}`;
  return h;
}

function qs(params) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null) u.append(k, String(v));
  }
  return u.toString();
}

async function request(method, table, params, body, prefer) {
  const query = params && Object.keys(params).length ? `?${qs(params)}` : '';
  const headers = authHeaders({ 'Content-Type': 'application/json' });
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${cfg.SUPABASE_URL}/rest/v1/${table}${query}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`DB ${method} ${table} ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const select = (table, params) => request('GET', table, params);

async function selectAll(table, params = {}) {
  const out = [];
  const size = 1000;
  for (let offset = 0; ; offset += size) {
    const rows = await request('GET', table, { ...params, limit: size, offset });
    out.push(...rows);
    if (rows.length < size) break;
  }
  return out;
}

// Hitung baris tanpa mengunduhnya (tidak dibatasi 1000)
async function count(table, filters = {}) {
  const res = await fetch(`${cfg.SUPABASE_URL}/rest/v1/${table}?${qs({ ...filters, select: '*' })}`, {
    method: 'GET',
    headers: authHeaders({ Prefer: 'count=exact', Range: '0-0', 'Range-Unit': 'items' }),
  });
  if (!res.ok && res.status !== 206) throw new Error(`DB COUNT ${table} ${res.status}`);
  const total = String(res.headers.get('content-range') || '').split('/')[1];
  return Number(total) || 0;
}

async function insert(table, rows, { onConflict, ignore } = {}) {
  const list = Array.isArray(rows) ? rows : [rows];
  if (!list.length) return;
  const prefer = ignore ? 'resolution=ignore-duplicates,return=minimal' : 'return=minimal';
  const params = onConflict ? { on_conflict: onConflict } : undefined;
  for (let i = 0; i < list.length; i += 500) {
    await request('POST', table, params, list.slice(i, i + 500), prefer);
  }
}

async function upsert(table, rows, onConflict) {
  const list = Array.isArray(rows) ? rows : [rows];
  const params = onConflict ? { on_conflict: onConflict } : undefined;
  await request('POST', table, params, list, 'resolution=merge-duplicates,return=minimal');
}

async function update(table, filters, patch) {
  if (!filters || !Object.keys(filters).length) throw new Error('update tanpa filter ditolak');
  await request('PATCH', table, filters, patch, 'return=minimal');
}

// Seperti update, tetapi mengembalikan baris yang terubah. Dipakai untuk "klaim" atomik.
async function updateReturning(table, filters, patch) {
  if (!filters || !Object.keys(filters).length) throw new Error('update tanpa filter ditolak');
  const rows = await request('PATCH', table, filters, patch, 'return=representation');
  return rows || [];
}

async function remove(table, filters) {
  if (!filters || !Object.keys(filters).length) throw new Error('delete tanpa filter ditolak');
  await request('DELETE', table, filters, undefined, 'return=minimal');
}

const DEFAULT_SETTINGS = { sim_mode: true, notify: true, passive_lock: 0, ban_dm: false };

async function getSettings() {
  const rows = await select('settings', {});
  const out = { ...DEFAULT_SETTINGS };
  for (const r of rows || []) out[r.key] = r.value;
  return out;
}

const setSetting = (key, value) => upsert('settings', { key, value }, 'key');

async function getSession(user_id) {
  const rows = await select('sessions', { user_id: `eq.${user_id}`, limit: 1 });
  const s = rows && rows[0];
  if (!s) return null;
  if (Date.now() - new Date(s.updated_at).getTime() > 15 * 60 * 1000) return null;
  return s;
}
const setSession = (user_id, state, data) =>
  upsert('sessions', { user_id, state, data: data || {}, updated_at: new Date().toISOString() }, 'user_id');
const clearSession = (user_id) => remove('sessions', { user_id: `eq.${user_id}` });

async function getChat(chat_id) {
  const rows = await select('chats', { chat_id: `eq.${chat_id}`, limit: 1 });
  return (rows && rows[0]) || null;
}

module.exports = {
  select, selectAll, count, insert, upsert, update, updateReturning, remove,
  getSettings, setSetting, getSession, setSession, clearSession, getChat,
};
