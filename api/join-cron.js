const cfg = require('../lib/config');
const approval = require('../lib/approval');

module.exports = async (req, res) => {
  if (!cfg.CRON_SECRET) return res.status(500).json({ error: 'CRON_SECRET belum diatur' });
  const bearer = req.headers.authorization === `Bearer ${cfg.CRON_SECRET}`;
  const key = req.query && req.query.key === cfg.CRON_SECRET;
  if (!bearer && !key) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const out = await approval.processDue();
    return res.status(200).json({ ok: true, ...out });
  } catch (e) {
    console.error('join-cron error', e);
    return res.status(500).json({ ok: false, error: String(e.message).slice(0, 200) });
  }
};
