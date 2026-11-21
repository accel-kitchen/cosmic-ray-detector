'use strict';
// 自動保存の書き込み。コンソールから受け取るのはファイル名だけで、置き場所はアプリが決めたフォルダに固定する。
const fs = require('fs');
const path = require('path');

const MAX_NAME = 200;
// Windows で使えない文字と制御文字。区切り文字（/ \）もここで弾く。
const BAD_CHARS = /[<>:"/\\|?*\u0000-\u001f]/;
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

// フォルダの直下のファイル名だけを通す。拡張子は .dat / .csv / .txt / .json に限る。
function checkName(name) {
  if (typeof name !== 'string' || !name || name.length > MAX_NAME) return false;
  if (BAD_CHARS.test(name)) return false;
  if (name.startsWith('.') || name.endsWith('.') || name.endsWith(' ')) return false;
  if (RESERVED.test(name)) return false;
  if (!/\.(dat|csv|txt|json)$/i.test(name)) return false;
  return true;
}

function resolveIn(dir, name) {
  if (!checkName(name)) {
    const e = new Error(`bad file name: ${JSON.stringify(name)}`);
    e.code = 'EBADNAME';
    throw e;
  }
  const full = path.resolve(dir, name);
  if (path.dirname(full) !== path.resolve(dir)) {
    const e = new Error(`outside the save folder: ${name}`);
    e.code = 'EBADNAME';
    throw e;
  }
  return full;
}

async function fileSize(dir, name) {
  const full = resolveIn(dir, name);
  try {
    return (await fs.promises.stat(full)).size;
  } catch (e) {
    if (e.code === 'ENOENT') return -1;
    throw e;
  }
}

// 末尾に追記する。pos はコンソールが見ていたファイルの長さ。食い違っていても
// （外でファイルを触られたなど）データは捨てずに末尾へ足し、戻り値で知らせる。
async function appendFile(dir, name, text, pos) {
  const full = resolveIn(dir, name);
  await fs.promises.mkdir(dir, { recursive: true });
  let before = -1;
  try { before = (await fs.promises.stat(full)).size; } catch (_) {}
  await fs.promises.appendFile(full, String(text), 'utf8');
  return { ok: true, mismatch: pos != null && before >= 0 && pos !== before, before: Math.max(0, before) };
}

module.exports = { checkName, resolveIn, fileSize, appendFile };
