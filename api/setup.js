const cfg = require('../lib/config');
const tg = require('../lib/telegram');

module.exports = async (req, res) => {
  if (!cfg.SETUP_KEY || !req.query || req.query.key !== cfg.SETUP_KEY) {
    return res.status(401).send('Kunci setup salah atau belum diatur.');
  }
  const missing = ['BOT_TOKEN', 'ADMIN_IDS', 'WEBHOOK_SECRET', 'CRON_SECRET', 'SUPABASE_URL']
    .filter((k) => !process.env[k]);
  if (!process.env.SUPABASE_SERVICE_KEY && !process.env.SUPABASE_KEY) missing.push('SUPABASE_SERVICE_KEY');
  if (missing.length) return res.status(400).send(`Variabel belum diisi: ${missing.join(', ')}`);

  try {
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const url = `https://${host}/api/webhook`;
    await tg.call('setWebhook', {
      url,
      secret_token: cfg.WEBHOOK_SECRET,
      allowed_updates: ['message', 'channel_post', 'callback_query', 'chat_member', 'my_chat_member', 'chat_join_request'],
      drop_pending_updates: true,
    });
    await tg.call('setMyCommands', {
      commands: [
        { command: 'start', description: 'Buka panel kontrol' },
        { command: 'cek', description: 'Jalankan pemeriksaan member pasif' },
        { command: 'ban', description: 'Ban pengguna lewat ID' },
        { command: 'unban', description: 'Cabut ban pengguna' },
        { command: 'whitelist', description: 'Tambah pengecualian' },
        { command: 'help', description: 'Bantuan' },
      ],
      scope: { type: 'all_private_chats' },
    });
    const me = await tg.call('getMe');
    const info = await tg.call('getWebhookInfo');
    return res.status(200).send(
      `Setup berhasil.\nBot: @${me.username}\nWebhook: ${info.url}\nUpdate tertunda: ${info.pending_update_count}\nGalat terakhir: ${info.last_error_message || 'tidak ada'}`
    );
  } catch (e) {
    return res.status(500).send(`Setup gagal: ${e.message}`);
  }
};
