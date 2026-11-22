const db = require('./db');
const sync = require('./sync');
const enf = require('./enforcement');
const { esc, fmtDuration, fmtDate } = require('./util');

const btn = (text, data) => ({ text, callback_data: data });
const onoff = (v) => (v ? 'Aktif' : 'Nonaktif');
const typeLabel = (t) => (t === 'channel' ? 'Channel' : 'Grup');

async function homeView() {
  const [chats, settings] = await Promise.all([db.selectAll('chats', {}), db.getSettings()]);
  const managed = chats.filter((c) => c.managed);
  const text = [
    '<b>Pusat Kontrol Moderasi</b>',
    'Penegakan keanggotaan lintas channel dan grup.',
    '',
    '<b>Ringkasan</b>',
    `Chat dalam jaringan ban: ${managed.length}`,
    `Ban saat keluar: ${managed.filter((c) => c.leave_ban).length} chat`,
    `Cek member pasif: ${managed.filter((c) => c.passive_check).length} channel`,
    `Mode simulasi: ${onoff(settings.sim_mode)}`,
    `Auto approve join: ${chats.filter((c) => c.ar_enabled).length} chat`,
  ].join('\n');
  return {
    text,
    keyboard: [
      [btn('Auto Approve Join', 'm:ar')],
      [btn('Penegakan Member', 'm:enf')],
      [btn('Whitelist', 'm:wl'), btn('Pengaturan', 'm:set')],
      [btn('Bantuan', 'm:help')],
    ],
  };
}

function enforceView() {
  return {
    text: [
      '<b>Penegakan Member</b>',
      'Ban otomatis lintas channel dan grup.',
    ].join('\n'),
    keyboard: [
      [btn('Chat Terkelola', 'm:chats'), btn('Cek Member Pasif', 'm:passive')],
      [btn('Ban Manual', 'bm:ask'), btn('Cabut Ban', 'u:ask')],
      [btn('Riwayat Ban', 'm:log'), btn('Pesan Ban', 'm:bandm')],
      [btn('Kembali', 'm:home')],
    ],
  };
}

async function chatsView() {
  const chats = await db.selectAll('chats', { order: 'title.asc' });
  const rows = chats.slice(0, 40).map((c) => [
    btn(`${c.title || c.chat_id}  |  ${typeLabel(c.type)}  |  ${c.managed ? 'Aktif' : 'Off'}`, `c:${c.chat_id}`),
  ]);
  rows.push([btn('Segarkan Daftar', 'rf:all'), btn('Kembali', 'm:enf')]);
  const text = chats.length
    ? ['<b>Chat Terkelola</b>', 'Pilih chat untuk mengatur aturannya.'].join('\n')
    : [
        '<b>Chat Terkelola</b>',
        'Belum ada chat terdeteksi.',
        '',
        'Jadikan bot sebagai admin di channel dan grup diskusi, chat akan muncul otomatis di sini.',
      ].join('\n');
  return { text, keyboard: rows };
}

async function chatView(chatId) {
  const c = await db.getChat(chatId);
  if (!c) return chatsView();
  const isChannel = c.type === 'channel';
  let linked = 'Tidak berlaku';
  if (isChannel) {
    if (c.linked_chat_id) {
      const g = await db.getChat(c.linked_chat_id);
      linked = g ? esc(g.title) : `ID ${c.linked_chat_id}`;
    } else linked = 'Belum terhubung';
  }
  const [realCount, trackedCount] = await Promise.all([
    sync.memberCount(c.chat_id),
    isChannel ? db.count('members', { chat_id: `eq.${c.chat_id}` }).catch(() => null) : null,
  ]);
  const lines = [
    `<b>${esc(c.title)}</b>`,
    `Jenis: ${typeLabel(c.type)}`,
    `ID: <code>${c.chat_id}</code>`,
    '',
    `Jumlah member (Telegram): ${realCount === null ? 'tidak terbaca' : realCount}`,
    '',
    `Jaringan ban: ${onoff(c.managed)}`,
    `Ban saat keluar: ${onoff(c.leave_ban)}`,
  ];
  if (isChannel) {
    lines.push(
      `Cek member pasif: ${onoff(c.passive_check)}`,
      `Batas waktu komentar: ${fmtDuration(c.deadline_minutes)}`,
      `Toleransi: ${c.tolerance} postingan`,
      `Grup diskusi: ${linked}`,
      `Member terlacak bot: ${trackedCount === null ? 'tidak terbaca' : trackedCount}`
    );
  }
  if (!c.bot_admin) lines.push('', 'Peringatan: bot bukan admin di chat ini.');
  const kb = [
    [btn(`Jaringan ban: ${onoff(c.managed)}`, `t:${c.chat_id}:managed`)],
    [btn(`Ban saat keluar: ${onoff(c.leave_ban)}`, `t:${c.chat_id}:leave`)],
  ];
  if (isChannel) {
    kb.push([btn(`Cek member pasif: ${onoff(c.passive_check)}`, `t:${c.chat_id}:passive`)]);
    kb.push([btn('Batas Waktu', `d:${c.chat_id}`), btn('Toleransi', `k:${c.chat_id}`)]);
    kb.push([btn('Impor Member', `i:${c.chat_id}`), btn('Sinkronkan Member', `sm:${c.chat_id}`)]);
  }
  kb.push([btn('Kembali', 'm:chats')]);
  return { text: lines.join('\n'), keyboard: kb };
}

function durationView(chatId) {
  const p = (label, min) => btn(label, `ds:${chatId}:${min}`);
  return {
    text: [
      '<b>Batas Waktu Komentar</b>',
      'Member harus berkomentar di postingan dalam waktu ini sejak postingan terbit.',
    ].join('\n'),
    keyboard: [
      [p('12 jam', 720), p('1 hari', 1440), p('2 hari', 2880)],
      [p('3 hari', 4320), p('7 hari', 10080), p('14 hari', 20160)],
      [p('30 hari', 43200)],
      [btn('Isi manual', `dc:${chatId}`)],
      [btn('Kembali', `c:${chatId}`)],
    ],
  };
}

function toleranceView(chatId) {
  const p = (n) => btn(String(n), `ks:${chatId}:${n}`);
  return {
    text: [
      '<b>Toleransi</b>',
      'Jumlah postingan yang boleh terlewat sebelum member diban.',
      'Nilai 1 berarti ban pada postingan pertama yang tidak dikomentari.',
    ].join('\n'),
    keyboard: [[p(1), p(2), p(3), p(5)], [btn('Kembali', `c:${chatId}`)]],
  };
}

async function passiveView() {
  const chans = await db.selectAll('chats', { managed: 'eq.true', passive_check: 'eq.true', type: 'eq.channel' });
  const lines = ['<b>Cek Member Pasif</b>'];
  if (!chans.length) {
    lines.push('Belum ada channel dengan cek pasif aktif.', 'Aktifkan lewat menu Chat Terkelola.');
  } else {
    for (const c of chans) {
      const open = await db.select('posts', {
        channel_id: `eq.${c.chat_id}`,
        status: 'eq.open',
        order: 'posted_at.asc',
        select: 'posted_at',
        limit: 200,
      });
      let next = 'Tidak ada antrean';
      if (open.length) next = fmtDate(new Date(new Date(open[0].posted_at).getTime() + c.deadline_minutes * 60000));
      lines.push('', `<b>${esc(c.title)}</b>`, `Batas waktu: ${fmtDuration(c.deadline_minutes)}`, `Antrean postingan: ${open.length}`, `Jatuh tempo berikutnya: ${next}`);
    }
  }
  return {
    text: lines.join('\n'),
    keyboard: [[btn('Jalankan Pemeriksaan Sekarang', 'p:run')], [btn('Kembali', 'm:enf')]],
  };
}

async function whitelistView() {
  const rows = await db.selectAll('whitelist', { order: 'created_at.desc' });
  const shown = rows.slice(0, 15);
  const text = [
    '<b>Whitelist</b>',
    'Pengguna di daftar ini tidak pernah diban otomatis.',
    '',
    shown.length ? shown.map((r) => `<code>${r.user_id}</code>`).join('\n') : 'Daftar kosong.',
  ].join('\n');
  const kb = shown.map((r) => [btn(`Hapus ${r.user_id}`, `w:rm:${r.user_id}`)]);
  kb.push([btn('Tambah ID', 'w:add')]);
  kb.push([btn('Kembali', 'm:home')]);
  return { text, keyboard: kb };
}

async function logView() {
  const rows = await db.select('ban_log', { order: 'created_at.desc', limit: 10 });
  const label = { leave: 'Keluar', passive: 'Pasif', manual: 'Manual', unban: 'Cabut ban' };
  const text = [
    '<b>Riwayat Ban</b>',
    '10 catatan terbaru.',
    '',
    rows.length
      ? rows
          .map(
            (r) =>
              `${fmtDate(r.created_at)}  ${esc(r.user_name || r.user_id)} (<code>${r.user_id}</code>)\n${label[r.reason] || r.reason}${
                r.source_title ? `, ${esc(r.source_title)}` : ''
              }, ${r.ok_count}/${r.ok_count + r.fail_count} chat${
                r.dm_status ? `, pesan ${{ sent: 'terkirim', failed: 'gagal', skipped: 'dilewati' }[r.dm_status] || r.dm_status}` : ''
              }`
          )
          .join('\n\n')
      : 'Belum ada catatan.',
  ].join('\n');
  return { text, keyboard: [[btn('Cabut Ban', 'u:ask')], [btn('Kembali', 'm:enf')]] };
}

async function settingsView() {
  const s = await db.getSettings();
  return {
    text: [
      '<b>Pengaturan</b>',
      '',
      `Mode simulasi: ${onoff(s.sim_mode)}`,
      'Saat aktif, cek member pasif hanya melaporkan siapa yang akan diban tanpa menjalankan ban.',
      '',
      `Notifikasi admin: ${onoff(s.notify)}`,
    ].join('\n'),
    keyboard: [
      [btn(`Mode simulasi: ${onoff(s.sim_mode)}`, 's:sim')],
      [btn(`Notifikasi admin: ${onoff(s.notify)}`, 's:notify')],
      [btn('Kembali', 'm:home')],
    ],
  };
}

/* ---------- Pesan ban ke pengguna ---------- */

async function banDmView() {
  const s = await db.getSettings();
  return {
    text: [
      '<b>Pesan Ban</b>',
      'Setelah seseorang diban, bot mengirim pesan pemberitahuan kepadanya (opsional).',
      '',
      `Status: ${onoff(s.ban_dm)}`,
      '',
      'Teksnya berbeda untuk tiap alasan ban. Pilih di bawah untuk melihat, mengubah, atau mencoba pratinjau.',
      '',
      'Pesan hanya sampai ke orang yang pernah membuka bot. Jika belum, pesan gagal dan dicatat di Riwayat Ban. Satu orang maksimal sekali per 24 jam.',
    ].join('\n'),
    keyboard: [
      [btn(`Pesan ban: ${onoff(s.ban_dm)}`, 'bd:tg')],
      ...enf.BAN_KINDS.map((k) => [btn(enf.BAN_KIND_LABEL[k], `bt:${k}`)]),
      [btn('Kembali', 'm:enf')],
    ],
  };
}

async function banTextView(kind) {
  if (!enf.BAN_KINDS.includes(kind)) return banDmView();
  const s = await db.getSettings();
  const custom = typeof s[enf.settingKey(kind)] === 'string' && s[enf.settingKey(kind)].trim();
  return {
    text: [
      `<b>Pesan Ban: ${enf.BAN_KIND_LABEL[kind]}</b>`,
      `Status fitur: ${onoff(s.ban_dm)}`,
      '',
      `Teks saat ini${custom ? '' : ' (bawaan)'}:`,
      `<i>${esc(enf.banTemplate(s, kind))}</i>`,
      '',
      '<b>Variabel</b>',
      '<code>{nama}</code> nama orang itu',
      '<code>{jumlah}</code> jumlah chat tempat ia diban',
      '<code>{alasan}</code> alasan ban singkat',
      '<code>{chat}</code> channel atau grup asal',
      '<code>{daftar}</code> daftar nama chat',
    ].join('\n'),
    keyboard: [
      [btn('Ubah Teks', `be:${kind}`), btn('Reset Teks', `br:${kind}`)],
      [btn('Pratinjau', `bp:${kind}`)],
      [btn('Kembali', 'm:bandm')],
    ],
  };
}

const banTextPrompt = (kind) =>
  promptView(
    `Teks Pesan Ban: ${enf.BAN_KIND_LABEL[kind] || ''}`,
    `Kirim teks pesan. Variabel yang bisa dipakai: <code>{nama}</code> <code>{jumlah}</code> <code>{alasan}</code> <code>{chat}</code> <code>{daftar}</code>. Teks biasa, maksimal ${enf.BAN_DM_MAX} karakter.`,
    `bt:${kind}`
  );

function helpView() {
  return {
    text: [
      '<b>Bantuan</b>',
      '',
      '<b>Auto approve join</b>',
      'Permintaan bergabung disetujui otomatis sesuai syarat profil dan waktu yang kamu atur. Yang tidak memenuhi syarat menunggu keputusan manualmu.',
      '',
      '<b>Persetujuan aturan dan wajib join (opsional)</b>',
      'Calon member menerima pesan dari bot berisi aturan buatanmu dan harus menekan tombol setuju. Kamu juga bisa mewajibkan mereka bergabung ke channel atau grup lain (maksimal 5) sebelum disetujui. Atur lewat Auto Approve Join, pilih chat, lalu Persetujuan Aturan atau Wajib Join.',
      '',
      '<b>Ban saat keluar</b>',
      'Member yang keluar dari chat yang diaktifkan akan diban permanen di semua chat jaringan.',
      '',
      '<b>Pesan ban (opsional)</b>',
      'Bot bisa memberi tahu orang yang diban lewat pesan pribadi dengan teks buatanmu. Hanya sampai ke orang yang pernah membuka bot. Atur di Penegakan Member > Pesan Ban.',
      '',
      '<b>Cek member pasif</b>',
      'Member wajib berkomentar di setiap postingan channel dalam batas waktu. Postingan yang sudah dihapus tidak dihitung.',
      '',
      '<b>Perintah</b>',
      '/start  buka panel',
      '/cek  jalankan pemeriksaan pasif',
      '/ban ID  ban lewat ID',
      '/unban ID  cabut ban (lalu pilih chat)',
      '/unban ID semua  cabut ban di semua chat',
      '/unban ID ID_CHAT  cabut ban di satu chat',
      '/whitelist ID  tambah whitelist',
      '/unwhitelist ID  hapus whitelist',
    ].join('\n'),
    keyboard: [[btn('Kembali', 'm:home')]],
  };
}


/* ---------- Cabut ban per ID ---------- */

const idsLabel = (ids) => (ids.length <= 3 ? ids.map((i) => `<code>${i}</code>`).join(', ') : `${ids.length} ID`);

function unbanScopeView(ids) {
  return {
    text: [
      '<b>Cabut Ban</b>',
      `ID: ${idsLabel(ids)}`,
      '',
      'Pilih di mana ban dicabut:',
    ].join('\n'),
    keyboard: [
      [btn('Semua channel dan grup', 'us:all')],
      [btn('Salah satu channel/grup', 'us:one')],
      [btn('Pilih beberapa channel/grup', 'us:multi')],
      [btn('Batal', 'x:c')],
    ],
  };
}

async function unbanChatList() {
  const all = await db.selectAll('chats', { order: 'title.asc' });
  return all.filter((c) => c.bot_admin !== false).slice(0, 40);
}

async function unbanOneView(ids) {
  const chats = await unbanChatList();
  const rows = chats.map((c) => [btn(`${c.title || c.chat_id}  |  ${typeLabel(c.type)}`, `uo:${c.chat_id}`)]);
  rows.push([btn('Kembali', 'us:back')]);
  return {
    text: [
      '<b>Cabut Ban: Pilih Satu Chat</b>',
      `ID: ${idsLabel(ids)}`,
      '',
      chats.length ? 'Ketuk chat tempat ban akan dicabut.' : 'Belum ada chat dengan bot sebagai admin.',
    ].join('\n'),
    keyboard: rows,
  };
}

async function unbanMultiView(ids, sel = []) {
  const chats = await unbanChatList();
  const on = new Set(sel.map(String));
  const rows = chats.map((c) => [btn(`${on.has(String(c.chat_id)) ? '✓ ' : ''}${c.title || c.chat_id}  |  ${typeLabel(c.type)}`, `um:${c.chat_id}`)]);
  rows.push([btn(`Cabut Ban (${on.size} dipilih)`, 'us:go')]);
  rows.push([btn('Pilih Semua', 'us:sel'), btn('Kosongkan', 'us:clr')]);
  rows.push([btn('Kembali', 'us:back')]);
  return {
    text: [
      '<b>Cabut Ban: Pilih Beberapa Chat</b>',
      `ID: ${idsLabel(ids)}`,
      '',
      'Ketuk chat untuk memilih atau membatalkan, lalu tekan Cabut Ban.',
    ].join('\n'),
    keyboard: rows,
  };
}

function unbanResultText(ids, results) {
  const lines = ['<b>Cabut Ban</b>'];
  for (const { id, r } of results) {
    lines.push(`<code>${id}</code>: ${r.ok} dari ${r.total} chat berhasil${r.fail ? `, ${r.fail} gagal` : ''}`);
    for (const f of (r.failChats || []).slice(0, 5)) lines.push(`  ${esc(f.chat.title)}: ${esc(f.error)}`);
  }
  return lines.join('\n');
}

const promptView = (title, body, back) => ({
  text: [`<b>${title}</b>`, body].join('\n'),
  keyboard: [[btn('Batal', back || 'x:c')]],
});

module.exports = {
  btn, homeView, enforceView, chatsView, chatView, durationView, toleranceView, passiveView,
  whitelistView, logView, settingsView, helpView, promptView, banDmView, banTextView, banTextPrompt,
  unbanScopeView, unbanOneView, unbanMultiView, unbanResultText,
};
