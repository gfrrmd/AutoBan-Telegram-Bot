const cfg = require('./config');
const tg = require('./telegram');
const db = require('./db');
const { esc, sleep, userLink, displayName } = require('./util');

function shortError(e) {
  const d = String((e && e.description) || (e && e.message) || '').toLowerCase();
  if (d.includes('not enough rights') || d.includes('chat_admin_required') || d.includes('administrator rights'))
    return 'Hak admin bot kurang';
  if (d.includes('user is an administrator') || d.includes('can\'t remove chat owner')) return 'Pengguna adalah admin';
  if (d.includes('chat not found') || d.includes('bot is not a member') || d.includes('kicked')) return 'Bot tidak ada di chat';
  return d.slice(0, 50) || 'Gagal';
}

async function exemptSet() {
  const wl = await db.selectAll('whitelist', { select: 'user_id' });
  return new Set([...cfg.ADMIN_IDS, ...wl.map((r) => Number(r.user_id))]);
}

async function notifyAdmins(text) {
  const settings = await db.getSettings();
  if (!settings.notify) return;
  for (const id of cfg.ADMIN_IDS) {
    try {
      await tg.send(id, text);
    } catch (_) {}
  }
}

// Ban permanen di semua chat terkelola
async function banEverywhere(user, { reason, source, detail }) {
  const all = await db.selectAll('chats', { managed: 'eq.true' });
  const targets = all.filter((c) => c.bot_admin !== false);
  const skipped = all.length - targets.length;
  const ok = [];
  const fail = [];
  for (const c of targets) {
    try {
      await tg.call('banChatMember', { chat_id: c.chat_id, user_id: user.id });
      ok.push(c);
    } catch (e) {
      fail.push({ chat: c, error: shortError(e) });
    }
    await sleep(60);
  }
  await db.insert('ban_log', [
    {
      user_id: user.id,
      user_name: displayName(user),
      reason,
      source_chat_id: source ? source.chat_id : null,
      source_title: source ? source.title : null,
      detail: detail || null,
      ok_count: ok.length,
      fail_count: fail.length,
    },
  ]);
  await db.remove('members', { user_id: `eq.${user.id}` });
  await db.remove('misses', { user_id: `eq.${user.id}` });
  return { ok, fail, skipped, total: all.length };
}

function resultLines(res) {
  const lines = [`Hasil: ${res.ok.length} dari ${res.total} chat berhasil`];
  if (res.skipped) lines.push(`Dilewati (bot bukan admin): ${res.skipped}`);
  if (res.fail.length) {
    lines.push('', '<b>Gagal</b>');
    for (const f of res.fail.slice(0, 8)) lines.push(`${esc(f.chat.title)}: ${esc(f.error)}`);
  }
  return lines;
}

async function handleLeave(chatRow, user) {
  const exempt = await exemptSet();
  if (exempt.has(user.id)) return;
  const since = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  const recent = await db.select('ban_log', {
    user_id: `eq.${user.id}`,
    reason: 'eq.leave',
    created_at: `gte.${since}`,
    limit: 1,
  });
  if (recent && recent.length) return;
  const res = await banEverywhere(user, { reason: 'leave', source: chatRow, detail: 'Keluar dari chat' });
  await notifyAdmins(
    [
      '<b>Ban Otomatis: Keluar dari Channel</b>',
      '',
      `Pengguna: ${userLink(user.id, displayName(user))} (<code>${user.id}</code>)`,
      `Sumber: ${esc(chatRow.title)}`,
      ...resultLines(res),
    ].join('\n')
  );
}

async function unbanEverywhere(userId) {
  const all = await db.selectAll('chats', { managed: 'eq.true' });
  let ok = 0;
  let fail = 0;
  for (const c of all.filter((x) => x.bot_admin !== false)) {
    try {
      await tg.call('unbanChatMember', { chat_id: c.chat_id, user_id: userId, only_if_banned: true });
      ok++;
    } catch (_) {
      fail++;
    }
    await sleep(60);
  }
  await db.insert('ban_log', [
    { user_id: userId, user_name: String(userId), reason: 'unban', detail: 'Ban dicabut oleh admin', ok_count: ok, fail_count: fail },
  ]);
  await db.remove('misses', { user_id: `eq.${userId}` });
  return { ok, fail };
}

// Verifikasi apakah postingan channel masih ada.
// true = ada, false = pasti sudah dihapus, null = tidak bisa dipastikan (aman: jangan ban).
async function postAlive(channelId, messageId, logChat) {
  try {
    const r = await tg.call('copyMessage', {
      chat_id: logChat,
      from_chat_id: channelId,
      message_id: messageId,
      disable_notification: true,
    });
    try {
      await tg.call('deleteMessage', { chat_id: logChat, message_id: r.message_id });
    } catch (_) {}
    return true;
  } catch (e) {
    const d = String(e.description || '').toLowerCase();
    if (d.includes('message to copy not found') || d.includes('message to forward not found')) return false;
  }
  // Cadangan untuk channel yang melarang penyalinan konten
  try {
    await tg.call('editMessageReplyMarkup', { chat_id: channelId, message_id: messageId });
    return true;
  } catch (e) {
    const d = String(e.description || '').toLowerCase();
    if (d.includes('message is not modified')) return true;
    if (d.includes('message to edit not found')) return false;
  }
  return null;
}

const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function checkAlive(post, ctx) {
  if (ctx.alive.has(post.id)) return ctx.alive.get(post.id);
  const r = await postAlive(post.channel_id, post.message_id, ctx.logChat);
  ctx.alive.set(post.id, r);
  await sleep(80);
  return r;
}

async function markDeleted(post) {
  await db.update('posts', { id: `eq.${post.id}` }, { status: 'deleted' });
  await db.remove('misses', { post_id: `eq.${post.id}` });
}

async function evaluateChannel(ch, ctx) {
  const { out } = ctx;
  if (!ch.linked_chat_id) {
    out.errors.push(`${ch.title}: grup diskusi belum terhubung`);
    return;
  }
  let adminIds;
  try {
    const admins = await tg.call('getChatAdministrators', { chat_id: ch.chat_id });
    adminIds = new Set(admins.map((a) => a.user.id));
  } catch (e) {
    out.errors.push(`${ch.title}: gagal membaca daftar admin channel`);
    return;
  }
  const isExempt = (id) => ctx.exempt.has(id) || adminIds.has(id);
  out.channels++;

  let members = null;
  const loadMembers = async () => {
    if (!members) members = await db.selectAll('members', { chat_id: `eq.${ch.chat_id}`, select: 'user_id,joined_at,name' });
    return members;
  };

  // Tahap 1: evaluasi postingan yang sudah jatuh tempo
  const cutoff = new Date(Date.now() - ch.deadline_minutes * 60000).toISOString();
  const since = ch.passive_since ? new Date(ch.passive_since).toISOString() : null;
  const due = await db.select('posts', {
    channel_id: `eq.${ch.chat_id}`,
    status: 'eq.open',
    and: `(posted_at.lte.${cutoff}${since ? `,posted_at.gte.${since}` : ''})`,
    order: 'posted_at.asc',
    limit: 40,
  });

  for (const post of due) {
    if (ctx.timeUp()) {
      out.partial = true;
      break;
    }
    const alive = await checkAlive(post, ctx);
    if (alive === false) {
      await markDeleted(post);
      out.deletedPosts++;
      continue;
    }
    if (alive === null) {
      const attempts = (post.attempts || 0) + 1;
      await db.update('posts', { id: `eq.${post.id}` }, { attempts, status: attempts >= 3 ? 'skipped' : 'open' });
      if (attempts >= 3) out.skippedPosts++;
      continue;
    }
    const commenters = new Set(
      (await db.selectAll('comments', { post_id: `eq.${post.id}`, select: 'user_id' })).map((r) => Number(r.user_id))
    );
    const postedAt = new Date(post.posted_at).getTime();
    const missing = (await loadMembers()).filter(
      (m) =>
        new Date(m.joined_at).getTime() <= postedAt &&
        !isExempt(Number(m.user_id)) &&
        !commenters.has(Number(m.user_id))
    );
    if (missing.length) {
      await db.insert(
        'misses',
        missing.map((m) => ({ channel_id: ch.chat_id, user_id: m.user_id, post_id: post.id })),
        { ignore: true, onConflict: 'channel_id,user_id,post_id' }
      );
    }
    await db.update('posts', { id: `eq.${post.id}` }, { status: 'evaluated' });
    out.evaluated++;
  }

  // Tahap 2: penegakan. Semua postingan yang dihitung diverifikasi ulang agar yang sudah dihapus tidak dihitung.
  const missRows = await db.selectAll('misses', { channel_id: `eq.${ch.chat_id}`, select: 'user_id,post_id' });
  const byUser = new Map();
  for (const r of missRows) {
    const uid = Number(r.user_id);
    if (!byUser.has(uid)) byUser.set(uid, []);
    byUser.get(uid).push(Number(r.post_id));
  }
  const flagged = [...byUser].filter(([, posts]) => posts.length >= ch.tolerance);
  if (!flagged.length) return;

  const postIds = [...new Set(flagged.flatMap(([, p]) => p))];
  const postMap = new Map();
  for (const part of chunk(postIds, 100)) {
    const rows = await db.select('posts', { id: `in.(${part.join(',')})` });
    for (const p of rows) postMap.set(Number(p.id), p);
  }
  const memberMap = new Map((await loadMembers()).map((m) => [Number(m.user_id), m]));

  for (const [uid, pids] of flagged) {
    if (ctx.timeUp()) {
      out.partial = true;
      break;
    }
    const m = memberMap.get(uid);
    if (!m || isExempt(uid)) {
      await db.remove('misses', { channel_id: `eq.${ch.chat_id}`, user_id: `eq.${uid}` });
      continue;
    }
    let valid = 0;
    for (const pid of pids) {
      const post = postMap.get(pid);
      if (!post || post.status === 'deleted') continue;
      const alive = await checkAlive(post, ctx);
      if (alive === true) valid++;
      else if (alive === false) {
        await markDeleted(post);
        post.status = 'deleted';
        out.deletedPosts++;
      }
    }
    if (valid < ch.tolerance) continue;

    const name = m.name || String(uid);
    if (ctx.simulated) {
      out.flagged.push({ id: uid, name, channel: ch.title, count: valid });
      continue;
    }
    const res = await banEverywhere(
      { id: uid, first_name: name },
      { reason: 'passive', source: ch, detail: `${valid} postingan tanpa komentar` }
    );
    out.banned.push({ id: uid, name, channel: ch.title, count: valid, ok: res.ok.length, total: res.total });
  }
}

async function runPassiveCheck() {
  const started = Date.now();
  const out = {
    simulated: true,
    channels: 0,
    evaluated: 0,
    deletedPosts: 0,
    skippedPosts: 0,
    flagged: [],
    banned: [],
    errors: [],
    partial: false,
  };
  const settings = await db.getSettings();
  out.simulated = !!settings.sim_mode;

  if (settings.passive_lock && Date.now() - Number(settings.passive_lock) < 5 * 60 * 1000) {
    out.errors.push('Pemeriksaan lain sedang berjalan, coba lagi beberapa menit.');
    return out;
  }
  const channels = await db.selectAll('chats', { managed: 'eq.true', passive_check: 'eq.true', type: 'eq.channel' });
  if (!channels.length) return out;

  const logChat = cfg.LOG_CHAT_ID || cfg.ADMIN_IDS[0];
  try {
    await tg.call('sendChatAction', { chat_id: logChat, action: 'typing' });
  } catch (_) {
    out.errors.push('Chat log tidak dapat dijangkau. Kirim /start ke bot dari akun admin.');
    return out;
  }

  await db.setSetting('passive_lock', Date.now());
  try {
    const ctx = {
      out,
      logChat,
      simulated: out.simulated,
      exempt: await exemptSet(),
      alive: new Map(),
      timeUp: () => Date.now() - started > cfg.TIME_BUDGET_MS,
    };
    for (const ch of channels) {
      if (ctx.timeUp()) {
        out.partial = true;
        break;
      }
      try {
        await evaluateChannel(ch, ctx);
      } catch (e) {
        out.errors.push(`${ch.title}: ${String(e.message).slice(0, 80)}`);
      }
    }
  } finally {
    await db.setSetting('passive_lock', 0);
  }
  return out;
}

function formatPassiveSummary(out) {
  const L = [];
  L.push('<b>Pemeriksaan Member Pasif</b>');
  L.push(`Mode: ${out.simulated ? 'Simulasi (tidak ada ban)' : 'Penegakan aktif'}`);
  L.push('');
  L.push(`Channel diperiksa: ${out.channels}`);
  L.push(`Postingan dievaluasi: ${out.evaluated}`);
  L.push(`Postingan terhapus (diabaikan): ${out.deletedPosts}`);
  if (out.skippedPosts) L.push(`Postingan tidak terverifikasi (dilewati): ${out.skippedPosts}`);
  const list = out.simulated ? out.flagged : out.banned;
  L.push('');
  L.push(`${out.simulated ? 'Akan diban (simulasi)' : 'Diban'}: ${list.length}`);
  for (const x of list.slice(0, 15)) {
    L.push(`${esc(x.name)} (<code>${x.id}</code>), ${esc(x.channel)}, ${x.count} terlewat`);
  }
  if (list.length > 15) L.push(`dan ${list.length - 15} lainnya`);
  if (out.partial) L.push('', 'Sebagian antrean belum selesai dan dilanjutkan pada pemeriksaan berikutnya.');
  if (out.errors.length) {
    L.push('', '<b>Catatan</b>');
    for (const e of out.errors.slice(0, 6)) L.push(esc(e));
  }
  return L.join('\n');
}

module.exports = {
  exemptSet, notifyAdmins, banEverywhere, unbanEverywhere, handleLeave,
  runPassiveCheck, formatPassiveSummary, postAlive,
};
