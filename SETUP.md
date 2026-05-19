# Gmail → LINE 重要メール通知システム セットアップ手順

## 全体の流れ

```
Gmail受信 → GAS（10分おきに実行）→ Claude AIで重要度判定 → LINEに通知
```

---

## Step 1: 必要なトークン・APIキーを取得する

### 1-1. Claude APIキーの取得
1. https://console.anthropic.com/ にアクセス
2. 「API Keys」→「Create Key」でAPIキーを発行
3. `sk-ant-...` 形式のキーをコピーして保管

### 1-2. LINE Notifyトークンの取得
1. https://notify-bot.line.me/ja/ にアクセス
2. LINEアカウントでログイン
3. 「マイページ」→「トークンを発行する」
4. トークン名: `Mirai Dental メール通知`
5. 通知先グループまたは自分自身を選択
6. 発行されたトークンをコピーして保管

---

## Step 2: Google Apps Script プロジェクトを作成する

1. https://script.google.com/ にアクセス
2. 「新しいプロジェクト」をクリック
3. プロジェクト名を `Mirai-Dental-Gmail-Notify` に変更

---

## Step 3: スクリプトファイルをコピーする

GASエディタに以下の順でファイルを作成し、`src/` フォルダの内容をコピーする:

| ファイル名 | 内容 |
|-----------|------|
| `Config.gs` | 設定管理 |
| `GmailService.gs` | Gmail操作 |
| `ClaudeService.gs` | Claude AI連携 |
| `LineNotifyService.gs` | LINE Notify連携 |
| `Main.gs` | メイン処理・トリガー設定 |

> **appsscript.json の編集**  
> GASエディタ左メニュー「プロジェクトの設定」→「appsscript.json をエディタで表示」を有効にし、
> リポジトリの `appsscript.json` の内容に置き換える

---

## Step 4: スクリプトプロパティを設定する

GASエディタ →「プロジェクトの設定」→「スクリプトプロパティ」に以下を追加:

| プロパティ名 | 値 | 必須 |
|-------------|---|------|
| `CLAUDE_API_KEY` | `sk-ant-...` | ✅ |
| `LINE_NOTIFY_TOKEN` | `xxxx...` | ✅ |
| `CHECK_INTERVAL_MINUTES` | `10` | 任意（デフォルト10分） |
| `MAX_EMAILS_PER_RUN` | `20` | 任意（デフォルト20件） |
| `PROCESSED_LABEL` | `LINE通知済み` | 任意 |

---

## Step 5: 初回テストを実行する

1. GASエディタで `testSetup` 関数を選択
2. 「実行」をクリック
3. 初回はGmailとURLフェッチの権限許可を求められるので「許可」する
4. 実行ログで `=== セットアップテスト完了 ✅ ===` が表示されることを確認
5. LINEに「接続されました」メッセージが届くことを確認

---

## Step 6: トリガーを設定する

1. GASエディタで `setupTrigger` 関数を選択して実行
2. GASエディタ左メニュー「トリガー」で `checkAndNotify` が登録されていることを確認

---

## 動作確認

- テストメールを自分宛に送信して、約10分以内にLINE通知が届くことを確認
- Gmailに「LINE通知済み」ラベルが付くことを確認

---

## 重要度の判定カスタマイズ

`ClaudeService.gs` の `_buildPrompt` メソッド内の判定基準を編集することで、
クリニック固有のルールを追加できます。

---

## コスト目安

| サービス | 料金 |
|---------|------|
| Google Apps Script | 無料 |
| LINE Notify | 無料 |
| Claude API (Haiku) | 約 $0.001 / メール判定 |

1日100通処理しても約¥15/日程度。
