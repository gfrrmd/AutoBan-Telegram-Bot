const cfg = require('../lib/config');
const { handleUpdate } = require('../lib/handlers');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(200).send('OK');
  if (cfg.WEBHOOK_SECRET && req.headers['x-telegram-bot-api-secret-token'] !== cfg.WEBHOOK_SECRET) {
    return res.status(401).send('Unauthorized');
  }
  try {
    await handleUpdate(req.body || {});
  } catch (e) {
    console.error('update error', e);
  }
  return res.status(200).send('OK');
};
