# Isolated end-to-end test of searxng_scholar in a REAL, SEPARATE dsh process.
#
# IMPORTANT: keep this file pure ASCII. Windows PowerShell 5.1 decodes BOM-less
# scripts with the system ANSI codepage, and a tool rewrite may strip a BOM --
# ASCII is the only encoding-proof choice.
#
# What it does (all state lives under ~/.dsh/profiles/headless and a scratch
# workspace -- the running web GUI, its port, and its sessions are untouched):
#   1. sanity-check the LLM API key is reachable by the child process
#   2. provision the shipped `headless` profile and link this plugin into it
#      (idempotent; re-running is a no-op)
#   3. run `dsh --profile headless "<task>"` from a scratch workspace -- a
#      one-shot process: no port, one task, prints the answer, exits
#      (exit 0 = the turn completed; the tool list is assembled at boot, so
#      this process loads the FIXED plugin code, unlike the running GUI)
#   4. validate the session log the scratch run produced through the host
#      restore gate (scripts/check-session-log.mjs)
#
# Usage:  powershell -File scripts/dsh-headless-test.ps1 [-Query "..."] [-KeepWorkspace]
#
# Prereqs: the child process must see ZAI_CODING_CN_API_KEY -- either set in
# your shell, or put `ZAI_CODING_CN_API_KEY=...` in ~/.dsh/.env (the `user`
# env layer dsh loads on every boot).
param(
  [string]$Query = 'CRISPR base editing review',
  [string]$Workspace = (Join-Path $env:TEMP 'dsh-scholar-headless-test'),
  [switch]$KeepWorkspace
)
$ErrorActionPreference = 'Stop'

# --- 1. API key reachability for the child process -----------------------------
$dshHome = Join-Path $env:USERPROFILE '.dsh'
$envFile = Join-Path $dshHome '.env'
$hasKey = [bool]$env:ZAI_CODING_CN_API_KEY -or ((Test-Path $envFile) -and (Select-String -Path $envFile -Pattern 'ZAI_CODING_CN_API_KEY' -Quiet))
if (-not $hasKey) {
  Write-Warning "ZAI_CODING_CN_API_KEY is neither in this shell nor in $envFile."
  Write-Warning "Create the file with one line:  ZAI_CODING_CN_API_KEY=<your key>  (it is the 'user' env layer dsh boots with), or set it in this shell first."
  exit 2
}

# --- 2. headless profile + this plugin (idempotent) ---------------------------
$pluginDir = (Get-Item (Join-Path $PSScriptRoot '..')).FullName
Write-Host "==> linking plugin into the headless profile: $pluginDir"
dsh plugin --profile headless add "link:$($pluginDir -replace '\\','/')"
if ($LASTEXITCODE -ne 0) { throw "dsh plugin add failed ($LASTEXITCODE)" }

$manifestPath = Join-Path $dshHome 'profiles\headless\package.json'
node -e "const f=process.argv[1];const m=require('node:fs').readFileSync(f,'utf8');const j=JSON.parse(m);j.dsh=j.dsh||{};j.dsh.profile=j.dsh.profile||{bundles:[]};const b=j.dsh.profile.bundles;if(!b.includes('dsh-web-search-searxng'))b.push('dsh-web-search-searxng');require('node:fs').writeFileSync(f,JSON.stringify(j,null,2)+'\n');console.log('bundles: '+b.join(', '))" $manifestPath
if ($LASTEXITCODE -ne 0) { throw "manifest edit failed" }

# --- 3. one-shot headless run from the scratch workspace ----------------------
New-Item -ItemType Directory -Force $Workspace | Out-Null
Write-Host ""
Write-Host "==> headless run in scratch workspace: $Workspace"
Push-Location $Workspace
try {
  $task = "Use ONLY the searxng_scholar tool to search the academic topic `"$Query`" (max_results = 3), then summarize the findings in at most three sentences. Do not use any other tool."
  dsh --profile headless $task
  $runCode = $LASTEXITCODE
} finally { Pop-Location }
Write-Host ""
Write-Host "==> headless exit code: $runCode"

# --- 4. restore-gate validation of the scratch session log ---------------------
# Layout: sessions/<workspace-slug>/session-<uuid>/session.jsonl[.zstd]
$bucket = Get-ChildItem (Join-Path $dshHome 'sessions') -Directory |
  Where-Object Name -like '*dsh-scholar-headless-test*' |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
$log = $null
if ($bucket) {
  $sessionDir = Get-ChildItem $bucket.FullName -Directory -Filter 'session-*' |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($sessionDir) {
    $log = @('session.jsonl.zstd', 'session.jsonl') |
      ForEach-Object { Join-Path $sessionDir.FullName $_ } |
      Where-Object { Test-Path $_ } |
      Select-Object -First 1
  }
}
if ($log) {
  Write-Host ""
  Write-Host "==> validating $log"
  node (Join-Path $PSScriptRoot 'check-session-log.mjs') $log
  $checkCode = $LASTEXITCODE
} else {
  $where = '<no scratch bucket found>'
  if ($bucket) { $where = $bucket.FullName }
  Write-Warning "no session log found under $where -- the run may not have started a session"
  $checkCode = 1
}

if (-not $KeepWorkspace) { Remove-Item $Workspace -Recurse -Force -ErrorAction SilentlyContinue }
exit [math]::Max($runCode, $checkCode)
