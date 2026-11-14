// Database dan Telegram tiruan untuk pengujian (tanpa jaringan)
process.env.BOT_TOKEN = '999:TEST';
process.env.ADMIN_IDS = '1,2';
process.env.SUPABASE_URL = 'http://x';
process.env.SUPABASE_SERVICE_KEY = 'x';

const db = require('../lib/db');
const tg = require('../lib/telegram');

function matcher(val, expr) {
  const i = expr.indexOf('.');
  const op = expr.slice(0, i);
  const rhs = expr.slice(i + 1);
  if (op === 'eq') return String(val) === rhs;
  if (op === 'in') return rhs.slice(1, -1).split(',').includes(String(val));
  if (op === 'lte') return val != null && new Date(val) <= new Date(rhs);
  if (op === 'lt') return val != null && new Date(val) < new Date(rhs);
  if (op === 'gte') return val != null && new Date(val) >= new Date(rhs);
  throw new Error('op tidak didukung: ' + op);
}

function setup() {
  const t = { chats: [], join_requests: [], whitelist: [], settings: [], sessions: [], members: [], misses: [], ban_log: [], posts: [] };
  let seq = 1;
  const RESERVED = ['select', 'limit', 'offset', 'order', 'or'];
  const filter = (table, f = {}) =>
    (t[table] || []).filter((r) => Object.entries(f).every(([k, v]) => RESERVED.includes(k) || matcher(r[k], v)));

  db.select = async (table, f = {}) => filter(table, f).slice(0, f.limit || 1000).map((r) => ({ ...r }));
  db.selectAll = async (table, f = {}) => filter(table, f).map((r) => ({ ...r }));
  db.getChat = async (id) => (t.chats.find((c) => String(c.chat_id) === String(id)) || null);
  db.getSettings = async () => ({ sim_mode: true, notify: true, passive_lock: 0 });
  db.upsert = async (table, row, conflict) => {
    const keys = conflict.split(',');
    const ex = t[table].find((r) => keys.every((k) => String(r[k]) === String(row[k])));
    if (ex) Object.assign(ex, row);
    else t[table].push({ id: seq++, ...row });
  };
  db.update = async (table, f, patch) => filter(table, f).forEach((r) => Object.assign(r, patch));
  db.updateReturning = async (table, f, patch) => {
    const rows = filter(table, f);
    rows.forEach((r) => Object.assign(r, patch));
    return rows.map((r) => ({ ...r }));
  };
  db.remove = async (table, f) => { t[table] = t[table].filter((r) => !filter(table, f).includes(r)); };
  db.insert = async (table, rows) => { for (const r of [].concat(rows)) t[table].push({ id: seq++, ...r }); };
  db.setSession = async (user_id, state, data) => { t.sessions = [{ user_id, state, data, updated_at: new Date().toISOString() }]; };
  db.getSession = async () => t.sessions[0] || null;
  db.clearSession = async () => { t.sessions = []; };
  db.setSetting = async () => {};
  db.count = async (table, f = {}) => {
    const { or, ...rest } = f;
    let rows = filter(table, rest);
    if (or) {
      const lt = or.match(/checked_at\.lt\.([^)]+)/)[1];
      rows = rows.filter((r) => r.checked_at == null || new Date(r.checked_at) < new Date(lt));
    }
    return rows.length;
  };

  const calls = [];
  const behavior = { photos: 1, failMethods: new Set(), failSend: false };
  tg.call = async (method, params = {}) => {
    calls.push({ method, params });
    if (behavior.failMethods.has(method)) {
      const e = new Error(method); e.description = behavior.failMethods.get ? '' : ''; throw e;
    }
    if (method === 'getUserProfilePhotos') return { total_count: behavior.photos };
    if (method === 'sendMessage' && behavior.failSend) {
      const e = new tg.TgError('sendMessage', 403, 'Forbidden: bot can\'t initiate conversation with a user'); throw e;
    }
    if (method === 'approveChatJoinRequest' && behavior.approveError) {
      throw new tg.TgError(method, 400, behavior.approveError);
    }
    if (method === 'getChat') return behavior.chatInfo || { id: params.chat_id, title: 'Channel Uji' };
    if (method === 'getChatMemberCount') return behavior.count === undefined ? 100 : behavior.count;
    if (method === 'getChatMember') {
      if (behavior.statusOf && params.user_id !== 999) return { status: behavior.statusOf(params.user_id), user: { id: params.user_id } };
      return behavior.me || { status: 'administrator', can_invite_users: true };
    }
    if (method === 'sendMessage' && behavior.rejectUrlButtons && JSON.stringify(params.keyboard || '').includes('"url"')) {
      throw new tg.TgError('sendMessage', 400, 'Bad Request: BUTTON_USER_PRIVACY_RESTRICTED');
    }
    return {};
  };
  tg.send = async (chat_id, text, keyboard) => tg.call('sendMessage', { chat_id, text, keyboard });
  tg.edit = async (chat_id, message_id, text, keyboard) => tg.call('editMessageText', { chat_id, message_id, text, keyboard });

  const chat = (over = {}) => {
    const c = {
      chat_id: -1001, title: 'Channel Uji', type: 'channel', bot_admin: true, managed: false,
      ar_enabled: true, ar_delay_minutes: 0, ar_require_photo: false, ar_require_bio: false,
      ar_link_rule: 'off', ar_match: 'all', ar_dm: false, ar_dm_text: null, ar_notify_admin: true, ...over,
    };
    t.chats = [c];
    return c;
  };
  const jr = (over = {}) => ({
    chat: { id: -1001, type: 'channel', title: 'Channel Uji' },
    from: { id: 500, first_name: 'Budi', username: 'budi' },
    user_chat_id: 500, date: Math.floor(Date.now() / 1000), bio: '', ...over,
  });
  return { t, calls, behavior, chat, jr };
}

module.exports = { setup };
