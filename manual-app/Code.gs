/**
 * 院内マニュアル — Googleスプレッドシート版サーバー
 *
 * index.html をウェブアプリとして配信し、マニュアル・スタッフ・進み具合・ログイン中の端末を
 * スプレッドシートに保存します。index.html 内の体験モード（LocalServer）と同じ動きです。
 *
 * セキュリティの考え方
 * - スタッフは6桁のログインコードでログインし、端末ごとのトークンを受け取ります。
 * - すべての読み書きはトークンを確認してから行います。退職にしたスタッフのトークンは即時に無効です。
 * - ログインコードとトークンは、そのままではなくハッシュ値で保存します。
 * - スタッフには自分の進み具合だけを返し、全員分は管理者にだけ返します。
 */

const SHEET_DEFS = {
  manuals: ['id', 'json', 'updatedAt'],
  staff: ['id', 'name', 'role', 'active', 'retiredAt', 'codeHash'],
  progress: ['staffId', 'manualId', 'json', 'updatedAt'],
  sessions: ['tokenHash', 'staffId', 'device', 'createdAt', 'lastSeen'],
  notion: ['manualId', 'pageId', 'state', 'op', 'title', 'updatedAt', 'message']
};
const ADMIN_ID = '__admin';
const STAFF_IDLE_MS = 120 * 24 * 3600 * 1000; // 120日使わなければ自動でログアウト
const ADMIN_TTL_MS = 12 * 3600 * 1000;        // 管理者ページは12時間で閉じる
const SEEN_WRITE_MS = 3600 * 1000;            // 最終利用日時の書き込みは1時間に1回まで
const FAIL_LIMIT = 20;                        // 10分間にこの回数失敗したらログインを一時停止

function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle(appTitle_())
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

/* ---------- スプレッドシート ---------- */

function props_() {
  return PropertiesService.getScriptProperties();
}

// データ用のスプレッドシート（初回は自動で作成）
// 医院名（管理者ページで設定。未設定なら「院内マニュアル」とだけ表示）
function clinicName_() {
  return props_().getProperty('CLINIC_NAME') || '';
}
function appTitle_() {
  return (clinicName_() ? clinicName_() + ' ' : '') + '院内マニュアル';
}

function book_() {
  const id = props_().getProperty('SHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  const ss = SpreadsheetApp.create(appTitle_() + ' データ');
  props_().setProperty('SHEET_ID', ss.getId());
  return ss;
}

function sheet_(name) {
  const ss = book_();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, SHEET_DEFS[name].length).setValues([SHEET_DEFS[name]]).setFontWeight('bold');
    sh.setFrozenRows(1);
    const first = ss.getSheetByName('シート1') || ss.getSheetByName('Sheet1');
    if (first && ss.getSheets().length > 1) ss.deleteSheet(first);
  }
  return sh;
}

function rows_(name) {
  const sh = sheet_(name);
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, SHEET_DEFS[name].length).getValues();
}

function writeAll_(name, values) {
  const sh = sheet_(name);
  const cols = SHEET_DEFS[name].length;
  const last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, cols).clearContent();
  if (values.length) sh.getRange(2, 1, values.length, cols).setValues(values);
}

// keyCols 列の値が一致する行を置き換え、なければ追加する（prepend: 先頭に追加）
function upsert_(name, keyCols, row, prepend) {
  const sh = sheet_(name);
  const data = rows_(name);
  const idx = data.findIndex(r => keyCols.every(c => String(r[c]) === String(row[c])));
  if (idx >= 0) {
    sh.getRange(idx + 2, 1, 1, row.length).setValues([row]);
  } else if (prepend && data.length) {
    sh.insertRowBefore(2);
    sh.getRange(2, 1, 1, row.length).setValues([row]);
  } else {
    sh.getRange(data.length + 2, 1, 1, row.length).setValues([row]);
  }
}

function removeWhere_(name, test) {
  const data = rows_(name);
  const kept = data.filter(r => !test(r));
  if (kept.length !== data.length) writeAll_(name, kept);
  return data.length - kept.length;
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

const iso_ = () => new Date().toISOString();
const isActive_ = v => v === true || String(v).toUpperCase() === 'TRUE';
// スプレッドシートが日付に変換したセルも、ISO形式の文字列に戻す
const when_ = v => v instanceof Date ? v.toISOString() : String(v || '');

/* ---------- ハッシュ・コード・トークン ---------- */

function secret_() {
  let s = props_().getProperty('SECRET');
  if (!s) {
    s = Utilities.getUuid() + Utilities.getUuid();
    props_().setProperty('SECRET', s);
  }
  return s;
}

function hash_(text) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, secret_() + ':' + text, Utilities.Charset.UTF_8);
  return bytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

function newToken_() {
  return Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
}

function newCode_() {
  const used = {};
  rows_('staff').forEach(r => { if (r[5]) used[r[5]] = true; });
  for (let i = 0; i < 50; i++) {
    const n = parseInt(Utilities.getUuid().replace(/-/g, '').slice(0, 12), 16) % 900000 + 100000;
    const code = String(n);
    if (!used[hash_('code:' + code)]) return code;
  }
  throw new Error('CODE');
}

/* ---------- ログインの確認 ---------- */

function throttle_() {
  const n = Number(CacheService.getScriptCache().get('loginFails') || 0);
  if (n >= FAIL_LIMIT) throw new Error('LIMIT');
}

function fail_() {
  const cache = CacheService.getScriptCache();
  const n = Number(cache.get('loginFails') || 0) + 1;
  cache.put('loginFails', String(n), 600);
}

function openSession_(staffId, device) {
  const token = newToken_();
  const now = iso_();
  sheet_('sessions').appendRow([hash_('token:' + token), staffId, String(device || '').slice(0, 40), now, now]);
  return { token: token };
}

// トークンを確かめ、{ admin: true } または { admin: false, staff } を返す
function resolve_(token) {
  if (!token) throw new Error('AUTH');
  const h = hash_('token:' + token);
  const sessions = rows_('sessions');
  const idx = sessions.findIndex(r => r[0] === h);
  if (idx < 0) throw new Error('AUTH');
  const s = sessions[idx];
  const now = Date.now();
  const drop = () => { withLock_(() => removeWhere_('sessions', r => r[0] === h)); throw new Error('AUTH'); };
  if (s[1] === ADMIN_ID) {
    if (now - new Date(s[3]).getTime() > ADMIN_TTL_MS) drop();
    return { admin: true };
  }
  const st = rows_('staff').find(r => String(r[0]) === String(s[1]) && isActive_(r[3]));
  if (!st || now - new Date(s[4]).getTime() > STAFF_IDLE_MS) drop();
  if (now - new Date(s[4]).getTime() > SEEN_WRITE_MS) sheet_('sessions').getRange(idx + 2, 5).setValue(iso_());
  return { admin: false, staff: { id: String(st[0]), name: String(st[1]), role: String(st[2]) } };
}

function requireAdmin_(token) {
  let r;
  try {
    r = resolve_(token);
  } catch (e) {
    throw new Error('ADMINAUTH');
  }
  if (!r.admin) throw new Error('ADMINAUTH');
}

/* ---------- 暗証番号 ---------- */

const PIN_KEYS = { edit: 'EDIT_PIN', admin: 'ADMIN_PIN' };

function pinOf_(kind) {
  return props_().getProperty(PIN_KEYS[kind]) || '';
}

function pinOk_(kind, pin) {
  const set = pinOf_(kind);
  if (/^\d{4}$/.test(set)) return set === String(pin || ''); // 以前の版で保存した暗証番号
  return !set || set === hash_('pin:' + String(pin || ''));
}

function staffRow_(id) {
  const data = rows_('staff');
  const idx = data.findIndex(r => String(r[0]) === String(id));
  if (idx < 0) throw new Error('STAFF');
  return { idx: idx, row: data[idx] };
}

function setStaffRow_(idx, row) {
  sheet_('staff').getRange(idx + 2, 1, 1, row.length).setValues([row]);
}

function remap_(manualId, map) {
  if (!map) return;
  const data = rows_('progress');
  let changed = false;
  data.forEach(r => {
    if (String(r[1]) !== String(manualId)) return;
    const rec = JSON.parse(r[2]);
    if (!rec.done || !rec.done.length) return;
    const old = {};
    rec.done.forEach(i => { old[i] = true; });
    rec.done = map.map((o, i) => (o >= 0 && old[o]) ? i : -1).filter(i => i >= 0);
    r[2] = JSON.stringify(rec);
    changed = true;
  });
  if (changed) writeAll_('progress', data);
}

/* ---------- 画面から呼ばれる関数（ログイン不要） ---------- */

function status() {
  return { hasAdminPin: !!pinOf_('admin'), initialized: props_().getProperty('INITIALIZED') === '1', clinicName: clinicName_() };
}

// 初回だけ、サンプルのマニュアルを登録する
function initialize(list) {
  return withLock_(() => {
    if (props_().getProperty('INITIALIZED') === '1') return false;
    writeAll_('manuals', list.map(m => [m.id, JSON.stringify(m), iso_()]));
    ['staff', 'progress', 'sessions'].forEach(sheet_);
    props_().setProperty('INITIALIZED', '1');
    return true;
  });
}

function login(code, device) {
  throttle_();
  const h = hash_('code:' + String(code || ''));
  const st = rows_('staff').find(r => isActive_(r[3]) && r[5] && r[5] === h);
  if (!st) { fail_(); throw new Error('LOGIN'); }
  return withLock_(() => openSession_(String(st[0]), device));
}

function adminLogin(pin, device) {
  throttle_();
  if (!pinOf_('admin')) throw new Error('NOADMIN');
  if (!pinOk_('admin', pin)) { fail_(); throw new Error('PIN'); }
  return withLock_(() => openSession_(ADMIN_ID, device));
}

// 管理者の暗証番号がまだないときだけ使える
function adminSetup(pin, device) {
  return withLock_(() => {
    if (pinOf_('admin')) throw new Error('PIN');
    if (!/^\d{4}$/.test(String(pin))) throw new Error('FORMAT');
    props_().setProperty(PIN_KEYS.admin, hash_('pin:' + String(pin)));
    return openSession_(ADMIN_ID, device);
  });
}

function logout(token) {
  if (!token) return true;
  const h = hash_('token:' + token);
  return withLock_(() => { removeWhere_('sessions', r => r[0] === h); return true; });
}

/* ---------- ログインしたスタッフ・管理者 ---------- */

function ping(token) {
  resolve_(token);
  return true;
}

function getAll(token) {
  const r = resolve_(token);
  const progress = {};
  rows_('progress').forEach(p => {
    if (!r.admin && String(p[0]) !== r.staff.id) return;
    (progress[p[0]] = progress[p[0]] || {})[p[1]] = JSON.parse(p[2]);
  });
  if (!r.admin && !progress[r.staff.id]) progress[r.staff.id] = {};
  return {
    role: r.admin ? 'admin' : 'staff',
    me: r.admin ? null : r.staff,
    manuals: rows_('manuals').map(m => JSON.parse(m[1])),
    progress: progress,
    hasEditPin: !!pinOf_('edit'),
    hasAdminPin: !!pinOf_('admin'),
    initialized: props_().getProperty('INITIALIZED') === '1',
    clinicName: clinicName_()
  };
}

function verifyPin(token, kind, pin) {
  resolve_(token);
  return pinOk_(kind, pin);
}

function saveManual(token, m, map, editPin) {
  const who = resolve_(token);
  if (!who.admin && !pinOk_('edit', editPin)) throw new Error('PIN');
  const isNew = withLock_(() => {
    const existed = rows_('manuals').some(r => String(r[0]) === String(m.id));
    upsert_('manuals', [0], [m.id, JSON.stringify(m), iso_()], true);
    remap_(m.id, map);
    return !existed;
  });
  notifyManual_(isNew ? '追加' : '更新', m, who);
  return notionQueue_(m.id, 'save', m.title) ? 'notion' : true;
}

function deleteManual(token, id, editPin) {
  const who = resolve_(token);
  if (!who.admin && !pinOk_('edit', editPin)) throw new Error('PIN');
  const m = withLock_(() => {
    const row = rows_('manuals').find(r => String(r[0]) === String(id));
    removeWhere_('manuals', r => String(r[0]) === String(id));
    removeWhere_('progress', r => String(r[1]) === String(id));
    try { return row ? JSON.parse(row[1]) : null; } catch (e) { return null; }
  });
  if (m) notifyManual_('削除', m, who);
  return m && notionQueue_(id, 'delete', m.title, m.source) ? 'notion' : true;
}

// 記録先のスタッフはトークンから決める（ほかの人の記録は書き換えられない）
function saveProgress(token, manualId, rec) {
  const r = resolve_(token);
  if (r.admin) throw new Error('STAFF');
  return withLock_(() => {
    upsert_('progress', [0, 1], [r.staff.id, manualId, JSON.stringify(rec), iso_()]);
    return true;
  });
}

/* ---------- 管理者だけ ---------- */

function adminData(token) {
  requireAdmin_(token);
  const sessions = rows_('sessions');
  const progress = {};
  rows_('progress').forEach(p => { (progress[p[0]] = progress[p[0]] || {})[p[1]] = JSON.parse(p[2]); });
  return {
    staff: rows_('staff').map(r => ({
      id: String(r[0]), name: String(r[1]), role: String(r[2]), active: isActive_(r[3]),
      retiredAt: when_(r[4]),
      sessions: sessions.filter(x => String(x[1]) === String(r[0])).map(x => ({ device: String(x[2]), lastSeen: when_(x[4]) }))
    })),
    progress: progress,
    slack: slackReady_(),
    notion: notionInfo_()
  };
}

function addStaff(token, name, role) {
  requireAdmin_(token);
  name = String(name || '').trim();
  if (!name) throw new Error('FORMAT');
  return withLock_(() => {
    const code = newCode_();
    const id = 's' + Utilities.getUuid().replace(/-/g, '').slice(0, 10);
    sheet_('staff').appendRow([id, name, String(role || '').trim(), true, '', hash_('code:' + code)]);
    return { id: id, code: code };
  });
}

function updateStaff(token, id, name, role) {
  requireAdmin_(token);
  name = String(name || '').trim();
  if (!name) throw new Error('FORMAT');
  return withLock_(() => {
    const s = staffRow_(id);
    s.row[1] = name;
    s.row[2] = String(role || '').trim();
    setStaffRow_(s.idx, s.row);
    return true;
  });
}

// 退職：ログインコードを無効にし、ログイン中の端末をすべてログアウト（記録は残す）
function retireStaff(token, id) {
  requireAdmin_(token);
  return withLock_(() => {
    const s = staffRow_(id);
    s.row[3] = false;
    s.row[4] = iso_();
    s.row[5] = '';
    setStaffRow_(s.idx, s.row);
    const closed = removeWhere_('sessions', r => String(r[1]) === String(id));
    return { closed: closed };
  });
}

function reinstateStaff(token, id) {
  requireAdmin_(token);
  return withLock_(() => {
    const s = staffRow_(id);
    const code = newCode_();
    s.row[3] = true;
    s.row[4] = '';
    s.row[5] = hash_('code:' + code);
    setStaffRow_(s.idx, s.row);
    return { code: code };
  });
}

function reissueCode(token, id) {
  requireAdmin_(token);
  return withLock_(() => {
    const s = staffRow_(id);
    if (!isActive_(s.row[3])) throw new Error('STAFF');
    const code = newCode_();
    s.row[5] = hash_('code:' + code);
    setStaffRow_(s.idx, s.row);
    removeWhere_('sessions', r => String(r[1]) === String(id));
    return { code: code };
  });
}

function logoutStaff(token, id) {
  requireAdmin_(token);
  return withLock_(() => { removeWhere_('sessions', r => String(r[1]) === String(id)); return true; });
}

function deleteStaff(token, id) {
  requireAdmin_(token);
  return withLock_(() => {
    removeWhere_('staff', r => String(r[0]) === String(id));
    removeWhere_('progress', r => String(r[0]) === String(id));
    removeWhere_('sessions', r => String(r[1]) === String(id));
    return true;
  });
}

// 全員の端末をログアウト（管理者のログインは残す）
function revokeAll(token) {
  requireAdmin_(token);
  return withLock_(() => { removeWhere_('sessions', r => r[1] !== ADMIN_ID); return true; });
}

function setClinicName(token, name) {
  requireAdmin_(token);
  name = String(name || '').replace(/\s+/g, ' ').trim();
  if (name.length > 20) throw new Error('FORMAT');
  if (name) props_().setProperty('CLINIC_NAME', name); else props_().deleteProperty('CLINIC_NAME');
  return name;
}

function setPin(token, kind, next) {
  requireAdmin_(token);
  if (!PIN_KEYS[kind]) throw new Error('KIND');
  if (next && !/^\d{4}$/.test(String(next))) throw new Error('FORMAT');
  return withLock_(() => {
    if (kind === 'admin') {
      if (!next) throw new Error('FORMAT');
      // 管理者の暗証番号を変えたら、この端末以外の管理者ページを閉じる
      const mine = hash_('token:' + token);
      removeWhere_('sessions', r => r[1] === ADMIN_ID && r[0] !== mine);
    }
    if (next) props_().setProperty(PIN_KEYS[kind], hash_('pin:' + String(next)));
    else props_().deleteProperty(PIN_KEYS[kind]);
    return true;
  });
}

function replaceManuals(token, list) {
  requireAdmin_(token);
  return withLock_(() => {
    writeAll_('manuals', list.map(m => [m.id, JSON.stringify(m), iso_()]));
    const ids = {};
    list.forEach(m => { ids[m.id] = true; });
    removeWhere_('progress', r => !ids[r[1]]);
    return true;
  });
}

/* ---------- 画像・動画（Googleドライブの非公開フォルダに保存） ---------- */

const MEDIA_TYPES = /^(image\/(jpeg|png|gif|webp|heic|heif)|video\/(mp4|quicktime|webm|3gpp))$/;
const MEDIA_MAX_BYTES = 25 * 1024 * 1024;

// 保存用フォルダ（初回は自動で作成。共有はしないので、設置した人だけが Drive で見られる）
function mediaFolder_() {
  const id = props_().getProperty('MEDIA_FOLDER_ID');
  if (id) return DriveApp.getFolderById(id);
  const folder = DriveApp.createFolder(appTitle_() + ' 画像・動画');
  props_().setProperty('MEDIA_FOLDER_ID', folder.getId());
  return folder;
}

function uploadMedia(token, editPin, name, mime, base64) {
  if (!resolve_(token).admin && !pinOk_('edit', editPin)) throw new Error('PIN');
  if (!MEDIA_TYPES.test(String(mime))) throw new Error('TYPE');
  const bytes = Utilities.base64Decode(String(base64 || ''));
  if (!bytes.length) throw new Error('TYPE');
  if (bytes.length > MEDIA_MAX_BYTES) throw new Error('VIDEOSIZE');
  const blob = Utilities.newBlob(bytes, mime, String(name || 'file').slice(0, 80));
  const file = mediaFolder_().createFile(blob);
  return { id: file.getId(), size: bytes.length };
}

// ログイン中の人だけ、保存フォルダの中のファイルを少しずつ受け取れる
function getMediaChunk(token, id, offset, length) {
  resolve_(token);
  const file = DriveApp.getFileById(String(id));
  const parents = file.getParents();
  const folderId = props_().getProperty('MEDIA_FOLDER_ID');
  let inFolder = false;
  while (parents.hasNext()) { if (parents.next().getId() === folderId) inFolder = true; }
  if (!inFolder) throw new Error('NOTFOUND');
  const bytes = file.getBlob().getBytes();
  const start = Math.max(0, Number(offset) || 0);
  const end = Math.min(bytes.length, start + Math.min(Number(length) || 0, 8 * 1024 * 1024));
  return { size: bytes.length, mime: file.getMimeType(), data: Utilities.base64Encode(bytes.slice(start, end)) };
}

/* ---------- Slack通知 ---------- */
// Slack の「Incoming Webhook」のURLへ送る。URLは管理者ページの「Slack通知」で登録する（スクリプトのプロパティに保存し、画面には返さない）。

const CAT_NAMES = {
  reception: '受付・会計', assist: '診療補助', hygiene: '衛生士業務', steril: '滅菌・消毒', emergency: '緊急時対応',
  open: '開院・閉院', patient: '患者さま対応', material: '器具・材料', chart: 'カルテ・用語', rules: '院内ルール・申請'
};
const SLACK_URL_RE = /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_\/-]+$/;

function slackReady_() {
  return !!props_().getProperty('SLACK_URL');
}

const slackEsc_ = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function sendSlack_(text) {
  const url = props_().getProperty('SLACK_URL');
  if (!url) throw new Error('SLACK_UNSET');
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ text: String(text).slice(0, 3900) }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) throw new Error('SLACK_' + res.getResponseCode() + ' ' + String(res.getContentText()).slice(0, 60));
}

// 通知に失敗しても、マニュアルの保存は取り消さない
function notifyManual_(kind, m, who) {
  if (!slackReady_()) return;
  try {
    const icon = { 追加: ':new:', 更新: ':memo:', 削除: ':wastebasket:' }[kind] || ':memo:';
    const name = who.admin ? '管理者' : who.staff.name + 'さん';
    const url = ScriptApp.getService().getUrl();
    sendSlack_([
      icon + ' マニュアルが' + kind + 'されました',
      '*「' + slackEsc_(m.title || '（無題）') + '」*（' + (CAT_NAMES[m.cat] || 'その他') + '）',
      kind + 'した人：' + slackEsc_(name) + '　' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'M月d日 HH:mm'),
      kind !== '削除' && url ? '<' + url + '?m=' + encodeURIComponent(m.id) + '|アプリで開く>' : ''
    ].filter(Boolean).join('\n'));
  } catch (e) {
    console.warn('Slack通知に失敗しました: ' + e.message);
  }
}

// 空のまま保存すると通知を止める
function setSlack(token, url) {
  requireAdmin_(token);
  url = String(url || '').trim();
  if (!url) { props_().deleteProperty('SLACK_URL'); return false; }
  if (!SLACK_URL_RE.test(url)) throw new Error('FORMAT');
  props_().setProperty('SLACK_URL', url);
  return true;
}

function testSlack(token) {
  requireAdmin_(token);
  sendSlack_(':cherry_blossom: *' + slackEsc_(appTitle_()) + '*\nSlack通知のテストです。マニュアルが追加・更新・削除されると、ここにお知らせが届きます。');
  return true;
}

// 初回だけ、エディタでこの関数を選んで「実行」し、外部への送信（Slack・Notion）を許可する
function authorize() {
  UrlFetchApp.fetch('https://slack.com', { muteHttpExceptions: true });
  UrlFetchApp.fetch('https://api.notion.com', { muteHttpExceptions: true });
  return 'OK';
}

/* ---------- Notion連携 ---------- */
// アプリで保存・削除したマニュアルを Notion のページにも反映する（アプリ → Notion の一方通行）。
// 鍵（インテグレーションのシークレット）は管理者ページの「Notion連携」で登録し、スクリプトのプロパティに保存する（画面には返さない）。
// 反映は保存のあとに画面から notionFlush を呼んで行う（保存そのものは待たせない）。失敗したものは「未反映」として残し、あとでやり直せる。

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
const NOTION_KEY_RE = /^(ntn_|secret_)[A-Za-z0-9]{20,}$/;
const NOTION_CHECK_TTL_MS = 3600 * 1000;   // 確認してから1時間以内なら連携を始められる
const NOTION_BUDGET_MS = 270 * 1000;       // 1回の反映にかける時間（Apps Scriptの上限6分より短く）
const NOTION_CONFIRMS = 5;                 // 連携前に管理者が確認する項目の数（画面と合わせる）

function notionKey_() { return props_().getProperty('NOTION_KEY') || ''; }
function notionOn_() { return props_().getProperty('NOTION_ON') === '1' && !!notionKey_(); }

// NotionのURL・ID からページIDを取り出す（見つからなければ空文字）
function notionId_(x) {
  const t = String(x || '').trim().split(/[?#]/)[0].replace(/-/g, '');
  const m = t.match(/([0-9a-f]{32})$/i);
  return m ? m[1].toLowerCase() : '';
}

function notionCall_(method, path, body) {
  const key = notionKey_();
  if (!key) throw new Error('NOTION_UNSET');
  for (let attempt = 0; ; attempt++) {
    const o = {
      method: method,
      headers: { Authorization: 'Bearer ' + key, 'Notion-Version': NOTION_VERSION },
      contentType: 'application/json',
      muteHttpExceptions: true
    };
    if (body) o.payload = JSON.stringify(body);
    const res = UrlFetchApp.fetch(NOTION_API + path, o);
    const code = res.getResponseCode();
    let json = {};
    try { json = JSON.parse(res.getContentText() || '{}'); } catch (e) { json = {}; }
    Utilities.sleep(340); // Notion の上限（1秒に3回まで）を守る
    if ((code === 429 || code >= 500) && attempt < 3) {
      Utilities.sleep(1500 * (attempt + 1));
      continue;
    }
    if (code >= 200 && code < 300) return json;
    const err = new Error('NOTION_' + code + ' ' + (json.code || '') + ' ' + String(json.message || '').slice(0, 120));
    err.status = code;
    throw err;
  }
}

// 文字を Notion の rich_text に（1つ2000文字までなので分ける）
function notionText_(text, opt) {
  const s = String(text == null ? '' : text);
  const out = [];
  for (let i = 0; i < s.length; i += 1900) {
    const part = { type: 'text', text: { content: s.slice(i, i + 1900) } };
    if (opt && opt.link) part.text.link = { url: opt.link };
    if (opt && (opt.bold || opt.color)) part.annotations = { bold: !!opt.bold, color: (opt && opt.color) || 'default' };
    out.push(part);
  }
  return out;
}
const notionUrlOk_ = u => /^https?:\/\/[^\s]+$/.test(String(u || '')) && String(u).length < 1900;
const nBlock_ = (type, rich, extra) => {
  const b = { object: 'block', type: type };
  b[type] = Object.assign({ rich_text: rich }, extra || {});
  return b;
};

// マニュアル1件を Notion のブロックの並びにする
function notionBlocks_(m) {
  const app = ScriptApp.getService().getUrl() || '';
  const link = app ? app + '?m=' + encodeURIComponent(m.id) : '';
  const blocks = [];
  const head = notionText_('このページは院内マニュアルアプリから自動で反映しています。直すときはアプリで編集してください（Notionで直した内容は、次にアプリで保存したときに上書きされます）。');
  if (link) head.push.apply(head, notionText_('　アプリで開く', { link: link }));
  blocks.push(nBlock_('callout', head, { icon: { type: 'emoji', emoji: 'ℹ️' }, color: 'gray_background' }));
  if (m.summary) blocks.push(nBlock_('paragraph', notionText_(m.summary)));
  const meta = ['カテゴリ：' + (CAT_NAMES[m.cat] || 'その他')];
  if (m.minutes) meta.push('目安：' + m.minutes + '分');
  if ((m.tags || []).length) meta.push('タグ：' + m.tags.join('、'));
  meta.push('最終反映：' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm'));
  blocks.push(nBlock_('paragraph', notionText_(meta.join('　／　'), { color: 'gray' })));
  blocks.push({ object: 'block', type: 'divider', divider: {} });
  (m.steps || []).forEach((st, i) => {
    if (st.h) blocks.push(nBlock_('heading_3', notionText_(st.h)));
    const line = notionText_('手順' + (i + 1) + '　', { bold: true });
    if (st.t) line.push.apply(line, notionText_(st.t));
    blocks.push(nBlock_('paragraph', line));
    if (st.say) blocks.push(nBlock_('quote', notionText_('💬 声かけ例：' + st.say)));
    if (st.tip) blocks.push(nBlock_('callout', notionText_(st.tip), { icon: { type: 'emoji', emoji: '💡' }, color: 'yellow_background' }));
    if (st.warn) blocks.push(nBlock_('callout', notionText_(st.warn), { icon: { type: 'emoji', emoji: '⚠️' }, color: 'red_background' }));
    (st.img || []).filter(notionUrlOk_).forEach(u => blocks.push({ object: 'block', type: 'image', image: { type: 'external', external: { url: u } } }));
    const media = (st.media || []).filter(x => x && !x.pending).length;
    if (media) {
      const r = notionText_('📷 アプリで追加した画像・動画が' + media + '件あります（アプリで見られます）');
      if (link) r.push.apply(r, notionText_('　開く', { link: link }));
      blocks.push(nBlock_('paragraph', r));
    }
    (st.links || []).filter(x => x && notionUrlOk_(x.url)).forEach(x => blocks.push(nBlock_('bulleted_list_item', notionText_(x.label || x.url, { link: x.url }))));
  });
  return blocks;
}

function notionAppend_(pageId, blocks) {
  for (let i = 0; i < blocks.length; i += 100) notionCall_('patch', '/blocks/' + pageId + '/children', { children: blocks.slice(i, i + 100) });
}

// 追加先（ページまたはデータベース）を調べる
function notionParent_(id) {
  try {
    const p = notionCall_('get', '/pages/' + id);
    return { type: 'page', id: id, title: notionTitleOf_(p) };
  } catch (e) {
    if (e.status !== 404 && e.status !== 400) throw e;
  }
  const db = notionCall_('get', '/databases/' + id);
  const key = Object.keys(db.properties || {}).find(k => db.properties[k].type === 'title') || 'Name';
  return { type: 'database', id: id, titleKey: key, title: (db.title || []).map(t => t.plain_text).join('') };
}
function notionTitleKey_(page) {
  return Object.keys(page.properties || {}).find(k => page.properties[k].type === 'title') || 'title';
}
function notionTitleOf_(page) {
  const p = (page.properties || {})[notionTitleKey_(page)];
  return p && p.title ? p.title.map(t => t.plain_text).join('') : '';
}

function notionCreate_(m) {
  const pid = props_().getProperty('NOTION_PARENT');
  if (!pid) throw new Error('NOTION_NOPARENT');
  const par = notionParent_(pid);
  const blocks = notionBlocks_(m);
  const body = {
    parent: par.type === 'database' ? { database_id: pid } : { page_id: pid },
    properties: {},
    children: blocks.slice(0, 100)
  };
  body.properties[par.type === 'database' ? par.titleKey : 'title'] = { title: notionText_(m.title || '（無題）') };
  const page = notionCall_('post', '/pages', body);
  const id = notionId_(page.id);
  notionAppend_(id, blocks.slice(100));
  return id;
}

// 既存のページの中身を入れ替える（ページの中のサブページ・データベースは消さずに残す）
function notionReplace_(pageId, m) {
  const page = notionCall_('get', '/pages/' + pageId);
  if (page.archived || page.in_trash) return false;
  const key = notionTitleKey_(page);
  if (m.title && notionTitleOf_(page) !== m.title) {
    const props = {};
    props[key] = { title: notionText_(m.title) };
    notionCall_('patch', '/pages/' + pageId, { properties: props });
  }
  let cursor = null;
  const old = [];
  do {
    const r = notionCall_('get', '/blocks/' + pageId + '/children?page_size=100' + (cursor ? '&start_cursor=' + cursor : ''));
    (r.results || []).forEach(b => { if (b.type !== 'child_page' && b.type !== 'child_database') old.push(b.id); });
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);
  old.forEach(id => notionCall_('delete', '/blocks/' + id));
  notionAppend_(pageId, notionBlocks_(m));
  return true;
}

// 保存・削除のたびに「未反映」として記録する（連携がオフなら何もしない）
function notionQueue_(manualId, op, title, source) {
  if (!notionOn_()) return false;
  withLock_(() => {
    const row = rows_('notion').find(r => String(r[0]) === String(manualId));
    const pageId = (row && row[1]) || (op === 'delete' ? notionId_(source) : '');
    upsert_('notion', [0], [manualId, pageId, 'pending', op, String(title || '').slice(0, 100), iso_(), ''], false);
  });
  return true;
}

function notionDo_(row) {
  const id = String(row[0]);
  let pageId = String(row[1] || '');
  if (row[3] === 'delete') {
    if (pageId) {
      try { notionCall_('patch', '/pages/' + pageId, { archived: true }); } catch (e) { if (e.status !== 404) throw e; }
    }
    return pageId;
  }
  const mr = rows_('manuals').find(r => String(r[0]) === id);
  if (!mr) return pageId; // 反映する前に削除された
  const m = JSON.parse(mr[1]);
  if (!pageId) pageId = notionId_(m.source);
  if (pageId) {
    try {
      if (notionReplace_(pageId, m)) return pageId;
    } catch (e) {
      if (e.status === 404) throw new Error('NOTION_404 元のページを開けません（連携がつながっていないか、削除されています）');
      throw e;
    }
  }
  return notionCreate_(m); // 元のページが無い・ゴミ箱にある → 追加先に新しく作る
}

// 未反映のものを順に Notion に送る。ログイン中ならだれでも呼べる（中身はサーバーのデータから作る）
function notionFlush(token) {
  resolve_(token);
  if (!notionOn_()) return { done: 0, left: 0, errors: 0 };
  const cache = CacheService.getScriptCache();
  if (cache.get('notionBusy')) return { busy: true };
  cache.put('notionBusy', '1', 330);
  const start = Date.now();
  let done = 0, errors = 0;
  try {
    rows_('notion').filter(r => r[2] === 'pending').some(r => {
      if (Date.now() - start > NOTION_BUDGET_MS) return true;
      const stamp = when_(r[5]);
      let state = 'ok', msg = '', pageId = String(r[1] || '');
      try { pageId = notionDo_(r) || pageId; done++; } catch (e) { state = 'error'; msg = String(e.message).slice(0, 200); errors++; }
      withLock_(() => {
        const now = rows_('notion').find(x => String(x[0]) === String(r[0]));
        // 反映中にもう一度保存された場合は、未反映のまま残して次に送る
        const again = now && when_(now[5]) !== stamp;
        upsert_('notion', [0], [r[0], pageId, again ? 'pending' : (state === 'ok' && r[3] === 'delete' ? 'deleted' : state), now ? now[3] : r[3], now ? now[4] : r[4], again ? when_(now[5]) : iso_(), msg], false);
      });
      return false;
    });
  } finally {
    cache.put('notionBusy', '', 1);
  }
  const left = rows_('notion').filter(r => r[2] === 'pending').length;
  return { done: done, left: left, errors: errors };
}

function notionInfo_() {
  const p = props_();
  const rows = notionKey_() || p.getProperty('NOTION_ON') ? rows_('notion') : [];
  const pid = p.getProperty('NOTION_PARENT') || '';
  return {
    key: !!notionKey_(),
    parent: pid ? 'https://www.notion.so/' + pid : '',
    parentTitle: p.getProperty('NOTION_PARENT_TITLE') || '',
    on: notionOn_(),
    checkedAt: p.getProperty('NOTION_CHECK_OK') ? new Date(Number(p.getProperty('NOTION_CHECK_OK'))).toISOString() : '',
    pending: rows.filter(r => r[2] === 'pending').length,
    errors: rows.filter(r => r[2] === 'error').map(r => ({ title: String(r[4]), message: String(r[6]), at: when_(r[5]) })).slice(0, 10),
    recent: rows.filter(r => r[2] === 'ok' || r[2] === 'deleted')
      .sort((a, b) => when_(b[5]).localeCompare(when_(a[5]))).slice(0, 5)
      .map(r => ({ title: String(r[4]), state: String(r[2]), at: when_(r[5]), url: r[1] ? 'https://www.notion.so/' + r[1] : '' }))
  };
}

// 鍵と追加先を登録する（変えると、連携はいったん止まり、確認からやり直す）
function setNotion(token, key, parent) {
  requireAdmin_(token);
  key = String(key || '').trim();
  parent = String(parent || '').trim();
  const p = props_();
  if (key && !NOTION_KEY_RE.test(key)) throw new Error('FORMAT_KEY');
  if (!key && !notionKey_()) throw new Error('FORMAT_KEY');
  const pid = notionId_(parent);
  if (!pid) throw new Error('FORMAT_PARENT');
  if (key) p.setProperty('NOTION_KEY', key);
  p.setProperty('NOTION_PARENT', pid);
  ['NOTION_ON', 'NOTION_CHECK_OK', 'NOTION_PARENT_TITLE'].forEach(k => p.deleteProperty(k));
  return notionInfo_();
}

// 連携前の確認：鍵・追加先・書き込み・元のページを開けるか、を実際に Notion に問い合わせて確かめる
function notionCheck(token) {
  requireAdmin_(token);
  const p = props_();
  p.deleteProperty('NOTION_CHECK_OK');
  const checks = [];
  const add = (id, label, ok, detail) => { checks.push({ id: id, label: label, ok: ok, detail: detail }); return ok; };
  const why = e => {
    const s = e.status;
    return s === 401 ? '鍵が正しくありません（コピーし直して登録してください）'
      : s === 404 ? '連携がつながっていません'
      : s === 403 ? '権限が足りません（インテグレーションの「機能」で、コンテンツの読み取り・更新・挿入をオンにしてください）'
      : String(e.message).slice(0, 120);
  };
  let ok = true;
  try {
    const me = notionCall_('get', '/users/me');
    add('key', '鍵が使えるか', true, (me.name || 'インテグレーション') + (me.bot && me.bot.workspace_name ? '（' + me.bot.workspace_name + '）' : ''));
  } catch (e) {
    add('key', '鍵が使えるか', false, why(e));
    return { checks: checks, ready: false };
  }
  let par = null;
  try {
    par = notionParent_(p.getProperty('NOTION_PARENT'));
    p.setProperty('NOTION_PARENT_TITLE', par.title || '');
    add('parent', '新しいマニュアルの追加先を開けるか', true, '「' + (par.title || '無題') + '」' + (par.type === 'database' ? '（データベース）' : ''));
  } catch (e) {
    ok = add('parent', '新しいマニュアルの追加先を開けるか', false, why(e) + '。追加先のページ右上の「…」→「接続」で、作ったインテグレーションを追加してください') && ok;
  }
  if (par) {
    try {
      const body = { parent: par.type === 'database' ? { database_id: par.id } : { page_id: par.id }, properties: {} };
      body.properties[par.type === 'database' ? par.titleKey : 'title'] = { title: notionText_('連携テスト（自動で削除されます）') };
      const t = notionCall_('post', '/pages', body);
      notionCall_('patch', '/pages/' + notionId_(t.id), { archived: true });
      add('write', '追加先に書き込めるか', true, 'テスト用のページを作って、ゴミ箱に移しました');
    } catch (e) {
      ok = add('write', '追加先に書き込めるか', false, why(e)) && ok;
    }
  } else ok = false;
  const manuals = rows_('manuals').map(r => JSON.parse(r[1]));
  const src = {};
  manuals.forEach(m => { const id = notionId_(m.source); if (id) src[id] = m.title; });
  const ids = Object.keys(src);
  const ng = [];
  const start = Date.now();
  let seen = 0;
  ids.some(id => {
    if (Date.now() - start > 200 * 1000) return true;
    seen++;
    try { notionCall_('get', '/pages/' + id); } catch (e) { ng.push(src[id] + (e.status === 404 ? '' : '（' + why(e) + '）')); }
    return false;
  });
  if (seen < ids.length) ng.push('ほか' + (ids.length - seen) + '件は時間切れで確かめられませんでした（もう一度確認してください）');
  ok = add('source', 'Notionから取り込んだページ（' + ids.length + '件）を開けるか', !ng.length,
    ng.length ? '開けないページ：' + ng.slice(0, 8).join('、') + (ng.length > 8 ? ' ほか' + (ng.length - 8) + '件' : '') + '。院内Wiki の「マニュアルDB」と「アシスト業務」のページで「…」→「接続」から追加してください（中のページにも自動でつながります）'
      : 'すべて開けました') && ok;
  const stats = { total: manuals.length, linked: manuals.filter(m => notionId_(m.source)).length };
  stats.fresh = stats.total - stats.linked;
  if (ok) p.setProperty('NOTION_CHECK_OK', String(Date.now()));
  return { checks: checks, ready: ok, stats: stats };
}

// 確認がすべて済んでいれば連携を始める
function notionStart(token, confirmed) {
  requireAdmin_(token);
  const at = Number(props_().getProperty('NOTION_CHECK_OK') || 0);
  if (!at || Date.now() - at > NOTION_CHECK_TTL_MS) throw new Error('NOTION_CHECK');
  if (!Array.isArray(confirmed) || confirmed.filter(Boolean).length < NOTION_CONFIRMS) throw new Error('NOTION_CONFIRM');
  props_().setProperty('NOTION_ON', '1');
  return notionInfo_();
}

// 連携を止める（鍵を消すときは forget を true に）
function notionStop(token, forget) {
  requireAdmin_(token);
  const p = props_();
  p.deleteProperty('NOTION_ON');
  if (forget) ['NOTION_KEY', 'NOTION_PARENT', 'NOTION_PARENT_TITLE', 'NOTION_CHECK_OK'].forEach(k => p.deleteProperty(k));
  return notionInfo_();
}

// 反映できなかったものを、もう一度「未反映」に戻して送る
function notionRetry(token) {
  requireAdmin_(token);
  withLock_(() => {
    const data = rows_('notion');
    let changed = false;
    data.forEach(r => { if (r[2] === 'error') { r[2] = 'pending'; r[6] = ''; changed = true; } });
    if (changed) writeAll_('notion', data);
  });
  return notionFlush(token);
}
