const cfg = require('../lib/config');
const enf = require('../lib/enforcement');
const sync = require('../lib/sync');

module.exports = async (req, res) => {
  if (!cfg.CRON_SECRET) return res.status(500).json({ error: 'CRON_SECRET belum diatur' });
  const bearer = req.headers.authorization === `Bearer ${cfg.CRON_SECRET}`;
  const key = req.query && req.query.key === cfg.CRON_SECRET;
  if (!bearer && !key) return res.status(401).json({ error: 'Unauthorized' });
  try {
    await sync.refreshAll().catch(() => {});
    const out = await enf.runPassiveCheck();
    const notable = out.flagged.length || out.banned.length || out.errors.length || out.deletedPosts;
    if (notable) await enf.notifyAdmins(enf.formatPassiveSummary(out));
    return res.status(200).json({ ok: true, ...out });
  } catch (e) {
    console.error('cron error', e);
    return res.status(500).json({ ok: false, error: String(e.message).slice(0, 200) });
  }
};
