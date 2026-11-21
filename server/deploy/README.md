# VPS への載せ方（Phase 2 の手順書・草案）

> **草案です。VPS では一度も実行していません。** 設定ファイルとスクリプトは、手元で構文を確認し、
> `smoke.sh` を手元のサーバーと旧サーバーに対して動かしただけです（旧サーバーでは、期待どおり失敗を検出）。
> 先に **調査（手順 1）** を行い、その結果で「調査で確定する項目」を埋めてから使ってください。
>
> 実行するのはあなた（root か sudo）です。サーバー側の Claude は、調査と、設定の確認までです。

対象: `https://cosmicray.accel-kitchen.com`（VPS 118.27.30.120、Apache 2.4、Ubuntu）
アプリ: `server/`（Node 22、`127.0.0.1:3100` だけで待ち受け）。Apache が公開側を受け持ちます。

## ファイル

| ファイル | 役割 |
|---|---|
| `survey.sh` | **VPS の調査（読み取りだけ）。`sudo` で 1 回実行する** |
| `SURVEY-PROMPT.md` | 同じ調査を、サーバー側 Claude に頼むときの依頼文（root が無いので読める範囲は狭い） |
| `env.example` | `/etc/cosmicray/env` の雛形 |
| `cosmicray-v3.service` | アプリの systemd ユニット |
| `apache-1-bootstrap.conf` / `apache-2-final.conf` | Apache の設定（証明書の取得前 / 後） |
| `deploy.sh` | `server/` だけを展開し、切り替え、健全性を確認し、失敗なら戻す |
| `smoke.sh` | 公開 URL の確認（curl だけ。**合格基準ではなく、最初の確認**） |
| `cosmicray-v3-backup.service` / `.timer` | 毎晩のバックアップ（`scripts/backup.js`） |

## 調査の結果（2026-11-22、`survey.sh` を root と `accel-kitchen` で実行）

| 項目 | 結果 | この手順書への効果 |
|---|---|---|
| OS / Apache | Ubuntu 24.04.5、Apache 2.4.58 | — |
| メモリ・CPU・ディスク | 3.9 GiB（空き 2.7 GiB）、swap 2 GiB（378 MiB 使用中）、4 CPU、空き 46 GB | `SCRYPT_CONCURRENCY=2`（約 256 MiB）で足りる。`MemoryMax=768M` も妥当。同居しているものが多い（MariaDB、uvicorn、別の Node アプリ、RustDesk）ので、メモリは余裕を見込みすぎない |
| `node` | root の PATH には無く、**nvm の下にだけある**（`/home/accel-kitchen/.nvm/versions/node/v22.14.0` と `v22.23.4`、kaduo にも v22.14.0）。旧サーバーは v22.14.0 で動いている | 専用の `node` を `/opt` にコピーして使う（手順 3b）。`ProtectHome=yes` の下では `/home` の `node` は使えない |
| Apache のモジュール | `proxy`、`proxy_http`、`headers`、`ssl`、`rewrite`、`remoteip` が**すべて有効** | `a2enmod` は不要 |
| 既存の VirtualHost | `accel-kitchen.com`（:80 は https へ転送、:443 は一部のパスだけ `localhost:3000` へ転送）、`line.accel-kitchen.com`（FastAPI の 8003） | 新しい VirtualHost を足すだけ。名前で選ばれるので、既存のサイトには触れない |
| 証明書 | certbot 5.10.0（snap）、更新タイマーあり。`/etc/letsencrypt/live/` に `accel-kitchen.com` と `line.accel-kitchen.com`。`options-ssl-apache.conf` あり | `certbot certonly --webroot` で足す。更新は snap のタイマーが行う |
| 手前の CDN | なし（応答の `Server` は Apache、`via`/`cf-` なし） | `X-Forwarded-For` は Apache が追記するだけ（`smoke.sh` の 5 で確認） |
| ポート | **3100 は空き**。ufw は有効（80/443/3465 などだけ許可）、INPUT は DROP | アプリは `127.0.0.1:3100` で待ち受けるので、ufw の変更は不要 |
| ユーザー | `cosmicray` は無い。`kaduo`（1000、sudo 可）、`accel-kitchen`（1001、sudo 不可） | 手順 3 で作る。sudo は `kaduo` で行う |
| アクセスログ | 14 日で消える（毎日ローテーション、14 世代） | プライバシーポリシーに「アクセスログは約 14 日」と書ける（Q-N2） |
| メール | postfix も exim も**動いていない**。外向きの 25・587 は**届く**。`/usr/sbin/sendmail` はあるが MTA は無い。`mta-sts-daemon`（127.0.0.1:8461）が動いている | Phase 3 の Q-N1 の材料 |
| 旧サーバー | PM2（`accel-kitchen`）で `/opt/cosmicray-server/server.js` が稼働。データ 191 MB、局は 5 つ（`ktt`、`nsr`、`sendai`、`test`、`waseda`）。**直近 30 日に書いた局は 0**（最新は `ktt` の 2026-06-17） | 切り替え日は要らない。Phase 4 は、データの保存（アーカイブ）が中心になる |
| 気づいた点 | `/opt/cosmicray-server/users.json` が `-rw-rw-rw-`（**全員が読み書きできる**）。中身はパスワードのハッシュ。同じ VPS に `kaduo`、`www-data`、MariaDB、別のアプリがある | 旧サーバーの問題。`chmod 600 /opt/cosmicray-server/users.json`（`accel-kitchen` で実行）で直せる。新サーバーの `users` は DB の中にあり、ファイルの権限は `cosmicray` だけ |

## 調査で確定する項目（上の結果で埋まったもの）

| 項目 | どこに効くか |
|---|---|
| `node` の実際の場所と版（nvm など、ホームの下にないか） | `cosmicray-v3.service` の `ExecStart`、`ProtectHome` |
| メモリ・ディスク・CPU | `SCRYPT_CONCURRENCY`、`MemoryMax`（1 回のパスワード照合に約 128 MiB） |
| Apache の有効モジュール（`proxy` `proxy_http` `headers` `ssl` `rewrite`） | 手順 7 の `a2enmod` |
| 証明書の発行方法（certbot か、ほかか） | 手順 7 |
| 既存の転送設定と、Apache の手前の CDN などの有無 | `X-Forwarded-For` の扱い（`smoke.sh` の 5） |
| ポート 3100 の空き、既存のユーザー名 | 手順 3 |
| ビルド道具（`gcc` `make` `python3`）、glibc の版 | `better-sqlite3` を入れられるか |
| メール送信（Postfix の有無） | Phase 3（Q-N1） |

## 手順

### 1. 調査（読み取りだけ）
**おすすめは `survey.sh`**: root で読めるものが多い（Apache の設定、モジュール、ファイアウォール）ので、あなたが `sudo` で 1 回実行します。
何も変更せず、何もインストールせず、標準出力に書くだけです。秘密に見える行は `(redacted)` になり、`users.json` は開きません。
```bash
scp -P 3465 survey.sh <ユーザー>@accel-kitchen.com:/tmp/
ssh -p 3465 <ユーザー>@accel-kitchen.com        # この VPS の SSH ポートは 3465（scp は -P、ssh は -p）
sudo bash /tmp/survey.sh > /tmp/survey-report.md 2>&1
less /tmp/survey-report.md            # 貼る前に一度、目で確認する
```
旧データが `/opt/cosmicray-server/…/cosmicray-data` 以外にある場合は、`sudo OLD_DATA_DIR=/path bash /tmp/survey.sh …`。
レポートを私に貼ってください。末尾の「Could not read or run」に出たものだけ、必要に応じてもう一度見ます。

サーバー側の Claude に任せたいときは、`SURVEY-PROMPT.md` を貼ります（root が使えないので、読めない項目が増えます）。

### 2. 手元で: コミット → タグ → 配布用のファイル
`git archive` は**コミット済みの内容だけ**を含みます。先にコミットしてから、タグを付けます。
サーバー用のタグは `server-v` で始めます（基板・ケースの変更と区別するため）。

```powershell
git tag server-v0.1.0
git archive --format=tar.gz -o server-v0.1.0.tar.gz server-v0.1.0 server
scp -P 3465 server-v0.1.0.tar.gz kaduo@accel-kitchen.com:/tmp/
scp -P 3465 -r server/deploy kaduo@accel-kitchen.com:/tmp/      # 設定ファイルとスクリプト一式
```
以降の VPS でのコマンドは、特に断りがなければ `cd /tmp/deploy` で実行します。
（コピーした `deploy/` は、改行コードが LF のままか確認してください。`server/.gitattributes` が LF に固定しています。）
リポジトリを公開していない、またはまだプッシュしていなくても、この方法なら届きます。
（`deploy.sh git <tag>` の方式は、プッシュと、非公開なら読み取り専用の deploy key が要ります。）

### 3. VPS: ユーザーとディレクトリ
```bash
sudo useradd --system --home-dir /var/lib/cosmicray --shell /usr/sbin/nologin cosmicray
sudo install -d -o cosmicray -g cosmicray -m 0750 /var/lib/cosmicray
sudo install -d -o cosmicray -g cosmicray -m 0750 /var/backups/cosmicray   # 保存先は手順 9 で決める
sudo install -d -o root -g cosmicray -m 0750 /etc/cosmicray
sudo install -d -o root -g root -m 0755 /opt/cosmicray-v3
```

### 3b. VPS: 専用の `node`（`/opt` にコピー）
`node` は nvm の下にしか無く、`ProtectHome=yes` のサービスからは見えません。`accel-kitchen` の nvm にある v22.23.4 を、そのまま `/opt` にコピーします（ダウンロードは不要です）。
```bash
sudo cp -a /home/accel-kitchen/.nvm/versions/node/v22.23.4 /opt/node-v22.23.4
sudo chown -R root:root /opt/node-v22.23.4
/opt/node-v22.23.4/bin/node -v        # v22.23.4 と出ること
```
別の版にするときは、`cosmicray-v3.service`、`cosmicray-v3-backup.service` の `ExecStart` と、`deploy.sh` の `NODE_DIR`（環境変数でも指定できます）を合わせて変えます。

### 4. VPS: 環境ファイル
```bash
sudo cp env.example /etc/cosmicray/env        # 雛形をコピー
sudo chown root:cosmicray /etc/cosmicray/env && sudo chmod 0640 /etc/cosmicray/env
echo "JWT_SECRET を入れます（値は画面にも会話にも出さない）:"
sudo sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$(openssl rand -base64 48 | tr -d '\n')|" /etc/cosmicray/env
sudoedit /etc/cosmicray/env                   # SCRYPT_CONCURRENCY を調査結果に合わせる
```

### 5. VPS: ユニットを入れて、初回のデプロイ
ユニットの `ExecStart`（node の場所）を調査結果に直してから入れます。まだ起動しません。
```bash
sudo cp cosmicray-v3.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable cosmicray-v3
sudo bash ./deploy.sh tarball /tmp/server-v0.1.0.tar.gz server-v0.1.0
```
`deploy.sh` が、展開 → `npm ci --omit=dev` → 読み込み確認 → 切り替え → 再起動 → `/healthz` が今回のコミットを返すかの確認まで行い、
失敗したら前のリリースに戻します（最初の 1 回だけは戻す先がないので、ログを見ます: `journalctl -u cosmicray-v3 -n 50`）。

### 5b. VPS: Node 22 で、テストを走らせる
手元では Node 24 でしかテストしていません。展開した版の `test/` を、VPS の Node 22 で走らせます（データも秘密も使わず、`/tmp` だけに書きます）。
```bash
cd /opt/cosmicray-v3/current && /opt/node-v22.23.4/bin/node --test "test/*.test.js" 2>&1 | tail -15
```
`# pass 41` と `# fail 0` が出れば合格です（件数は版で変わります）。失敗したら、その出力を私に貼ってください。

### 6. VPS: 試験用の局
試験用のパスワードは、画面に出さず、ファイルに書かせます。
```bash
sudo -u cosmicray bash -c 'set -a; . /etc/cosmicray/env; set +a; cd /opt/cosmicray-v3/current && node scripts/seed-station.js acceptance-test'
sudo cat /var/lib/cosmicray/seed-acceptance-test.txt     # 手順 8 でログインするとき見る。終わったら消す
```

### 7. Apache と証明書
DNS（Value-Domain の A レコード `cosmicray` → 118.27.30.120）は設定済みです。
必要なモジュールは**すべて有効**なので、`a2enmod` は要りません。certbot は snap 版（更新タイマーあり）なので、更新の設定も要りません。
どの VirtualHost が既定で答えるかは、設定の前後に `sudo apache2ctl -S` で確認できます。**本番の `accel-kitchen.com` のサイトに触る前に、必ず `sudo apache2ctl configtest` を通してください。**
`apache-1-bootstrap.conf` の先頭のコメントのとおりに、証明書を取得します。
そのあと `apache-2-final.conf` の先頭のコメントのとおりに、本番の設定へ入れ替えます。
**この設定では、CORS のヘッダを Apache で付けません**（アプリだけが付けます。二重に付くとブラウザが拒否します）。

### 8. 確認

**8-1. `smoke.sh`（最初の確認）** どの PC からでも実行できます。
```powershell
bash smoke.sh
```
5 番目の確認は、偽の `X-Forwarded-For` を付けたログインを 12 回送り、429 が返ることを見ます（あなたの IP が 1 分ほどログインできなくなります）。
これが失敗する場合は、アプリが偽のヘッダを信じています。**公開しないでください。**

**8-2. 実ブラウザでの受け入れ試験（これが合格基準）**
本物の Console を使います: `https://accel-kitchen.com/app/cosmicray-monitor/`（新サーバーとは別オリジンです）。
1. 「Server」欄に `https://cosmicray.accel-kitchen.com`、ID に `acceptance-test`、パスワードに手順 6 のものを入れて「Log in」。「Logged in as …」と出ること。
2. 送信を開始し、数イベントを送る（実機をつなぐか、デモ以外のイベントが要ります。デモのイベントは送られません）。Console の表示が `sent N / failed 0` になること。
3. サーバー側で行が増えていること:
   ```bash
   sudo tail -n 3 /var/lib/cosmicray/events/acceptance-test/$(date -u +%F).jsonl
   ```
4. 間違ったパスワードで、Console に「Invalid credentials」と出る（接続エラーではない）こと。
5. あなたの Chrome で、`file://` で開いた Console からも、間違ったパスワードで「Invalid credentials」が出ること（`Origin: null`）。

### 9. バックアップ
保存先は、**別のディスクか別のマシン**が望ましいです（決めてください）。決まったら `cosmicray-v3-backup.service` の 2 か所のパスを直して入れます。
```bash
sudo cp cosmicray-v3-backup.service cosmicray-v3-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now cosmicray-v3-backup.timer
sudo systemctl start cosmicray-v3-backup.service && journalctl -u cosmicray-v3-backup -n 5 --no-pager
```
**復元を一度は実際に試してください**（バックアップは、戻せて初めてバックアップです）:
`/var/backups/cosmicray/db/` の最新のスナップショットを別の場所の `db.sqlite` として置き、`events/` を `DATA_DIR/events/` へコピーし、
`DATA_DIR` をそこへ向けたアプリでログインできること。
参加者がアカウントの削除を求めたときは、バックアップ側（`events/` のミラー）からも消す必要があります（計画書の Q-N12）。

### 10. 更新とロールバック
更新は、コミット → 新しいタグ → 手順 2 → `sudo bash ./deploy.sh tarball …`。直近 5 件のリリースが残ります。
手で戻すとき:
```bash
ls -1dt /opt/cosmicray-v3/releases/*                       # 戻したい版を選ぶ
sudo ln -sfn /opt/cosmicray-v3/releases/<選んだ版> /opt/cosmicray-v3/current.new && sudo mv -T /opt/cosmicray-v3/current.new /opt/cosmicray-v3/current
sudo systemctl restart cosmicray-v3
```

## うまくいかないとき

| 症状 | 見るもの |
|---|---|
| 起動直後に落ちる | `journalctl -u cosmicray-v3 -n 50`。`JWT_SECRET is required…` なら環境ファイル。`EACCES`/`ProtectHome` なら node の場所 |
| `npm ci` が失敗する | ビルド道具と glibc（`better-sqlite3` の事前ビルド版が取れない場合）。出力をそのまま調査に回す |
| `smoke.sh` の 2 が `ACAO headers=2` | Apache の設定に CORS のヘッダが残っている。消す |
| `smoke.sh` の 2 が `204` でない | 転送がパス単位になっている／別の VirtualHost が先に応答している |
| `smoke.sh` の 5 が失敗 | Apache の手前に別のプロキシ（CDN など）がある。接続元の扱いを見直す |
| 全員のログインが 429 | 接続元がすべて `127.0.0.1` に見えている（`X-Forwarded-For` が付いていない） |
| Console が「サーバーにつながりません」 | 手順 8-2 の 4 と同じ確認。CORS ヘッダ、証明書、`https` で入れているか |
| 同じ症状で、CORS も証明書も正しい | **アプリが落ちている。** Apache が返す 502/503 には CORS のヘッダが付かないので、ブラウザには CORS の失敗に見える。`systemctl status cosmicray-v3` と `curl http://127.0.0.1:3100/healthz`（VPS 上）で確かめる |
