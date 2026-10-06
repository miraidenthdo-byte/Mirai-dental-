// Notionから取り込んだマニュアル（notion-manuals.json）の形をチェックする
// 使い方: node manual-app/data/validate.js
const fs = require('fs');
const path = require('path');
const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'notion-manuals.json'), 'utf8'));
const CATS = ['reception', 'assist', 'hygiene', 'steril', 'emergency', 'open', 'patient', 'material', 'chart', 'rules'];
const STEP_KEYS = ["t", "h", "tip", "warn", "say", "img", "media", "links"];
const errors = [];
const ids = new Set();
data.manuals.forEach((m, i) => {
  const at = `#${i + 1} ${m.title || '(無題)'}`;
  ['id', 'cat', 'title', 'updated', 'source'].forEach(k => { if (!m[k]) errors.push(`${at}: ${k} がありません`); });
  if (ids.has(m.id)) errors.push(`${at}: ID ${m.id} が重複しています`);
  ids.add(m.id);
  if (!CATS.includes(m.cat)) errors.push(`${at}: カテゴリ ${m.cat} はありません`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(m.updated)) errors.push(`${at}: updated の形式が違います`);
  if (!Number.isInteger(m.minutes) || m.minutes < 1) errors.push(`${at}: minutes が不正です`);
  if (!Array.isArray(m.steps) || !m.steps.length) errors.push(`${at}: 手順がありません`);
  (m.steps || []).forEach((s, j) => {
    if (!s.t || !String(s.t).trim()) errors.push(`${at}: ステップ${j + 1} の本文が空です`);
    Object.keys(s).forEach(k => { if (!STEP_KEYS.includes(k)) errors.push(`${at}: ステップ${j + 1} に不明な項目 ${k}`); });
    (s.img || []).forEach(u => { if (!/^https:\/\//.test(u)) errors.push(`${at}: ステップ${j + 1} の画像URLが不正です`); });
    (s.links || []).forEach(l => { if (!l.label || !/^https:\/\//.test(l.url)) errors.push(`${at}: ステップ${j + 1} のリンクが不正です`); });
  });
  const size = JSON.stringify(m).length;
  if (size >= 50000) errors.push(`${at}: ${size}文字（スプレッドシートのセル上限 50,000 を超えます）`);
});
const byCat = {};
data.manuals.forEach(m => { byCat[m.cat] = (byCat[m.cat] || 0) + 1; });
const steps = data.manuals.reduce((a, m) => a + m.steps.length, 0);
const imgs = data.manuals.reduce((a, m) => a + m.steps.reduce((b, s) => b + (s.img || []).length, 0), 0);
const biggest = Math.max(...data.manuals.map(m => JSON.stringify(m).length));
console.log(`マニュアル ${data.manuals.length}件 / 手順 ${steps} / 画像 ${imgs} / 最大 ${biggest}文字`);
console.log('カテゴリ別:', byCat);
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log('OK');
