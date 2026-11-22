const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');
const ui = require('../lib/ui');
const uiAr = require('../lib/ui-approval');
const { handleUpdate } = require('../lib/handlers');

const allButtons = (v) => v.keyboard.flat();

test('semua view: callback_data <= 64 byte, teks <= 4096, maksimal 6 tombol per layar kategori', async () => {
  const h = setup(); h.chat();
  h.t.chats[0].ar_dm_text = 'x'.repeat(500);
  h.t.chats[0].ar_agree_text = 'y'.repeat(1000);
  const views = {
    home: await ui.homeView(), enf: ui.enforceView(), hub: await uiAr.hubView(), main: await uiAr.arView(-1001),
    filters: await uiAr.filtersView(-1001), delay: await uiAr.delayView(-1001), notify: await uiAr.notifyView(-1001),
    queue: await uiAr.queueView(-1001), agree: await uiAr.agreeView(-1001), force: await uiAr.forceView(-1001),
    bandm: await ui.banDmView(), banText: await ui.banTextView('leave'),
  };
  for (const [name, v] of Object.entries(views)) {
    assert.ok(v.text.length < 4096, name);
    for (const b of allButtons(v)) assert.ok(Buffer.byteLength(b.callback_data) <= 64, `${name}: ${b.callback_data}`);
  }
  assert.ok(allButtons(views.home).length <= 6);
  assert.ok(allButtons(views.main).length <= 8);
  assert.ok(allButtons(views.enf).length <= 7);
});

test('navigasi tombol: setiap callback di view bisa ditangani tanpa galat', async () => {
  const h = setup(); h.chat();
  const seen = new Set();
  const queue = ['m:home'];
  while (queue.length) {
    const data = queue.shift();
    if (seen.has(data)) continue;
    seen.add(data);
    h.calls.length = 0;
    await handleUpdate({ callback_query: { id: 'q', from: { id: 1 }, data, message: { chat: { id: 1 }, message_id: 1 } } });
    const edit = h.calls.find((c) => c.method === 'editMessageText');
    const ans = h.calls.find((c) => c.method === 'answerCallbackQuery');
    assert.ok(!(ans && ans.params.text === 'Terjadi kesalahan, coba lagi.'), `galat di ${data}`);
    if (edit) for (const b of edit.params.keyboard.flat()) {
      // lewati aksi yang mengubah data atau meminta input
      if (/^(at:.*:(en)|jr:|p:run|u:|w:|ds:|ks:|as:|t:|i:|dc:|ac:|ax:|az:)/.test(b.callback_data)) continue;
      queue.push(b.callback_data);
    }
  }
  for (const must of ['m:ar', 'm:enf', 'ar:-1001', 'af:-1001', 'ad:-1001', 'an:-1001', 'aq:-1001', 'm:chats', 'm:log']) assert.ok(seen.has(must), `tidak terjangkau: ${must}`);
});

test('tombol toggle mengubah pengaturan dan siklus link berjalan', async () => {
  const h = setup(); h.chat();
  const press = (data) => handleUpdate({ callback_query: { id: 'q', from: { id: 1 }, data, message: { chat: { id: 1 }, message_id: 1 } } });
  await press('at:-1001:photo'); assert.equal(h.t.chats[0].ar_require_photo, true);
  await press('at:-1001:link'); assert.equal(h.t.chats[0].ar_link_rule, 'deny');
  await press('at:-1001:link'); assert.equal(h.t.chats[0].ar_link_rule, 'require');
  await press('at:-1001:link'); assert.equal(h.t.chats[0].ar_link_rule, 'off');
  await press('at:-1001:match'); assert.equal(h.t.chats[0].ar_match, 'any');
  await press('as:-1001:15'); assert.equal(h.t.chats[0].ar_delay_minutes, 15);
});

test('mengaktifkan ditolak bila hak bot kurang; mematikan memindahkan antrean ke manual', async () => {
  const h = setup(); const c = h.chat({ ar_enabled: false });
  const press = (data) => handleUpdate({ callback_query: { id: 'q', from: { id: 1 }, data, message: { chat: { id: 1 }, message_id: 1 } } });
  h.behavior.me = { status: 'administrator', can_invite_users: false };
  await press('at:-1001:en'); assert.equal(c.ar_enabled, false);
  h.behavior.me = { status: 'administrator', can_invite_users: true };
  await press('at:-1001:en'); assert.equal(c.ar_enabled, true);
  h.t.join_requests.push({ id: 50, chat_id: -1001, user_id: 9, status: 'waiting' });
  await press('at:-1001:en'); assert.equal(c.ar_enabled, false);
  assert.equal(h.t.join_requests[0].status, 'manual');
});

test('input manual: jeda dan teks pesan', async () => {
  const h = setup(); h.chat();
  const press = (data) => handleUpdate({ callback_query: { id: 'q', from: { id: 1 }, data, message: { chat: { id: 1 }, message_id: 1 } } });
  const say = (text) => handleUpdate({ message: { chat: { id: 1, type: 'private' }, from: { id: 1 }, text } });
  await press('ac:-1001');
  await say('abc'); assert.equal(h.t.chats[0].ar_delay_minutes, 0);
  await say('45'); assert.equal(h.t.chats[0].ar_delay_minutes, 45); // tanpa satuan = menit
  await press('ac:-1001'); await say('2 jam'); assert.equal(h.t.chats[0].ar_delay_minutes, 120);
  await press('ac:-1001'); await say('0'); assert.equal(h.t.chats[0].ar_delay_minutes, 0);
  await press('ax:-1001'); await say('Selamat datang {nama}!'); assert.equal(h.t.chats[0].ar_dm_text, 'Selamat datang {nama}!');
  await press('az:-1001'); assert.equal(h.t.chats[0].ar_dm_text, null);
});

/* ---------- Menu per kategori dan diagnostik ---------- */

test('menu utama dikelompokkan per kategori dan semua tombol punya tujuan', async () => {
  const h = setup();
  const home = await ui.homeView();
  const labels = home.keyboard.flat().map((b) => b.text);
  assert.deepEqual(labels, ['Auto Approve Join', 'Penegakan Member', 'Moderasi Manual', 'Pengaturan', 'Bantuan']);
  const mod = ui.moderationView();
  assert.deepEqual(mod.keyboard.flat().map((b) => b.callback_data), ['bm:ask', 'u:ask', 'm:wl', 'm:log', 'm:home']);
  const enf = ui.enforceView();
  assert.deepEqual(enf.keyboard.flat().map((b) => b.callback_data), ['m:chats', 'm:passive', 'm:bandm', 'm:home']);
  assert.ok(h);
});

test('galat saat /start tidak senyap: admin menerima penjelasan', async () => {
  const diag = require('../lib/diagnostics');
  const sent = [];
  const tgm = require('../lib/telegram');
  const orig = tgm.send;
  tgm.send = async (chat, text) => { sent.push({ chat, text }); };
  try {
    const cfg = require('../lib/config');
    const adminId = cfg.ADMIN_IDS[0] || 1;
    if (!cfg.ADMIN_IDS.length) cfg.ADMIN_IDS.push(adminId);
    await diag.reportError(
      { message: { chat: { id: adminId, type: 'private' }, from: { id: adminId } } },
      new Error('DB GET chats 400: column chats.ar_enabled does not exist')
    );
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /schema\.sql/);
    await diag.reportError({ message: { chat: { id: 999, type: 'private' }, from: { id: 999 } } }, new Error('x'));
    assert.equal(sent.length, 1);
  } finally {
    tgm.send = orig;
  }
});
