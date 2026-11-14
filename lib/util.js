const cfg = require('./config');

const esc = (s) =>
  String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fmtDate(d) {
  const date = d instanceof Date ? d : new Date(d);
  return new Intl.DateTimeFormat('id-ID', {
    timeZone: cfg.TIMEZONE,
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

// Contoh valid: "90 menit", "12 jam", "3 hari", "3d", "12j". Tanpa satuan memakai defaultUnit (bawaan: jam).
function parseDuration(input, min = 30, max = 525600, defaultUnit = 'jam') {
  const m = String(input || '')
    .trim()
    .toLowerCase()
    .match(/^(\d+(?:[.,]\d+)?)\s*(menit|mnt|min|m|jam|j|hari|d)?$/);
  if (!m) return null;
  const n = parseFloat(m[1].replace(',', '.'));
  const unit = m[2] || defaultUnit;
  const mult = ['menit', 'mnt', 'min', 'm'].includes(unit) ? 1 : ['jam', 'j'].includes(unit) ? 60 : 1440;
  const minutes = Math.round(n * mult);
  if (minutes < min || minutes > max) return null;
  return minutes;
}

function fmtDuration(minutes) {
  const m = Number(minutes) || 0;
  if (m % 1440 === 0) return `${m / 1440} hari`;
  if (m % 60 === 0) return `${m / 60} jam`;
  return `${m} menit`;
}

function displayName(user) {
  if (!user) return 'Tanpa nama';
  const full = `${user.first_name || ''} ${user.last_name || ''}`.trim();
  return full || (user.username ? `@${user.username}` : String(user.id));
}

// Pengguna ber-username memakai tautan t.me (selalu bisa diklik).
// Tanpa username dipakai tg://user?id=, yang bisa tidak aktif bila privasi pengguna membatasinya.
function userLink(id, name, username) {
  const href = username ? `https://t.me/${username}` : `tg://user?id=${id}`;
  return `<a href="${href}">${esc(name || id)}</a>`;
}

function parseIds(text) {
  const found = String(text || '').match(/\d{5,15}/g) || [];
  return [...new Set(found.map(Number))].filter((n) => Number.isSafeInteger(n) && n > 0);
}

module.exports = { esc, sleep, fmtDate, parseDuration, fmtDuration, displayName, userLink, parseIds };
