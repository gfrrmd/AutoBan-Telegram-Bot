const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');
const ui = require('../lib/ui');
const sync = require('../lib/sync');
const enf = require('../lib/enforcement');
const { userLink } = require('../lib/util');
const { handleUpdate } = require('../lib/handlers');

const press = (data, from = 1) =>
  handleUpdate({ callback_query: { id: 'q', from: { id: from }, data, message: { chat: { id: 1 }, message_id: 1 } } });
const base = { chat_id: -1001, name: 'x', joined_at: new Date().toISOString() };

test('nama channel: pesan sistem "ganti nama" memperbarui judul', async () => {
  const h = setup(); h.chat({ managed: true });
  await handleUpdate({ channel_post: { chat: { id: -1001, type: 'channel' }, message_id: 5, date: 1, new_chat_title: 'Nama Baru' } });
  assert.equal(h.t.chats[0].title, 'Nama Baru');
  assert.equal(h.t.chats.length, 1);
  await handleUpdate({ message: { chat: { id: -1001, type: 'supergroup' }, message_id: 6, date: 1, new_chat_title: 'Grup Baru' } });
  assert.equal(h.t.chats[0].title, 'Grup Baru');
});

test('nama channel: membuka detail chat menyegarkan dari Telegram, cron segarkan semua', async () => {
  const h = setup(); h.chat({ title: 'Lama' });
  h.behavior.chatInfo = { id: -1001, title: 'Terbaru', username: 'terbaru' };
  await press('c:-1001');
  assert.equal(h.t.chats[0].title, 'Terbaru');
  h.t.chats[0].title = 'Basi';
  assert.equal(await sync.refreshAll(), 1);
  assert.equal(h.t.chats[0].title, 'Terbaru');
  await press('rf:all');
  const edit = h.calls.filter((c) => c.method === 'editMessageText').pop();
  assert.match(edit.params.text, /Chat Terkelola/);
});

test('jumlah member: menampilkan angka Telegram dan catatan bot (tanpa batas 1000)', async () => {
  const h = setup(); h.chat({ managed: true });
  h.behavior.count = 2480;
  for (let i = 1; i <= 1500; i++) h.t.members.push({ ...base, user_id: 10000 + i });
  const v = await ui.chatView(-1001);
  assert.match(v.text, /Jumlah member \(Telegram\): 2480/);
  assert.match(v.text, /Member terlacak bot: 1500/);
  h.behavior.count = undefined;
  h.behavior.failMethods.add('getChatMemberCount');
  assert.match((await ui.chatView(-1001)).text, /tidak terbaca/);
});

test('member yang dikeluarkan admin (kicked) ikut dihapus dari catatan dan tidak diban otomatis', async () => {
  const h = setup(); h.chat({ managed: true });
  h.t.members.push({ ...base, user_id: 77 }, { ...base, user_id: 78 });
  const ev = (status, from) => ({ chat_member: {
    chat: { id: -1001, type: 'channel' }, from: { id: from }, date: 1,
    old_chat_member: { status: 'member', user: { id: 77 } },
    new_chat_member: { status, user: { id: 77, first_name: 'A' } } } });
  await handleUpdate(ev('kicked', 1));
  assert.deepEqual(h.t.members.map((m) => m.user_id), [78]);
  assert.ok(!h.calls.some((c) => c.method === 'banChatMember'));
});

test('sinkronisasi: menghapus yang sudah tidak jadi member, bertahap dengan sisa', async () => {
  const h = setup(); h.chat({ managed: true });
  for (let i = 1; i <= 10; i++) h.t.members.push({ ...base, user_id: i });
  h.behavior.statusOf = (id) => (id <= 4 ? 'kicked' : id === 5 ? 'left' : 'member');
  const out = await sync.syncMembers(-1001, 60000);
  assert.equal(out.checked, 10);
  assert.equal(out.removed, 5);
  assert.equal(out.remaining, 0);
  assert.equal(h.t.members.length, 5);
  assert.ok(h.t.members.every((m) => m.checked_at));
  // lewat tombol panel
  h.t.members.push({ ...base, user_id: 50 });
  h.behavior.statusOf = () => 'left';
  await press('sm:-1001');
  assert.ok(!h.t.members.some((m) => m.user_id === 50));
  assert.match(h.calls.filter((c) => c.method === 'editMessageText').pop().params.text, /Sinkronisasi Member/);
});

test('userLink: ber-username pakai t.me, tanpa username pakai tg://user', () => {
  assert.match(userLink(5, 'Ani', 'ani_x'), /href="https:\/\/t\.me\/ani_x"/);
  assert.match(userLink(5, 'Ani'), /href="tg:\/\/user\?id=5"/);
});

test('notifikasi keluar: ada ID, tombol ban/cabut ban berbasis ID, tombol profil', async () => {
  const h = setup(); h.chat({ managed: true, leave_ban: true });
  const ev = { chat_member: {
    chat: { id: -1001, type: 'channel' }, from: { id: 321 }, date: 1,
    old_chat_member: { status: 'member', user: { id: 321 } },
    new_chat_member: { status: 'left', user: { id: 321, first_name: 'Tanpa Username' } } } };
  await handleUpdate(ev);
  const note = h.calls.find((c) => c.method === 'sendMessage' && /Ban Otomatis/.test(c.params.text));
  assert.match(note.params.text, /ID: <code>321<\/code>/);
  const flat = note.params.keyboard.flat();
  assert.ok(flat.some((b) => b.callback_data === 'bn:321'));
  assert.ok(flat.some((b) => b.callback_data === 'ub:321'));
  assert.ok(flat.some((b) => b.url === 'tg://user?id=321'));
});

test('Telegram menolak tombol profil (privasi): notifikasi tetap terkirim tanpa tombol berurl', async () => {
  const h = setup(); h.chat({ managed: true, leave_ban: true });
  h.behavior.rejectUrlButtons = true;
  await enf.notifyAdmins('uji', enf.userActions({ id: 9 }));
  const sent = h.calls.filter((c) => c.method === 'sendMessage');
  const last = sent[sent.length - 1];
  assert.ok(!JSON.stringify(last.params.keyboard).includes('"url"'));
  assert.ok(last.params.keyboard.flat().some((b) => b.callback_data === 'bn:9'));
  assert.equal(sent.length, 4); // 2 admin x (percobaan gagal + kirim ulang)
});

test('ban manual: perintah /ban, tombol, dan menghormati whitelist', async () => {
  const h = setup(); h.chat({ managed: true });
  h.t.whitelist.push({ user_id: 60000 });
  await handleUpdate({ message: { chat: { id: 1, type: 'private' }, from: { id: 1 }, text: '/ban 55555 60000' } });
  const bans = h.calls.filter((c) => c.method === 'banChatMember');
  assert.equal(bans.length, 1);
  assert.equal(bans[0].params.user_id, 55555);
  const reply = h.calls.filter((c) => c.method === 'sendMessage').pop().params.text;
  assert.match(reply, /<code>60000<\/code>: dilewati/);
  await press('bn:777');
  assert.ok(h.calls.some((c) => c.method === 'banChatMember' && c.params.user_id === 777));
  await press('ub:777');
  assert.ok(h.calls.some((c) => c.method === 'unbanChatMember' && c.params.user_id === 777));
  await press('bn:777', 999); // bukan admin
  assert.equal(h.calls.filter((c) => c.method === 'banChatMember').length, 2);
});

test('ban manual lewat menu: sesi meminta ID lalu mengeksekusi', async () => {
  const h = setup(); h.chat({ managed: true });
  await press('bm:ask');
  await handleUpdate({ message: { chat: { id: 1, type: 'private' }, from: { id: 1 }, text: '88888' } });
  assert.ok(h.calls.some((c) => c.method === 'banChatMember' && c.params.user_id === 88888));
});
