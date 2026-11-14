const db = require('./db');
const { btn, promptView } = require('./ui');
const { esc, fmtDuration } = require('./util');
const { DEFAULT_DM } = require('./approval');

const onoff = (v) => (v ? 'Aktif' : 'Nonaktif');
const typeLabel = (t) => (t === 'channel' ? 'Channel' : 'Grup');
const delayLabel = (m) => (Number(m) > 0 ? fmtDuration(m) : 'Langsung');
const LINK_LABEL = { off: 'Tidak dicek', deny: 'Wajib tanpa link', require: 'Wajib ada link' };

function rulesSummary(c) {
  const r = [];
  if (c.ar_require_photo) r.push('foto profil');
  if (c.ar_require_bio) r.push('bio terisi');
  if (c.ar_link_rule === 'deny') r.push('bio tanpa link');
  if (c.ar_link_rule === 'require') r.push('bio berisi link');
  if (!r.length) return 'Tanpa syarat (semua permintaan disetujui)';
  const mode = r.length > 1 ? ` (${c.ar_match === 'any' ? 'salah satu' : 'semua'} terpenuhi)` : '';
  return r.join(', ') + mode;
}

async function counts(chatId) {
  const since = new Date(Date.now() - 86400000).toISOString();
  const [open, done] = await Promise.all([
    db.select('join_requests', { chat_id: `eq.${chatId}`, status: 'in.(waiting,manual,error)', select: 'status', limit: 1000 }),
    db.select('join_requests', { chat_id: `eq.${chatId}`, status: 'eq.approved', processed_at: `gte.${since}`, select: 'dm_status', limit: 1000 }),
  ]);
  const n = (st) => (open || []).filter((r) => r.status === st).length;
  return {
    waiting: n('waiting'),
    manual: n('manual'),
    error: n('error'),
    approved24: (done || []).length,
    dmSent24: (done || []).filter((r) => r.dm_status === 'sent').length,
  };
}

async function hubView() {
  const chats = (await db.selectAll('chats', { order: 'title.asc' })).filter((c) => c.bot_admin !== false);
  const open = await db.select('join_requests', { status: 'in.(waiting,manual)', select: 'status', limit: 1000 });
  const manual = (open || []).filter((r) => r.status === 'manual').length;
  const rows = chats.slice(0, 40).map((c) => [
    btn(`${c.title || c.chat_id}  |  ${typeLabel(c.type)}  |  ${c.ar_enabled ? 'Aktif' : 'Off'}`, `ar:${c.chat_id}`),
  ]);
  rows.push([btn('Kembali', 'm:home')]);
  const lines = ['<b>Auto Approve Join</b>'];
  if (chats.length) {
    lines.push(
      'Pilih channel atau grup untuk mengatur persetujuan otomatis.',
      '',
      `Menunggu keputusan manual: ${manual}`,
      '',
      'Syarat: tautan undangan harus memakai opsi persetujuan admin, dan bot memiliki hak "Undang Pengguna".'
    );
  } else {
    lines.push('Belum ada chat terdeteksi.', 'Jadikan bot admin di channel atau grup, lalu chat akan muncul di sini.');
  }
  return { text: lines.join('\n'), keyboard: rows };
}

async function arView(chatId) {
  const c = await db.getChat(chatId);
  if (!c) return hubView();
  const q = await counts(chatId);
  const lines = [
    `<b>Auto Approve: ${esc(c.title)}</b>`,
    '',
    `Status: ${onoff(c.ar_enabled)}`,
    `Syarat: ${rulesSummary(c)}`,
    `Waktu persetujuan: ${delayLabel(c.ar_delay_minutes)}`,
    `Pesan ke member: ${onoff(c.ar_dm)}`,
    `Peringatan ke admin: ${onoff(c.ar_notify_admin)}`,
    '',
    `Menunggu waktu: ${q.waiting}`,
    `Perlu keputusan manual: ${q.manual}`,
  ];
  if (!c.bot_admin) lines.push('', 'Peringatan: bot bukan admin di chat ini.');
  return {
    text: lines.join('\n'),
    keyboard: [
      [btn(`Auto approve: ${onoff(c.ar_enabled)}`, `at:${c.chat_id}:en`)],
      [btn('Syarat Profil', `af:${c.chat_id}`), btn('Waktu Persetujuan', `ad:${c.chat_id}`)],
      [btn('Notifikasi', `an:${c.chat_id}`), btn('Antrean', `aq:${c.chat_id}`)],
      [btn('Kembali', 'm:ar')],
    ],
  };
}

async function filtersView(chatId) {
  const c = await db.getChat(chatId);
  if (!c) return hubView();
  return {
    text: [
      `<b>Syarat Profil: ${esc(c.title)}</b>`,
      'Permintaan yang tidak memenuhi syarat tidak ditolak, tetapi menunggu keputusan manualmu.',
      '',
      `Foto profil: ${c.ar_require_photo ? 'Wajib' : 'Tidak dicek'}`,
      `Bio: ${c.ar_require_bio ? 'Wajib terisi' : 'Tidak dicek'}`,
      `Link di bio: ${LINK_LABEL[c.ar_link_rule] || LINK_LABEL.off}`,
      `Pencocokan: ${c.ar_match === 'any' ? 'Salah satu syarat cukup' : 'Semua syarat aktif harus terpenuhi'}`,
      '',
      'Catatan: foto atau bio yang disembunyikan lewat pengaturan privasi Telegram terbaca sebagai kosong.',
    ].join('\n'),
    keyboard: [
      [btn(`Foto profil: ${c.ar_require_photo ? 'Wajib' : 'Off'}`, `at:${c.chat_id}:photo`)],
      [btn(`Bio: ${c.ar_require_bio ? 'Wajib' : 'Off'}`, `at:${c.chat_id}:bio`)],
      [btn(`Link di bio: ${LINK_LABEL[c.ar_link_rule] || LINK_LABEL.off}`, `at:${c.chat_id}:link`)],
      [btn(`Pencocokan: ${c.ar_match === 'any' ? 'Salah satu' : 'Semua'}`, `at:${c.chat_id}:match`)],
      [btn('Kembali', `ar:${c.chat_id}`)],
    ],
  };
}

async function delayView(chatId) {
  const c = await db.getChat(chatId);
  if (!c) return hubView();
  const cur = Number(c.ar_delay_minutes) || 0;
  const p = (label, min) => btn(`${cur === min ? '✓ ' : ''}${label}`, `as:${chatId}:${min}`);
  return {
    text: [
      `<b>Waktu Persetujuan: ${esc(c.title)}</b>`,
      `Saat ini: ${delayLabel(cur)}`,
      '',
      'Jeda dihitung sejak permintaan diterima bot. Selama jeda, kamu masih bisa menolak permintaan secara manual di Telegram.',
      'Jeda di atas 0 diproses oleh pekerjaan terjadwal (cron), jadi ketepatan waktu mengikuti jadwal cron.',
    ].join('\n'),
    keyboard: [
      [p('Langsung', 0), p('1 menit', 1), p('5 menit', 5)],
      [p('15 menit', 15), p('30 menit', 30), p('1 jam', 60)],
      [p('6 jam', 360), p('12 jam', 720), p('1 hari', 1440)],
      [btn('Isi manual', `ac:${chatId}`)],
      [btn('Kembali', `ar:${chatId}`)],
    ],
  };
}

async function notifyView(chatId) {
  const c = await db.getChat(chatId);
  if (!c) return hubView();
  return {
    text: [
      `<b>Notifikasi: ${esc(c.title)}</b>`,
      '',
      `Pesan ke member: ${onoff(c.ar_dm)}`,
      `Peringatan ke admin: ${onoff(c.ar_notify_admin)}`,
      '',
      'Teks pesan saat ini:',
      `<i>${esc(c.ar_dm_text || DEFAULT_DM)}</i>`,
      '',
      'Telegram hanya mengizinkan bot mengirim pesan ke orang yang belum pernah membuka bot selama 5 menit setelah mereka meminta join. Untuk jeda lebih lama, pesan hanya sampai ke member yang pernah memulai bot.',
    ].join('\n'),
    keyboard: [
      [btn(`Pesan ke member: ${onoff(c.ar_dm)}`, `at:${c.chat_id}:dm`)],
      [btn('Ubah Teks', `ax:${c.chat_id}`), btn('Reset Teks', `az:${c.chat_id}`)],
      [btn(`Peringatan admin: ${onoff(c.ar_notify_admin)}`, `at:${c.chat_id}:adm`)],
      [btn('Kembali', `ar:${c.chat_id}`)],
    ],
  };
}

async function queueView(chatId, note) {
  const c = await db.getChat(chatId);
  if (!c) return hubView();
  const q = await counts(chatId);
  const lines = [
    `<b>Antrean: ${esc(c.title)}</b>`,
    '',
    `Menunggu waktu: ${q.waiting}`,
    `Perlu keputusan manual: ${q.manual}`,
    `Gagal diproses: ${q.error}`,
    `Disetujui 24 jam terakhir: ${q.approved24}`,
    `Pesan terkirim ke member (24 jam): ${q.dmSent24}`,
  ];
  if (note) lines.push('', esc(note));
  return {
    text: lines.join('\n'),
    keyboard: [[btn('Proses yang Jatuh Tempo', `aq:${c.chat_id}:run`)], [btn('Kembali', `ar:${c.chat_id}`)]],
  };
}

const delayPrompt = (chatId) =>
  promptView(
    'Waktu Persetujuan Manual',
    'Ketik jeda, contoh: <code>10 menit</code>, <code>2 jam</code>, <code>1 hari</code>. Ketik <code>0</code> untuk langsung. Tanpa satuan dianggap menit. Maksimal 30 hari.',
    `ad:${chatId}`
  );

const textPrompt = (chatId) =>
  promptView(
    'Teks Pesan Persetujuan',
    'Kirim teks pesan. Gunakan <code>{nama}</code> untuk nama member dan <code>{chat}</code> untuk nama channel atau grup. Teks biasa, maksimal 500 karakter.',
    `an:${chatId}`
  );

module.exports = { hubView, arView, filtersView, delayView, notifyView, queueView, delayPrompt, textPrompt };
