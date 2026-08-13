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
  (`friction` + `dead_end` + `reconstruction` + `abandoned_branch`). **Baseline 18.1%**
  (2026-08-13, n=271). Measure over a rolling **100-entry window**, never per-day: throughput swings
  1–22 entries/day. This *replaces* recurrence-conditioned-on-recall, which needs months and answers
  a question nobody asked.
- The write path is the product. The read path is support for it.
- **Adding scarce entries does not move the metric — converting does.** Measured 2026-08-13: the
  review session that *discovered* the composition problem then wrote 11 entries at 18.2% scarce,
  i.e. exactly baseline, because its 2 scarce entries came alongside 9 abundant ones. A ratio moves
  when a `surprise` that is really a `dead_end` gets written as one, not when a nudge appends more
  at the end. Prefer interventions that fire **before the write**.

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
not superseded**. Only **2 of 6 planned tools** and **0 of 5 planned MCP resources** exist. Three
independent field reports plus one analysis session derived "new" requirements that were already
written there (entry `01KZW32FQJ…`):

- `list_projects` = the planned `ledger://projects` resource.
- `get_entry` = the planned `ledger_get` — and **`getEntry(id)` is already implemented** at
  `repo/ledger-repository.ts`; it was simply never exposed as a tool.
- The `Stop`-hook journaling nudge is verbatim plan §7's **named top product risk**.
- `projects` / `sessions` were specified as *tables* (`sessions.external_id` = the host session
  join key) and shipped denormalized. The slug fragmentation, the missing project listing and the
  87%-NULL `session_id` all trace to that single drop — the fix is implementing the written schema.
- `@llm-pipe/core` (Calane) is imported nowhere, so the locked "sibling on Calane" decision is
  unimplemented. Decide deliberately whether to close or retire it.

**Cheapest wins are usually completion, not invention.**

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
- Hook bridge: `node <repo>/dist/bin/ledger-hook.js`, wired via `.claude/settings.local.json`;
  needs `EVALUAGENT_PROJECT` to match the MCP scope or it defaults to the cwd basename and
  splits entries across project tags.
- Conventions: TDD (`npx vitest run`), TypeBox + Ajv (no Zod), ESM `.js` import specifiers.

## Measurement conventions (post-HOLD read/measure bundle, 2026-08-02)

- Every `recall_reasoning` call is logged to the `recall_events` table (query + returned
  ids/ranks + proc-session id). This is the T2/T3 join key — analysis reads it via direct
  SQL (`~/.evaluagent/ledger.db`).
- Writes without an explicit session id get a `proc-<ulid>` per-server-process stamp.
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
