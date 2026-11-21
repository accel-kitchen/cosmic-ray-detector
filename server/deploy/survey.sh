#!/usr/bin/env bash
# Read-only survey of the VPS before cosmicray-v3 is installed.
# It changes nothing, installs nothing, restarts nothing, and writes only to its standard output.
#
#   sudo bash survey.sh > survey-report.md 2>&1
#
# Run it with sudo: without root it still works but cannot read the Apache configuration,
# the firewall or other users' files, and the report says which parts it could not read.
#
# Lines that look like secrets (password, secret, token, api key, private key) are replaced by
# "(redacted)", and users.json is never opened. This is a best-effort filter: read the report
# once before you paste it anywhere.
set -u
MAXLINES=${MAXLINES:-60}
FAILED=()

# A key name counts only at the start of a word (after a non-letter), so "ProxyPass" and "htpasswd"
# are left alone while "DB_PASSWORD", "--jwt-secret=" and "Authorization:" are caught.
# The second rule catches camelCase (dbPassword=...) without catching "ProxyPass".
red() {
  sed -E \
    -e 's/(^|[^A-Za-z])((pass(word)?|passwd|secret|token|api[_-]?key|private[_-]?key|credential|authorization)[A-Za-z_]*[[:space:]]*[=: ][[:space:]]*).*/\1\2(redacted)/I' \
    -e 's/([a-z](Password|Secret|Token|ApiKey|PrivateKey)[A-Za-z_]*[[:space:]]*[=: ][[:space:]]*).*/\1(redacted)/'
}
h()   { printf '\n## %s\n' "$*"; }

# check "what this shows" 'shell command'
check() {
  printf '\n**%s**\n```\n$ %s\n' "$1" "$2"
  local out rc
  out=$(bash -c "$2" 2>&1); rc=$?
  printf '%s\n' "$out" | head -n "$MAXLINES" | red
  if [ "$rc" -ne 0 ]; then
    printf '(exit status %s: could not run, or found nothing)\n' "$rc"
    FAILED+=("$1")
  fi
  printf '```\n'
}

echo "# VPS survey for cosmicray-v3"
echo
echo "- taken: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "- host: $(hostname)"
echo "- run as: $(id -un) (uid $(id -u)); root: $([ "$(id -u)" -eq 0 ] && echo yes || echo NO, so some parts below cannot be read)"
echo "- this script is read-only; secrets-looking lines are redacted"

h "A. Machine"
check "OS, kernel, uptime"            'head -4 /etc/os-release; uname -srm; uptime'
check "Memory and swap (MiB)"         'free -m'
check "Disk"                          'df -h / /var /opt /tmp'
check "CPUs"                          'nproc'
check "systemd, and is the journal kept across reboots?" 'systemctl --version | head -1; ls -d /var/log/journal'
check "Time zone and clock sync"      'timedatectl | head -8'

h "B. Node.js and build tools"
check "node and npm on PATH"          'which -a node npm; node -v; npm -v'
check "Where node really lives, and can another user run it?" 'p=$(readlink -f "$(command -v node)"); echo "$p"; namei -l "$p"'
check "Other node installs"           'ls -d /usr/local/bin/node /usr/bin/node /opt/*/bin/node /home/*/.nvm/versions/node/* /root/.nvm/versions/node/*'
check "Tools" 'for c in gcc make python3 git curl tar rsync openssl sqlite3 certbot; do printf "%s: " $c; command -v $c || echo "not installed"; done; ldd --version | head -1'

h "C. Apache and certificates"
check "Apache version"                'apache2 -v'
check "Modules we need (proxy proxy_http headers ssl rewrite) and remoteip"  'apache2ctl -M | grep -E "proxy|headers|ssl|rewrite|remoteip"'
check "Enabled sites"                 'ls -la /etc/apache2/sites-enabled/'
MAXLINES=400 check "Contents of every enabled site (secrets redacted)" 'for f in /etc/apache2/sites-enabled/*; do echo "### $f"; cat "$f"; echo; done'
# grep -R, not -r: the files in sites-enabled/ are symbolic links, which -r does not follow.
check "Proxy, rewrite, header and size rules anywhere in the Apache config" 'grep -RnE "ProxyPass|ProxyPassMatch|RewriteRule|Header .*Access-Control|LimitRequestBody|RemoteIP|RequestHeader|ServerName|ServerAlias" /etc/apache2/sites-enabled /etc/apache2/conf-enabled'
check "Is mod_remoteip configured? (it rewrites the client address the app would see)" 'grep -RnE "RemoteIP|ProxyAddHeaders" /etc/apache2/apache2.conf /etc/apache2/conf-enabled /etc/apache2/mods-enabled /etc/apache2/sites-enabled'
check "Virtual hosts as Apache sees them (which one answers by default)" 'apache2ctl -S'
check "Is the new host name already used?" 'grep -Rn "cosmicray.accel-kitchen.com" /etc/apache2'
check "What /usr/local/bin/node is" 'ls -l /usr/local/bin/node'
check "How certificates are issued" 'certbot --version; ls /etc/letsencrypt/live; ls -la /etc/letsencrypt/options-ssl-apache.conf; systemctl list-timers --all | grep -iE "certbot|acme"; ls /root/.acme.sh /home/*/.acme.sh'
check "Anything in front of Apache? (headers our own site returns)" 'curl -sI -m 10 https://accel-kitchen.com/ | grep -iE "^(HTTP|server|via|x-cache|cf-|x-forwarded|strict-transport)"'
check "Apache log rotation (client addresses are in these logs)" 'cat /etc/logrotate.d/apache2; ls -la /var/log/apache2 | head -15'

h "D. Ports, users, firewall"
check "Listening ports"               'ss -ltnp'
check "Is port 3100 free?"            'ss -ltn | grep -E ":3100[[:space:]]" && echo "3100 is IN USE" || echo "3100 is free"'
check "Relevant users"                'getent passwd | cut -d: -f1,3,6,7 | grep -E "cosmicray|accel|kaduo|www-data"'
check "Does a cosmicray user exist yet?" 'getent passwd cosmicray'
check "Firewall"                      'ufw status; nft list ruleset | head -30; iptables -S | head -20'
check "Is sudo usable without a password for this user? (informational)" 'sudo -n true && echo yes'

h "E. The old server (read-only look; users.json is never opened)"
check "How it runs, and as whom"      'ps -eo user,pid,etime,args | grep -E "node|pm2" | grep -v grep'
# The [o] keeps the pattern from matching this very command line.
check "Which node does it use?"       'pid=$(pgrep -f "[o]pt/cosmicray-server/server.js" | head -1); if [ -n "$pid" ]; then readlink -f /proc/$pid/exe; else echo "no cosmicray-server process visible to this user"; exit 1; fi'
check "Its directory (names, sizes, dates only)" 'ls -la /opt/cosmicray-server'
OLD=${OLD_DATA_DIR:-}      # set OLD_DATA_DIR=/path if the old data lives somewhere else
if [ -z "$OLD" ]; then
  for d in /opt/cosmicray-server/webserver/cosmicray-data /opt/cosmicray-server/cosmicray-data; do [ -d "$d" ] && OLD="$d" && break; done
fi
echo; echo "old data directory found: ${OLD:-none found}"
if [ -n "$OLD" ]; then
  check "Size of the old data"        "du -sh '$OLD'"
  check "Stations and the date of each one's newest file" "for d in '$OLD'/*/; do printf '%s  ' \"\$(basename \"\$d\")\"; find \"\$d\" -type f -printf '%TY-%Tm-%Td\\n' | sort | tail -1; done"
  check "Stations that wrote anything in the last 30 days (who to tell about the switch)" "find '$OLD' -type f -mtime -30 -printf '%h\\n' | sort -u | xargs -r -n1 basename"
fi

h "F. Mail (for the self-registration phase)"
check "Mail software"                 'systemctl is-active postfix exim4; command -v sendmail'
check "Can this host reach outside SMTP ports? (587 submission, 25)" 'timeout 5 bash -c "</dev/tcp/smtp.gmail.com/587" && echo "587 ok" || echo "587 blocked"; timeout 5 bash -c "</dev/tcp/gmail-smtp-in.l.google.com/25" && echo "25 ok" || echo "25 blocked"'

h "Could not read or run"
if [ "${#FAILED[@]}" -eq 0 ]; then
  echo "(everything ran)"
else
  printf -- '- %s\n' "${FAILED[@]}"
  echo
  echo "Some of these are normal (for example 'no ufw', or a path that does not exist on this machine)."
  echo "Run again with sudo if any of them need root."
fi
