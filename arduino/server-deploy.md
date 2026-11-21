# 測定サーバー更新手順（CORS 対応版を載せる）

> **注記（2026-11-21）：この文書の前提は崩れました。急ぎでは使わないでください。**
> 旧サーバー（`https://accel-kitchen.com`）の API は、本物の Console（`https://accel-kitchen.com/app/cosmicray-monitor/`）と**同じオリジン**にあるので、
> CORS が無くても、配信中の Console からは動いている可能性が高いです（そこから試した間違いパスワードのログインは `401` が正常に読めました）。
> CORS が無くて困るのは、`file://`、`localhost`、別のホストから開いた Console だけです。
> 新サーバー（`cosmicray.accel-kitchen.com`）を作る方針になったので、旧サーバーの更新は、必要になったときの参考として残しています。
> 新サーバーの手順は `server/deploy/README.md` にあります。

対象: `https://accel-kitchen.com` の `cosmicray-server`（`/opt/cosmicray-server`、PM2 管理）。
目的: Console（v2 / v1）のブラウザからログインと送信ができるようにする。
2026-11-21 時点の症状: サーバーが OPTIONS に `200` / 本文 `POST` を返し、`Access-Control-Allow-*` が付かない（CORS 修正 S-01 が未反映）。

## 0. 先に決めておくこと

- 手元の `F:\Document\Programming\cosmicray-server` は `webserver/server.js` が**未コミット**。先にコミットする（サーバーと手元の版を一致させるため）。
- サーバー上の待ち受けは `127.0.0.1:3000`、手元のコードは `0.0.0.0`。**サーバー上の `server.js` を手で書き換えている可能性がある**ので、上書きする前に差分を見る（手順 2）。
- `JWT_SECRET` は環境変数で与える。新しい `server.js` は、`NODE_ENV=production` で未設定だと終了し、未設定だと起動ごとに別の秘密鍵を作る（再起動で全トークンが無効になる）。PM2 側にすでに設定されているか確認する（手順 1）。

## 1. サーバーで現状を控える

```bash
cd /opt/cosmicray-server
pm2 list                         # プロセス名を確認（以降 <name> と書く）
pm2 env <id>  | grep -E "JWT_SECRET|NODE_ENV|PORT"   # 値は他人に見せない
node -v
cp -a server.js server.js.bak-$(date +%Y%m%d)       # 戻せるようにする
cp -a users.json users.json.bak-$(date +%Y%m%d)     # 念のため
```

## 2. 差分を見る

手元の `webserver/server.js` をサーバーの `/tmp/server.new.js` に置いてから比較する。

```bash
diff -u /opt/cosmicray-server/server.js /tmp/server.new.js | less
```

`listen('127.0.0.1', ...)` のような、サーバー側だけの変更があれば、新しい版にも同じ変更を入れる。

## 3. 反映する

**コピーしてよいもの**: `server.js`、`package.json`、`package-lock.json`。
**上書きしてはいけないもの**: `users.json`、`cosmicray-data/`（または `data/`）、`output.log`、`node_modules/`（手元のものを持ち込まない）。

```bash
cp /tmp/server.new.js /opt/cosmicray-server/server.js
cd /opt/cosmicray-server
npm ci --omit=dev        # package-lock を置いた場合。依存は express / bcrypt / jsonwebtoken のみ
pm2 restart <name> --update-env
pm2 logs <name> --lines 30 --nostream
```

ログに `FATAL` が出ていないこと、`Cosmic Watch Server running` が出ていることを確認する。

## 4. 外から確認する（どの PC でも可）

OPTIONS に `204` と CORS ヘッダが付くこと。

```powershell
curl.exe -s -i -X OPTIONS https://accel-kitchen.com/auth/login -H "Origin: null" -H "Access-Control-Request-Method: POST" -H "Access-Control-Request-Headers: content-type,authorization"
```

期待する出力: `HTTP/1.1 204`、`Access-Control-Allow-Origin: *`、`Access-Control-Allow-Headers: Content-Type, Authorization, Idempotency-Key`。

通常の応答にも `Access-Control-Allow-Origin: *` が付くこと（存在しないユーザーなので 401 が正しい）。

```powershell
curl.exe -s -i -X POST https://accel-kitchen.com/auth/login -H "Origin: null" -H "Content-Type: application/json" -d '{"id":"nonexistent-probe","password":"x"}'
```

## 5. Console で通し確認

1. Console（`https://` で開くか、`file://` / `localhost`）の「サーバー」欄に `https://accel-kitchen.com` を入れる。`:3000` は付けない。
2. 局 ID とパスワードでログインし、エラーが出ないことを確認する。
3. 検出器をつなぐか、デモ以外の実データで数イベント送る（デモのイベントは送られない仕様）。
4. サーバーの `pm2 logs <name>` と `cosmicray-data/<ID>/` の最新ファイルに行が増えていることを確認する。

## 6. うまくいかないとき

| 症状 | 原因の見当 | 対処 |
|---|---|---|
| 4 の OPTIONS がまだ `200` / `POST` | 再起動されていない、または別のプロセスが 3000 番にいる | `pm2 list`、`ss -ltnp \| grep 3000` |
| 起動直後に落ちる（`FATAL`） | `NODE_ENV=production` で `JWT_SECRET` が未設定 | PM2 の環境に `JWT_SECRET` を設定して `pm2 restart --update-env` |
| 再起動のたびにログインが切れる | `JWT_SECRET` が未設定で毎回ランダム | 同上 |
| Console が「サーバーにつながりません」のまま | CORS 未反映、`http://` のサーバーに `https://` ページから送っている | 手順 4、URL を `https://` にする |
| 戻したい | — | `cp server.js.bak-<日付> server.js && pm2 restart <name>` |

## 補足

- `/health` と `GET /latest-data/*` は Apache が転送していないため、外からは 404 になる（Console の送信には不要）。
- 平文の `users.json` や `JWT_SECRET` の値はチャットや文書に貼らない。
