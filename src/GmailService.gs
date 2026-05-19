/**
 * Gmail から未処理の受信メールを取得する
 */
const GmailService = {
  /**
   * 処理済みラベルを取得または作成する
   * @returns {GmailLabel}
   */
  getOrCreateProcessedLabel() {
    const labelName = Config.PROCESSED_LABEL;
    let label = GmailApp.getUserLabelByName(labelName);
    if (!label) {
      label = GmailApp.createLabel(labelName);
    }
    return label;
  },

  /**
   * 未処理の受信メールスレッドを取得する
   * @returns {GmailThread[]}
   */
  getUnprocessedThreads() {
    const labelName = Config.PROCESSED_LABEL;
    const intervalMin = Config.CHECK_INTERVAL_MINUTES;
    // 処理済みラベルが付いていない受信メールを取得
    // after: で時間フィルタも掛けることでAPI負荷を軽減
    const afterDate = new Date(Date.now() - intervalMin * 60 * 1000 * 2);
    const afterStr = Utilities.formatDate(afterDate, 'UTC', "yyyy/MM/dd");
    const query = `in:inbox -label:${labelName} after:${afterStr}`;
    const threads = GmailApp.search(query, 0, Config.MAX_EMAILS_PER_RUN);
    return threads;
  },

  /**
   * スレッドから最新メッセージの情報を抽出する
   * @param {GmailThread} thread
   * @returns {{subject: string, from: string, body: string, date: Date}}
   */
  extractMessageInfo(thread) {
    const message = thread.getMessages().slice(-1)[0]; // 最新メッセージ
    const body = message.getPlainBody().substring(0, 800); // 最大800文字
    return {
      subject: message.getSubject() || '(件名なし)',
      from: message.getFrom(),
      body: body,
      date: message.getDate(),
    };
  },

  /**
   * スレッドに処理済みラベルを付与する
   * @param {GmailThread} thread
   */
  markAsProcessed(thread) {
    const label = this.getOrCreateProcessedLabel();
    thread.addLabel(label);
  },
};
