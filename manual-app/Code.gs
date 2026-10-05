/**
 * みらい歯科 院内マニュアル — Googleスプレッドシート版サーバー
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
  sessions: ['tokenHash', 'staffId', 'device', 'createdAt', 'lastSeen']
};
const ADMIN_ID = '__admin';
const STAFF_IDLE_MS = 120 * 24 * 3600 * 1000; // 120日使わなければ自動でログアウト
const ADMIN_TTL_MS = 12 * 3600 * 1000;        // 管理者ページは12時間で閉じる
const SEEN_WRITE_MS = 3600 * 1000;            // 最終利用日時の書き込みは1時間に1回まで
const FAIL_LIMIT = 20;                        // 10分間にこの回数失敗したらログインを一時停止

function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('みらい歯科 院内マニュアル')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

/* ---------- スプレッドシート ---------- */

function props_() {
  return PropertiesService.getScriptProperties();
}

// データ用のスプレッドシート（初回は自動で作成）
function book_() {
  const id = props_().getProperty('SHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  const ss = SpreadsheetApp.create('みらい歯科 院内マニュアル データ');
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
  return { hasAdminPin: !!pinOf_('admin'), initialized: props_().getProperty('INITIALIZED') === '1' };
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
    initialized: props_().getProperty('INITIALIZED') === '1'
  };
}

function verifyPin(token, kind, pin) {
  resolve_(token);
  return pinOk_(kind, pin);
}

function saveManual(token, m, map, editPin) {
  if (!resolve_(token).admin && !pinOk_('edit', editPin)) throw new Error('PIN');
  return withLock_(() => {
    upsert_('manuals', [0], [m.id, JSON.stringify(m), iso_()], true);
    remap_(m.id, map);
    return true;
  });
}

function deleteManual(token, id, editPin) {
  if (!resolve_(token).admin && !pinOk_('edit', editPin)) throw new Error('PIN');
  return withLock_(() => {
    removeWhere_('manuals', r => String(r[0]) === String(id));
    removeWhere_('progress', r => String(r[1]) === String(id));
    return true;
  });
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
    progress: progress
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
