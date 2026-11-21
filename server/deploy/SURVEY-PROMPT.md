# サーバー側 Claude への調査依頼（貼り付け用）

VPS で新しいサーバーを動かす前の**読み取り調査**です。以下の枠内を、そのまま貼ります。
前回（旧サーバーの更新）の教訓を踏まえ、権限のないことをする必要がないように書いてあります。

```text
これは「調べるだけ」の依頼です。何も変更せず、何もインストールせず、サービスを再起動しないでください。

【目的】
この VPS（accel-kitchen.com）に、新しい Node.js のサーバー（cosmicray-v3）を、専用ユーザー + systemd + Apache のリバースプロキシで動かします。
その設定を確定するために、現状を調べてください。設定を書くのは私です。あなたは事実だけを集めてください。

【前提と制約】
- 前回、あなたの実行ユーザーは kaduo で、sudo にパスワードが要り、pm2 は PATH にありませんでした。
  今回も、権限の回避（sudo -u での切り替えなど）はしないでください。
- 読めなかったもの、実行できなかったコマンドは、推測せず、「読めなかった（理由）」と書いてください。
  そのリストは、私が root で確認し直します。
- 次のものは、出力にも報告にも書かないでください: JWT_SECRET などの秘密の値、パスワード、秘密鍵、トークン、
  users.json の中身、環境変数の値。設定ファイルを写すときは、秘密に見える行は「(省略)」にしてください。
- sudo を使えるかどうかは、sudo -n true が通るかだけを確認してください（パスワードは入力しない）。

【調べること】
A. マシン
   - OS（/etc/os-release）、カーネル、アーキテクチャ、稼働時間。
   - メモリと swap（free -m）、ディスクの空き（df -h）、CPU の数（nproc）、負荷（uptime）。
   - systemd が使えるか（systemctl --version）、journald が永続化されているか（/var/log/journal があるか）。
   - タイムゾーンと時刻の同期（timedatectl）。
B. Node.js
   - which -a node npm、node -v、npm -v。インストール方法の見当（apt か、nvm か、tarball か）。
   - node の実体のパスが /home の下にないか。ある場合、そのパスの各階層が「他のユーザーから実行できる」権限か
     （namei -l <実体のパス> の結果）。
   - ビルド道具: gcc、make、python3 があるか。glibc の版（ldd --version の 1 行目）。
     （better-sqlite3 は通常、ビルド済みのバイナリを取得しますが、取得できないときの備えです）
   - git、curl、tar、rsync、openssl、sqlite3 があるか（あるかどうかだけ）。
C. Apache
   - apache2 -v。有効なモジュールに proxy、proxy_http、headers、ssl、rewrite があるか
     （apache2ctl -M が使えなければ /etc/apache2/mods-enabled/ を見る）。
   - /etc/apache2/sites-enabled/ の一覧と、各ファイルの内容の写し（秘密に見える行は省略）。
     特に、旧サーバー向けの ProxyPass / ProxyPassMatch / RewriteRule（どのパスを 127.0.0.1:3000 に転送しているか）、
     Header ... Access-Control の有無、LimitRequestBody、SSLCertificateFile のパス。
   - cosmicray.accel-kitchen.com という名前を使っている VirtualHost が、すでにあるか。
   - 証明書の発行方法: certbot があるか（certbot --version）、/etc/letsencrypt/live/ の一覧（名前だけ）、
     certbot の更新タイマー（systemctl list-timers | grep -i certbot）、/etc/letsencrypt/options-ssl-apache.conf があるか。
     certbot でない場合（acme.sh など）は、その手がかり。
   - Apache の手前に CDN やロードバランサーがあるか。この VPS から自分のサイトを読んで、応答ヘッダを見る:
       curl -sI https://accel-kitchen.com/ | grep -iE "^(server|via|x-cache|cf-|x-forwarded|strict-transport)"
     （Cloudflare などを示すヘッダの有無）
   - Apache のログの置き場所と、ローテーション（/etc/logrotate.d/apache2 の rotate と保持日数）。
     ログにはクライアントの IP が残るので、保持期間を知りたいのです。
D. ポートとユーザー
   - 待ち受けているポート（ss -ltnp。他ユーザーのプロセス名が見えなくても、ポート番号は分かります）。
     特に 3100 が空いているか。旧サーバー（3000）の待ち受けアドレス。
   - 既存のユーザー: getent passwd | cut -d: -f1,3,6,7 のうち、cosmicray という名前があるか、
     accel-kitchen の UID とホーム。
   - ファイアウォール: ufw status や nft list ruleset が読めれば要点（読めなければ「読めなかった」）。
E. 旧サーバー（cosmicray-server、読み取りだけ）
   - プロセスの様子: ps -eo user,pid,etime,args | grep -E "node|pm2" | grep -v grep（コマンドラインに秘密があれば省略）。
   - /opt/cosmicray-server の中身の一覧（ファイル名、大きさ、更新日時。users.json の中身は読まない）。
   - データの置き場所（cosmicray-data/ など）の合計サイズ（du -sh）。
   - 局のディレクトリ名の一覧と、各局の最新ファイルの更新日時（名前と日時だけ）。
     直近 30 日に更新があった局を、別に挙げてください（誰が送信中かを知るためです）。
   - 旧サーバーの Node のバージョン（PM2 の管理下のプロセスが使っている node のパス）。
F. メール（Phase 3 の準備。あるかどうかだけ）
   - postfix や exim が入っているか、動いているか（systemctl is-active postfix）。
   - sendmail コマンドがあるか。
   - この VPS から外向きの 25 番・587 番に接続できるか（timeout 5 bash -c '</dev/tcp/smtp.gmail.com/587' && echo ok）。

【報告の形】
下の見出しのまま、事実だけを Markdown で書いてください。各項目に、実行したコマンドと、その結果を要約して添えてください。
読めなかったものは「読めなかった（理由）」。最後に、次の 3 つを必ず書いてください。
1. 読めなかった・実行できなかったものの一覧（私が root で確認し直すもの）。
2. 私の想定と違った点。
3. 新サーバーを動かすうえで、危なそうに見えた点（根拠つきで。推測は「推測」と書く）。

見出し: A マシン / B Node.js / C Apache / D ポートとユーザー / E 旧サーバー / F メール / 最後の 3 点
```

## 返ってきた報告の使い方

- **B** → `cosmicray-v3.service` の `ExecStart` と `ProtectHome`。node が `/home` の下なら、`/usr/local` などへの入れ直しか、ユニットの方針の見直しが要ります。
- **A** → `SCRYPT_CONCURRENCY`（1 回約 128 MiB）と `MemoryMax`。
- **C** → `apache-1/2` の `a2enmod`、証明書の取り方、既存の転送設定との衝突、手前のプロキシの有無（`smoke.sh` の 5 の意味が変わります）。
- **D** → ポート 3100、ユーザー名。
- **E** → 旧データの移行（Phase 4）の見積もり。直近 30 日に送った局が、切り替えを知らせる相手です。
- **F** → Phase 3 のメール送信方法（Q-N1）。
