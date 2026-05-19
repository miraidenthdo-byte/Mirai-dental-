/**
 * LINE Notify でメッセージを送信する
 */
const LineNotifyService = {
  API_URL: 'https://notify-api.line.me/api/notify',

  /**
   * 重要メールの通知を送信する
   * @param {{subject: string, from: string, date: Date}} emailInfo
   * @param {{summary: string, reason: string}} judgment
   */
  sendImportantEmailAlert(emailInfo, judgment) {
    const dateStr = Utilities.formatDate(emailInfo.date, 'Asia/Tokyo', 'MM/dd HH:mm');
    const message = [
      '',
      '📧 重要メール通知',
      `📌 ${judgment.summary || emailInfo.subject}`,
      `─────────────────`,
      `件名: ${emailInfo.subject.substring(0, 50)}`,
      `送信者: ${emailInfo.from.substring(0, 40)}`,
      `受信: ${dateStr}`,
      `理由: ${judgment.reason}`,
    ].join('\n');
    this._send(message);
  },

  /**
   * エラー発生時の通知を送信する
   * @param {string} errorMessage
   */
  sendErrorAlert(errorMessage) {
    const message = `\n⚠️ Gmail通知システムエラー\n${errorMessage.substring(0, 100)}`;
    this._send(message);
  },

  /**
   * LINE Notify API を呼び出す
   * @param {string} message
   */
  _send(message) {
    const options = {
      method: 'post',
      headers: { Authorization: `Bearer ${Config.LINE_NOTIFY_TOKEN}` },
      payload: { message: message },
      muteHttpExceptions: true,
    };
    const response = UrlFetchApp.fetch(this.API_URL, options);
    const code = response.getResponseCode();
    if (code !== 200) {
      throw new Error(`LINE Notify エラー: ${code} ${response.getContentText().substring(0, 200)}`);
    }
  },
};
