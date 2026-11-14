const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');
const approval = require('../lib/approval');
const { handleUpdate } = require('../lib/handlers');

const names = (calls) => calls.map((c) => c.method);

test('hasLink: mendeteksi bentuk link umum', () => {
  for (const s of ['cek https://x.co/abc', 'www.toko.id', 't.me/promo', 'hubungi toko.com', 'situs: shop[.]xyz', 'wa tg://resolve?domain=a', 'mail a@gmail.com'])
    assert.equal(approval.hasLink(s), true, s);
  for (const s of ['', 'Pecinta kopi, Jakarta', 'Dr. Ahmad S.Kom', 'hidup itu indah. nikmati', 'node.js dev', '@username saja'])
    assert.equal(approval.hasLink(s), false, s);
});

test('tanpa syarat dan tanpa jeda: langsung disetujui', async () => {
  const h = setup(); h.chat();
  await handleUpdate({ chat_join_request: h.jr() });
  assert.deepEqual(names(h.calls), ['approveChatJoinRequest']);
  assert.equal(h.t.join_requests[0].status, 'approved');
});

test('auto approve nonaktif: bot tidak melakukan apa pun', async () => {
  const h = setup(); h.chat({ ar_enabled: false });
  await handleUpdate({ chat_join_request: h.jr() });
  assert.equal(h.calls.length, 0);
  assert.equal(h.t.join_requests.length, 0);
});

test('syarat foto: tanpa foto masuk antrean manual dan admin diberi tombol', async () => {
  const h = setup(); h.chat({ ar_require_photo: true }); h.behavior.photos = 0;
  await handleUpdate({ chat_join_request: h.jr() });
  assert.equal(h.t.join_requests[0].status, 'manual');
  assert.ok(!names(h.calls).includes('approveChatJoinRequest'));
  const alerts = h.calls.filter((c) => c.method === 'sendMessage');
  assert.equal(alerts.length, 2); // dua admin
  assert.match(alerts[0].params.keyboard[0][0].callback_data, /^jr:\d+:a$/);
  assert.match(alerts[0].params.text, /foto profil/i);
});

test('syarat foto: ada foto disetujui', async () => {
  const h = setup(); h.chat({ ar_require_photo: true }); h.behavior.photos = 3;
  await handleUpdate({ chat_join_request: h.jr() });
  assert.equal(h.t.join_requests[0].status, 'approved');
});

test('gagal membaca foto dianggap tidak pasti: masuk manual, bukan disetujui', async () => {
  const h = setup(); h.chat({ ar_require_photo: true });
  h.behavior.failMethods.add('getUserProfilePhotos');
  await handleUpdate({ chat_join_request: h.jr() });
  assert.equal(h.t.join_requests[0].status, 'manual');
});

test('aturan link: deny, require, dan mode salah satu', async () => {
  let h = setup(); h.chat({ ar_link_rule: 'deny' });
  await handleUpdate({ chat_join_request: h.jr({ bio: 'beli di toko.com' }) });
  assert.equal(h.t.join_requests[0].status, 'manual');

  h = setup(); h.chat({ ar_link_rule: 'require' });
  await handleUpdate({ chat_join_request: h.jr({ bio: 'tanpa tautan' }) });
  assert.equal(h.t.join_requests[0].status, 'manual');

  h = setup(); h.chat({ ar_require_bio: true, ar_require_photo: true, ar_match: 'any' }); h.behavior.photos = 0;
  await handleUpdate({ chat_join_request: h.jr({ bio: 'ada bio' }) });
  assert.equal(h.t.join_requests[0].status, 'approved'); // salah satu cukup

  h = setup(); h.chat({ ar_require_bio: true, ar_require_photo: true, ar_match: 'all' }); h.behavior.photos = 0;
  await handleUpdate({ chat_join_request: h.jr({ bio: 'ada bio' }) });
  assert.equal(h.t.join_requests[0].status, 'manual'); // semua harus terpenuhi
});

test('whitelist melewati syarat profil', async () => {
  const h = setup(); h.chat({ ar_require_bio: true });
  h.t.whitelist.push({ user_id: 500 });
  await handleUpdate({ chat_join_request: h.jr() });
  assert.equal(h.t.join_requests[0].status, 'approved');
});

test('jeda: menunggu dulu, disetujui setelah jatuh tempo, tidak ganda', async () => {
  const h = setup(); h.chat({ ar_delay_minutes: 30 });
  await handleUpdate({ chat_join_request: h.jr() });
  assert.equal(h.t.join_requests[0].status, 'waiting');
  assert.ok(!names(h.calls).includes('approveChatJoinRequest'));

  let out = await approval.processDue();
  assert.equal(out.approved, 0); // belum jatuh tempo

  h.t.join_requests[0].due_at = new Date(Date.now() - 1000).toISOString();
  const [a, b] = await Promise.all([approval.processDue(), approval.processDue()]);
  assert.equal(a.approved + b.approved, 1);
  assert.equal(h.calls.filter((c) => c.method === 'approveChatJoinRequest').length, 1);
  assert.equal(h.t.join_requests[0].status, 'approved');
});

test('jatuh tempo saat fitur dimatikan: dialihkan ke manual, tidak disetujui', async () => {
  const h = setup(); const c = h.chat({ ar_delay_minutes: 5 });
  await handleUpdate({ chat_join_request: h.jr() });
  c.ar_enabled = false;
  h.t.join_requests[0].due_at = new Date(Date.now() - 1000).toISOString();
  const out = await approval.processDue();
  assert.equal(out.moved, 1);
  assert.equal(h.t.join_requests[0].status, 'manual');
  assert.ok(!names(h.calls).includes('approveChatJoinRequest'));
});

test('pesan persetujuan: terkirim sebelum approve, teks kustom di-escape', async () => {
  const h = setup(); h.chat({ ar_dm: true, ar_dm_text: 'Halo {nama}, <b>selamat</b> di {chat}' });
  await handleUpdate({ chat_join_request: h.jr({ from: { id: 500, first_name: 'A<i>' } }) });
  assert.deepEqual(names(h.calls), ['sendMessage', 'approveChatJoinRequest']);
  const text = h.calls[0].params.text;
  assert.match(text, /Halo A&lt;i&gt;, &lt;b&gt;selamat&lt;\/b&gt; di <b>Channel Uji<\/b>/);
  assert.equal(h.t.join_requests[0].dm_status, 'sent');
});

test('pesan gagal terkirim (403): approve tetap berjalan', async () => {
  const h = setup(); h.chat({ ar_dm: true }); h.behavior.failSend = true;
  await handleUpdate({ chat_join_request: h.jr() });
  assert.equal(h.t.join_requests[0].status, 'approved');
  assert.equal(h.t.join_requests[0].dm_status, 'failed');
});

test('tanpa pesan ke member bila dimatikan', async () => {
  const h = setup(); h.chat({ ar_dm: false });
  await handleUpdate({ chat_join_request: h.jr() });
  assert.ok(!names(h.calls).includes('sendMessage'));
});

test('permintaan sudah tidak ada: ditandai gone', async () => {
  const h = setup(); h.chat(); h.behavior.approveError = 'Bad Request: HIDE_REQUESTER_MISSING';
  await handleUpdate({ chat_join_request: h.jr() });
  assert.equal(h.t.join_requests[0].status, 'gone');
});

test('tombol admin: setujui dan tolak, tidak bisa diproses dua kali', async () => {
  const h = setup(); h.chat({ ar_require_bio: true });
  await handleUpdate({ chat_join_request: h.jr() });
  const id = h.t.join_requests[0].id;
  const cb = (data) => ({ callback_query: { id: 'q', from: { id: 1 }, data, message: { chat: { id: 1 }, message_id: 7 } } });
  await handleUpdate(cb(`jr:${id}:a`));
  assert.equal(h.t.join_requests[0].status, 'approved');
  assert.equal(h.t.join_requests[0].processed_by, 'admin:1');
  const before = h.calls.length;
  await handleUpdate(cb(`jr:${id}:d`));
  assert.ok(!h.calls.slice(before).some((c) => c.method === 'declineChatJoinRequest'));
  const edited = h.calls.find((c) => c.method === 'editMessageText');
  assert.match(edited.params.text, /Disetujui/);
});

test('bukan admin bot tidak bisa memakai tombol', async () => {
  const h = setup(); h.chat({ ar_require_bio: true });
  await handleUpdate({ chat_join_request: h.jr() });
  await handleUpdate({ callback_query: { id: 'q', from: { id: 999 }, data: `jr:${h.t.join_requests[0].id}:a`, message: { chat: { id: 9 }, message_id: 1 } } });
  assert.equal(h.t.join_requests[0].status, 'manual');
});
