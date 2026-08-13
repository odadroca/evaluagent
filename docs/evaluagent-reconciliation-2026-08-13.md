# Reconciliation — built vs. specified, and where the scope drifted

> **Date:** 2026-08-13. Written because the roadmap had been rewritten four times in two days and
> the scope felt like it was jittering. It was. This document is the stable reference: what the
> June spec asked for, what exists, what was invented outside it, and why the churn has a single
> structural cause.
>
> Every row below was verified against the code on 2026-08-13, not recalled.
> Sources of truth: [`REASONING-LEDGER-PLAN.md`](./REASONING-LEDGER-PLAN.md) (phasing, §5) and
> [`REASONING-LEDGER-ARCHITECTURE.md`](./REASONING-LEDGER-ARCHITECTURE.md) (data model §3, tool
> surface §7). Both remain **spec-stage but not superseded**.

---

## 1. The architecture has not moved

Seven weeks on, the design is unchanged and roughly **40% unbuilt**. Nothing in the last two days
altered a single architectural decision — the churn was entirely in the roadmap layer above it.

### Tool surface (architecture §7) — 3 of 6 planned tools

| Planned tool | Status |
|---|---|
| `record_reasoning` | ✅ |
| `recall_reasoning` | ✅ |
| `ledger_get` | ✅ shipped 2026-08-13 (`52c9664`) |
| `session_start` / `session_end` | ❌ |
| `ledger_query` | ❌ |
| `session_timeline` | ❌ |

Plus `list_projects` (✅), which is the planned **`ledger://projects` resource** delivered as a tool
instead — a deliberate deviation, since agents consume tools far more reliably than resources.

### MCP resources (architecture §7) — 0 of 5

`ledger://projects`, `ledger://project/{slug}/recent`, `ledger://session/{id}/timeline`,
`ledger://entry/{id}`, `session://current`. None built.

### Data model (architecture §3)

| Specified | Status |
|---|---|
| `projects(id, slug UNIQUE, label, created_at)` | ❌ denormalized to `entries.project` |
| `sessions(id, project_id, external_id, …)` | ❌ denormalized to `entries.session_id` |
| `tags` + `entry_tags` | ❌ JSON column |
| `entries.outcome` (anti-self-reinforcement — spec calls it *first-class*) | ❌ |
| `entries_fts` (FTS5) | ✅ |

### Locked decisions and later phases

- **§4 "Option 3 — sibling on Calane"**: `@llm-pipe/core` is imported nowhere. The premise of the
  whole architecture doc is unimplemented, and with it the `redactSecrets` / `TelemetrySink` reuse
  that Phase 4 was to stand on.
- **Phase 4** (REST + `openai-tools.json`, OTel mirror): no `src/http`, no `src/telemetry`.
- **Phases 5–7** (guards/DX, Postgres+pgvector, consolidation): untouched.

---

## 2. What was built *outside* the plan

Everything since 2026-08-02 sits in a layer the original phasing does not contain: **measurement,
and behavioural nudging**. Phase 7 (consolidation) is adjacent but distinct.

| Shipped | In the plan? |
|---|---|
| `recall_events` logging, `proc-<ulid>` session stamping, `ref_entry_id`/`superseded_by` | No — measurement layer |
| T2/T3 analysis, composition metric | No |
| `ledger_get`, `list_projects` | **Yes** — planned surface, finally exposed |
| Kind-disambiguation in `record_reasoning`'s description | No |
| Conditional recall gate, retry nudge, journal nudge | Partly — plan §7 names *"a `Stop`-hook journaling nudge"* as the mitigation for its **top product risk**; the other two are invention |
| Spine wired at user scope | No — deployment choice |
| Project slug merge (45 → 38) | Addresses §7's "project slug derivation" open question, but by hand-written SQL, with no tooling |

Roughly **one third completion, two thirds invention.**

---

## 3. The jitter, dated

- **2026-08-12** — north-star changed from recurrence-conditioned-on-recall to corpus composition
  (owner's purpose correction; the prior frame was measuring a goal the tool never had).
- **2026-08-12** — Sprint 1 proposed, built around inverting recall's default scope to global.
- **2026-08-13** — composition baseline corrected twice: 17.7% → 18.1% → *no point baseline at all*,
  after a 50-entry-block series showed the metric had already tripled unaided.
- **2026-08-13** — Sprint 0 invented (did not exist 36 hours earlier).
- **2026-08-13** — Sprint 3's spine wiring and Sprint 4's identity merge executed out of order.
- **2026-08-13** — 0a's mechanism changed mid-implementation (`Stop` → `UserPromptSubmit`).
- **2026-08-13** — Sprint 1 recommended for withdrawal, ~30 hours after being proposed.

Much of this was legitimate response to new information, and two of the corrections caught real
errors before they reached a decision. But the roadmap has no stable base, and that is a cost in
itself.

---

## 4. The single structural cause

**Almost every unstable thing this week is downstream of two unbuilt tables.**

`sessions.external_id` — specified in June as *"the host/Claude Code `session_id`, the **join key**
that lands hook-spine and self-report in the same session"* — has so far cost:

1. `session_id` NULL on 87% of self-reports (July finding), patched with `proc-<ulid>` stamping.
2. Spine and self-report joining on **neither project nor session** (only 1 shared session id exists
   across the entire corpus).
3. A **HIGH** bug in Sprint 0c: `sessionSelfReports` was structurally always 0, so the journal
   nudge's suppression guard was dead code and it nagged sessions that had recorded plenty.
4. `recall_events` failing to join the same way → a project+recency proxy shipped as a workaround.
5. Gate *ordering* untestable in the T2 analysis (observable on 2 of 80 events).

`projects` has cost: no project listing (built as a tool workaround), slug fragmentation across
~6 families (fixed by hand-written SQL, unversioned and unrepeatable), no aliasing (provenance
stuffed into `was:` tags), and the cwd-basename fallback at user scope.

**Two unbuilt tables → roughly ten downstream workarounds, four of them shipped this week.** Each
workaround is new surface that then needs its own corrections. *That is the jitter generator.*

---

## 5. Recommendation

**Freeze new behavioural invention.** Sprint 1, Sprint 2, and further nudges all wait.

**Build the data model the architecture already specifies** — `projects` and `sessions` with
`external_id`. This is not a new idea; it is completion of a June decision. It would:

- retire the `proc-<ulid>` stamp and both proxy fallbacks shipped on 2026-08-13;
- make spine ↔ self-report joins real, so gate placement becomes testable;
- make `rename_project` / `merge_projects` trivial, replacing the manual SQL merge;
- unblock `session_start`/`session_end` and `session_timeline` — three more planned tools;
- answer *"what did I learn in that session?"*, a capture-side question the schema was designed for
  and which is currently unanswerable.

**Hold Sprint 1 entirely.** Its centrepiece — inverting recall's default scope — is not in the
architecture at all (it came from a field report), is now largely redundant (`list_projects` +
`ledger_get` solved the reachability pain it targeted), and actively conflicts with Sprint 0c: under
a global default, a "cold" project would still return useful cross-project lessons, so suppressing
the gate there becomes wrong. Salvage only the three items that don't depend on it — verbosity
control, unknown-project errors, and enum values in validation messages.

**Calane: PARKED, with a named unblock** *(resolved 2026-08-14, ledger `01KZYMFSMS`)*. Not retired —
an earlier draft of this section said "close it or retire it", which was wrong. `@llm-pipe/core` is
publish-ready (proper `main`/`types`/`exports`, `files: ["dist"]`, not private, dependencies
overlapping evaluagent's without conflict), and `packages/telemetry` / `packages/stores` /
`packages/mcp-server` all exist — the reuse map describes real code. The mechanical blocker is only
that it is a **subpackage of a private-root pnpm workspace**, and npm git dependencies cannot target
a repository subdirectory.

- **State:** deferred. Buys nothing today — Phase 4 has no caller and evaluagent works standalone.
- **Unblock:** `pnpm build && npm publish` `@llm-pipe/core`, then a one-line dependency here.
- **Trigger to revisit:** Phase 4 (REST/OTel) acquiring a caller, or hosting needing `redactSecrets`.

The defect was never the pairing — it was a decision recorded as **locked** sitting silently
unimplemented, unreadable as pending vs. abandoned. Writing the state and the unblock fixes that at
zero cost. Note also that evaluagent built its own MCP server while `packages/mcp-server` already
existed: a second reuse-map item quietly re-implemented.

---

### On why these items stalled

The owner's framing, which is better than treating this as drift: evaluagent's development was
deliberately gated on proving value rather than building speculatively, and **that same gate is what
left Calane, Phase 4 and half the tool surface stranded**. Value-gating and completeness are in
tension by construction — the scope narrowed *because* the discipline worked. Stalled spec items are
therefore a predictable cost of a good rule, not evidence of a bad one. What needs fixing is not the
gate but the bookkeeping: a parked item must say it is parked, and what would unpark it.

---

## 6. Standing rule this produced

> When a spec element is skipped, the workarounds it forces are not free — they become surface that
> generates its own defects. Before inventing new capability, check whether the problem is an
> unbuilt piece of the design. **Cheapest wins are usually completion, not invention.**
