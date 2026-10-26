# Life-Fi Docs

Start with [docs/plan/plan-v2.md](docs/plan/plan-v2.md). It is the single plan to build
from; where any other document disagrees with it, plan-v2 wins.

## firmware/ — code

| Folder | What it is |
|---|---|
| [firmware/](firmware/README.md) | ESP32 / ESP32-S3 firmware: CSI capture, presence and people-count estimate on the serial console (first hardware milestone) |

## docs/plan/ — current, build from these

| Document | What it is for |
|---|---|
| [plan-v2.md](docs/plan/plan-v2.md) | **The master plan.** Whole system (firmware, engine, detectors, models, server, dashboard, profiles), decisions, phases and checklists |
| [csi-for-models.md](docs/plan/csi-for-models.md) | Companion to plan-v2: what the models and detectors need from ESP32 CSI — radio config, buffer layout, preprocessing, quality gates, recordings |
| [model-scope-and-phases.md](docs/plan/model-scope-and-phases.md) | Model side of plan-v2: which components learn weights, how much data they need, phases and gates |

## docs/research/ — evidence the plan is based on

| Document | What it is for |
|---|---|
| [csi-sufficiency-research.md](docs/research/csi-sufficiency-research.md) | Is ESP32-S3 CSI enough? Hardware limits, model feasibility, audit of the older docs |
| [training-data-sources.md](docs/research/training-data-sources.md) | Public CSI datasets, rated by fit, mapped to each detector/model |
| [csi-people-counting.md](docs/research/csi-people-counting.md) | How CSI sensing works, what one ESP32 link can say about head count, and how the firmware estimates it |

## docs/archive/ — superseded by plan-v2, kept as background

| Document | What it was |
|---|---|
| [implementation-plan.md](docs/archive/implementation-plan.md) | First code plan (v1): components, data formats, build order |
| [plan-audit-and-model-research.md](docs/archive/plan-audit-and-model-research.md) | Audit of v1 and first model research |
| [build-guide.md](docs/archive/build-guide.md) | How each part is built, with parameters, plus a gap list against v1 |

## Reading order

1. `docs/plan/plan-v2.md`
2. `docs/plan/csi-for-models.md` and `docs/plan/model-scope-and-phases.md` when working on firmware/engine or models
3. `docs/research/` when you need to know *why* a number or decision is what it is
4. `docs/archive/` only for history
