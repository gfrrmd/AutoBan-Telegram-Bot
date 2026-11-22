const env = process.env;

const toNum = (v) => {
  const s = String(v || '').trim();
  const n = Number(s);
  return s !== '' && Number.isFinite(n) ? n : null;
};

module.exports = {
  BOT_TOKEN: env.BOT_TOKEN || '',
  BOT_ID: Number(String(env.BOT_TOKEN || '').split(':')[0]) || 0,
  ADMIN_IDS: String(env.ADMIN_IDS || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0),
  WEBHOOK_SECRET: env.WEBHOOK_SECRET || '',
  SETUP_KEY: env.SETUP_KEY || '',
  CRON_SECRET: env.CRON_SECRET || '',
  LOG_CHAT_ID: toNum(env.LOG_CHAT_ID),
  TIMEZONE: env.TIMEZONE || 'Asia/Jakarta',
  SUPABASE_URL: String(env.SUPABASE_URL || '').replace(/\/+$/, ''),
  SUPABASE_KEY: env.SUPABASE_SERVICE_KEY || env.SUPABASE_KEY || '',
  // Urutan kirim pesan persetujuan ke member: 'before' (sebelum approve, bawaan) atau 'after'
  DM_ORDER: env.DM_ORDER === 'after' ? 'after' : 'before',
  // Batas waktu calon member menyelesaikan gerbang join (menit). Lewat dari itu, masuk antrean manual.
  GATE_TTL_MINUTES: toNum(env.GATE_TTL_MINUTES) || 1440,
  TIME_BUDGET_MS: toNum(env.TIME_BUDGET_MS) || 48000,
};
