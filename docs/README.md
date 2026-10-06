# Life-Fi Docs

Start with [plan/plan-v2.md](plan/plan-v2.md). It is the single plan to build
from; where any other document disagrees with it, plan-v2 wins.

## plan/ — current, build from these

| Document | What it is for |
|---|---|
| [plan-v2.md](plan/plan-v2.md) | **The master plan.** Whole system (firmware, engine, detectors, models, server, dashboard, profiles), decisions, phases and checklists |
| [csi-for-models.md](plan/csi-for-models.md) | Companion to plan-v2: what the models and detectors need from ESP32 CSI — radio config, buffer layout, preprocessing, quality gates, recordings |
| [model-scope-and-phases.md](plan/model-scope-and-phases.md) | Model side of plan-v2: which components learn weights, how much data they need, phases and gates |

## research/ — evidence the plan is based on

| Document | What it is for |
|---|---|
| [csi-sufficiency-research.md](research/csi-sufficiency-research.md) | Is ESP32-S3 CSI enough? Hardware limits, model feasibility, audit of the older docs |
| [training-data-sources.md](research/training-data-sources.md) | Public CSI datasets, rated by fit, mapped to each detector/model |

## archive/ — superseded by plan-v2, kept as background

| Document | What it was |
|---|---|
| [implementation-plan.md](archive/implementation-plan.md) | First code plan (v1): components, data formats, build order |
| [plan-audit-and-model-research.md](archive/plan-audit-and-model-research.md) | Audit of v1 and first model research |
| [build-guide.md](archive/build-guide.md) | How each part is built, with parameters, plus a gap list against v1 |

## Reading order

1. `plan/plan-v2.md`
2. `plan/csi-for-models.md` and `plan/model-scope-and-phases.md` when working on firmware/engine or models
3. `research/` when you need to know *why* a number or decision is what it is
4. `archive/` only for history
