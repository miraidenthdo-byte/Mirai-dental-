/**
 * スクリプトプロパティから設定を読み込む
 * GASエディタ > プロジェクトの設定 > スクリプトプロパティ で設定すること
 *
 * 必須プロパティ:
 *   CLAUDE_API_KEY     : Anthropic APIキー
 *   LINE_NOTIFY_TOKEN  : LINE Notifyトークン
 *
 * 任意プロパティ:
 *   CHECK_INTERVAL_MINUTES : チェック間隔（分）。デフォルト: 10
 *   MAX_EMAILS_PER_RUN     : 1回の実行で処理する最大メール数。デフォルト: 20
 *   PROCESSED_LABEL        : 処理済みラベル名。デフォルト: "LINE通知済み"
 */
const Config = {
  get CLAUDE_API_KEY() {
    const key = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
    if (!key) throw new Error('スクリプトプロパティ CLAUDE_API_KEY が設定されていません');
    return key;
  },
  get LINE_NOTIFY_TOKEN() {
    const token = PropertiesService.getScriptProperties().getProperty('LINE_NOTIFY_TOKEN');
    if (!token) throw new Error('スクリプトプロパティ LINE_NOTIFY_TOKEN が設定されていません');
    return token;
  },
  get CHECK_INTERVAL_MINUTES() {
    return parseInt(PropertiesService.getScriptProperties().getProperty('CHECK_INTERVAL_MINUTES') || '10', 10);
  },
  get MAX_EMAILS_PER_RUN() {
    return parseInt(PropertiesService.getScriptProperties().getProperty('MAX_EMAILS_PER_RUN') || '20', 10);
  },
  get PROCESSED_LABEL() {
    return PropertiesService.getScriptProperties().getProperty('PROCESSED_LABEL') || 'LINE通知済み';
  },
};
