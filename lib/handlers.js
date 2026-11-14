const cfg = require('./config');
const tg = require('./telegram');
const db = require('./db');
const ui = require('./ui');
const enf = require('./enforcement');
const approval = require('./approval');
const uiAr = require('./ui-approval');
const sync = require('./sync');
const { esc, parseDuration, fmtDuration, displayName, parseIds } = require('./util');

const isAdmin = (id) => cfg.ADMIN_IDS.includes(id);
const isIn = (m) => ['member', 'administrator', 'creator'].includes(m.status) || (m.status === 'restricted' && m.is_member);
const iso = (unix) => new Date(unix * 1000).toISOString();

async function handleUpdate(u) {
  if (u.my_chat_member) return onMyChatMember(u.my_chat_member);
  if (u.chat_member) return onChatMember(u.chat_member);
  if (u.chat_join_request) return approval.handleJoinRequest(u.chat_join_request);
  if (u.channel_post) return onChannelPost(u.channel_post);
  if (u.callback_query) return onCallback(u.callback_query);
  if (u.message) return onMessage(u.message);
}

/* ---------- Pendaftaran chat ---------- */

async function registerChat(chat, { botAdmin, addedBy }) {
  let linked = null;
  try {
    const info = await tg.call('getChat', { chat_id: chat.id });
    linked = info.linked_chat_id || null;
  } catch (_) {}
  const existing = await db.getChat(chat.id);
  const base = { title: chat.title || String(chat.id), type: chat.type, username: chat.username || null, bot_admin: botAdmin };
  if (linked) base.linked_chat_id = linked;
  if (!existing) {
    await db.insert('chats', [{ chat_id: chat.id, ...base, managed: isAdmin(addedBy) }]);
  } else {
    await db.update('chats', { chat_id: `eq.${chat.id}` }, base);
  }
  // Hubungkan dua arah channel dan grup diskusi
  if (linked && chat.type !== 'channel') {
    await db.update('chats', { chat_id: `eq.${linked}` }, { linked_chat_id: chat.id }).catch(() => {});
  }
}

async function onMyChatMember(u) {
  const chat = u.chat;
  if (chat.type === 'private') return;
  const st = u.new_chat_member.status;
  if (st === 'administrator') {
    await registerChat(chat, { botAdmin: true, addedBy: u.from.id });
    if (isAdmin(u.from.id)) {
      try {
        await tg.send(u.from.id, `Bot kini admin di <b>${esc(chat.title)}</b> dan sudah masuk jaringan ban.\nAtur aturannya lewat /start.`);
      } catch (_) {}
    }
  } else if (st === 'left' || st === 'kicked' || st === 'member' || st === 'restricted') {
    const existing = await db.getChat(chat.id);
    if (existing) await db.update('chats', { chat_id: `eq.${chat.id}` }, { bot_admin: false });
  }
}

/* ---------- Event keanggotaan ---------- */

async function onChatMember(cm) {
  const user = cm.new_chat_member.user;
  if (!user || user.is_bot) return;
  const row = await db.getChat(cm.chat.id);
  if (!row || !row.managed) return;
  const wasIn = isIn(cm.old_chat_member);
  const nowIn = isIn(cm.new_chat_member);

  if (!wasIn && nowIn) {
    if (row.type === 'channel') {
      await db.insert(
        'members',
        [{ chat_id: row.chat_id, user_id: user.id, name: displayName(user), joined_at: iso(cm.date), source: 'join' }],
        { ignore: true, onConflict: 'chat_id,user_id' }
      );
    }
    return;
  }

  if (!nowIn) {
    // Keluar sendiri, dikeluarkan admin, atau diban: semuanya tidak lagi menjadi member
    await db.remove('members', { chat_id: `eq.${row.chat_id}`, user_id: `eq.${user.id}` });
    await db.remove('misses', { channel_id: `eq.${row.chat_id}`, user_id: `eq.${user.id}` });
    // Hanya keluar atas kemauan sendiri yang memicu ban
    if (wasIn && cm.new_chat_member.status === 'left' && row.leave_ban && cm.from && cm.from.id === user.id) {
      await enf.handleLeave(row, user);
    }
  }
}

/* ---------- Postingan channel dan komentar ---------- */

async function onChannelPost(post) {
  if (post.new_chat_title) {
    await db.update('chats', { chat_id: `eq.${post.chat.id}` }, { title: post.new_chat_title }).catch(() => {});
    return;
  }
  if (post.pinned_message || post.new_chat_title || post.new_chat_photo || post.delete_chat_photo) return;
  const row = await db.getChat(post.chat.id);
  if (!row || !row.managed) return;
  await db.insert('posts', [{ channel_id: post.chat.id, message_id: post.message_id, posted_at: iso(post.date) }], {
    ignore: true,
    onConflict: 'channel_id,message_id',
  });
}

function forwardOrigin(msg) {
  const o = msg.forward_origin;
  const chId = (o && o.chat && o.chat.id) || (msg.forward_from_chat && msg.forward_from_chat.id);
  const mid = (o && o.message_id) || msg.forward_from_message_id;
  const date = (o && o.date) || msg.forward_date || msg.date;
  return chId && mid ? { channelId: chId, messageId: mid, date } : null;
}

// Catat pesan otomatis (salinan postingan) di grup diskusi dan kaitkan dengan postingan channel
async function ensurePostFromForward(groupMsg) {
  const o = forwardOrigin(groupMsg);
  if (!o) return null;
  const ch = await db.getChat(o.channelId);
  if (!ch || !ch.managed) return null;
  const found = await db.select('posts', { channel_id: `eq.${o.channelId}`, message_id: `eq.${o.messageId}`, limit: 1 });
  if (found && found[0]) {
    if (!found[0].group_message_id) {
      await db.update('posts', { id: `eq.${found[0].id}` }, { group_chat_id: groupMsg.chat.id, group_message_id: groupMsg.message_id });
    }
    return found[0];
  }
  await db.insert(
    'posts',
    [{
      channel_id: o.channelId, message_id: o.messageId, posted_at: iso(o.date),
      group_chat_id: groupMsg.chat.id, group_message_id: groupMsg.message_id,
    }],
    { ignore: true, onConflict: 'channel_id,message_id' }
  );
  if (ch.linked_chat_id !== groupMsg.chat.id) {
    await db.update('chats', { chat_id: `eq.${ch.chat_id}` }, { linked_chat_id: groupMsg.chat.id });
  }
  const again = await db.select('posts', { channel_id: `eq.${o.channelId}`, message_id: `eq.${o.messageId}`, limit: 1 });
  return again && again[0];
}

async function resolvePost(msg) {
  const gid = msg.chat.id;
  const reply = msg.reply_to_message;
  if (reply && reply.is_automatic_forward) return ensurePostFromForward(reply);
  const cands = [msg.message_thread_id, reply && reply.message_id, reply && reply.message_thread_id].filter(Boolean);
  if (cands.length) {
    const rows = await db.select('posts', {
      group_chat_id: `eq.${gid}`,
      group_message_id: `in.(${[...new Set(cands)].join(',')})`,
      limit: 1,
    });
    if (rows && rows[0]) return rows[0];
  }
  if (reply) {
    const c = await db.select('comments', { group_chat_id: `eq.${gid}`, group_message_id: `eq.${reply.message_id}`, limit: 1 });
    if (c && c[0]) {
      const p = await db.select('posts', { id: `eq.${c[0].post_id}`, limit: 1 });
      if (p && p[0]) return p[0];
    }
  }
  return null;
}

async function onGroupMessage(msg) {
  if (msg.new_chat_title) {
    await db.update('chats', { chat_id: `eq.${msg.chat.id}` }, { title: msg.new_chat_title }).catch(() => {});
    return;
  }
  if (msg.is_automatic_forward) {
    await ensurePostFromForward(msg);
    return;
  }
  if (!msg.from || msg.from.is_bot || msg.sender_chat) return;
  if (!msg.reply_to_message && !msg.message_thread_id) return;
  const post = await resolvePost(msg);
  if (!post) return;
  await db.insert(
    'comments',
    [{ post_id: post.id, user_id: msg.from.id, group_chat_id: msg.chat.id, group_message_id: msg.message_id }],
    { ignore: true, onConflict: 'group_chat_id,group_message_id' }
  );
}

/* ---------- Pesan pribadi (panel admin) ---------- */

async function showHome(chatId) {
  const v = await ui.homeView();
  await tg.send(chatId, v.text, v.keyboard);
}

async function onMessage(msg) {
  if (msg.chat.type !== 'private') return onGroupMessage(msg);
  const uid = msg.from.id;
  if (!isAdmin(uid)) {
    await tg.send(msg.chat.id, 'Bot ini khusus untuk administrator.');
    return;
  }
  const text = (msg.text || '').trim();
  const [cmdRaw, ...rest] = text.split(/\s+/);
  const cmd = cmdRaw.toLowerCase().replace(/@\w+$/, '');
  const arg = rest.join(' ');

  if (cmd === '/start' || cmd === '/panel' || cmd === '/menu') {
    await db.clearSession(uid);
    return showHome(msg.chat.id);
  }
  if (cmd === '/help') {
    const v = ui.helpView();
    return tg.send(msg.chat.id, v.text, v.keyboard);
  }
  if (cmd === '/cek') {
    await tg.send(msg.chat.id, 'Pemeriksaan dimulai, mohon tunggu.');
    const out = await enf.runPassiveCheck();
    return tg.send(msg.chat.id, enf.formatPassiveSummary(out));
  }
  if (cmd === '/ban') return doBan(msg.chat.id, arg);
  if (cmd === '/unban') return doUnban(msg.chat.id, arg, uid);
  if (cmd === '/whitelist') return doWhitelistAdd(msg.chat.id, arg);
  if (cmd === '/unwhitelist') {
    const ids = parseIds(arg);
    for (const id of ids) await db.remove('whitelist', { user_id: `eq.${id}` });
    return tg.send(msg.chat.id, `${ids.length} ID dihapus dari whitelist.`);
  }

  const s = await db.getSession(uid);
  if (!s) return showHome(msg.chat.id);
  return onSessionInput(msg, s);
}

async function doBan(chatId, arg) {
  const ids = parseIds(arg);
  if (!ids.length) return tg.send(chatId, 'Format: /ban ID_PENGGUNA');
  const lines = ['<b>Ban Manual</b>'];
  for (const id of ids.slice(0, 10)) lines.push(await enf.banById(id));
  return tg.send(chatId, lines.join('\n'));
}

// Format: /unban ID [ID...] [semua | ID_CHAT ...]. Tanpa cakupan, tampil pilihan chat.
async function doUnban(chatId, arg, uid) {
  const tokens = String(arg || '').split(/[\s,;]+/).filter(Boolean);
  const chatIds = tokens.filter((t) => /^-\d{3,}$/.test(t)).map(Number);
  const all = tokens.some((t) => ['semua', 'all'].includes(t.toLowerCase()));
  const ids = parseIds(tokens.filter((t) => !/^-/.test(t)).join(' '));
  if (!ids.length) return tg.send(chatId, 'Format: /unban ID_PENGGUNA [semua | ID_CHAT]');
  const list = ids.slice(0, 10);
  if (all || chatIds.length) {
    const results = [];
    for (const id of list) results.push({ id, r: await enf.unbanFrom(id, all ? null : chatIds) });
    return tg.send(chatId, ui.unbanResultText(list, results));
  }
  await db.setSession(uid, 'unban_pick', { ids: list, sel: [] });
  const v = ui.unbanScopeView(list);
  return tg.send(chatId, v.text, v.keyboard);
}

async function doWhitelistAdd(chatId, arg) {
  const ids = parseIds(arg);
  if (!ids.length) return tg.send(chatId, 'Format: /whitelist ID_PENGGUNA');
  await db.insert('whitelist', ids.map((id) => ({ user_id: id })), { ignore: true, onConflict: 'user_id' });
  return tg.send(chatId, `${ids.length} ID ditambahkan ke whitelist.`);
}

async function onSessionInput(msg, s) {
  const uid = msg.from.id;
  const chatId = msg.chat.id;
  const data = s.data || {};
  const text = (msg.text || '').trim();

  if (s.state === 'wl_add') {
    await db.clearSession(uid);
    return doWhitelistAdd(chatId, text);
  }
  if (s.state === 'ban') {
    await db.clearSession(uid);
    return doBan(chatId, text);
  }
  if (s.state === 'unban') {
    await db.clearSession(uid);
    return doUnban(chatId, text, uid);
  }
  if (s.state === 'unban_pick') {
    return tg.send(chatId, 'Pilih cakupan lewat tombol di atas, atau kirim /start untuk membatalkan.');
  }
  if (s.state === 'duration') {
    const minutes = parseDuration(text);
    if (!minutes) {
      return tg.send(chatId, 'Format tidak dikenali. Contoh: <code>12 jam</code>, <code>3 hari</code>, <code>90 menit</code>. Minimal 30 menit, maksimal 365 hari.');
    }
    await db.update('chats', { chat_id: `eq.${data.chat_id}` }, { deadline_minutes: minutes });
    await db.clearSession(uid);
    await tg.send(chatId, `Batas waktu diubah menjadi ${fmtDuration(minutes)}.`);
    const v = await ui.chatView(data.chat_id);
    return tg.send(chatId, v.text, v.keyboard);
  }
  if (s.state === 'ar_delay') {
    const low = text.toLowerCase();
    const minutes = ['0', 'langsung', 'instan'].includes(low) ? 0 : parseDuration(text, 1, 43200, 'menit');
    if (minutes === null) {
      return tg.send(chatId, 'Format tidak dikenali. Contoh: <code>10 menit</code>, <code>2 jam</code>, <code>1 hari</code>, atau <code>0</code> untuk langsung. Minimal 1 menit, maksimal 30 hari.');
    }
    await db.update('chats', { chat_id: `eq.${data.chat_id}` }, { ar_delay_minutes: minutes });
    await db.clearSession(uid);
    await tg.send(chatId, `Waktu persetujuan diubah menjadi ${minutes > 0 ? fmtDuration(minutes) : 'langsung'}.`);
    const v = await uiAr.delayView(data.chat_id);
    return tg.send(chatId, v.text, v.keyboard);
  }
  if (s.state === 'ar_text') {
    if (!text || text.startsWith('/')) return tg.send(chatId, 'Kirim teks pesan biasa.');
    if (text.length > 500) return tg.send(chatId, `Teks terlalu panjang (${text.length} dari 500 karakter).`);
    await db.update('chats', { chat_id: `eq.${data.chat_id}` }, { ar_dm_text: text });
    await db.clearSession(uid);
    await tg.send(chatId, 'Teks pesan tersimpan.');
    const v = await uiAr.notifyView(data.chat_id);
    return tg.send(chatId, v.text, v.keyboard);
  }
  if (s.state === 'import') {
    let raw = text;
    if (msg.document) {
      if ((msg.document.file_size || 0) > 1024 * 1024) return tg.send(chatId, 'Berkas terlalu besar (maksimal 1 MB).');
      raw = await tg.downloadFile(msg.document.file_id);
    }
    const ids = parseIds(raw);
    if (!ids.length) return tg.send(chatId, 'Tidak ada ID pengguna yang terbaca. Kirim daftar ID (satu per baris) atau berkas .txt/.csv.');
    await db.insert(
      'members',
      ids.map((id) => ({ chat_id: data.chat_id, user_id: id, name: String(id), source: 'import' })),
      { ignore: true, onConflict: 'chat_id,user_id' }
    );
    await db.clearSession(uid);
    await tg.send(chatId, `${ids.length} member diimpor. Mereka dinilai mulai dari postingan berikutnya.`);
    const v = await ui.chatView(data.chat_id);
    return tg.send(chatId, v.text, v.keyboard);
  }
  await db.clearSession(uid);
  return showHome(chatId);
}

/* ---------- Tombol panel ---------- */

async function onCallback(cq) {
  const uid = cq.from.id;
  let answered = false;
  // Telegram hanya menerima satu jawaban per tombol, jadi jawaban kedua diabaikan.
  const answer = async (text, alert) => {
    if (answered) return;
    answered = true;
    await tg.call('answerCallbackQuery', { callback_query_id: cq.id, ...(text ? { text, show_alert: !!alert } : {}) }).catch(() => {});
  };
  if (!isAdmin(uid)) return answer('Akses ditolak', true);
  if (!cq.message) return answer();

  const chatId = cq.message.chat.id;
  const messageId = cq.message.message_id;
  // Bila pesan lama tidak bisa diedit, kirim sebagai pesan baru agar tombol tidak terasa mati
  const show = async (v) => {
    try {
      return await tg.edit(chatId, messageId, v.text, v.keyboard);
    } catch (e) {
      const d = String((e && e.description) || '').toLowerCase();
      if (d.includes('message to edit not found') || d.includes("message can't be edited") || d.includes('message_id_invalid')) {
        return tg.send(chatId, v.text, v.keyboard);
      }
      throw e;
    }
  };
  const [a, b, c] = String(cq.data || '').split(':');

  try {
    if (a === 'm') {
      await answer();
      const map = { home: ui.homeView, enf: ui.enforceView, ar: uiAr.hubView, chats: ui.chatsView, passive: ui.passiveView, wl: ui.whitelistView, log: ui.logView, set: ui.settingsView, help: ui.helpView };
      const fn = map[b] || ui.homeView;
      return show(await fn());
    }
    if (a === 'x') {
      await db.clearSession(uid);
      await answer();
      return show(await ui.homeView());
    }
    if (a === 'c') {
      await answer();
      await sync.refreshChat(b);
      return show(await ui.chatView(b));
    }
    if (a === 'rf') {
      await answer('Menyegarkan');
      await sync.refreshAll();
      return show(await ui.chatsView());
    }
    if (a === 'sm') {
      await answer('Menyinkronkan');
      await show({ text: 'Menyinkronkan member dengan Telegram, mohon tunggu.', keyboard: [] });
      const out = await sync.syncMembers(b);
      const text = [
        '<b>Sinkronisasi Member</b>',
        '',
        `Diperiksa: ${out.checked}`,
        `Dihapus dari catatan (sudah tidak jadi member): ${out.removed}`,
        out.errors ? `Gagal diperiksa: ${out.errors}` : null,
        `Belum diperiksa: ${out.remaining}`,
        out.remaining ? '\nJalankan lagi untuk melanjutkan.' : '\nSemua catatan sudah cocok dengan Telegram.',
      ].filter((x) => x !== null).join('\n');
      return show({ text, keyboard: [[ui.btn('Sinkronkan Lagi', `sm:${b}`)], [ui.btn('Kembali', `c:${b}`)]] });
    }
    if (a === 'bm') {
      await db.setSession(uid, 'ban', {});
      await answer();
      return show(ui.promptView('Ban Manual', 'Kirim ID pengguna (satu atau beberapa). Mereka akan diban di semua chat jaringan.', 'm:enf'));
    }
    if (a === 'bn') {
      const id = Number(b);
      if (!Number.isSafeInteger(id) || id <= 0) return answer('ID tidak valid', true);
      await answer('Memproses');
      return tg.send(chatId, `<b>Ban Manual</b>\n${await enf.banById(id)}`);
    }
    if (a === 'ub') {
      const id = Number(b);
      if (!Number.isSafeInteger(id) || id <= 0) return answer('ID tidak valid', true);
      await db.setSession(uid, 'unban_pick', { ids: [id], sel: [] });
      await answer();
      const v = ui.unbanScopeView([id]);
      return tg.send(chatId, v.text, v.keyboard);
    }
    if (a === 'us' || a === 'uo' || a === 'um') {
      const sess = await db.getSession(uid);
      if (!sess || sess.state !== 'unban_pick' || !(sess.data && sess.data.ids && sess.data.ids.length)) {
        return answer('Sesi habis. Mulai lagi dari Cabut Ban.', true);
      }
      const ids = sess.data.ids;
      let sel = Array.isArray(sess.data.sel) ? sess.data.sel.map(String) : [];
      const run = async (chatIds) => {
        await answer('Memproses');
        await show({ text: 'Mencabut ban, mohon tunggu.', keyboard: [] });
        const results = [];
        for (const id of ids) results.push({ id, r: await enf.unbanFrom(id, chatIds) });
        await db.clearSession(uid);
        return show({ text: ui.unbanResultText(ids, results), keyboard: [[ui.btn('Kembali', 'm:enf')]] });
      };
      if (a === 'uo') return run([b]);
      if (a === 'um') {
        sel = sel.includes(String(b)) ? sel.filter((x) => x !== String(b)) : [...sel, String(b)];
        await db.setSession(uid, 'unban_pick', { ids, sel });
        await answer();
        return show(await ui.unbanMultiView(ids, sel));
      }
      if (b === 'all') return run(null);
      if (b === 'one') { await answer(); return show(await ui.unbanOneView(ids)); }
      if (b === 'multi') { await answer(); return show(await ui.unbanMultiView(ids, sel)); }
      if (b === 'back') { await answer(); return show(ui.unbanScopeView(ids)); }
      if (b === 'sel' || b === 'clr') {
        const chats = await db.selectAll('chats', {});
        sel = b === 'sel' ? chats.filter((x) => x.bot_admin !== false).slice(0, 40).map((x) => String(x.chat_id)) : [];
        await db.setSession(uid, 'unban_pick', { ids, sel });
        await answer();
        return show(await ui.unbanMultiView(ids, sel));
      }
      if (b === 'go') {
        if (!sel.length) return answer('Pilih minimal satu chat.', true);
        return run(sel);
      }
      return answer();
    }
    if (a === 't') {
      const row = await db.getChat(b);
      if (!row) return answer('Chat tidak ditemukan', true);
      if (c === 'managed') await db.update('chats', { chat_id: `eq.${b}` }, { managed: !row.managed });
      if (c === 'leave') await db.update('chats', { chat_id: `eq.${b}` }, { leave_ban: !row.leave_ban });
      if (c === 'passive') {
        if (!row.passive_check) {
          if (!row.linked_chat_id) return answer('Hubungkan grup diskusi ke channel ini terlebih dahulu, lalu jadikan bot admin di grup itu.', true);
          try {
            const me = await tg.call('getChatMember', { chat_id: row.linked_chat_id, user_id: cfg.BOT_ID });
            if (me.status !== 'administrator') return answer('Bot harus menjadi admin di grup diskusi agar bisa membaca komentar.', true);
          } catch (_) {
            return answer('Bot belum ada di grup diskusi. Tambahkan sebagai admin lalu coba lagi.', true);
          }
          await db.update('chats', { chat_id: `eq.${b}` }, { passive_check: true, passive_since: new Date().toISOString() });
        } else {
          await db.update('chats', { chat_id: `eq.${b}` }, { passive_check: false });
        }
      }
      await answer();
      return show(await ui.chatView(b));
    }
    if (a === 'd') {
      await answer();
      return show(ui.durationView(b));
    }
    if (a === 'ds') {
      await db.update('chats', { chat_id: `eq.${b}` }, { deadline_minutes: Number(c) });
      await answer('Tersimpan');
      return show(await ui.chatView(b));
    }
    if (a === 'dc') {
      await db.setSession(uid, 'duration', { chat_id: Number(b) });
      await answer();
      return show(ui.promptView('Batas Waktu Manual', 'Ketik durasi, contoh: <code>36 jam</code>, <code>5 hari</code>, <code>90 menit</code>.'));
    }
    if (a === 'k') {
      await answer();
      return show(ui.toleranceView(b));
    }
    if (a === 'ks') {
      await db.update('chats', { chat_id: `eq.${b}` }, { tolerance: Number(c) });
      await answer('Tersimpan');
      return show(await ui.chatView(b));
    }
    if (a === 'i') {
      await db.setSession(uid, 'import', { chat_id: Number(b) });
      await answer();
      return show(
        ui.promptView(
          'Impor Member',
          'Bot tidak bisa membaca daftar subscriber channel, jadi member lama perlu diimpor.\nKirim ID pengguna (satu per baris) atau berkas .txt/.csv berisi ID. Member yang diimpor dinilai mulai dari postingan berikutnya.'
        )
      );
    }
    if (a === 'w') {
      if (b === 'add') {
        await db.setSession(uid, 'wl_add', {});
        await answer();
        return show(ui.promptView('Tambah Whitelist', 'Kirim satu atau beberapa ID pengguna.'));
      }
      if (b === 'rm') await db.remove('whitelist', { user_id: `eq.${c}` });
      await answer();
      return show(await ui.whitelistView());
    }
    if (a === 'u') {
      await db.setSession(uid, 'unban', {});
      await answer();
      return show(ui.promptView('Cabut Ban', 'Kirim ID pengguna (satu atau beberapa). Setelah itu kamu bisa memilih: semua channel/grup, satu chat, atau beberapa chat.'));
    }
    if (a === 's') {
      const s = await db.getSettings();
      if (b === 'sim') await db.setSetting('sim_mode', !s.sim_mode);
      if (b === 'notify') await db.setSetting('notify', !s.notify);
      await answer();
      return show(await ui.settingsView());
    }
    if (a === 'ar' || a === 'af' || a === 'ad' || a === 'an' || a === 'aq') {
      await db.clearSession(uid);
      if (a === 'aq' && c === 'run') {
        await answer('Memproses');
        const out = await approval.processDue({ chatId: b });
        const note = `Selesai: ${out.approved} disetujui, ${out.moved} dialihkan ke manual, ${out.gone} sudah tidak ada, ${out.failed} gagal.${out.partial ? ' Sebagian belum selesai.' : ''}`;
        return show(await uiAr.queueView(b, note));
      }
      await answer();
      const fn = { ar: uiAr.arView, af: uiAr.filtersView, ad: uiAr.delayView, an: uiAr.notifyView, aq: uiAr.queueView }[a];
      return show(await fn(b));
    }
    if (a === 'at') {
      const row = await db.getChat(b);
      if (!row) return answer('Chat tidak ditemukan', true);
      const patch = {};
      if (c === 'en') {
        if (!row.ar_enabled) {
          const chk = await approval.checkRights(b);
          if (!chk.ok) return answer(chk.message, true);
        } else {
          await db.update('join_requests', { chat_id: `eq.${b}`, status: 'eq.waiting' }, { status: 'manual', reason: 'Auto approve dimatikan' });
        }
        patch.ar_enabled = !row.ar_enabled;
      }
      if (c === 'photo') patch.ar_require_photo = !row.ar_require_photo;
      if (c === 'bio') patch.ar_require_bio = !row.ar_require_bio;
      if (c === 'link') patch.ar_link_rule = { off: 'deny', deny: 'require', require: 'off' }[row.ar_link_rule || 'off'];
      if (c === 'match') patch.ar_match = row.ar_match === 'any' ? 'all' : 'any';
      if (c === 'dm') patch.ar_dm = !row.ar_dm;
      if (c === 'adm') patch.ar_notify_admin = !row.ar_notify_admin;
      if (Object.keys(patch).length) await db.update('chats', { chat_id: `eq.${b}` }, patch);
      await answer();
      const fn = { en: uiAr.arView, photo: uiAr.filtersView, bio: uiAr.filtersView, link: uiAr.filtersView, match: uiAr.filtersView, dm: uiAr.notifyView, adm: uiAr.notifyView }[c] || uiAr.arView;
      return show(await fn(b));
    }
    if (a === 'as') {
      await db.update('chats', { chat_id: `eq.${b}` }, { ar_delay_minutes: Number(c) || 0 });
      await answer('Tersimpan');
      return show(await uiAr.delayView(b));
    }
    if (a === 'ac') {
      await db.setSession(uid, 'ar_delay', { chat_id: Number(b) });
      await answer();
      return show(uiAr.delayPrompt(b));
    }
    if (a === 'ax') {
      await db.setSession(uid, 'ar_text', { chat_id: Number(b) });
      await answer();
      return show(uiAr.textPrompt(b));
    }
    if (a === 'az') {
      await db.update('chats', { chat_id: `eq.${b}` }, { ar_dm_text: null });
      await answer('Teks dikembalikan ke bawaan');
      return show(await uiAr.notifyView(b));
    }
    if (a === 'jr') {
      const rec = await approval.claim(b);
      if (!rec) return answer('Permintaan ini sudah diproses.', true);
      const chat = (await db.getChat(rec.chat_id)) || { title: String(rec.chat_id) };
      const by = `admin:${uid}`;
      const res = c === 'a' ? await approval.approveNow(rec, chat, by) : await approval.declineNow(rec, by);
      const outcome = res.ok ? (c === 'a' ? 'Disetujui' : 'Ditolak') : res.note;
      await answer(res.ok ? 'Berhasil' : res.note, !res.ok);
      return tg.edit(chatId, messageId, approval.formatAlert({ rec: { ...rec, reason: null }, chat, outcome }), []);
    }
    if (a === 'p' && b === 'run') {
      await answer('Memproses');
      await show({ text: 'Pemeriksaan berjalan, mohon tunggu.', keyboard: [] });
      const out = await enf.runPassiveCheck();
      return show({ text: enf.formatPassiveSummary(out), keyboard: [[ui.btn('Kembali', 'm:passive')]] });
    }
    return answer();
  } catch (e) {
    console.error('callback error', e);
    const msg = String((e && (e.description || e.message)) || '');
    let hint = '';
    if (/join_requests|ar_[a-z_]+|checked_at|column|relation|schema/i.test(msg) && /DB /.test(msg)) {
      hint = '\n\nKemungkinan database belum diperbarui. Jalankan ulang seluruh isi <code>supabase/schema.sql</code> di Supabase SQL Editor.';
    }
    if (!answered) return answer('Terjadi kesalahan, coba lagi.', true);
    // Tombol sudah dijawab, jadi tampilkan galat sebagai pesan agar tidak senyap
    return tg.send(chatId, `<b>Terjadi kesalahan</b>\n<code>${esc(msg.slice(0, 200))}</code>${hint}`).catch(() => {});
  }
}

module.exports = { handleUpdate };
