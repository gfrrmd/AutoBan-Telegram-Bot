const cfg = require('./config');
const tg = require('./telegram');
const db = require('./db');
const enf = require('./enforcement');
const { isIn } = require('./sync');
const { esc, sleep, displayName, userLink } = require('./util');

const DEFAULT_DM = 'Permintaan bergabung Anda ke {chat} telah disetujui. Selamat datang, {nama}!';
const DEFAULT_AGREE =
  'Halo {nama}! Sebelum bergabung ke {chat}, harap patuhi aturan berikut:\n\n' +
  '1. Hormati sesama anggota.\n2. Dilarang spam dan promosi tanpa izin.\n3. Dilarang membagikan konten yang melanggar hukum.\n\n' +
  'Tekan tombol di bawah jika kamu setuju.';
const DEFAULT_FORCE = 'Halo {nama}! Untuk masuk ke {chat}, bergabunglah dulu ke channel atau grup di bawah ini.';
const DEFAULT_AGREE_BTN = 'Saya Setuju';
const FORCE_MAX = 5;
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

function fillTemplate(tpl, chat, name) {
  return esc(tpl)
    .replace(/\{nama\}/gi, () => esc(name || ''))
    .replace(/\{chat\}/gi, () => `<b>${esc(chat.title || '')}</b>`);
}

function buildDmText(chat, name) {
  return fillTemplate((chat.ar_dm_text && chat.ar_dm_text.trim()) || DEFAULT_DM, chat, name);
}

async function sendApprovalDm(rec, chat) {
  try {
    const m = await tg.send(rec.user_chat_id || rec.user_id, buildDmText(chat, rec.name));
    rec._dmMessage = m && m.message_id ? { chat_id: rec.user_chat_id || rec.user_id, message_id: m.message_id } : null;
    return 'sent';
  } catch (_) {
    // Umumnya 403: pengguna belum pernah memulai bot dan jendela 5 menit sudah lewat
    return 'failed';
  }
}

// Pesan "disetujui" dikirim sebelum approve; bila approve gagal, tarik kembali agar member tidak salah informasi
async function retractDm(rec) {
  if (!rec._dmMessage) return;
  try {
    await tg.call('deleteMessage', rec._dmMessage);
  } catch (_) {}
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
    await retractDm(rec);
    if (d.includes('user_already_participant') || d.includes('hide_requester_missing')) {
      await finish(rec, { status: 'gone', reason: GONE, processed_by: by, dm_status: dmOn ? 'failed' : dm });
      return { ok: false, status: 'gone', note: GONE };
    }
    const note = (d.includes('not enough rights') || d.includes('administrator rights') ? 'Hak admin bot kurang' : d.slice(0, 80)) || 'Gagal';
    await finish(rec, { status: 'error', reason: note, processed_by: by, dm_status: dmOn ? 'failed' : dm });
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

/* ---------- Gerbang join: persetujuan aturan dan wajib join ---------- */

// Daftar chat wajib join sesuai isi database (tanpa melihat tombol aktif/nonaktif)
function rawForced(chat) {
  let raw = chat && chat.ar_force_chats;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch (_) {
      raw = [];
    }
  }
  return (Array.isArray(raw) ? raw : [])
    .filter((x) => x && Number.isFinite(Number(x.id)))
    .map((x) => ({ id: Number(x.id), url: x.url || null }));
}

// Daftar yang berlaku: hanya bila fitur wajib join dinyalakan
const forcedList = (chat) => (chat && chat.ar_force ? rawForced(chat) : []);

const gateActive = (chat) => !!(chat && (chat.ar_agree || forcedList(chat).length));

// Tautan gabung untuk chat syarat: username publik, atau tautan undangan buatan bot
async function joinLinkFor(target) {
  if (target.username) return `https://t.me/${target.username}`;
  try {
    const r = await tg.call('createChatInviteLink', { chat_id: target.chat_id, name: 'Wajib join' });
    return (r && r.invite_link) || null;
  } catch (_) {
    return null;
  }
}

async function titlesFor(ids) {
  if (!ids.length) return new Map();
  const rows = await db.select('chats', { chat_id: `in.(${ids.join(',')})`, select: 'chat_id,title,username' });
  return new Map((rows || []).map((r) => [Number(r.chat_id), r]));
}

// Susun pesan untuk calon member. missingIds diisi setelah pengecekan gagal (hanya tampilkan yang kurang).
async function buildGate(chat, rec, missingIds) {
  const forced = forcedList(chat);
  const shown = missingIds ? forced.filter((f) => missingIds.includes(f.id)) : forced;
  const info = await titlesFor(shown.map((f) => f.id));
  const needAgree = !!chat.ar_agree && !rec.agreed_at;

  const lines = [];
  if (needAgree) lines.push(fillTemplate((chat.ar_agree_text && chat.ar_agree_text.trim()) || DEFAULT_AGREE, chat, rec.name));
  else if (chat.ar_agree) lines.push('Aturan sudah kamu setujui.');
  else lines.push(fillTemplate(DEFAULT_FORCE, chat, rec.name));

  if (shown.length) {
    lines.push('');
    if (missingIds) lines.push('<b>Belum bergabung</b>', 'Bergabunglah ke daftar di bawah, lalu tekan Cek Lagi.');
    else lines.push('<b>Syarat bergabung</b>', needAgree ? 'Selain setuju, kamu juga harus bergabung ke:' : 'Bergabunglah ke:');
    for (const f of shown) lines.push(`- ${esc((info.get(f.id) || {}).title || f.id)}`);
  }

  const keyboard = [];
  for (const f of shown) {
    const i = info.get(f.id) || {};
    const url = f.url || (i.username ? `https://t.me/${i.username}` : null);
    if (url) keyboard.push([{ text: `Gabung: ${i.title || f.id}`.slice(0, 60), url }]);
  }
  const label = needAgree ? chat.ar_agree_btn || DEFAULT_AGREE_BTN : missingIds ? 'Cek Lagi' : 'Saya Sudah Bergabung';
  keyboard.push([btn(label, `gj:${rec.id}`)]);
  return { text: lines.join('\n'), keyboard };
}

async function sendGate(chat, rec) {
  try {
    const v = await buildGate(chat, rec);
    await tg.send(rec.user_chat_id || rec.user_id, v.text, v.keyboard);
    return true;
  } catch (_) {
    return false;
  }
}

// Cek keanggotaan di semua chat syarat. unknown = tidak bisa dipastikan (aman: tidak disetujui otomatis).
async function checkForce(forced, userId) {
  const missing = [];
  const unknown = [];
  for (const f of forced) {
    try {
      const m = await tg.call('getChatMember', { chat_id: f.id, user_id: userId });
      if (!isIn(m)) missing.push(f.id);
    } catch (e) {
      const d = String((e && e.description) || '').toLowerCase();
      if (d.includes('user not found') || d.includes('participant_id_invalid')) missing.push(f.id);
      else unknown.push(f.id);
    }
    await sleep(30);
  }
  return { missing, unknown };
}

// Klaim atomik untuk permintaan yang menunggu calon member
async function claimGate(id) {
  const rows = await db.updateReturning(
    'join_requests',
    { id: `eq.${id}`, status: 'eq.gate' },
    { status: 'gating', processed_at: new Date().toISOString() }
  );
  return rows[0] || null;
}

async function toManual(rec, chat, reason) {
  await db.update('join_requests', { id: `eq.${rec.id}` }, { status: 'manual', reason, processed_at: null });
  if (chat && chat.ar_notify_admin) await alertAdmins({ ...rec, reason }, chat);
}

// Syarat sudah terpenuhi: lanjut ke jeda persetujuan seperti biasa
async function proceedAfterGate(rec, chat) {
  const delay = Math.max(0, Number(chat.ar_delay_minutes) || 0);
  const now = Date.now();
  const due = Math.max(now, new Date(rec.requested_at).getTime() + delay * 60000);
  await db.update('join_requests', { id: `eq.${rec.id}` }, { status: 'waiting', due_at: new Date(due).toISOString(), processed_at: null });
  if (due > now) return { status: 'waiting' };
  const mine = await claim(rec.id, 'eq.waiting');
  if (!mine) return { status: 'waiting' };
  return approveNow(mine, chat, 'auto');
}

// Tombol "Setuju / Cek" yang ditekan calon member
async function handleGateCallback(cq) {
  const reply = (text, alert) =>
    tg.call('answerCallbackQuery', { callback_query_id: cq.id, ...(text ? { text, show_alert: !!alert } : {}) }).catch(() => {});
  const id = Number(String(cq.data || '').split(':')[1]);
  if (id === 0) return reply('Ini hanya pratinjau. Tombol ini aktif untuk calon member.', true);
  if (!Number.isSafeInteger(id) || id < 0) return reply();

  const found = await db.select('join_requests', { id: `eq.${id}`, limit: 1 });
  const row = found && found[0];
  if (!row || Number(row.user_id) !== Number(cq.from.id)) return reply('Permintaan tidak ditemukan.', true);
  if (row.status !== 'gate') return reply('Permintaan ini sudah diproses atau sudah tidak berlaku.', true);
  const rec = await claimGate(id);
  if (!rec) return reply('Sedang diproses, tunggu sebentar.', true);

  const target = cq.message ? { chat_id: cq.message.chat.id, message_id: cq.message.message_id } : null;
  const editMsg = (text, kb) => (target ? tg.edit(target.chat_id, target.message_id, text, kb || []).catch(() => {}) : null);
  const chat = await db.getChat(rec.chat_id);

  if (!chat || !chat.ar_enabled || chat.bot_admin === false) {
    await toManual(rec, chat, 'Auto approve nonaktif saat syarat diproses');
    await reply('Permintaanmu diteruskan ke admin.', true);
    return editMsg('Permintaanmu diteruskan ke admin untuk ditinjau.');
  }

  // Menekan tombol berarti setuju (bila persetujuan aturan aktif)
  if (chat.ar_agree && !rec.agreed_at) rec.agreed_at = new Date().toISOString();

  const forced = forcedList(chat);
  if (forced.length) {
    const chk = await checkForce(forced, rec.user_id);
    if (chk.unknown.length) {
      await toManual(rec, chat, 'Keanggotaan di chat syarat tidak dapat diverifikasi (periksa hak admin bot)');
      await reply('Verifikasi gagal. Permintaanmu diteruskan ke admin.', true);
      return editMsg('Verifikasi otomatis gagal. Permintaanmu diteruskan ke admin untuk ditinjau.');
    }
    if (chk.missing.length) {
      await db.update('join_requests', { id: `eq.${rec.id}` }, { status: 'gate', processed_at: null, agreed_at: rec.agreed_at || null });
      const v = await buildGate(chat, rec, chk.missing);
      await editMsg(v.text, v.keyboard);
      return reply('Kamu belum bergabung ke semua channel atau grup yang diwajibkan.', true);
    }
  }

  await db.update('join_requests', { id: `eq.${rec.id}` }, { agreed_at: rec.agreed_at || null });
  const r = await proceedAfterGate(rec, chat);
  await reply('Terima kasih!');
  if (r.status === 'approved') return editMsg(`Syarat terpenuhi. Permintaanmu ke <b>${esc(chat.title)}</b> telah disetujui.`);
  if (r.status === 'waiting') return editMsg(`Syarat terpenuhi. Permintaanmu ke <b>${esc(chat.title)}</b> akan disetujui otomatis.`);
  if (r.status === 'gone') return editMsg('Permintaan ini sudah tidak aktif.');
  if (chat.ar_notify_admin) await alertAdmins({ ...rec, reason: r.note }, chat);
  return editMsg('Permintaanmu diteruskan ke admin untuk ditinjau.');
}

// Kirim ulang pesan syarat ke calon member yang membuka bot (/start)
async function resendGates(userId, chatId) {
  const rows = await db.select('join_requests', {
    user_id: `eq.${userId}`,
    status: 'eq.gate',
    due_at: `gte.${new Date().toISOString()}`,
    limit: 3,
  });
  let n = 0;
  for (const rec of rows || []) {
    const chat = await db.getChat(rec.chat_id);
    if (!chat || !chat.ar_enabled || !gateActive(chat)) continue;
    try {
      const v = await buildGate(chat, rec);
      await tg.send(chatId, v.text, v.keyboard);
      n++;
    } catch (_) {}
  }
  return n;
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
  const gate = verdict.pass && !verdict.exempt && gateActive(chat);
  let row;
  if (!verdict.pass) row = { ...base, status: 'manual', reason: verdict.failed.join('; ') };
  else if (gate) row = { ...base, status: 'gate', due_at: new Date(Date.now() + cfg.GATE_TTL_MINUTES * 60000).toISOString(), agreed_at: null };
  else row = { ...base, status: 'waiting', due_at: new Date(Date.now() + delay * 60000).toISOString() };
  await db.upsert('join_requests', row, 'chat_id,user_id');
  const found = await db.select('join_requests', { chat_id: `eq.${jr.chat.id}`, user_id: `eq.${user.id}`, limit: 1 });
  const rec = found && found[0];
  if (!rec) return;

  if (!verdict.pass) {
    if (chat.ar_notify_admin) await alertAdmins(rec, chat, jr.bio || '');
    return;
  }
  if (gate) {
    if (!(await sendGate(chat, rec))) await toManual(rec, chat, 'Pesan syarat tidak dapat dikirim ke pengguna');
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
  await db.update('join_requests', { status: 'eq.gating', processed_at: `lte.${stale}` }, { status: 'gate', processed_at: null }).catch(() => {});

  // Calon member yang tidak menyelesaikan syarat tepat waktu: tidak ditolak, dialihkan ke keputusan manual
  const lapseFilter = { status: 'eq.gate', due_at: `lte.${new Date().toISOString()}` };
  if (chatId) lapseFilter.chat_id = `eq.${chatId}`;
  const lapsed = await db
    .updateReturning('join_requests', lapseFilter, { status: 'manual', reason: 'Syarat gabung tidak diselesaikan tepat waktu' })
    .catch(() => []);
  out.moved += lapsed.length;

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
  DEFAULT_DM, DEFAULT_AGREE, DEFAULT_AGREE_BTN, FORCE_MAX,
  hasLink, evaluate, buildDmText, formatAlert, handleJoinRequest, processDue,
  approveNow, declineNow, claim, checkRights,
  rawForced, forcedList, gateActive, joinLinkFor, buildGate, handleGateCallback, resendGates,
};
