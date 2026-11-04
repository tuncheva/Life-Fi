# Commits the overnight work that could not be signed after 07:44 (gpg passphrase cache
# expired while the owner slept), then pushes feat/overnight. Run from the repo root:
#
#   powershell -ExecutionPolicy Bypass -File docs\overnight\commit-pending.ps1
#
# gpg asks for the passphrase once. Order matters: the review fixes first (occupancy's new
# `calibrated` argument), then track F (its engine.py passes it), then the docs.
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..\..")
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

$fixes = @(
    "engine/lifefi/occupancy.py", "engine/config/rules.yaml", "engine/tests/test_occupancy.py",
    "ml/eval_position.py", "ml/results/position_eval.json", "docs/models.md",
    "firmware/src/lifefi_config.h", "firmware/src/tx_main.c", "docs/hardware/fixed-transmitter.md",
    "scripts/start.mjs", "ui/src/app/api/v1/alerts/[id]/ack/route.ts",
    "ui/src/components/Room3D.tsx", "ui/src/components/RoomView.tsx", "ui/src/components/TopBar.tsx",
    "ui/src/components/setup/StepRoom.tsx", "ui/src/lib/live.tsx", "ui/src/lib/room.ts",
    "ui/src/lib/setup.ts", "ui/src/lib/words.ts", "ui/src/server/http.ts", "ui/src/server/settings.ts",
    "ui/src/server/health.ts", "ui/test/health.test.ts", "ui/test/http.test.ts", "ui/test/room.test.ts", "contracts/api.md", "docs/ops/README.md",
    "docs/overnight/review-engine-firmware.md", "docs/overnight/review-ui-server.md"
)
Commit $fixes @'
fix: independent review findings (engine, firmware, UI, server)

Reviews in docs/overnight/review-engine-firmware.md and review-ui-server.md,
each finding verified before fixing ("Fixes applied" sections).

- Occupancy "empty" needs low disturbance, presence "empty" and an empty-room
  calibration, all for 30 s; anything less is "unsure" (a still person was
  read as empty). Replay false "empty" 7 -> 0. Occupancy replay numbers now
  fitted on the other session, not in-sample.
- Transmitter minimum rate 50 Hz, receiver probe 200 ms per channel.
- PIN lockout no longer blocks a trusted browser's alert ack (HttpOnly HMAC
  trust cookie); request bodies capped at 64 KB while streaming.
- Room drawing: ring labels and the scale bar only when distance quality is
  "medium"; a low-quality distance is a wide faint band marked "rough guess"
  (no metres). npm run start passes the engine port and data dir.
- An unreadable board reads "We cannot see the room right now" / "Sensor
  offline" instead of "Starting up" next to a green "Live" pill, and
  /api/v1/health no longer reports the board ok (ready: true) meanwhile.
- TopBar also carries track F's /teach menu row; docs/models.md and
  contracts/api.md also carry track F's paragraphs.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
'@

$teach = @(
    "engine/lifefi/engine.py", "ml/train_spots.py", "engine/tests/test_spots.py", "ml/tests/test_train_spots.py",
    "contracts/control.md", "ui/src/app/api/v1/recordings/start/route.ts", "ui/src/app/api/v1/recordings/stop/route.ts",
    "ui/src/app/api/v1/source/route.ts", "ui/src/app/api/v1/spots", "ui/src/app/teach", "ui/src/components/teach",
    "ui/src/components/setup/StepDone.tsx", "ui/src/lib/teach.ts", "ui/src/server/python.ts", "ui/src/server/teach.ts",
    "ui/src/server/position-files.ts", "ui/src/server/recordings.ts", "ui/test/teach.test.ts", "ui/test/teach-client.test.ts",
    "docs/overnight/plans/F-teach-spots.md"
)
Commit $teach @'
feat(teach): record labelled spots and retrain from the dashboard

Track F of the overnight run (docs/overnight/plans/F-teach-spots.md).

- /teach: checklist (board live at >= 20 readings/s, no other recording or
  calibration), spot distances, 1 or 2 rounds with spoken browser prompts,
  server-timed labels in record_spots.py's format; Train runs
  ml/train_spots.py --json and shows the cross-session score against chance.
- /api/v1/spots (+ teach, teach/stop, train, restore); a strictly worse model
  is never installed, the previous one is kept as spots_model.prev.json;
  PUT /source answers 409 while recording.
- Engine.load_spots() on reload_models; train_spots.py gets --out / --json,
  refuses sessions whose spot names differ, and scores loso_bal_acc with a
  fixed shrinkage (review M2). The engine passes `calibrated` to occupancy.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
'@

$docs = @("docs/overnight/REPORT.md", "docs/overnight/OPEN-QUESTIONS.md", "docs/overnight/commit-pending.ps1")
Commit $docs @'
docs(overnight): morning report, open questions, commit script

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
'@

git status --short
git push
