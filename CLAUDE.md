# evaluagent — working notes

> Durable lessons promoted from the reasoning ledger (consolidation pass). Loaded into every
> Claude Code session in this repo, so they don't depend on an on-demand `recall`.

## What evaluagent is for (read this before proposing work on it)

**Purpose: record what usually goes unrecorded — surprises, dead-ends, abandoned branches,
friction — to defeat survivor's bias, and improve collaboration.** Behaviour change in a later
session is a hoped-for *second-order* effect, **not the deliverable**.

This was restated by the owner on 2026-08-12 after four sessions had drifted into measuring the
tool against a behaviour-change hypothesis it was never given (entry `01KZVX5NC2…`). If you find
yourself evaluating evaluagent by "did recall stop a repeated mistake", you are using the wrong
yardstick and will reach an unfairly negative verdict.

- **North-star metric: corpus composition** — share of entries in the scarce kinds
  (`friction` + `dead_end` + `reconstruction` + `abandoned_branch`). This *replaces*
  recurrence-conditioned-on-recall, which needs months and answers a question nobody asked.
- **Do NOT compare against a lifetime average — there is a large pre-existing upward trend.**
  By 50-entry block: 14% → 12% → **8%** (Jul 02–21) → 24% → **30%** (Aug 05–11) → 22%. The share
  nearly quadrupled with no intervention in place, so the 17.9% all-time figure describes history,
  not current behaviour (last 50 entries run ~24%). Measure as an **interrupted time series against
  the extrapolated trend, in 50-entry blocks** — never per-day (throughput swings 1–22/day), and
  never against a point baseline, which would score the existing trend as a win.
- The write path is the product. The read path is support for it.
- **Adding scarce entries does not move the metric — converting does.** Measured 2026-08-13: the
  review session that *discovered* the composition problem then wrote 11 entries at 18.2% scarce,
  i.e. exactly baseline, because its 2 scarce entries came alongside 9 abundant ones. A ratio moves
  when a `surprise` that is really a `dead_end` gets written as one, not when a nudge appends more
  at the end. Prefer interventions that fire **before the write**.

### Assessing composition: exclude this project

Measured 2026-08-14: **78% of entries written since the last epoch were about evaluagent itself**
(7 of 9). While the tool is being built, the corpus fills with entries about the tool — so a
corpus-wide reading reports our own meta-work back to us and looks like success. **Filter out
`project='evaluagent'`.** The instrument's value has to appear in the real work.

Use **`ledger_query`** for this, not `recall_reasoning`: it is deliberately not logged to
`recall_events`, so analysis traffic cannot distort the measurement it is producing.

## Capture discipline (the composition problem, and how to not cause it)

Measured 2026-08-12: `confidence` 41.5% / `surprise` 40.8% / `friction` 8.3% / `dead_end` 4.5% /
`reconstruction` 3.4% / **`abandoned_branch` 1.5%**. The kinds that exist specifically to defeat
survivor's bias are 16 of 265 entries, while the largest slice is decisions — the one category
that already survives in commits, PR bodies and plan files.

Two causes, both fixable at write time (entry `01KZVYKKNX…`):

1. **`surprise` is a superset of `dead_end` with a cheaper payload.** Every dead end is also a
   prediction error, so the broad kind absorbs it — and `dead_end` demands `signal` ("what should
   have tipped me off, and when?"), which is real work. **27 of 219 abundant-kind entries contain
   negative-result language** vs only 18 correctly-kinded entries corpus-wide.
2. **Aggregation into a progress shape.** `01KZEHH9SE` is "Five candidate causes killed in one
   afternoon" filed as *one* `confidence`. Five dead ends, each with its own `signal`, compressed
   into a forward-moving summary.

**Rules:** a ruled-out hypothesis is a first-class result — record it as its own `dead_end` with
its `signal`. Don't bundle several negative results into one summary entry (the negative-result
form of the existing anti-bundling rule in `01KWARE1E5…`). Before writing a `surprise`, ask
whether you *pursued an approach that failed* — if so it is a `dead_end`.

## Before triaging any "missing capability", read the spec

`docs/REASONING-LEDGER-PLAN.md` and `docs/REASONING-LEDGER-ARCHITECTURE.md` are **spec-stage but
not superseded**. **5 of 6 planned tools** now exist — `ledger_get`, `list_projects` (`52c9664`), plus
`ledger_query`, `session_timeline` and `rename_project` (`82f5ebc`). Still missing:
`session_start`/`session_end` as *tools* (the hook bridge already does the work), and **all 5
planned MCP resources**. The surface is at 7 tools against the architecture's ~8 guideline, so a
new tool now needs justifying rather than just adding. Three independent field reports plus one
analysis session derived "new" requirements that were already written there (entry `01KZW32FQJ…`):

- `list_projects` = the planned `ledger://projects` resource. ✅ shipped as a tool.
- `get_entry` = the planned `ledger_get` — `getEntry(id)` had been implemented all along and was
  simply never exposed. ✅ shipped.
- The `Stop`-hook journaling nudge is verbatim plan §7's **named top product risk**. Still unbuilt
  (Sprint 0a).
- `projects` / `sessions` were specified as *tables* (`sessions.external_id` = the host session
  join key) and shipped denormalized. The slug fragmentation, the missing project listing and the
  87%-NULL `session_id` all trace to that single drop — the fix is implementing the written schema.
- `@llm-pipe/core` (Calane) is imported nowhere, so the locked "sibling on Calane" decision is
  unimplemented. Decide deliberately whether to close or retire it.

**Cheapest wins are usually completion, not invention.**

### The two unbuilt tables were the project's main defect generator — now built (2026-08-14)

Full reconciliation: [`docs/evaluagent-reconciliation-2026-08-13.md`](./docs/evaluagent-reconciliation-2026-08-13.md).

`projects` and `sessions` (with `external_id`) were specified in June, shipped denormalized, and
between them produced **~10 workarounds** — the `proc-<ulid>` stamp, spine/self-report joining on
nothing, a HIGH bug in the 0c nudges, a project+recency proxy for `recall_events`, gate ordering
untestable, no project listing, slug fragmentation fixed by hand-written SQL.

**Both shipped 2026-08-14 (`991c756`).** The `SessionStart` hook opens a `sessions` row keyed by the
host session id; the MCP server — which cannot see the host session — resolves the open session for
its project and stamps that. Self-reports, recall events and spine rows now share one id.

> **⚠️ The fix is FORWARD-ONLY.** All ~3,400 pre-existing entries keep their old ids, and the
> historical mapping cannot be reconstructed. Any analysis over data written before 2026-08-14 still
> needs the project+recency proxies. Check `created_at` before assuming a session join will work.

**The standing lesson survives the fix:** each workaround is new surface that then needs its own
corrections. Before inventing new capability, ask **"which spec element would have prevented this?"**
before "what should I build?"

## Claude Code setup: hot-reload vs restart

- **Hooks / `.claude/settings*.json` hot-reload mid-session** — *but only if* a settings file
  already existed under `.claude/` when the session started (Claude Code begins watching
  `.claude/` then). Editing hooks usually needs **no** restart.
- **MCP servers do NOT hot-load.** A `claude mcp add` (any scope) is picked up only by a fresh
  process — restart with **`claude -c`** to keep the conversation. `/mcp` and re-adding won't
  expose a newly-added server to the running session.
- Rule of thumb: after adding/changing the **MCP server**, restart; after editing **hooks**,
  usually don't.

## This repo's MCP server / hooks

- Server: `node <repo>/dist/bin/ledger.js serve`. Always `npm run build` before relying on it
  (config points at `dist/`, not `src/`).
- **Hook bridge is wired at USER scope since 2026-08-13** (`~/.claude/settings.json`, backup
  `settings.json.bak-20260813-174308`), so the behavioural spine now captures in **every project**,
  not just this repo. The repo-level hook wiring was removed to stop both scopes double-writing;
  `.claude/settings.local.json` still keeps `EVALUAGENT_PROJECT=evaluagent` and permissions.
  **Two consequences for analysis:** at user scope there is no per-project `EVALUAGENT_PROJECT`, so
  the hook falls back to the **cwd basename**. The session half of this is **fixed as of 2026-08-14**
  (`sessions.external_id` is built, so new writes share one id); the project half remains, and all
  pre-2026-08-14 data still joins on neither.
- Conventions: TDD (`npx vitest run`, 173 tests), TypeBox + Ajv (no Zod), ESM `.js` import specifiers.

## Measurement conventions (post-HOLD read/measure bundle, 2026-08-02)

- Every `recall_reasoning` call is logged to the `recall_events` table (query + returned
  ids/ranks + proc-session id). This is the T2/T3 join key — analysis reads it via direct
  SQL (`~/.evaluagent/ledger.db`).
- **Session stamping (changed 2026-08-14):** a write now takes the **real host session id**, resolved
  from the open `sessions` row for its project. `proc-<ulid>` remains only as a fallback when no
  session is open (e.g. a caller outside Claude Code). Entries written *before* 2026-08-14 still
  carry the old proxy ids.
- When a conclusion overturns a stored entry, set `ref_entry_id` on the new entry; recall
  surfaces `superseded_by` on the old one. Treat superseded entries as stale.
- When a ledger lesson is promoted into a CLAUDE.md, tag the entry `promoted-to-claude-md`
  (attribution: separates "carried by CLAUDE.md" from "carried by recall").
- **T2 measurement epoch: 2026-08-03 ~08:26Z** (bundle went live at `873a041`; first
  `recall_events` row `proc-01KZ3BQM…`). Filter analysis queries to after this point.

## T2 read — done early, 2026-08-12 (9 days in)

Full analysis in [`docs/evaluagent-T2-measurement-2026-08-12.md`](./docs/evaluagent-T2-measurement-2026-08-12.md);
sprint sequencing in [`docs/evaluagent-roadmap-2026-08-12.md`](./docs/evaluagent-roadmap-2026-08-12.md).
Re-run the analysis in the original 08-17…31 window to extend the series.

- **The read path works — don't rebuild it.** Zero warm-project retrieval misses in 80 events, and
  **41 of 47 non-empty recalls returned a *prior session's* entry** (cross-session recall is the
  normal case, not the exception). Ranking investment is now clearly secondary.
- **41% of recalls return nothing, and all of them are cold-project** (the scope had no entries).
  That is gate ceremony, not a ranker defect — don't "fix" retrieval because of this number.
- **68% of text queries carry an identifier-like token** (system object names, ticket IDs, symbol
  names). That is FTS's sweet spot — **embeddings are not earned**; gate them on a paraphrase
  recall@5 experiment first.
- **Salience is saturated**: 91% at s2/s3, post-epoch s0 = 0. `w_salience` is near-constant, so
  *do not retune ranking weights against it* — fix the prior first (use-earned salience, per
  `01KWBWTQ1P…`, now unblocked by `recall_events`).
- **`ref_entry_id` is a bad proxy for "was this entry used"** (entry `01KZVXDC7S…`): 13 of 19
  supersede links had no recall behind them. A real use-signal is still a missing primitive.
- **`ref_entry_id` is overloaded** — on `hook_spine` rows it means pre/post correlation, not
  supersession. Filter to `source='self_report'` in any analysis query or your numbers are garbage.
- Recall cost: mean body 1,604 B → **~20 KB per 10-entry recall**, paid on every gate-enforced
  planning turn. Verbosity control must ship *with* any scope widening.
