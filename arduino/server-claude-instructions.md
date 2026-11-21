# サーバー側 Claude への指示（汎用版・貼り付け用）

前提: こちらからファイルは渡さない。サーバー上の **いまの server.js を正** として、足りない部分だけを最小限のパッチで直す。
権限が足りない操作（`accel-kitchen` ユーザーでの書き込み、PM2 の再起動）は、Claude が実行せず、人間が実行するコマンドを用意する。

## A. すでに走っているセッションへの返信（短い版）

```text
新版 server.js は渡せません（手元の版が最新とは限らないため）。方針を変えます。
- 本番の /opt/cosmicray-server/server.js を「正」とし、下の仕様を満たしていない箇所だけを最小限のパッチで直してください。
- あなたの権限では書き込み・PM2 操作ができないので、(B) の進め方にします。
  あなたは、読み取り、パッチ案の作成、コピーでのテストまでを担当し、
  本番への適用と再起動は、私が accel-kitchen ユーザーで実行できるコマンドとして用意してください。
  sudo や権限の回避は不要です。
仕様と手順は次のとおりです。（以降は B 以下を貼る）
```

## B. 汎用の指示（新規セッション用・全文）

```text
/opt/cosmicray-server の cosmicray-server (Node/Express、PM2 管理) に、ブラウザからのアクセスを許可する CORS 対応が必要です。
手元の最新ソースは手元にありません。本番の server.js を読んで、下の仕様を満たすかを確認し、足りなければ最小限のパッチを作ってください。

【背景】
ブラウザ製の検出器コンソールが https://accel-kitchen.com を通してこのサーバーにログインし、データを送ります。
ブラウザは Content-Type: application/json と Authorization ヘッダの付いたリクエストの前に OPTIONS（プリフライト）を送ります。
いまの公開サーバーは、OPTIONS に 200 と本文 "POST"（Express 標準）を返し、Access-Control-Allow-* が付いていません。
そのため、ブラウザは応答を読めず、ログインに失敗します。

【満たすべき仕様】
1. すべてのレスポンス（成功・401・404 などのエラーを含む）に次のヘッダを付ける。
   Access-Control-Allow-Origin: *
   Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS
   Access-Control-Allow-Headers: Content-Type, Authorization, Idempotency-Key
   Access-Control-Max-Age: 86400
2. OPTIONS には 204 を返し、そこで処理を終える（認証や本文パーサに到達させない）。
3. このミドルウェアは、express.json()、express.static、認証、各ルートよりも前（app の最初のほう）に置く。
4. Access-Control-Allow-Credentials は付けない（付けると * が無効になる）。クライアントは credentials: 'omit' で送る。
5. 既存の挙動（ルート、認証、データの保存形式、app.listen の待ち受けアドレス）は変えない。
   特に待ち受けは現在 127.0.0.1 で、外へはリバースプロキシ経由で出している。0.0.0.0 に変えない。

【あなたの権限について】
/opt/cosmicray-server は accel-kitchen ユーザーの所有で、PM2 も同ユーザーのものです。
あなたの実行ユーザーでは書き込み・PM2 操作ができない場合があります。その場合、sudo や権限の回避はせず、次のとおりにしてください。
- 作業ディレクトリは、あなたが書き込める場所（例: ホーム配下の cosmicray-patch/）を使う。
- 本番ファイルへの適用と再起動は、私が実行するコマンドとして書き出す。

【守ること】
- 本番の users.json、cosmicray-data/（または data/）、output.log は読まない・コピーしない・変更しない。
  （パスワードのハッシュや観測データを含むため。ファイルがあるかどうかだけ報告してよい）
- JWT_SECRET など秘密の値は、出力にも報告にも書かない。設定されているかどうかも、確認できた範囲で「あり／なし／未確認」とだけ書く。
- 本番プロセスの再起動や本番ファイルの変更は、あなたは行わない。
- 分からないことは推測で進めず、「未確認」と書く。

【手順】
1. 読み取り（本番は変更しない）
   - /opt/cosmicray-server/server.js を読み、仕様 1〜5 を満たすかを、1 項目ずつ「満たす／満たさない／一部」と行番号つきで書く。
   - app.listen の行と、express.json() / express.static / 認証ミドルウェアの位置も書く。
   - 公開サーバーの OPTIONS の挙動（上の背景）が、server.js のどこから来ているかを説明する。
     読んだ結果、server.js がすでに CORS を実装していて、別の原因（Apache のプロキシ設定など）が疑わしい場合は、
     パッチを作らず、その根拠を報告して止まる。
2. パッチの作成（作業ディレクトリで）
   - server.js を作業ディレクトリへコピーし、仕様を満たすための最小限の変更だけを加える。
     コピー元の更新日時と、変更箇所を diff -u で示す。
   - node --check で構文を確認する。
3. コピーでのテスト（本番に触れない）
   - 作業ディレクトリにパッチ済み server.js を置き、node_modules は本番のものへの symlink にするか、
     できなければ npm ci --omit=dev で用意する（本番の users.json やデータは持ち込まない）。
   - JWT_SECRET はテスト用の使い捨ての値を環境変数で与え、別のポート（例: PORT=3101）で、127.0.0.1 だけで起動する。
   - 次の 3 つを実行し、ヘッダ部分を貼る。
     (a) curl -s -i -X OPTIONS http://127.0.0.1:3101/auth/login -H "Origin: null" -H "Access-Control-Request-Method: POST" -H "Access-Control-Request-Headers: content-type,authorization"
         → 204、Access-Control-Allow-Origin: *、Allow-Headers に Authorization が含まれる
     (b) curl -s -i -X POST http://127.0.0.1:3101/auth/login -H "Origin: null" -H "Content-Type: application/json" -d '{"id":"nonexistent-probe","password":"x"}'
         → 401 と Access-Control-Allow-Origin: *
     (c) curl -s -i http://127.0.0.1:3101/no-such-route -H "Origin: null"
         → 404 でも Access-Control-Allow-Origin: *
   - テストが終わったらテスト用プロセスを止め、作業ディレクトリのテスト用データを片付ける。
4. 適用コマンドの用意（実行は私）
   次を、コピー＆ペーストで実行できる形で書き出してください。accel-kitchen ユーザーで実行する想定です。
   - 本番 server.js のバックアップ（日時付き）
   - パッチ済み server.js の本番への差し替え（所有者と権限を元の server.js に合わせる）
   - PM2 の再起動（プロセス名は pm2 list で確認する前提のコマンドも添える。環境変数は維持する --update-env の要否も説明する）
   - 起動確認（pm2 logs の見かた、ss -ltnp | grep 3000）
   - 戻し方（バックアップから戻して再起動）
   - 公開 URL 越しの確認コマンド
       curl -s -i -X OPTIONS https://accel-kitchen.com/auth/login -H "Origin: null" -H "Access-Control-Request-Method: POST" -H "Access-Control-Request-Headers: content-type,authorization"
     （204 と Access-Control-Allow-Origin: * が付けば成功。落ちていれば Apache のプロキシ設定が原因なので、設定ファイルの場所と該当箇所を報告する。Apache の設定は変更しない）

【最後に報告してほしいこと】
- 仕様 1〜5 の確認結果（行番号つき）
- パッチの diff と作業ディレクトリの場所
- (a)(b)(c) の結果（ヘッダ部分だけ）
- 私が実行するコマンド一式
- 本番 server.js のうち、仕様に関係なく気づいた、私が判断すべき点（認証・パス・古い依存など）
- 未確認のこと
```

## 戻ってきた報告を受けたら

- あなたがコマンドを実行したあと、公開 URL への OPTIONS で 204 と `Access-Control-Allow-Origin: *` が付くことを確認する（こちらでも確認できる）。
- 付けば、Console の「サーバー」欄に `https://accel-kitchen.com` を入れ、実アカウントでログインと数イベントの送信を試す。
