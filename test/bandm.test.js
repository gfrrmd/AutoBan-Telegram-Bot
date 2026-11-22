const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');
const db = require('../lib/db');
const tg = require('../lib/telegram');
const enf = require('../lib/enforcement');
const ui = require('../lib/ui');
const { handleUpdate } = require('../lib/handlers');

const GRUP_B = { chat_id: -1002, title: 'Grup B', type: 'supergroup', username: null, bot_admin: true, managed: true, leave_ban: true };

function world({ dm = true } = {}) {
  const h = setup();
  h.chat({ managed: true, leave_ban: true });
  h.t.chats.push({ ...GRUP_B });
  if (dm) h.t.settingsStore.ban_dm = true;
  return h;
}
const leaveEv = (id = 321, name = 'Andi') => ({
  chat_member: {
    chat: { id: -1001, type: 'channel' }, from: { id }, date: 1,
    old_chat_member: { status: 'member', user: { id } },
    new_chat_member: { status: 'left', user: { id, first_name: name } },
  },
});
const press = (data) =>
  handleUpdate({ callback_query: { id: 'q', from: { id: 1, first_name: 'Admin' }, data, message: { chat: { id: 1 }, message_id: 7 } } });
const adminSay = (text) => handleUpdate({ message: { chat: { id: 1, type: 'private' }, from: { id: 1 }, text } });
const dmsTo = (h, id) => h.calls.filter((c) => c.method === 'sendMessage' && c.params.chat_id === id);
const answers = (h) => h.calls.filter((c) => c.method === 'answerCallbackQuery').map((c) => c.params.text);

test('bawaan mati: orang yang diban tidak menerima pesan', async () => {
  const h = world({ dm: false });
  await handleUpdate(leaveEv());
  assert.equal(dmsTo(h, 321).length, 0);
  assert.equal(h.t.ban_log[0].dm_status, undefined);
  assert.equal(h.calls.filter((c) => c.method === 'banChatMember').length, 2);
});

test('aktif: pesan berisi nama, jumlah chat, dan chat asal; tercatat terkirim', async () => {
  const h = world();
  await handleUpdate(leaveEv());
  const dm = dmsTo(h, 321);
  assert.equal(dm.length, 1);
  assert.match(dm[0].params.text, /Halo Andi/);
  assert.match(dm[0].params.text, /2 channel dan grup/);
  assert.match(dm[0].params.text, /<b>Channel Uji<\/b>/);
  assert.equal(h.t.ban_log[0].dm_status, 'sent');
  const report = dmsTo(h, 1).find((c) => /Ban Otomatis/.test(c.params.text));
  assert.match(report.params.text, /Pesan ke pengguna: terkirim/);
});

test('teks kustom: semua variabel terisi dan karakter HTML aman', async () => {
  const h = world();
  h.t.settingsStore.ban_dm_leave = 'Hai {nama} <b>! Alasan: {alasan}. Diban di {jumlah}:\n{daftar}';
  await handleUpdate(leaveEv(321, 'Andi <i>'));
  const text = dmsTo(h, 321)[0].params.text;
  assert.match(text, /Hai Andi &lt;i&gt; &lt;b&gt;!/);
  assert.match(text, /Alasan: keluar dari channel\./);
  assert.match(text, /Diban di 2:/);
  assert.match(text, /- Channel Uji\n- Grup B/);
});

test('teks terpisah untuk tiap alasan: manual dan pasif', async () => {
  const h = world();
  h.t.settingsStore.ban_dm_manual = 'MANUAL {nama}';
  await adminSay('/ban 55500');
  assert.equal(dmsTo(h, 55500)[0].params.text, 'MANUAL Pengguna'); // ID murni dianggap nama tidak diketahui
  assert.match(dmsTo(h, 1).pop().params.text, /Pesan ke pengguna: terkirim/);

  const ch = h.t.chats[0];
  await enf.banEverywhere({ id: 600, first_name: 'Sari' }, { reason: 'passive', source: ch, detail: 'x' });
  assert.match(dmsTo(h, 600)[0].params.text, /Sari.*tidak aktif berkomentar di <b>Channel Uji<\/b>/);
});

test('pesan gagal terkirim: ban tetap jalan, tercatat gagal, admin diberi tahu', async () => {
  const h = world();
  const prev = tg.call;
  tg.call = async (m, p = {}) => {
    if (m === 'sendMessage' && p.chat_id === 321) throw new tg.TgError(m, 403, "Forbidden: bot can't initiate conversation with a user");
    return prev(m, p);
  };
  await handleUpdate(leaveEv());
  tg.call = prev;
  assert.equal(h.calls.filter((c) => c.method === 'banChatMember').length, 2);
  assert.equal(h.t.ban_log[0].dm_status, 'failed');
  const report = dmsTo(h, 1).find((c) => /Ban Otomatis/.test(c.params.text));
  assert.match(report.params.text, /tidak terkirim/);
});

test('tidak dikirim ulang dalam 24 jam (Ban Ulang tidak membanjiri pesan)', async () => {
  const h = world();
  const u = { id: 321, first_name: 'Andi' };
  const first = await enf.banEverywhere(u, { reason: 'manual' });
  const second = await enf.banEverywhere(u, { reason: 'manual' });
  assert.equal(first.dm, 'sent');
  assert.equal(second.dm, 'skipped');
  assert.equal(dmsTo(h, 321).length, 1);
});

test('tidak ada ban yang berhasil: tidak ada pesan', async () => {
  const h = world();
  h.behavior.failMethods.add('banChatMember');
  const res = await enf.banEverywhere({ id: 321, first_name: 'Andi' }, { reason: 'manual' });
  assert.equal(res.dm, null);
  assert.equal(dmsTo(h, 321).length, 0);
});

test('database lama tanpa kolom dm_status: ban tetap tercatat', async () => {
  const h = world();
  const prev = db.insert;
  db.insert = async (table, rows, opt) => {
    if (table === 'ban_log' && [].concat(rows)[0].dm_status) throw new Error('DB POST ban_log 400: column dm_status does not exist');
    return prev(table, rows, opt);
  };
  const res = await enf.banEverywhere({ id: 321, first_name: 'Andi' }, { reason: 'manual' });
  db.insert = prev;
  assert.equal(res.ok.length, 2);
  assert.equal(h.t.ban_log.length, 1);
  assert.equal(h.t.ban_log[0].dm_status, undefined);
});

test('laporan pemeriksaan pasif dan riwayat ban menampilkan status pesan', async () => {
  const h = world();
  const out = {
    simulated: false, channels: 1, evaluated: 2, deletedPosts: 0, skippedPosts: 0, flagged: [], errors: [], partial: false,
    banned: [{ id: 1, name: 'A', channel: 'C', count: 1, dm: 'sent' }, { id: 2, name: 'B', channel: 'C', count: 1, dm: 'failed' }],
  };
  assert.match(enf.formatPassiveSummary(out), /Pesan ban: 1 terkirim, 1 tidak terkirim/);
  await enf.banEverywhere({ id: 321, first_name: 'Andi' }, { reason: 'manual' });
  assert.match((await ui.logView()).text, /pesan terkirim/);
  void h;
});

/* ---------- Panel ---------- */

test('panel: saklar, lihat teks, ubah teks, validasi, dan reset', async () => {
  const h = world({ dm: false });
  await press('bd:tg');
  assert.equal(h.t.settingsStore.ban_dm, true);
  await press('bd:tg');
  assert.equal(h.t.settingsStore.ban_dm, false);

  await press('bt:leave');
  assert.match(h.calls.filter((c) => c.method === 'editMessageText').pop().params.text, /\(bawaan\)/);

  await press('be:leave');
  await adminSay('/batal');
  assert.equal(h.t.settingsStore.ban_dm_leave, undefined);
  await adminSay('x'.repeat(enf.BAN_DM_MAX + 1));
  assert.equal(h.t.settingsStore.ban_dm_leave, undefined);
  await adminSay('Kamu diban dari {jumlah} chat.');
  assert.equal(h.t.settingsStore.ban_dm_leave, 'Kamu diban dari {jumlah} chat.');
  assert.doesNotMatch(await ui.banTextView('leave').then((v) => v.text), /\(bawaan\)/);

  await press('br:leave');
  assert.equal(h.t.settingsStore.ban_dm_leave, null);
  assert.equal(enf.banTemplate(await db.getSettings(), 'leave'), enf.DEFAULT_BAN_DM.leave);
  await press('bt:ngawur');
  assert.match(answers(h).at(-1), /tidak dikenal/i);
});

test('panel: pratinjau hanya dikirim ke admin dan memakai chat yang ada', async () => {
  const h = world({ dm: false });
  await press('bp:leave');
  const msgs = h.calls.filter((c) => c.method === 'sendMessage');
  assert.equal(msgs.length, 2);
  assert.ok(msgs.every((c) => c.params.chat_id === 1));
  assert.match(msgs[1].params.text, /Halo Admin/);
  assert.match(msgs[1].params.text, /2 channel dan grup/);
});

test('admin dan whitelist tidak pernah diban sehingga tidak menerima pesan', async () => {
  const h = world();
  h.t.whitelist.push({ user_id: 700 });
  await handleUpdate(leaveEv(700));
  assert.match(await enf.banById(2), /dilewati/);
  assert.match(await enf.banById(700), /dilewati/);
  assert.equal(dmsTo(h, 700).length, 0);
  assert.equal(dmsTo(h, 2).length, 0);
  assert.equal(h.calls.filter((c) => c.method === 'banChatMember').length, 0);
});
