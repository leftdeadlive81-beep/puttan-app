# Puttan Mobile (Android) — GPS発信 + クロノロジー専用アプリ

Webアプリ版Puttan（`../gps-server`）と同じSupabase認証・Renderバックエンド（Socket.IO）を共有する、
GPS発信とクロノロジー（報連相）だけに絞ったAndroidネイティブアプリ。画面OFF・アプリ切り替え中でも
バックグラウンドで位置情報を送信し続けられるようにするために作成した。

## 現在の状態

- [x] Capacitorプロジェクトのひな型作成（`package.json` / `capacitor.config.json`）
- [x] `www/` にログイン・GPS・クロノロジー画面を実装（`index.html` / `style.css` / `app.js`）
- [x] `socket.io` / `supabase-js` / `proj4` をCDN非依存でローカル同梱（`www/vendor/`）
- [x] 既存サーバー（`gps-server/server.js`）のSocket.IOにCORS設定を追加し、別オリジンからの接続を許可（デプロイ済み）
- [x] `npx cap add android` でAndroidネイティブプロジェクトを生成
- [x] `AndroidManifest.xml` にバックグラウンド位置情報関連の権限を追加
- [x] `@transistorsoft/capacitor-background-geolocation` (v9.3.0) をプラグインとして登録
- [x] `node_modules`内の型定義を実際に読み、`app.js`の`startBackgroundTracking()`/`stopBackgroundTracking()`を
      `window.Capacitor.Plugins.BackgroundGeolocation`（Capacitorのネイティブブリッジを直接呼ぶ方式。バンドラー無し構成のため）
      で実装済み。**ただし実機・エミュレータでの動作確認はまだ行っていない**
- [x] **デバッグAPKのビルドに成功**（`android/app/build/outputs/apk/debug/app-debug.apk`）

## ビルド環境メモ（このPCでの実績値）

- Android StudioインストールでSDKは `%LOCALAPPDATA%\Android\Sdk` に入った
- Android Studio同梱のJBR（JetBrains Runtime）は **Java 25** だが、現行のGradle 8.14.3はJava25未対応で
  `Unsupported class file major version 69` エラーになる → 別途 **Temurin JDK 21** を
  `C:\Users\leftd\dev-tools\jdk-21.0.12+8` に展開して使用している（AGP/Gradleを最新の9系に上げる方法もあるが、
  安定版の組み合わせを優先しこちらを採用）
- `android/local.properties` に `sdk.dir=C:/Users/leftd/AppData/Local/Android/Sdk` を設定済み（Windowsパスだが
  `.properties`ファイルなのでフォワードスラッシュ表記、バックスラッシュのエスケープ地獄を回避）

## ビルドコマンド

```
cd C:\Users\leftd\puttan-mobile

# Webアセットに変更を加えたら毎回
npx cap sync android

# Android Studioで開く（GUIビルド・実機/エミュレータ実行）
npx cap open android

# または CLIだけでデバッグAPKをビルド（Android Studio GUI不要、JDK21を明示的に指定）
cd android
JAVA_HOME="C:/Users/leftd/dev-tools/jdk-21.0.12+8" ./gradlew.bat assembleDebug
# 生成物: android/app/build/outputs/apk/debug/app-debug.apk
```

## まだ残っている作業

- [ ] **実機・エミュレータでの動作確認**（この環境からは実行できない。`adb install app-debug.apk` 後、
      ログイン→GPS開始→権限ダイアログ(2段階: 使用中→常に許可)→画面OFFでの送信継続、を確認）
- [ ] バックグラウンド位置情報プラグインのConfig・イベント処理が実機で期待通り動くか検証し、
      ズレがあれば`app.js`の`startBackgroundTracking()`を調整
- [ ] バッテリー最適化除外の案内UI（Xiaomi/Samsung等の機種依存対策、現状は未実装）
- [ ] チーム内APK配布

## このアプリが使うSocket.IOイベント（Web版 `server.js` と共通）

- `registerUser` → `registerUserResult`（プロフィール登録。水/燃料/物資はこのアプリでは扱わずサーバー側で0扱いになる）
- `location`（位置情報送信。30秒ごと or 10m移動ごとに間引き送信、Web版と同じロジック）
- `userOffline`（ログアウト時。`deleteUser`は管理者専用の完全削除なのでこのアプリからは呼ばない）
- `addChronology` / `chronology`（報連相の投稿・一覧）
- `loadMoreChronology`（過去ログのページング、ackコールバック形式）
- `toggleReaction` / `chronologyReactionUpdate`（8種類の固定絵文字リアクション）

## 動作確認方法（Android Studio導入後）

1. `adb devices` でエミュレータ/実機が認識されることを確認
2. `npx cap sync android && npx cap open android` でアプリを起動
3. Web版で作成済みのアカウントでログイン → GPS開始 → Web版の地図・隊員一覧にこのアプリからの位置情報が反映されるか確認
4. クロノロジーに投稿 → Web版の報連相タブに即座に反映されるか確認
5. 実機で画面をOFFにして数十分待ち、Web版の地図上でアイコンが更新され続けているか確認（ここがこのアプリを作った本来の目的）
