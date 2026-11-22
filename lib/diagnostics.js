const cfg = require('./config');
const tg = require('./telegram');
const db = require('./db');

// Tabel dan kolom yang wajib ada. Kolom baru ikut diperiksa agar database lama terdeteksi.
const CHECKS = [
  ['chats', 'chat_id,title,managed,leave_ban,passive_check,ar_enabled,ar_agree,ar_force_chats'],
  ['members', 'chat_id,user_id,checked_at'],
  ['posts', 'id,channel_id,status'],
  ['comments', 'id,post_id'],
  ['misses', 'channel_id,user_id'],
  ['whitelist', 'user_id'],
  ['ban_log', 'id,dm_status'],
  ['settings', 'key,value'],
  ['sessions', 'user_id,state,data'],
  ['join_requests', 'id,status,agreed_at'],
];

const isAdminId = (id) => cfg.ADMIN_IDS.includes(id);

// Terjemahkan galat teknis menjadi penyebab dan langkah perbaikan yang mudah dipahami
function explainError(e) {
  const msg = String((e && (e.description || e.message)) || e || '');
  if (/DB .* (401|403)|Invalid API key|JWT/i.test(msg)) {
    return { cause: 'Kunci Supabase ditolak.', fix: 'Periksa SUPABASE_SERVICE_KEY (harus service_role, bukan anon), lalu Redeploy.' };
  }
  if (/fetch failed|ENOTFOUND|Invalid URL|ECONNREFUSED/i.test(msg)) {
    return { cause: 'Alamat Supabase tidak bisa dijangkau.', fix: 'Periksa SUPABASE_URL (contoh: https://xxxx.supabase.co), lalu Redeploy.' };
  }
  if (/DB /.test(msg) && /column|relation|schema|does not exist|PGRST|42P01|42703/i.test(msg)) {
    return { cause: 'Struktur database belum diperbarui.', fix: 'Jalankan ulang seluruh isi supabase/schema.sql di Supabase SQL Editor.' };
  }
  if (/DB /.test(msg)) {
    return { cause: 'Database menolak permintaan.', fix: 'Periksa log Vercel dan pastikan schema.sql sudah dijalankan.' };
  }
  if (/\b401\b|Unauthorized/i.test(msg) && /telegram|bot|getMe|sendMessage/i.test(msg)) {
    return { cause: 'Token bot ditolak Telegram.', fix: 'Periksa BOT_TOKEN dari BotFather, lalu Redeploy.' };
  }
  if (/blocked|chat not found|forbidden/i.test(msg)) {
    return { cause: 'Bot tidak bisa mengirim pesan ke chat ini.', fix: 'Buka bot dan kirim /start dari akun admin.' };
  }
  return { cause: 'Terjadi galat yang belum dikenali.', fix: 'Lihat Vercel > Logs untuk detailnya.' };
}

async function checkDatabase() {
  if (!cfg.SUPABASE_URL || !cfg.SUPABASE_KEY) {
    return { ok: false, problems: ['SUPABASE_URL atau SUPABASE_SERVICE_KEY belum terbaca.'] };
  }
  const problems = [];
  for (const [table, cols] of CHECKS) {
    try {
      await db.select(table, { select: cols, limit: 1 });
    } catch (e) {
      const x = explainError(e);
      problems.push(`${table}: ${x.cause}`);
      if (/Kunci|Alamat/.test(x.cause)) break; // masalah koneksi, tidak perlu cek tabel lain
    }
  }
  return { ok: !problems.length, problems };
}

async function checkWebhook() {
  const info = await tg.call('getWebhookInfo');
  return {
    url: info.url || '',
    pending: info.pending_update_count || 0,
    lastError: info.last_error_message || '',
  };
}

// Dipakai webhook: bila pemrosesan gagal, admin yang mengirim perintah tetap mendapat balasan.
async function reportError(update, e) {
  const msg = update && update.message;
  const from = msg && msg.chat && msg.chat.type === 'private' ? msg.from : null;
  if (!from || !isAdminId(from.id)) return;
  const x = explainError(e);
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  await tg.send(
    msg.chat.id,
    [
      '<b>Bot mengalami gangguan</b>',
      `Penyebab: ${esc(x.cause)}`,
      `Solusi: ${esc(x.fix)}`,
      '',
      'Kirim /status untuk pemeriksaan lengkap.',
    ].join('\n')
  );
}

module.exports = { explainError, checkDatabase, checkWebhook, reportError, CHECKS };
