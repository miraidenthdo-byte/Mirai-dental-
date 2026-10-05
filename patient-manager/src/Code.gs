/**
 * 自費患者管理アプリ（インプラント・矯正・自費補綴）
 *
 * データは Google スプレッドシートに保存する。
 *   患者     : 患者の基本情報
 *   治療     : 患者ごとの治療ケース（1人の患者が複数の治療を持てる）
 *   入金     : 治療ケースごとの入金記録
 *
 * 初回のみ GAS エディタで setup() を実行すること。
 */

const SHEETS = {
  patients: {
    name: '患者',
    fields: ['id', 'chartNo', 'name', 'kana', 'birthDate', 'gender', 'phone', 'email',
      'address', 'memo', 'createdAt', 'updatedAt', 'updatedBy'],
    headers: ['ID', 'カルテ番号', '氏名', 'フリガナ', '生年月日', '性別', '電話番号', 'メール',
      '住所', 'メモ', '作成日時', '更新日時', '更新者'],
  },
  cases: {
    name: '治療',
    fields: ['id', 'patientId', 'category', 'status', 'title', 'sites', 'doctor',
      'consultDate', 'startDate', 'plannedEndDate', 'completedDate', 'lastVisit', 'nextVisit',
      'warrantyUntil', 'fee', 'paymentMethod',
      'implantSystem', 'implantCount', 'surgery1Date', 'surgery2Date', 'prosthesisDate',
      'orthoAppliance', 'retentionStartDate', 'adjustFee',
      'prosthType', 'material', 'setDate',
      'memo', 'createdAt', 'updatedAt', 'updatedBy'],
    headers: ['ID', '患者ID', '区分', 'ステータス', '治療名', '部位', '担当医',
      '初診相談日', '治療開始日', '完了予定日', '完了日', '最終来院日', '次回予約日',
      '保証期限', '契約金額', '支払方法',
      'インプラントシステム', '埋入本数', '一次手術日', '二次手術日', '上部構造装着日',
      '矯正装置', '保定開始日', '調整料(1回)',
      '補綴物種類', '材料', 'セット日',
      'メモ', '作成日時', '更新日時', '更新者'],
  },
  payments: {
    name: '入金',
    fields: ['id', 'caseId', 'patientId', 'date', 'amount', 'method', 'memo',
      'createdAt', 'updatedAt', 'updatedBy'],
    headers: ['ID', '治療ID', '患者ID', '入金日', '金額', '入金方法', 'メモ',
      '作成日時', '更新日時', '更新者'],
  },
};

const NUMBER_FIELDS = ['fee', 'implantCount', 'adjustFee', 'amount'];

// ───────────────────────── Web アプリ ─────────────────────────

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('自費患者管理 | Mirai Dental')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// ───────────────────────── 初期設定 ─────────────────────────

/**
 * データ保存用スプレッドシートを作成し、シートとヘッダーを準備する。
 * 既にスプレッドシートがある場合は不足しているシートだけを追加する。
 */
function setup() {
  const props = PropertiesService.getScriptProperties();
  let ss;
  const existingId = props.getProperty('SPREADSHEET_ID');
  if (existingId) {
    ss = SpreadsheetApp.openById(existingId);
  } else {
    ss = SpreadsheetApp.create('Mirai Dental 自費患者データ');
    props.setProperty('SPREADSHEET_ID', ss.getId());
  }

  Object.keys(SHEETS).forEach(key => {
    const def = SHEETS[key];
    let sheet = ss.getSheetByName(def.name);
    if (!sheet) sheet = ss.insertSheet(def.name);
    sheet.getRange(1, 1, 1, def.headers.length)
      .setValues([def.headers])
      .setFontWeight('bold')
      .setBackground('#e8f0ee');
    sheet.setFrozenRows(1);
    // 日付などが自動変換されないよう、データ列はすべて書式なしテキストにする
    sheet.getRange(2, 1, sheet.getMaxRows() - 1, def.headers.length).setNumberFormat('@');
  });

  const defaultSheet = ss.getSheetByName('シート1') || ss.getSheetByName('Sheet1');
  if (defaultSheet && ss.getSheets().length > 1) ss.deleteSheet(defaultSheet);

  Logger.log('セットアップ完了: ' + ss.getUrl());
}

// ───────────────────────── 画面から呼ばれる API ─────────────────────────

function getAllData() {
  return {
    patients: readTable_('patients'),
    cases: readTable_('cases'),
    payments: readTable_('payments'),
    user: Session.getActiveUser().getEmail(),
  };
}

function savePatient(patient) {
  return withLock_(() => {
    if (!patient.name) throw new Error('氏名は必須です');
    if (patient.chartNo) {
      const dup = readTable_('patients')
        .find(p => p.chartNo === patient.chartNo && p.id !== patient.id);
      if (dup) throw new Error(`カルテ番号 ${patient.chartNo} は既に ${dup.name} さんで登録されています`);
    }
    upsert_('patients', patient);
    return getAllData();
  });
}

function deletePatient(patientId) {
  return withLock_(() => {
    deleteWhere_('payments', r => r.patientId === patientId);
    deleteWhere_('cases', r => r.patientId === patientId);
    deleteWhere_('patients', r => r.id === patientId);
    return getAllData();
  });
}

function saveCase(treatmentCase) {
  return withLock_(() => {
    if (!treatmentCase.patientId) throw new Error('患者が指定されていません');
    if (!treatmentCase.category) throw new Error('区分は必須です');
    upsert_('cases', treatmentCase);
    return getAllData();
  });
}

function deleteCase(caseId) {
  return withLock_(() => {
    deleteWhere_('payments', r => r.caseId === caseId);
    deleteWhere_('cases', r => r.id === caseId);
    return getAllData();
  });
}

function savePayment(payment) {
  return withLock_(() => {
    if (!payment.caseId) throw new Error('治療が指定されていません');
    if (!payment.date) throw new Error('入金日は必須です');
    if (!(Number(payment.amount) > 0)) throw new Error('金額は1円以上で入力してください');
    upsert_('payments', payment);
    return getAllData();
  });
}

function deletePayment(paymentId) {
  return withLock_(() => {
    deleteWhere_('payments', r => r.id === paymentId);
    return getAllData();
  });
}

// ───────────────────────── スプレッドシート操作 ─────────────────────────

function getSheet_(key) {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('初期設定がされていません。GASエディタで setup() を実行してください');
  const sheet = SpreadsheetApp.openById(id).getSheetByName(SHEETS[key].name);
  if (!sheet) throw new Error(`シート「${SHEETS[key].name}」がありません。setup() を再実行してください`);
  return sheet;
}

function readTable_(key) {
  return readRows_(key).map(r => r.record);
}

/** 空行を除いたレコードと、そのシート上の行番号を返す */
function readRows_(key) {
  const fields = SHEETS[key].fields;
  const sheet = getSheet_(key);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const values = sheet.getRange(2, 1, lastRow - 1, fields.length).getValues();
  const rows = [];
  values.forEach((row, i) => {
    if (row[0] === '') return;
    const record = {};
    fields.forEach((f, j) => {
      let v = row[j];
      if (v instanceof Date) v = Utilities.formatDate(v, 'Asia/Tokyo', 'yyyy-MM-dd');
      if (NUMBER_FIELDS.includes(f)) v = v === '' ? '' : Number(v);
      else v = String(v);
      record[f] = v;
    });
    rows.push({ record: record, rowNumber: i + 2 });
  });
  return rows;
}

function upsert_(key, obj) {
  const fields = SHEETS[key].fields;
  const sheet = getSheet_(key);
  const now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
  const user = Session.getActiveUser().getEmail() || '';

  const ids = sheet.getLastRow() < 2 ? []
    : sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues().map(r => String(r[0]));
  const index = obj.id ? ids.indexOf(obj.id) : -1;

  const record = Object.assign({}, obj);
  if (index === -1) {
    record.id = record.id || Utilities.getUuid();
    record.createdAt = now;
  }
  record.updatedAt = now;
  record.updatedBy = user;

  const existing = index === -1 ? null
    : sheet.getRange(index + 2, 1, 1, fields.length).getValues()[0];
  const row = fields.map((f, i) => {
    if (f === 'createdAt' && existing) return existing[i];
    const v = record[f];
    return v === undefined || v === null ? '' : String(v);
  });

  // 書式なしテキストにしてから書き込む（電話番号の先頭0や日付の自動変換を防ぐ）
  const rowNumber = index === -1 ? sheet.getLastRow() + 1 : index + 2;
  sheet.getRange(rowNumber, 1, 1, fields.length).setNumberFormat('@').setValues([row]);
  return record;
}

function deleteWhere_(key, predicate) {
  const sheet = getSheet_(key);
  const rows = readRows_(key);
  // 下の行から削除して行番号のずれを防ぐ
  for (let i = rows.length - 1; i >= 0; i--) {
    if (predicate(rows[i].record)) sheet.deleteRow(rows[i].rowNumber);
  }
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}
