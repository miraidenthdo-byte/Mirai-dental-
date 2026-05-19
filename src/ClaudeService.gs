/**
 * Claude API を使ってメールの業務重要度を判定する
 */
const ClaudeService = {
  API_URL: 'https://api.anthropic.com/v1/messages',
  MODEL: 'claude-haiku-4-5-20251001', // 高速・低コストのモデルを使用

  /**
   * メールが業務上重要かどうかを判定する
   * @param {{subject: string, from: string, body: string}} emailInfo
   * @returns {{important: boolean, reason: string, summary: string}}
   */
  judgeImportance(emailInfo) {
    const prompt = this._buildPrompt(emailInfo);
    const response = this._callApi(prompt);
    return this._parseResponse(response);
  },

  _buildPrompt(emailInfo) {
    return `あなたは歯科クリニックの業務管理AIです。
以下のメールが「業務上重要かどうか」を判定してください。

【重要と判断する基準】
- 患者からの予約・キャンセル・緊急連絡
- 取引先・業者からの納品・請求・契約に関する連絡
- 保険請求・審査に関する重要通知
- スタッフの勤怠・緊急連絡
- 医療機器のトラブル・メンテナンス通知
- 行政・厚生局からの通知
- 支払い期限・未払いに関する警告

【重要でないと判断する基準】
- ニュースレター・メルマガ・広告
- SNS通知・自動配信メール
- セールス・営業メール（面識のない企業）
- 定期自動送信の確認メール

---
件名: ${emailInfo.subject}
送信者: ${emailInfo.from}
本文（抜粋）:
${emailInfo.body}
---

以下のJSON形式のみで回答してください（説明文不要）:
{
  "important": true または false,
  "reason": "重要/不要と判断した理由（30文字以内）",
  "summary": "重要な場合のみ: LINEに通知する要約文（60文字以内）"
}`;
  },

  _callApi(prompt) {
    const payload = {
      model: this.MODEL,
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    };
    const options = {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'x-api-key': Config.CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    };
    const response = UrlFetchApp.fetch(this.API_URL, options);
    const code = response.getResponseCode();
    if (code !== 200) {
      throw new Error(`Claude API エラー: ${code} ${response.getContentText().substring(0, 200)}`);
    }
    return JSON.parse(response.getContentText());
  },

  _parseResponse(apiResponse) {
    try {
      const text = apiResponse.content[0].text.trim();
      // JSONブロック抽出（```json ... ``` 形式にも対応）
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('JSON が見つかりません');
      return JSON.parse(jsonMatch[0]);
    } catch (e) {
      Logger.log(`Claude レスポンス解析エラー: ${e.message}`);
      return { important: false, reason: '解析エラー', summary: '' };
    }
  },
};
