const cfg = require('../lib/config');
const { handleUpdate } = require('../lib/handlers');
const diag = require('../lib/diagnostics');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(200).send('OK');
  if (cfg.WEBHOOK_SECRET && req.headers['x-telegram-bot-api-secret-token'] !== cfg.WEBHOOK_SECRET) {
    return res.status(401).send('Unauthorized');
  }
  const update = req.body || {};
  try {
    await handleUpdate(update);
  } catch (e) {
    console.error('update error', e);
    // Jangan senyap: beri tahu admin penyebabnya
    await diag.reportError(update, e).catch(() => {});
  }
  return res.status(200).send('OK');
};
