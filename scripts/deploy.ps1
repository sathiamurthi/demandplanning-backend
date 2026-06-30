# =============================================================
# deploy.ps1  --  DemandGenius full deployment script
#
# Deploys backend (Render) and/or frontend (Vercel).
# Safe to re-run -- all state is derived from the project.
#
# SETUP (one-time):
#   1. Copy  enterprise-final/scripts/.env.deploy.example
#      to    enterprise-final/scripts/.env.deploy
#   2. Fill in the tokens (see .env.deploy.example for sources)
#
# USAGE (run from any directory):
#   cd d:\Applications\DemandPlanning\enterprise-final
#   .\scripts\deploy.ps1                         # deploy both
#   .\scripts\deploy.ps1 -Target backend         # backend only
#   .\scripts\deploy.ps1 -Target frontend        # frontend only
#   .\scripts\deploy.ps1 -SkipTests              # skip smoke tests
#   .\scripts\deploy.ps1 -DryRun                 # print plan, no changes
#   .\scripts\deploy.ps1 -CommitMsg "my message" # custom git commit msg
#
# WHAT IT DOES:
#   Backend  -> git commit (if dirty) -> push GitHub -> Render deploy -> wait live
#   Frontend -> git commit (if dirty) -> npx vercel --prod
#   Smoke    -> /v1/health + superadmin login + /api/* proxy check
#
# REQUIREMENTS:
#   - Node.js / npx in PATH
#   - enterprise-final/scripts/.env.deploy  (gitignored)
# =============================================================
param(
    [ValidateSet("both","backend","frontend")]
    [string]$Target    = "both",
    [switch]$SkipTests,
    [switch]$DryRun,
    [string]$CommitMsg = ""
)

$ErrorActionPreference = "Stop"

# ---- Resolve directories ------------------------------------
$SCRIPT_DIR   = $PSScriptRoot
$BACKEND_DIR  = (Resolve-Path (Join-Path $SCRIPT_DIR "..")).Path
$FRONTEND_DIR = (Resolve-Path (Join-Path $BACKEND_DIR "..\frontend")).Path

# ---- Load .env.deploy ---------------------------------------
$envFile = Join-Path $SCRIPT_DIR ".env.deploy"
if (-not (Test-Path $envFile)) {
    Write-Host ""
    Write-Host "ERROR: $envFile not found." -ForegroundColor Red
    Write-Host "       Copy .env.deploy.example and fill in your tokens." -ForegroundColor Yellow
    Write-Host ""
    exit 1
}
$cfg = @{}
Get-Content $envFile | Where-Object { $_ -match "^[A-Z_]" -and $_ -notmatch "^#" } | ForEach-Object {
    $parts = $_ -split "=", 2
    if ($parts.Count -eq 2) { $cfg[$parts[0].Trim()] = $parts[1].Trim() }
}

foreach ($key in @("RENDER_TOKEN","VERCEL_TOKEN","RENDER_SVC_ID","VERCEL_TEAM")) {
    if (-not $cfg.ContainsKey($key) -or -not $cfg[$key]) {
        Write-Host "ERROR: $key missing in .env.deploy" -ForegroundColor Red; exit 1
    }
}

$RENDER_TOKEN  = $cfg["RENDER_TOKEN"]
$VERCEL_TOKEN  = $cfg["VERCEL_TOKEN"]
$VERCEL_TEAM   = $cfg["VERCEL_TEAM"]
$RENDER_SVC_ID = $cfg["RENDER_SVC_ID"]
if ($cfg.ContainsKey("BACKEND_URL"))  { $BACKEND_URL  = $cfg["BACKEND_URL"]  } else { $BACKEND_URL  = "https://demandplanning-backend.onrender.com" }
if ($cfg.ContainsKey("FRONTEND_URL")) { $FRONTEND_URL = $cfg["FRONTEND_URL"] } else { $FRONTEND_URL = "https://demandgenius.vercel.app" }

# ---- Helpers ------------------------------------------------
function hdr  { param($n,$m) Write-Host "`n[$n] $m" -ForegroundColor Cyan }
function ok   { param($m)    Write-Host "  OK  $m"  -ForegroundColor Green }
function info { param($m)    Write-Host "  ..  $m"  -ForegroundColor Gray }
function warn { param($m)    Write-Host "  !!  $m"  -ForegroundColor Yellow }
function fail { param($m)    Write-Host "  FAIL $m" -ForegroundColor Red; exit 1 }

function Invoke-Git {
    param([string]$Dir, [string[]]$GitArgs)
    # Do NOT use 2>&1 -- in PS5.1 it wraps stderr as NativeCommandError records
    # which trigger Stop even when the process exits 0 (e.g. "Everything up-to-date").
    # Stderr goes straight to host (visible to user). LASTEXITCODE reflects real exit code.
    $savedPref = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $out = & git -C $Dir @GitArgs
    $ec  = $LASTEXITCODE
    $ErrorActionPreference = $savedPref
    if ($ec -ne 0) { fail "git $($GitArgs -join ' ') failed (exit $ec)" }
    return ($out -join "`n")
}

function Get-GitDirty {
    param([string]$Dir)
    $s = & git -C $Dir status --porcelain 2>&1
    return ($null -ne $s -and $s.ToString().Trim() -ne "")
}

# ---- Dry run ------------------------------------------------
if ($DryRun) {
    Write-Host ""
    Write-Host "  [DRY RUN] No changes will be made." -ForegroundColor Yellow
    Write-Host "  Backend  dir : $BACKEND_DIR"
    Write-Host "  Frontend dir : $FRONTEND_DIR"
    Write-Host "  Target       : $Target"
    Write-Host "  Backend URL  : $BACKEND_URL"
    Write-Host "  Frontend URL : $FRONTEND_URL"
    Write-Host ""
    exit 0
}

$started = Get-Date

# ====================================================================
# BACKEND
# ====================================================================
if ($Target -eq "both" -or $Target -eq "backend") {

    hdr 1 "Backend -- git commit + push"
    if (Get-GitDirty $BACKEND_DIR) {
        $msg = if ($CommitMsg) { $CommitMsg } else { "chore: deploy $(Get-Date -Format 'yyyy-MM-dd HH:mm')" }
        Invoke-Git $BACKEND_DIR @("add","-A") | Out-Null
        & git -C $BACKEND_DIR commit -m $msg
        if ($LASTEXITCODE -ne 0) { fail "git commit failed" }
        ok "Committed: $msg"
    } else {
        info "Nothing to commit -- using current HEAD"
    }
    Invoke-Git $BACKEND_DIR @("push","origin","main") | Out-Null
    $backendSha = (Invoke-Git $BACKEND_DIR @("rev-parse","--short","HEAD")).ToString().Trim()
    ok "Pushed $backendSha to GitHub"

    hdr 2 "Backend -- trigger Render deploy"
    $rHdr = @{ "Authorization" = "Bearer $RENDER_TOKEN"; "Content-Type" = "application/json" }
    try {
        $dep = Invoke-RestMethod -Method POST `
            -Uri "https://api.render.com/v1/services/$RENDER_SVC_ID/deploys" `
            -Headers $rHdr -Body '{"clearCache":"do_not_clear"}' -TimeoutSec 30
        $deployId = $dep.id
        ok "Deploy triggered: $deployId"
    } catch {
        fail "Render API error: $_"
    }

    hdr 3 "Backend -- waiting for Render live (up to 8 min)"
    $deadline   = (Get-Date).AddMinutes(8)
    $lastStatus = ""
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 15
        try {
            $d = Invoke-RestMethod -Method GET `
                -Uri "https://api.render.com/v1/services/$RENDER_SVC_ID/deploys/$deployId" `
                -Headers $rHdr -TimeoutSec 15
            $st = $d.status
            if ($st -ne $lastStatus) { info "Render: $st"; $lastStatus = $st }
            if ($st -eq "live")          { ok "Backend LIVE"; break }
            if ($st -eq "update_failed") { fail "Render deploy failed" }
            if ($st -eq "build_failed")  { fail "Render build failed" }
        } catch {
            warn "Poll error (retrying): $_"
        }
    }
    if ($lastStatus -ne "live") { fail "Timed out waiting for Render (last: $lastStatus)" }
}

# ====================================================================
# FRONTEND
# ====================================================================
if ($Target -eq "both" -or $Target -eq "frontend") {

    hdr 4 "Frontend -- git commit + push"
    if (Get-GitDirty $FRONTEND_DIR) {
        $msg = if ($CommitMsg) { $CommitMsg } else { "chore: deploy $(Get-Date -Format 'yyyy-MM-dd HH:mm')" }
        Invoke-Git $FRONTEND_DIR @("add","-A") | Out-Null
        & git -C $FRONTEND_DIR commit -m $msg
        if ($LASTEXITCODE -ne 0) { fail "git commit failed" }
        ok "Committed: $msg"
    } else {
        info "Nothing to commit -- using current HEAD"
    }
    Invoke-Git $FRONTEND_DIR @("push","origin","main") | Out-Null
    $frontendSha = (Invoke-Git $FRONTEND_DIR @("rev-parse","--short","HEAD")).ToString().Trim()
    ok "Pushed $frontendSha to GitHub"

    hdr 5 "Frontend -- Vercel production deploy (takes ~2 min)"
    Push-Location $FRONTEND_DIR
    try {
        $proc = Start-Process -FilePath "npx" `
            -ArgumentList "vercel","--prod","--token",$VERCEL_TOKEN,"--scope",$VERCEL_TEAM,"--yes" `
            -NoNewWindow -Wait -PassThru
        if ($proc.ExitCode -ne 0) { fail "Vercel deploy exited $($proc.ExitCode)" }
        ok "Vercel deploy complete --> $FRONTEND_URL"
    } finally {
        Pop-Location
    }
}

# ====================================================================
# SMOKE TESTS
# ====================================================================
if (-not $SkipTests) {

    hdr 6 "Smoke tests"

    # 1. Backend health
    info "Backend /v1/health ..."
    try {
        $h = Invoke-RestMethod "$BACKEND_URL/v1/health" -TimeoutSec 20
        if ($h.status -eq "ok") {
            ok "Backend OK -- version=$($h.version) uptime=$([math]::Round($h.uptime))s"
        } else {
            warn "Backend health: $($h.status)"
        }
    } catch { warn "Backend health failed: $_" }

    # 2. Superadmin login
    info "Superadmin login ..."
    $loginToken = $null
    try {
        $lr = Invoke-RestMethod -Method POST "$BACKEND_URL/v1/auth/login" `
            -ContentType "application/json" `
            -Body '{"email":"superadmin@genericdemandai.com","password":"Admin@123"}' `
            -TimeoutSec 20
        if ($lr.data)          { $loginToken = $lr.data.accessToken }
        elseif ($lr.accessToken) { $loginToken = $lr.accessToken }
        if ($loginToken) { ok "Superadmin login OK" } else { warn "Login returned no token" }
    } catch { warn "Login failed: $_" }

    # 3. Tenants list (requires auth)
    if ($loginToken) {
        info "Superadmin tenants ..."
        try {
            $aHdr = @{ Authorization = "Bearer $loginToken" }
            $tr   = Invoke-RestMethod "$BACKEND_URL/v1/superadmin/tenants" -Headers $aHdr -TimeoutSec 20
            $tArr = if ($tr.data) { $tr.data } else { $tr }
            ok "Tenants: $($tArr.Count) found"
        } catch { warn "Tenants check failed: $_" }
    }

    # 4. Frontend /v1/* proxy
    info "Frontend /v1/health proxy ..."
    try {
        $fh = Invoke-RestMethod "$FRONTEND_URL/v1/health" -TimeoutSec 20
        if ($fh.status -eq "ok") { ok "Frontend /v1/* proxy OK" } else { warn "Proxy: $($fh.status)" }
    } catch { warn "Frontend /v1/* proxy failed: $_" }

    # 5. Frontend /api/* proxy -- must hit backend (401 = OK, 404 = broken)
    info "Frontend /api/* proxy (admin panel route) ..."
    try {
        $null = Invoke-WebRequest "$FRONTEND_URL/api/tenants/probe/categories" `
            -TimeoutSec 20 -UseBasicParsing
        warn "Unexpected 2xx on unauthenticated /api/* probe -- check auth middleware"
    } catch {
        $resp = $_.Exception.Response
        if ($null -ne $resp) {
            $code = [int]$resp.StatusCode
            if ($code -eq 401) {
                ok "/api/* proxy OK (401 -- backend reached, auth working)"
            } elseif ($code -eq 404) {
                warn "/api/* proxy BROKEN (404 -- check next.config.ts /api rewrite)"
            } else {
                warn "/api/* proxy returned HTTP $code"
            }
        } else {
            warn "/api/* probe error (no HTTP response): $_"
        }
    }
}

# ====================================================================
# DONE
# ====================================================================
$elapsed = [math]::Round(((Get-Date) - $started).TotalSeconds)
Write-Host ""
Write-Host "=================================================" -ForegroundColor Green
Write-Host "  Deployment complete  ($elapsed s)  [$Target]"    -ForegroundColor Green
Write-Host "=================================================" -ForegroundColor Green
Write-Host "  Frontend  : $FRONTEND_URL"
Write-Host "  Backend   : $BACKEND_URL"
Write-Host "  Superadmin: $FRONTEND_URL/superadmin"
Write-Host "  Health    : $BACKEND_URL/v1/health"
Write-Host ""
