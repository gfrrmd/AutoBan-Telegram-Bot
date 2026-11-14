const cfg = require('./config');
const tg = require('./telegram');
const db = require('./db');
const { sleep } = require('./util');

const isIn = (m) => ['member', 'administrator', 'creator'].includes(m.status) || (m.status === 'restricted' && m.is_member);

// Ambil nama dan username terbaru dari Telegram
async function refreshChat(chatId) {
  try {
    const info = await tg.call('getChat', { chat_id: chatId });
    const patch = { title: info.title || String(chatId), username: info.username || null };
    if (info.linked_chat_id) patch.linked_chat_id = info.linked_chat_id;
    await db.update('chats', { chat_id: `eq.${chatId}` }, patch);
    return info;
  } catch (_) {
    return null;
  }
}

async function refreshAll(budgetMs = 8000) {
  const started = Date.now();
  const chats = await db.selectAll('chats', {});
  let updated = 0;
  for (const c of chats) {
    if (Date.now() - started > budgetMs) break;
    if (c.bot_admin === false) continue;
    if (await refreshChat(c.chat_id)) updated++;
    await sleep(40);
  }
  return updated;
}

// Jumlah member sebenarnya menurut Telegram (null bila tidak bisa dibaca)
async function memberCount(chatId) {
  try {
    const n = await tg.call('getChatMemberCount', { chat_id: chatId });
    return Number.isFinite(Number(n)) ? Number(n) : null;
  } catch (_) {
    return null;
  }
}

// Cocokkan catatan member bot dengan keadaan sebenarnya. Berjalan bertahap; ulangi sampai sisa 0.
async function syncMembers(chatId, budgetMs = 40000) {
  const started = Date.now();
  const startIso = new Date(started).toISOString();
  const out = { checked: 0, removed: 0, errors: 0, remaining: 0 };
  const rows = await db.select('members', {
    chat_id: `eq.${chatId}`,
    order: 'checked_at.asc.nullsfirst',
    select: 'user_id',
    limit: 400,
  });
  const verified = [];
  const flush = async () => {
    if (!verified.length) return;
    await db.update('members', { chat_id: `eq.${chatId}`, user_id: `in.(${verified.join(',')})` }, { checked_at: new Date().toISOString() });
    verified.length = 0;
  };
  for (const r of rows) {
    if (Date.now() - started > budgetMs) break;
    const uid = Number(r.user_id);
    let gone = false;
    try {
      const m = await tg.call('getChatMember', { chat_id: chatId, user_id: uid });
      gone = !isIn(m);
    } catch (e) {
      const d = String((e && e.description) || '').toLowerCase();
      if (d.includes('user not found') || d.includes('participant_id_invalid')) gone = true;
      else {
        out.errors++;
        continue;
      }
    }
    out.checked++;
    if (gone) {
      await db.remove('members', { chat_id: `eq.${chatId}`, user_id: `eq.${uid}` });
      await db.remove('misses', { channel_id: `eq.${chatId}`, user_id: `eq.${uid}` });
      out.removed++;
    } else {
      verified.push(uid);
      if (verified.length >= 50) await flush();
    }
    await sleep(35);
  }
  await flush();
  out.remaining = await db.count('members', {
    chat_id: `eq.${chatId}`,
    or: `(checked_at.is.null,checked_at.lt.${startIso})`,
  });
  return out;
}

module.exports = { isIn, refreshChat, refreshAll, memberCount, syncMembers };
