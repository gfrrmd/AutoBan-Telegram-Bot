const cfg = require('./config');
const { sleep } = require('./util');

class TgError extends Error {
  constructor(method, code, description) {
    super(`${method}: ${description}`);
    this.method = method;
    this.code = code;
    this.description = description || '';
  }
}

async function call(method, params = {}, retry = true) {
  const res = await fetch(`https://api.telegram.org/bot${cfg.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  let data = null;
  try {
    data = await res.json();
  } catch (_) {}
  if (!data || !data.ok) {
    const code = (data && data.error_code) || res.status;
    const wait = data && data.parameters && data.parameters.retry_after;
    if (code === 429 && retry && wait && wait <= 8) {
      await sleep((wait + 1) * 1000);
      return call(method, params, false);
    }
    throw new TgError(method, code, (data && data.description) || 'unknown error');
  }
  return data.result;
}

const send = (chat_id, text, keyboard) =>
  call('sendMessage', {
    chat_id,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  });

async function edit(chat_id, message_id, text, keyboard) {
  try {
    return await call('editMessageText', {
      chat_id,
      message_id,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: keyboard || [] },
    });
  } catch (e) {
    if (String(e.description).includes('message is not modified')) return null;
    throw e;
  }
}

async function downloadFile(file_id) {
  const info = await call('getFile', { file_id });
  const res = await fetch(`https://api.telegram.org/file/bot${cfg.BOT_TOKEN}/${info.file_path}`);
  if (!res.ok) throw new Error('Gagal mengunduh berkas');
  return res.text();
}

module.exports = { call, send, edit, downloadFile, TgError };
