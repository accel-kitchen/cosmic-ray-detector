<#
.SYNOPSIS
  Deploys a tagged server release to the VPS from this PC, in one command.

.DESCRIPTION
  1. makes the tarball of the tag (git archive; nothing has to be pushed),
  2. copies it to the VPS (scp),
  3. runs deploy.sh there (sudo: you type the sudo password once) and then smoke.sh.

  Nothing is run on the VPS if the tag does not exist or the tarball cannot be made. If deploy.sh fails its
  health check it puts the previous release back by itself (see deploy/README.md); smoke.sh is then not run.
  This script never touches the database or the environment file, and it does not put stations on the map.

.EXAMPLE
  powershell -File server\deploy\deploy-remote.ps1                    # the newest server-v* tag, after a question
  powershell -File server\deploy\deploy-remote.ps1 -Tag server-v0.3.12
  powershell -File server\deploy\deploy-remote.ps1 -DryRun            # makes the tarball and prints what it would run
#>
param(
  [string]$Tag,                                  # default: the newest server-vX.Y.Z tag
  [string]$VpsUser = 'kaduo',
  [string]$VpsHost = 'accel-kitchen.com',
  [int]$Port = 3465,
  [switch]$Yes,                                  # do not ask before deploying
  [switch]$DryRun                                # build the tarball, print the commands, connect to nothing
)
$ErrorActionPreference = 'Stop'

$repo = (& git -C $PSScriptRoot rev-parse --show-toplevel).Trim()
if ($LASTEXITCODE -ne 0 -or -not $repo) { throw 'not inside the git repository' }

if (-not $Tag) {
  $Tag = (& git -C $repo tag --list 'server-v*' --sort=-v:refname | Select-Object -First 1)
  if (-not $Tag) { throw 'no server-v* tag found' }
}
if ($Tag -notmatch '^server-v\d+\.\d+\.\d+$') { throw "the tag must look like server-v0.3.12 (got: $Tag)" }
& git -C $repo rev-parse --verify --quiet "refs/tags/$Tag^{commit}" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "no such tag: $Tag" }

$commit = (& git -C $repo rev-parse --short "$Tag^{commit}").Trim()
$head = (& git -C $repo rev-parse --short HEAD).Trim()
$subject = (& git -C $repo log -1 --format=%s "$Tag^{commit}").Trim()
Write-Host "Release : $Tag  ($commit)  $subject"
if ($commit -ne $head) { Write-Host "Note    : HEAD is $head, not the tag. The tag is what gets deployed." -ForegroundColor Yellow }
Write-Host "To      : $VpsUser@$VpsHost (ssh port $Port)"

# The tarball goes to a folder of its own, not into the repository.
$work = Join-Path ([System.IO.Path]::GetTempPath()) ("crd-deploy-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $work | Out-Null
$name = "$Tag.tar.gz"
$tar = Join-Path $work $name
try {
  & git -C $repo archive --format=tar.gz -o $tar $Tag server
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $tar)) { throw 'git archive failed' }
  $kb = [math]::Round((Get-Item $tar).Length / 1KB)
  Write-Host "Tarball : $name ($kb KB)"

  # $Tag was checked against a strict pattern above, so it can go into the remote command as it is.
  $remote = "cd /tmp/deploy && sudo bash ./deploy.sh tarball /tmp/$name $Tag && bash smoke.sh"
  if ($DryRun) {
    Write-Host ''
    Write-Host 'Dry run. It would run:'
    Write-Host "  scp -P $Port $name ${VpsUser}@${VpsHost}:/tmp/"
    Write-Host "  ssh -t -p $Port ${VpsUser}@${VpsHost} `"$remote`""
    return
  }

  if (-not $Yes) {
    $a = Read-Host 'Deploy this release to the VPS now? (y/N)'
    if ($a -notmatch '^[yY]') { Write-Host 'Stopped. Nothing was sent.'; return }
  }

  Write-Host "`n== copying"
  & scp -P $Port $tar "${VpsUser}@${VpsHost}:/tmp/"
  if ($LASTEXITCODE -ne 0) { throw 'scp failed. Nothing was deployed.' }

  Write-Host "`n== deploying (the sudo password is asked once), then the smoke test"
  & ssh -t -p $Port "${VpsUser}@${VpsHost}" $remote
  $code = $LASTEXITCODE
  if ($code -ne 0) {
    Write-Host "`nFAILED (exit code $code). Read the output above: deploy.sh puts the previous release back when its health check fails." -ForegroundColor Red
    exit $code
  }
  Write-Host "`nDone: $Tag is deployed and the smoke test passed. Still to do by hand: the real-browser test." -ForegroundColor Green
}
finally {
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
