/**
 * メインエントリーポイント
 * トリガーから定期的に呼び出される
 */
function checkAndNotify() {
  try {
    const threads = GmailService.getUnprocessedThreads();
    if (threads.length === 0) return;

    Logger.log(`未処理メール: ${threads.length} 件`);

    for (const thread of threads) {
      try {
        const emailInfo = GmailService.extractMessageInfo(thread);
        const judgment = ClaudeService.judgeImportance(emailInfo);

        Logger.log(`件名: ${emailInfo.subject} → 重要: ${judgment.important} (${judgment.reason})`);

        if (judgment.important) {
          LineNotifyService.sendImportantEmailAlert(emailInfo, judgment);
        }

        // 重要・不要に関わらず処理済みとしてマーク（再処理防止）
        GmailService.markAsProcessed(thread);

        // API レート制限を避けるため少し待機
        Utilities.sleep(1000);
      } catch (threadError) {
        Logger.log(`スレッド処理エラー: ${threadError.message}`);
        // 1件のエラーで全体を止めない
      }
    }
  } catch (fatalError) {
    Logger.log(`致命的エラー: ${fatalError.message}`);
    try {
      LineNotifyService.sendErrorAlert(fatalError.message);
    } catch (_) {
      // LINE通知自体が失敗しても何もしない
    }
  }
}

/**
 * 時間ベーストリガーをセットアップする
 * 初回のみ手動で実行すること
 */
function setupTrigger() {
  // 既存トリガーを削除
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'checkAndNotify')
    .forEach(t => ScriptApp.deleteTrigger(t));

  // 新しいトリガーを登録
  ScriptApp.newTrigger('checkAndNotify')
    .timeBased()
    .everyMinutes(Config.CHECK_INTERVAL_MINUTES)
    .create();

  Logger.log(`トリガーを設定しました: ${Config.CHECK_INTERVAL_MINUTES}分ごとに実行`);
}

/**
 * セットアップ確認テスト
 * 初回のみ手動で実行して動作確認する
 */
function testSetup() {
  Logger.log('=== セットアップテスト開始 ===');

  // 1. スクリプトプロパティの確認
  try {
    const apiKey = Config.CLAUDE_API_KEY;
    Logger.log(`✅ CLAUDE_API_KEY: 設定済み (${apiKey.substring(0, 8)}...)`);
  } catch (e) {
    Logger.log(`❌ CLAUDE_API_KEY: ${e.message}`);
    return;
  }

  try {
    const token = Config.LINE_NOTIFY_TOKEN;
    Logger.log(`✅ LINE_NOTIFY_TOKEN: 設定済み (${token.substring(0, 4)}...)`);
  } catch (e) {
    Logger.log(`❌ LINE_NOTIFY_TOKEN: ${e.message}`);
    return;
  }

  // 2. LINE Notify テスト送信
  try {
    LineNotifyService._send('\n✅ Mirai Dental Gmail通知システムが正常に接続されました');
    Logger.log('✅ LINE Notify: テスト送信成功');
  } catch (e) {
    Logger.log(`❌ LINE Notify: ${e.message}`);
    return;
  }

  // 3. Gmail アクセス確認
  try {
    GmailService.getOrCreateProcessedLabel();
    Logger.log(`✅ Gmail: ラベル "${Config.PROCESSED_LABEL}" を確認/作成しました`);
  } catch (e) {
    Logger.log(`❌ Gmail: ${e.message}`);
    return;
  }

  Logger.log('=== セットアップテスト完了 ✅ ===');
  Logger.log('次のステップ: setupTrigger() を実行してください');
}
