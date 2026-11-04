# Commits the overnight-2 work that could not be signed after 03:48 (the gpg passphrase
# cache expired while the owner slept), then pushes feat/overnight. Run from the repo root:
#
#   powershell -ExecutionPolicy Bypass -File docs\overnight\2026-11-04\commit-pending.ps1
#
# gpg asks for the passphrase once. Three commits: track H, the engine review fix, the docs.
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..\..\..")
if ((git rev-parse --abbrev-ref HEAD) -ne "feat/overnight") { throw "not on feat/overnight" }

function Commit($files, $message) {
    git add -- $files
    if ($LASTEXITCODE -ne 0) { throw "git add failed" }
    # the message goes through a file: PowerShell 5.1 mangles double quotes in native arguments
    $msg = [System.IO.Path]::GetTempFileName()
    [System.IO.File]::WriteAllText($msg, $message, (New-Object System.Text.UTF8Encoding $false))
    git commit -q -F $msg -- $files
    $code = $LASTEXITCODE
    Remove-Item $msg
    if ($code -ne 0) { throw "git commit failed" }
    git log --oneline -1
}

$history = @(
    "ui/src/server/store.ts", "ui/src/server/history.ts", "ui/src/server/vitals-history.ts",
    "ui/src/app/api/v1/history/vitals", "ui/src/lib/api.ts", "ui/src/lib/vitals-history.ts",
    "ui/src/components/model/InsightsPage.tsx", "ui/src/components/model/HoursChart.tsx",
    "ui/src/components/model/HoursSection.tsx", "ui/test/store.test.ts", "ui/test/vitals-history.test.ts",
    "contracts/api.md", "docs/overnight/2026-11-04/plans/H-vitals-history.md"
)
Commit $history @'
feat(ui): "Last hours" on Insights, breathing and heart rate over the night

Track H of overnight run 2 (plan in
docs/overnight/2026-11-04/plans/H-vitals-history.md).

- History rows gain heart_bpm / heart_valid (kept only when the profile
  stores breathing: home and clinic, not school; same retention).
  Existing databases migrate in place on first start (guarded ALTER TABLE
  in one transaction, PRAGMA user_version = 1; idempotent, safe with two
  processes, older builds keep working). Tested on old-format files and on
  a copy of the real data/lifefi.sqlite (8155 rows kept, 6.6 ms).
- GET /api/v1/history/vitals?hours=1|6|24: median per bucket (60 s /
  5 min / 10 min) plus a range summary; fewer than 3 valid readings in a
  bucket is a gap, never a number.
- Insights: collapsible "Last hours - How was the night?" (closed by
  default, its own 1/6/24 h control): breathing, heart (Experimental) and
  movement, with "read x % of the time someone was there".

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
'@

$fix = @("engine/lifefi/engine.py", "docs/overnight/2026-11-04/review-engine-firmware.md")
Commit $fix @'
fix(engine): no pre-gap breathing rate published as valid after a gap

Finding 1 of the independent engine/firmware review
(docs/overnight/2026-11-04/review-engine-firmware.md): after a signal gap
the last breathing window from before the gap stayed valid for up to ~7 s.
breath_valid now also requires the window to belong to the current
segment (breath_at >= vitals_since), as the reason logic already did.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
'@

$docs = @(
    "docs/overnight/2026-11-04/REPORT.md", "docs/overnight/2026-11-04/OPEN-QUESTIONS.md",
    "docs/overnight/2026-11-04/plans/R2-ui-round2.md", "docs/overnight/2026-11-04/commit-pending.ps1"
)
Commit $docs @'
docs(overnight): night 2 report, open questions, UI round 2 plan (planner + critic)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
'@

git push origin feat/overnight
if ($LASTEXITCODE -ne 0) { throw "git push failed" }
