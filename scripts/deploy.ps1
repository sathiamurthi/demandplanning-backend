# =============================================================
# deploy.ps1  —  End-to-end deployment
# 1. Push backend to GitHub  →  trigger Render deploy
# 2. Push frontend to Vercel CLI  (fresh build)
# 3. Wait for Render to go live
# 4. Smoke-test health + login
#
# REQUIRES: scripts\.env.deploy  (gitignored, not committed)
#
# USAGE:
#   .\scripts\deploy.ps1                        # deploy both
#   .\scripts\deploy.ps1 -Target backend        # backend only
#   .\scripts\deploy.ps1 -Target frontend       # frontend only
#   .\scripts\deploy.ps1 -SkipTests             # skip smoke tests
# =============================================================
param(
    [ValidateSet("both","backend","frontend")]
    [string]$Target   = "both",
    [switch]$SkipTests
)

$ErrorActionPreference = "Stop"

# ── Load secrets from .env.deploy ────────────────────────────
$envFile = Join-Path $PSScriptRoot ".env.deploy"
if (-not (Test-Path $envFile)) {
    Write-Host "ERROR: $envFile not found. Copy .env.deploy.example and fill in tokens." -ForegroundColor Red
    exit 1
}
$secrets = @{}
Get-Content $envFile | Where-Object { $_ -match "^[A-Z]" -and $_ -notmatch "^#" } | ForEach-Object {
    $p = $_ -split "=", 2; if ($p.Count -eq 2) { $secrets[$p[0].Trim()] = $p[1].Trim() }
}

$RENDER_TOKEN  = $secrets["RENDER_TOKEN"]
$VERCEL_TOKEN  = $secrets["VERCEL_TOKEN"]
$VERCEL_TEAM   = $secrets["VERCEL_TEAM"]
$RENDER_SVC_ID = $secrets["RENDER_SVC_ID"]
$BACKEND_URL   = $secrets["BACKEND_URL"]   ?? "https://demandplanning-backend.onrender.com"
$FRONTEND_URL  = $secrets["FRONTEND_URL"]  ?? "https://demandgenius.vercel.app"
$FRONTEND_DIR  = Join-Path $PSScriptRoot "..\..\frontend"
$BACKEND_DIR   = Join-Path $PSScriptRoot ".."

# ── Helpers ───────────────────────────────────────────────────
function Write-Step { param($n,$msg) Write-Host "`n[$n] $msg" -ForegroundColor Cyan }
function Write-OK   { param($msg)    Write-Host "     $msg" -ForegroundColor Green }
function Write-Info { param($msg)    Write-Host "     $msg" -ForegroundColor Gray }
function Write-Fail { param($msg)    Write-Host "     FAIL: $msg" -ForegroundColor Red; exit 1 }

$started = Get-Date

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# BACKEND
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
if ($Target -in "both","backend") {

    Write-Step 1 "Backend — TypeScript build check"
    Push-Location $BACKEND_DIR
    try {
        $tscOut = npx tsc --noEmit 2>&1
        if ($LASTEXITCODE -ne 0) { Write-Fail "TypeScript errors:`n$tscOut" }
        Write-OK "No TypeScript errors"
    } finally { Pop-Location }

    Write-Step 2 "Backend — git commit + push"
    Push-Location $BACKEND_DIR
    try {
        $changes = git status --porcelain
        if ($changes) {
            git add -A
            $ts = Get-Date -Format "yyyy-MM-dd HH:mm"
            git commit -m "chore: deploy $ts"
            Write-OK "Committed changes"
        } else {
            Write-Info "Nothing to commit — pushing current HEAD"
        }
        git push origin main
        $commitSha = git rev-parse --short HEAD
        Write-OK "Pushed: $commitSha"
    } finally { Pop-Location }

    Write-Step 3 "Render — triggering deploy"
    $headers = @{ "Authorization" = "Bearer $RENDER_TOKEN"; "Content-Type" = "application/json" }
    $deploy  = Invoke-RestMethod -Method POST `
        -Uri "https://api.render.com/v1/services/$RENDER_SVC_ID/deploys" `
        -Headers $headers `
        -Body '{"clearCache":"do_not_clear"}'
    $deployId = $deploy.id
    Write-OK "Deploy triggered: $deployId"

    Write-Step 4 "Render — waiting for live (up to 8 min)"
    $deadline = (Get-Date).AddMinutes(8)
    $last = ""
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 15
        $d = Invoke-RestMethod -Method GET `
            -Uri "https://api.render.com/v1/services/$RENDER_SVC_ID/deploys/$deployId" `
            -Headers $headers
        $status = $d.status
        if ($status -ne $last) {
            Write-Info "Status: $status"
            $last = $status
        }
        if ($status -eq "live")          { Write-OK "Backend is LIVE"; break }
        if ($status -eq "update_failed") { Write-Fail "Render deploy failed" }
        if ($status -eq "build_failed")  { Write-Fail "Render build failed" }
    }
    if ($last -ne "live") { Write-Fail "Timed out waiting for Render" }
}

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# FRONTEND
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
if ($Target -in "both","frontend") {

    Write-Step 5 "Frontend — git commit + push to GitHub"
    Push-Location $FRONTEND_DIR
    try {
        $changes = git status --porcelain
        if ($changes) {
            git add -A
            $ts = Get-Date -Format "yyyy-MM-dd HH:mm"
            git commit -m "chore: deploy $ts"
            Write-OK "Committed frontend changes"
        } else {
            Write-Info "Nothing to commit"
        }
        git push origin main
        Write-OK "Pushed to GitHub"
    } finally { Pop-Location }

    Write-Step 6 "Frontend — Vercel production deploy"
    Push-Location $FRONTEND_DIR
    try {
        $vercelOut = npx vercel --prod `
            --token $VERCEL_TOKEN `
            --scope $VERCEL_TEAM `
            --yes 2>&1
        if ($LASTEXITCODE -ne 0) { Write-Fail "Vercel deploy failed:`n$vercelOut" }
        $deployUrl = ($vercelOut | Select-String "https://demandgenius").Matches.Value | Select-Object -First 1
        Write-OK "Vercel deploy complete: $($deployUrl ?? $FRONTEND_URL)"
    } finally { Pop-Location }
}

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# SMOKE TESTS
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
if (-not $SkipTests) {
    Write-Step 7 "Smoke tests"

    try {
        $health = Invoke-RestMethod "$BACKEND_URL/v1/health" -TimeoutSec 15
        if ($health.status -eq "ok") { Write-OK "Backend health: OK (uptime $([math]::Round($health.uptime))s)" }
        else { Write-Info "Backend health: $($health.status)" }
    } catch { Write-Info "Backend health check failed: $_" }

    try {
        $login = Invoke-RestMethod -Method POST "$BACKEND_URL/v1/auth/login" `
            -ContentType "application/json" `
            -Body '{"email":"superadmin@genericdemandai.com","password":"Admin@123"}' `
            -TimeoutSec 15
        if ($login.success) { Write-OK "Superadmin login: OK" }
        else { Write-Info "Superadmin login: $($login | ConvertTo-Json -Compress)" }
    } catch { Write-Info "Login check failed: $_" }

    try {
        $proxy = Invoke-RestMethod "$FRONTEND_URL/v1/health" -TimeoutSec 15
        if ($proxy.status -eq "ok") { Write-OK "Frontend proxy /v1/health: OK" }
        else { Write-Info "Frontend proxy: $($proxy.status)" }
    } catch { Write-Info "Frontend proxy check: $_" }
}

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# DONE
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
$elapsed = [math]::Round(((Get-Date) - $started).TotalSeconds)
Write-Host ""
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Green
Write-Host "  Deployment complete  ($elapsed s)" -ForegroundColor Green
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Green
Write-Host "  Frontend : $FRONTEND_URL"
Write-Host "  Backend  : $BACKEND_URL"
Write-Host "  API Docs : $BACKEND_URL/v1/api-docs"
Write-Host ""
