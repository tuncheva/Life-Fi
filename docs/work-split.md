# Work Split

Who owns which part of [implementation-plan.md](implementation-plan.md). The
owner builds the part, writes its tests and makes its step check pass. Shared
items name both people; the first one leads.

| Person | Area | Folders |
|---|---|---|
| Tina | AI models | `ml/`, model loading in `engine/`, `scripts/onsite_adapt` |
| Max | Hardware and device tools | `firmware/`, `tools/` |
| Ivan | Processing server (engine) | `engine/` |
| Emil | API and app polish | `server/`, `contracts/`, `scripts/`, CI, `docs/` |
| Alex | UI | `ui/` |

## Tina — AI models

- `contracts/model_io.md` (with Ivan): window size, features, ONNX metadata
- `ml/` loader: feature dumps + `labels.jsonl` → labelled 3 s windows, reaction-time offset for marks
- Split config with locked test sessions; split by whole session only
- M1 (presence / person count) and M2 (posture) training with augmentation
- Coarse M2 fallback (`still`, `moving`)
- ONNX export with `metadata_props` + test vectors; PyTorch vs ONNX Runtime check at 1e-3
- Evaluation report: per-class accuracy, confusion matrix, fall recall, false alarms per hour
- `engine/` ONNX Runtime integration (with Ivan): load M1/M2, labels from metadata, `pipeline_version` check, `reload_models`, `src` field
- Plan and run the recording sessions in section 5 (with Max for the hardware)
- Final retrain on all non-test sessions, final evaluation report
- `scripts/onsite_adapt` and `ml/finetune.py`; rehearse in an unfamiliar room

## Max — Hardware and device tools

- Router setup and ESP32-S3 placement
- `contracts/csi_frame.h` (with Ivan)
- `firmware/`: station mode, `WIFI_PS_NONE`, 100 Hz ping, CSI callback → queue → UDP task, header from `rx_ctrl`, `boot_id`, HT filter, reconnect, watchdog
- `firmware/`: channel / ping rate / node id over serial, stored in NVS
- `tools/csirec`: reader and writer + unit tests
- `tools/fake-node` with all flags (`--rate`, `--breath-bpm`, `--loss`, `--reset-every`, `--mix-nonht`, `--motion-burst`)
- `tools/recorder`, `tools/replayer` (`--speed`, `--loop`, `source = 1`), `tools/serial-bridge`
- Confirm HT-LTF byte offsets on a real capture and write them into `model_io.md`
- Step 2 check: ≥ 80 Hz, < 5 % loss over 10 minutes
- `docs/setup.md` hardware part: flashing the ESP32, router config

## Ivan — Processing server (engine)

- `engine/` skeleton: CMake, GoogleTest, portable UDP socket, frame parser with reject counters
- TCP :6000 results/commands server; `contracts/control.md` and `results.schema.json` (with Emil)
- Per-node ring buffer, `boot_id` handling, HT-LTF amplitude extraction, resample to 50 Hz, debug CSV dump
- DSP: gain compensation, Hampel filter, `PIPELINE_VERSION`, `calibrate` (`empty` / `rolling`)
- Presence and motion; breathing pipeline (30 s buffer, PCA, band-pass, FFT, confidence, reset on motion)
- `breathing.wave` and `csi` heatmap rows in results
- `--dump-features`, `record_start` / `record_stop`, `set_source`
- Rules from `rules.yaml` (`fall`, `fainted_suspected`, `no_breathing`), edge-triggered events, rule fallback
- `--evaluate` for tuning rules against recordings
- < 100 ms processing per window

## Emil — API and app polish

- `contracts/api.md` and `contracts/recording.md`; owns keeping all six contracts consistent
- `server/`: Spring Boot, engine client with reconnect, `/api/v1/status`, `/ws/live`, CORS
- `/api/v1/calibrate`, H2 history + `/api/v1/history`
- Recordings API: session ids, record commands, `labels.jsonl` writer
- `/api/v1/source` (spawns / stops the replayer)
- Alerts from `profiles.yml`, `/api/v1/alerts` + acknowledge, `/api/v1/profile`
- Latency stamps per stage + `scripts/latency_report`
- Serve the UI static export
- `scripts/`: `fake-engine`, `run_all` (live and replay), `check_session`
- CI for every folder, `contracts/fixtures/` feature check
- Polish: end-to-end testing, bug triage across components, `docs/README.md`, `docs/architecture.md`, software part of `docs/setup.md`

## Alex — UI

- `ui/`: Next.js app, TypeScript types generated from `results.schema.json`, mock data validated in CI
- Live motion page from `/ws/live` (step 1)
- Home page: state, breathing waveform, motion, timeline, CSI heatmap, calibrate button
- Labelling screen: start/stop, segment buttons, "fall now" mark, keyboard shortcuts
- `ui/label-cli` fallback labeller
- School and Clinic pages, profile switcher, alert banner with acknowledge
- Phone layout
- Replay banner, calibration status, "connection lost" state
- Dashboard layout and navigation shared by all pages: header, sidebar, profile and source indicators
- Dashboard overview: live status cards (presence, people count, posture, breathing rate) with model / rule `src` shown
- History view from `/api/v1/history`: charts by day and hour, event list with filters
- Alerts page: alert list, acknowledged / open filter, alert detail with the timeline around the event
- Recordings page: list of sessions, labels per session, start replay of a recording
- Settings page: calibration, active profile, engine and node status
- Design system: shared components, colours, light and dark theme
- UI tests (component tests and one end-to-end run against fake-engine)

## By step

| Step | Tina | Max | Ivan | Emil | Alex |
|---|---|---|---|---|---|
| 1 Skeleton | `model_io.md` draft, `ml/` setup | `csirec`, fake-node, `csi_frame.h` | engine parser, TCP stub | server, fake-engine, `run_all`, CI | live motion page |
| 2 Real CSI | review real capture | firmware, recorder, offsets | ring buffer, extraction, resample | status of real node in API | show real-node status |
| 3 DSP | prepare feature loader | support captures | DSP, breathing, `--dump-features` | `/calibrate` | Home page, dashboard layout, design system |
| 4 Recording | plan sessions (section 5) | replayer | record, `set_source` | history, recordings API, `check_session`, fixtures | labelling screen, label-cli, history, recordings page |
| 5 Models | **train, export, evaluate** | run recording sessions | ONNX integration (with Tina) | CI for test vectors | show count / posture |
| 6 Rules | fall recall evaluation | — | rules, `--evaluate` | alerts, profiles | School, Clinic, alerts page, phone |
| 7 Hardening | retrain, `onsite_adapt` | NVS config, serial-bridge | < 100 ms | latency, docs, polish | replay / lost states, settings, UI tests |
