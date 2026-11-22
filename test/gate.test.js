const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');
const approval = require('../lib/approval');
const { handleUpdate } = require('../lib/handlers');

const KANAL_B = { chat_id: -1002, title: 'Kanal B', type: 'channel', username: 'kanalB', bot_admin: true };
const KANAL_C = { chat_id: -1003, title: 'Grup C', type: 'supergroup', username: null, bot_admin: true };

const press = (uid, data) =>
  handleUpdate({ callback_query: { id: 'q', from: { id: uid, first_name: 'Budi' }, data, message: { chat: { id: uid }, message_id: 7 } } });
const adminSay = (text) => handleUpdate({ message: { chat: { id: 1, type: 'private' }, from: { id: 1 }, text } });
const sent = (h) => h.calls.filter((c) => c.method === 'sendMessage');
const answers = (h) => h.calls.filter((c) => c.method === 'answerCallbackQuery').map((c) => c.params.text);
const edits = (h) => h.calls.filter((c) => c.method === 'editMessageText');
const approved = (h) => h.calls.filter((c) => c.method === 'approveChatJoinRequest').length;

function withForce(h, over = {}) {
  const c = h.chat({ ar_force: true, ar_force_chats: [{ id: -1002, url: 'https://t.me/kanalB' }], ...over });
  h.t.chats.push({ ...KANAL_B });
  return c;
}

/* ---------- Persetujuan aturan ---------- */

test('persetujuan aturan: pesan terkirim, belum disetujui sampai tombol ditekan', async () => {
  const h = setup(); h.chat({ ar_agree: true });
  await handleUpdate({ chat_join_request: h.jr() });
  const rec = h.t.join_requests[0];
  assert.equal(rec.status, 'gate');
  assert.equal(approved(h), 0);
  const dm = sent(h)[0].params;
  assert.equal(dm.chat_id, 500);
  assert.match(dm.text, /Budi/);
  assert.match(dm.text, /Channel Uji/);
  assert.equal(dm.keyboard.at(-1)[0].text, 'Saya Setuju');
  assert.equal(dm.keyboard.at(-1)[0].callback_data, `gj:${rec.id}`);

  await press(500, `gj:${rec.id}`);
  assert.equal(approved(h), 1);
  assert.equal(h.t.join_requests[0].status, 'approved');
  assert.ok(h.t.join_requests[0].agreed_at);
  assert.match(edits(h)[0].params.text, /disetujui/);
});

test('teks dan label tombol bisa diubah', async () => {
  const h = setup(); h.chat({ ar_agree: true, ar_agree_text: 'Aturan untuk {nama} di {chat}. <b>', ar_agree_btn: 'Oke Lanjut' });
  await handleUpdate({ chat_join_request: h.jr() });
  const dm = sent(h)[0].params;
  assert.match(dm.text, /Aturan untuk Budi di <b>Channel Uji<\/b>\. &lt;b&gt;/);
  assert.equal(dm.keyboard.at(-1)[0].text, 'Oke Lanjut');
});

test('orang lain tidak bisa menekan tombol milik pemohon', async () => {
  const h = setup(); h.chat({ ar_agree: true });
  await handleUpdate({ chat_join_request: h.jr() });
  await press(777, `gj:${h.t.join_requests[0].id}`);
  assert.equal(approved(h), 0);
  assert.equal(h.t.join_requests[0].status, 'gate');
  assert.match(answers(h).at(-1), /tidak ditemukan/i);
});

test('tombol ditekan dua kali: yang kedua ditolak, tidak approve ganda', async () => {
  const h = setup(); h.chat({ ar_agree: true });
  await handleUpdate({ chat_join_request: h.jr() });
  const data = `gj:${h.t.join_requests[0].id}`;
  await press(500, data);
  await press(500, data);
  assert.equal(approved(h), 1);
  assert.match(answers(h).at(-1), /sudah diproses/i);
});

test('whitelist dan admin melewati gerbang', async () => {
  const h = setup(); h.chat({ ar_agree: true });
  h.t.whitelist.push({ user_id: 500 });
  await handleUpdate({ chat_join_request: h.jr() });
  assert.equal(h.t.join_requests[0].status, 'approved');
  assert.equal(sent(h).length, 0);
});

test('gerbang mati: alur lama tidak berubah', async () => {
  const h = setup(); h.chat({ ar_agree: false, ar_force: true, ar_force_chats: [] });
  await handleUpdate({ chat_join_request: h.jr() });
  assert.equal(h.t.join_requests[0].status, 'approved');
});

test('syarat profil gagal tetap masuk manual, tanpa pesan gerbang', async () => {
  const h = setup(); h.chat({ ar_agree: true, ar_require_photo: true }); h.behavior.photos = 0;
  await handleUpdate({ chat_join_request: h.jr() });
  assert.equal(h.t.join_requests[0].status, 'manual');
  assert.ok(sent(h).every((c) => c.params.chat_id !== 500));
});

test('pesan gerbang gagal terkirim: masuk manual dan admin diberi tahu', async () => {
  const h = setup(); h.chat({ ar_agree: true });
  h.behavior.failSend = true;
  await handleUpdate({ chat_join_request: h.jr() });
  assert.equal(h.t.join_requests[0].status, 'manual');
  assert.match(h.t.join_requests[0].reason, /tidak dapat dikirim/i);
  assert.equal(approved(h), 0);
});

/* ---------- Wajib join ---------- */

test('wajib join: belum bergabung tetap menunggu, setelah bergabung disetujui', async () => {
  const h = setup(); withForce(h);
  await handleUpdate({ chat_join_request: h.jr() });
  const rec = h.t.join_requests[0];
  assert.equal(rec.status, 'gate');
  const dm = sent(h)[0].params;
  assert.match(dm.text, /Kanal B/);
  assert.equal(dm.keyboard[0][0].url, 'https://t.me/kanalB');
  assert.equal(dm.keyboard.at(-1)[0].text, 'Saya Sudah Bergabung');

  h.behavior.statusOf = () => 'left';
  await press(500, `gj:${rec.id}`);
  assert.equal(approved(h), 0);
  assert.equal(h.t.join_requests[0].status, 'gate');
  assert.match(answers(h).at(-1), /belum bergabung/i);
  assert.match(edits(h)[0].params.text, /Belum bergabung/);
  assert.equal(edits(h)[0].params.keyboard.at(-1)[0].text, 'Cek Lagi');

  h.behavior.statusOf = () => 'member';
  await press(500, `gj:${rec.id}`);
  assert.equal(approved(h), 1);
  assert.equal(h.t.join_requests[0].status, 'approved');
});

test('wajib join lebih dari satu: hanya yang kurang yang ditampilkan lagi', async () => {
  const h = setup();
  withForce(h, { ar_force_chats: [{ id: -1002, url: 'https://t.me/kanalB' }, { id: -1003, url: 'https://t.me/+xyz' }] });
  h.t.chats.push({ ...KANAL_C });
  await handleUpdate({ chat_join_request: h.jr() });
  const dm = sent(h)[0].params;
  assert.equal(dm.keyboard.filter((r) => r[0].url).length, 2);

  const rec = h.t.join_requests[0];
  // sudah di Kanal B, belum di Grup C
  const tg = require('../lib/telegram');
  const prev = tg.call;
  tg.call = async (m, p = {}) => (m === 'getChatMember' && p.chat_id === -1003 ? { status: 'left', user: { id: p.user_id } } : prev(m, p));
  await press(500, `gj:${rec.id}`);
  tg.call = prev;
  const shown = edits(h)[0].params.keyboard.filter((r) => r[0].url);
  assert.equal(shown.length, 1);
  assert.match(shown[0][0].text, /Grup C/);
  assert.equal(h.t.join_requests[0].status, 'gate');
});

test('persetujuan aturan + wajib join: setuju tercatat walau belum bergabung', async () => {
  const h = setup(); withForce(h, { ar_agree: true });
  await handleUpdate({ chat_join_request: h.jr() });
  const rec = h.t.join_requests[0];
  assert.match(sent(h)[0].params.text, /patuhi aturan/);
  assert.equal(sent(h)[0].params.keyboard.at(-1)[0].text, 'Saya Setuju');

  h.behavior.statusOf = () => 'left';
  await press(500, `gj:${rec.id}`);
  assert.ok(h.t.join_requests[0].agreed_at);
  assert.equal(h.t.join_requests[0].status, 'gate');
  assert.match(edits(h)[0].params.text, /sudah kamu setujui/);

  h.behavior.statusOf = () => 'member';
  await press(500, `gj:${rec.id}`);
  assert.equal(h.t.join_requests[0].status, 'approved');
});

test('verifikasi tidak pasti (bot tidak bisa membaca chat syarat): tidak disetujui, masuk manual', async () => {
  const h = setup(); withForce(h);
  await handleUpdate({ chat_join_request: h.jr() });
  h.behavior.failMethods.add('getChatMember');
  await press(500, `gj:${h.t.join_requests[0].id}`);
  assert.equal(approved(h), 0);
  assert.equal(h.t.join_requests[0].status, 'manual');
  assert.ok(sent(h).some((c) => c.params.chat_id === 1 && /Perlu Ditinjau/.test(c.params.text)));
});

test('jeda persetujuan tetap berlaku setelah gerbang selesai', async () => {
  const h = setup(); h.chat({ ar_agree: true, ar_delay_minutes: 30 });
  await handleUpdate({ chat_join_request: h.jr() });
  await press(500, `gj:${h.t.join_requests[0].id}`);
  assert.equal(h.t.join_requests[0].status, 'waiting');
  assert.equal(approved(h), 0);
  assert.match(edits(h)[0].params.text, /akan disetujui otomatis/);

  h.t.join_requests[0].due_at = new Date(Date.now() - 1000).toISOString();
  const out = await approval.processDue();
  assert.equal(out.approved, 1);
  assert.equal(h.t.join_requests[0].status, 'approved');
});

test('gerbang kedaluwarsa: tidak ditolak, dialihkan ke manual oleh cron', async () => {
  const h = setup(); h.chat({ ar_agree: true });
  await handleUpdate({ chat_join_request: h.jr() });
  h.t.join_requests[0].due_at = new Date(Date.now() - 1000).toISOString();
  const out = await approval.processDue();
  assert.equal(out.moved, 1);
  assert.equal(h.t.join_requests[0].status, 'manual');
  assert.equal(approved(h), 0);
  assert.ok(!h.calls.some((c) => c.method === 'declineChatJoinRequest'));
});

test('auto approve dimatikan saat menunggu: permintaan gerbang dialihkan ke manual', async () => {
  const h = setup(); const c = h.chat({ ar_agree: true });
  await handleUpdate({ chat_join_request: h.jr() });
  await press(1, 'at:-1001:en');
  assert.equal(c.ar_enabled, false);
  assert.equal(h.t.join_requests[0].status, 'manual');
});

test('/start dari calon member mengirim ulang syarat; orang lain tetap ditolak', async () => {
  const h = setup(); h.chat({ ar_agree: true });
  await handleUpdate({ chat_join_request: h.jr() });
  h.calls.length = 0;
  await handleUpdate({ message: { chat: { id: 500, type: 'private' }, from: { id: 500 }, text: '/start' } });
  assert.match(sent(h)[0].params.text, /patuhi aturan/);
  h.calls.length = 0;
  await handleUpdate({ message: { chat: { id: 888, type: 'private' }, from: { id: 888 }, text: '/start' } });
  assert.match(sent(h)[0].params.text, /khusus untuk administrator/);
});

/* ---------- Panel admin ---------- */

test('panel: wajib join butuh minimal satu chat syarat; pilih, hapus, batas jumlah', async () => {
  const h = setup(); const c = h.chat();
  h.t.chats.push({ ...KANAL_B }, { ...KANAL_C });

  await press(1, 'at:-1001:force');
  assert.equal(c.ar_force, undefined);
  assert.match(answers(h).at(-1), /minimal satu/i);

  await press(1, 'fc:-1001:-1002');
  assert.deepEqual(c.ar_force_chats, [{ id: -1002, url: 'https://t.me/kanalB' }]);
  await press(1, 'fc:-1001:-1003'); // tanpa username: tautan undangan dibuat bot
  assert.equal(c.ar_force_chats[1].url, 'https://t.me/+abc123');

  await press(1, 'at:-1001:force');
  assert.equal(c.ar_force, true);

  await press(1, 'fc:-1001:-1002');
  await press(1, 'fc:-1001:-1003');
  assert.deepEqual(c.ar_force_chats, []);
  assert.equal(c.ar_force, false); // otomatis mati bila daftar kosong
});

test('panel: chat syarat ditolak bila bot bukan admin di sana, atau tautan tidak bisa dibuat, atau chat itu sendiri', async () => {
  const h = setup(); const c = h.chat();
  h.t.chats.push({ ...KANAL_B, bot_admin: false }, { ...KANAL_C });
  await press(1, 'fc:-1001:-1002');
  assert.match(answers(h).at(-1), /harus menjadi admin/i);
  h.behavior.noInviteLink = true;
  await press(1, 'fc:-1001:-1003');
  assert.match(answers(h).at(-1), /tautan undangan/i);
  await press(1, 'fc:-1001:-1001');
  assert.match(answers(h).at(-1), /itu sendiri/i);
  assert.equal(c.ar_force_chats, undefined);
});

test('panel: maksimal 5 chat syarat', async () => {
  const h = setup(); const c = h.chat();
  for (let i = 0; i < 6; i++) h.t.chats.push({ chat_id: -2000 - i, title: `K${i}`, type: 'channel', username: `k${i}`, bot_admin: true });
  for (let i = 0; i < 6; i++) await press(1, `fc:-1001:${-2000 - i}`);
  assert.equal(c.ar_force_chats.length, approval.FORCE_MAX);
  assert.match(answers(h).at(-1), /Maksimal/);
});

test('panel: ubah teks, label tombol, reset, dan pratinjau', async () => {
  const h = setup(); const c = h.chat({ ar_agree: true });
  await press(1, 'gx:-1001');
  await adminSay('/x'); // perintah tidak diterima sebagai teks
  assert.equal(c.ar_agree_text, undefined);
  await adminSay('Selamat datang {nama}, patuhi aturan {chat}.');
  assert.equal(c.ar_agree_text, 'Selamat datang {nama}, patuhi aturan {chat}.');

  await press(1, 'gx:-1001');
  await adminSay('z'.repeat(1001));
  assert.equal(c.ar_agree_text, 'Selamat datang {nama}, patuhi aturan {chat}.');
  await press(1, 'x:c');

  await press(1, 'gb:-1001');
  await adminSay('a'.repeat(31));
  assert.equal(c.ar_agree_btn, undefined);
  await adminSay('Siap Lanjut');
  assert.equal(c.ar_agree_btn, 'Siap Lanjut');

  h.calls.length = 0;
  await press(1, 'gp:-1001');
  const msgs = sent(h);
  assert.equal(msgs.length, 2);
  assert.match(msgs[1].params.text, /Selamat datang Budi/);
  assert.equal(msgs[1].params.keyboard.at(-1)[0].callback_data, 'gj:0');
  await press(1, 'gj:0');
  assert.match(answers(h).at(-1), /pratinjau/i);

  await press(1, 'gz:-1001');
  assert.equal(c.ar_agree_text, null);
  assert.equal(c.ar_agree_btn, null);
});

test('panel: pratinjau ditolak bila gerbang belum aktif', async () => {
  const h = setup(); h.chat();
  await press(1, 'gp:-1001');
  assert.match(answers(h).at(-1), /Aktifkan/);
});
