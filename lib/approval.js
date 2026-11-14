const cfg = require('./config');
const tg = require('./telegram');
const db = require('./db');
const enf = require('./enforcement');
const { esc, sleep, displayName, userLink } = require('./util');

const DEFAULT_DM = 'Permintaan bergabung Anda ke {chat} telah disetujui. Selamat datang, {nama}!';
const CLAIMABLE = 'in.(manual,waiting,error)';
const iso = (unix) => new Date(unix * 1000).toISOString();
const btn = (text, data) => ({ text, callback_data: data });

/* ---------- Deteksi link di bio ---------- */

const TLDS = [
  'com', 'net', 'org', 'info', 'biz', 'id', 'co', 'io', 'me', 'xyz', 'site', 'online', 'top', 'vip', 'club',
  'shop', 'store', 'link', 'ly', 'gg', 'app', 'dev', 'cc', 'tv', 'to', 'ru', 'cn', 'in', 'us', 'uk', 'my',
  'sg', 'tk', 'ml', 'ga', 'cf', 'gq', 'live', 'life', 'fun', 'ink', 'pro', 'asia', 'wiki', 'bio', 'page',
].join('|');

const LINK_RE = new RegExp(
  '(?:https?:\\/\\/|www\\.|tg:\\/\\/|(?:^|[^a-z0-9])[a-z0-9][a-z0-9-]{0,62}(?:\\.[a-z0-9-]{1,63})*\\.(?:' +
    TLDS +
    ')(?![a-z0-9]))',
  'i'
);

// Mendeteksi URL, www, t.me, dan nama domain umum. Alamat email ikut terdeteksi karena memuat domain.
function hasLink(text) {
  const t = String(text || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s*[[({]\s*(?:\.|dot)\s*[\])}]\s*/gi, '.');
  return LINK_RE.test(t);
}

/* ---------- Evaluasi syarat ---------- */

async function evaluate(jr, chat, exempt) {
  const user = jr.from;
  if (exempt.has(user.id)) return { pass: true, failed: [], exempt: true };

  const checks = [];
  if (chat.ar_require_photo) {
    let ok = null;
    try {
      const r = await tg.call('getUserProfilePhotos', { user_id: user.id, limit: 1 });
      ok = Number(r.total_count) > 0;
    } catch (_) {}
    checks.push({ ok, fail: ok === null ? 'Foto profil tidak dapat diperiksa' : 'Tidak ada foto profil (atau disembunyikan)' });
  }
  const bio = String(jr.bio || '').trim();
  if (chat.ar_require_bio) checks.push({ ok: bio.length > 0, fail: 'Bio kosong' });
  if (chat.ar_link_rule === 'deny') checks.push({ ok: !hasLink(bio), fail: 'Bio mengandung link' });
  if (chat.ar_link_rule === 'require') checks.push({ ok: hasLink(bio), fail: 'Bio tidak mengandung link' });

  if (!checks.length) return { pass: true, failed: [] };
  // Hasil tidak pasti (ok === null) tidak pernah dianggap lolos
  const pass = chat.ar_match === 'any' ? checks.some((c) => c.ok === true) : checks.every((c) => c.ok === true);
  return { pass, failed: checks.filter((c) => c.ok !== true).map((c) => c.fail) };
}

/* ---------- Teks pesan ---------- */

function buildDmText(chat, name) {
  const tpl = (chat.ar_dm_text && chat.ar_dm_text.trim()) || DEFAULT_DM;
  return esc(tpl)
    .replace(/\{nama\}/gi, () => esc(name || ''))
    .replace(/\{chat\}/gi, () => `<b>${esc(chat.title || '')}</b>`);
}

async function sendApprovalDm(rec, chat) {
  try {
    await tg.send(rec.user_chat_id || rec.user_id, buildDmText(chat, rec.name));
    return 'sent';
  } catch (_) {
    // Umumnya 403: pengguna belum pernah memulai bot dan jendela 5 menit sudah lewat
    return 'failed';
  }
}

function formatAlert({ rec, chat, bio, outcome }) {
  const lines = [
    '<b>Permintaan Join Perlu Ditinjau</b>',
    '',
    `Chat: ${esc(chat.title || rec.chat_id)}`,
    `Pengguna: ${userLink(rec.user_id, rec.name, rec.username)} (<code>${rec.user_id}</code>)`,
  ];
  if (rec.username) lines.push(`Username: @${esc(rec.username)}`);
  if (bio !== undefined) lines.push(`Bio: ${bio ? esc(String(bio).slice(0, 160)) : 'Kosong'}`);
  if (rec.reason) lines.push(`Alasan: ${esc(rec.reason)}`);
  if (outcome) lines.push('', `<b>${esc(outcome)}</b>`);
  return lines.join('\n');
}

async function alertAdmins(rec, chat, bio) {
  const text = formatAlert({ rec, chat, bio });
  const kb = [[btn('Setujui', `jr:${rec.id}:a`), btn('Tolak', `jr:${rec.id}:d`)]];
  for (const id of cfg.ADMIN_IDS) {
    try {
      await tg.send(id, text, kb);
    } catch (_) {}
  }
}

/* ---------- Aksi ---------- */

async function finish(rec, patch) {
  await db.update('join_requests', { id: `eq.${rec.id}` }, { ...patch, processed_at: new Date().toISOString() });
}

const GONE = 'Permintaan sudah tidak ada atau sudah diproses';

async function approveNow(rec, chat, by) {
  const dmOn = !!chat.ar_dm;
  let dm = dmOn ? null : 'skipped';
  // Jendela kirim pesan ke pengguna hanya terjamin sebelum permintaan diproses
  if (dmOn && cfg.DM_ORDER === 'before') dm = await sendApprovalDm(rec, chat);
  try {
    await tg.call('approveChatJoinRequest', { chat_id: rec.chat_id, user_id: rec.user_id });
  } catch (e) {
    const d = String((e && e.description) || (e && e.message) || '').toLowerCase();
    if (d.includes('user_already_participant') || d.includes('hide_requester_missing')) {
      await finish(rec, { status: 'gone', reason: GONE, processed_by: by, dm_status: dm });
      return { ok: false, status: 'gone', note: GONE };
    }
    const note = (d.includes('not enough rights') || d.includes('administrator rights') ? 'Hak admin bot kurang' : d.slice(0, 80)) || 'Gagal';
    await finish(rec, { status: 'error', reason: note, processed_by: by, dm_status: dm });
    return { ok: false, status: 'error', note };
  }
  if (dmOn && cfg.DM_ORDER !== 'before') dm = await sendApprovalDm(rec, chat);
  await finish(rec, { status: 'approved', processed_by: by, dm_status: dm });
  return { ok: true, status: 'approved', dm };
}

async function declineNow(rec, by) {
  try {
    await tg.call('declineChatJoinRequest', { chat_id: rec.chat_id, user_id: rec.user_id });
  } catch (e) {
    const d = String((e && e.description) || '').toLowerCase();
    if (d.includes('user_already_participant') || d.includes('hide_requester_missing')) {
      await finish(rec, { status: 'gone', reason: GONE, processed_by: by });
      return { ok: false, status: 'gone', note: GONE };
    }
    const note = d.slice(0, 80) || 'Gagal';
    await finish(rec, { status: 'error', reason: note, processed_by: by });
    return { ok: false, status: 'error', note };
  }
  await finish(rec, { status: 'declined', processed_by: by });
  return { ok: true, status: 'declined' };
}

// Klaim atomik agar dua proses tidak menangani permintaan yang sama
async function claim(id, from = CLAIMABLE) {
  const rows = await db.updateReturning('join_requests', { id: `eq.${id}`, status: from }, { status: 'processing' });
  return rows[0] || null;
}

/* ---------- Permintaan masuk ---------- */

async function checkRights(chatId) {
  try {
    const me = await tg.call('getChatMember', { chat_id: chatId, user_id: cfg.BOT_ID });
    if (me.status === 'creator') return { ok: true };
    if (me.status !== 'administrator') return { ok: false, message: 'Bot belum menjadi admin di chat ini.' };
    if (me.can_invite_users === false) {
      return { ok: false, message: 'Hak admin bot kurang. Aktifkan hak "Undang Pengguna" (Invite Users atau Add Subscribers).' };
    }
    return { ok: true };
  } catch (_) {
    return { ok: false, message: 'Tidak dapat memeriksa hak bot. Pastikan bot sudah menjadi admin di chat ini.' };
  }
}

async function handleJoinRequest(jr) {
  const user = jr.from;
  if (!user || user.is_bot) return;
  const chat = await db.getChat(jr.chat.id);
  if (!chat || !chat.ar_enabled) return; // permintaan dibiarkan menunggu keputusan manual di Telegram

  const verdict = await evaluate(jr, chat, await enf.exemptSet());
  const delay = Math.max(0, Number(chat.ar_delay_minutes) || 0);
  const base = {
    chat_id: jr.chat.id,
    user_id: user.id,
    user_chat_id: jr.user_chat_id || null,
    name: displayName(user),
    username: user.username || null,
    requested_at: iso(jr.date),
    due_at: null,
    reason: null,
    dm_status: null,
    processed_by: null,
    processed_at: null,
  };
  const row = verdict.pass
    ? { ...base, status: 'waiting', due_at: new Date(Date.now() + delay * 60000).toISOString() }
    : { ...base, status: 'manual', reason: verdict.failed.join('; ') };
  await db.upsert('join_requests', row, 'chat_id,user_id');
  const found = await db.select('join_requests', { chat_id: `eq.${jr.chat.id}`, user_id: `eq.${user.id}`, limit: 1 });
  const rec = found && found[0];
  if (!rec) return;

  if (!verdict.pass) {
    if (chat.ar_notify_admin) await alertAdmins(rec, chat, jr.bio || '');
    return;
  }
  if (delay === 0) {
    const mine = await claim(rec.id, 'eq.waiting');
    if (mine) await approveNow(mine, chat, 'auto');
  }
}

/* ---------- Antrean tertunda (dipanggil cron) ---------- */

async function processDue({ chatId } = {}) {
  const started = Date.now();
  const out = { approved: 0, moved: 0, gone: 0, failed: 0, partial: false, errors: [] };

  // Pulihkan klaim yang menggantung akibat proses terhenti
  const stale = new Date(Date.now() - 10 * 60000).toISOString();
  await db.update('join_requests', { status: 'eq.processing', due_at: `lte.${stale}` }, { status: 'waiting' }).catch(() => {});

  const filters = { status: 'eq.waiting', due_at: `lte.${new Date().toISOString()}`, order: 'due_at.asc', limit: 100 };
  if (chatId) filters.chat_id = `eq.${chatId}`;
  const due = await db.select('join_requests', filters);

  const chats = new Map();
  for (const item of due) {
    if (Date.now() - started > cfg.TIME_BUDGET_MS) {
      out.partial = true;
      break;
    }
    if (!chats.has(item.chat_id)) chats.set(item.chat_id, await db.getChat(item.chat_id));
    const chat = chats.get(item.chat_id);
    const rec = await claim(item.id, 'eq.waiting');
    if (!rec) continue;

    if (!chat || !chat.ar_enabled || chat.bot_admin === false) {
      await db.update('join_requests', { id: `eq.${rec.id}` }, { status: 'manual', reason: 'Auto approve nonaktif saat jatuh tempo' });
      out.moved++;
      continue;
    }
    const r = await approveNow(rec, chat, 'auto');
    if (r.status === 'approved') out.approved++;
    else if (r.status === 'gone') out.gone++;
    else {
      out.failed++;
      if (out.errors.length < 5) out.errors.push(`${chat.title}: ${r.note}`);
    }
    await sleep(60);
  }

  if (!chatId) {
    const old = new Date(Date.now() - 30 * 86400000).toISOString();
    await db.remove('join_requests', { status: 'in.(approved,declined,gone,error)', processed_at: `lt.${old}` }).catch(() => {});
  }
  return out;
}

module.exports = {
  DEFAULT_DM, hasLink, evaluate, buildDmText, formatAlert, handleJoinRequest, processDue,
  approveNow, declineNow, claim, checkRights,
};
