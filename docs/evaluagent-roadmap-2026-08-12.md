# evaluagent — next sprints, filtered by confirmed utilization

> **Date:** 2026-08-12
> **Inputs:** three field reports from live use in other projects; the T2/T3 measurement
> ([`evaluagent-T2-measurement-2026-08-12.md`](./evaluagent-T2-measurement-2026-08-12.md), 80
> recall events / 9 days); prior roadmap decisions carried in the ledger; the owner's
> 2026-08-12 decision that the corpus is **per-user global with `project` as a facet**.
>
> **Method:** every field-report claim was re-tested against the live DB or the source before being
> accepted. Items the data contradicts are demoted here with the evidence, not carried forward out
> of politeness. Sprint boundaries follow a constraint the field reports could not see — see §0.

---

## 0. Two constraints that set the shape

**0.1 Three deployment tiers, not two** *(refined 2026-08-13)*. Established in `01KWC2A95Y…` and
sharpened by checking how hooks are actually invoked:

| Change | Needs `npm run build`? | Needs `claude -c` restart? |
|---|---|---|
| Hook **wiring** (`.claude/settings*.json`) | no | no — hot-reloads |
| Hook **code** (`dist/bin/ledger-hook.js`) | **yes** | **no** — a fresh process spawns per event |
| **MCP server** (`tools.ts`, `server.ts`, service, repo) | **yes** | **yes** — long-lived process |

So the cheapest tier is not "hooks" as a whole: settings-only edits are free, hook code costs a
build, and only server changes cost a restart. Every read-path change — scope, verbosity, new tools,
validation messages — is bottom-tier and must be **bundled into one build+restart**.

This is why the sprints below are not ordered purely by severity: *Sprint 1 is a bundle because it
has to be one*, and the cheaper tiers ship ahead of it independently.

**0.2 The binding constraint is corpus composition, not retrieval.**

> **Scope correction (owner, 2026-08-12, after this document's first draft).** Earlier drafts framed
> the open problem as *intervening at the moment the lesson applies*. That imported a goal evaluagent
> never had. The stated intent is: **record what usually goes unrecorded — to defeat survivor's bias
> — and improve collaboration.** Behaviour change is a hoped-for second-order effect, not the
> deliverable. The recurrence-conditioned-on-recall north-star measured the wrong thing.

Re-measured against the actual intent, the corpus composition is **inverted relative to its purpose**:

| Kind | n | % | Already captured elsewhere? |
|---|---|---|---|
| `confidence` | 110 | **41.5%** | Yes — commits, PR bodies, plan files |
| `surprise` | 108 | 40.8% | Rarely |
| `friction` | 22 | 8.3% | No |
| `dead_end` | 12 | 4.5% | No |
| `reconstruction` | 9 | 3.4% | No |
| `abandoned_branch` | **4** | **1.5%** | Never |

The kinds that exist specifically to defeat survivor's bias total **16 of 265 entries**. The largest
slice is decisions — the one category that survives in other artifacts anyway.

**Why this is a timing problem.** Mean position of each kind within its session (0 = start, 1 = end):
`surprise` 0.32 · `confidence` 0.61 · `friction` 0.64 · `dead_end` 0.77 · `reconstruction` 0.89 ·
`abandoned_branch` 1.00. A surprise is punctual — noticed and written. An abandoned branch is only
recognisable retrospectively, by which point the session is closing and **nothing asks**. Hence n=4.
(Writes are not batched: median gap between consecutive entries is 73 min, 3 of 45 gaps under 2 min.)

**The enforcement asymmetry.** Recall is hook-enforced; recording is not enforced at all — backwards
for a tool whose purpose is capture. And 41% of the enforced recalls fire against an empty corpus, so
the entire enforcement budget is spent on the secondary path, often on nothing.

**Consequence for this roadmap: Sprints 1–4 below are mostly read-path work and are therefore
secondary.** They remain correct as written and the silent-failure fixes in Sprint 1 are worth doing.
But the cheapest work with the highest purpose-alignment is three hook edits (no rebuild, no restart)
— see Sprint 0. Do those first and let the measurement decide whether the server sprints are funded.

---

## 1. What utilization confirms, and what it refutes

### Confirmed — build on these

| Observation | Figure | Consequence |
|---|---|---|
| Cross-session retrieval is the normal case | 41 of 47 non-empty recalls | Read path works; don't rebuild it |
| Cold-project empties | 33 of 80 (41%) | Global default converts most of this to signal |
| Salience is saturated | 91% at s2/s3; post-epoch s0 = 0 | `w_sal` is near-constant — a dead ranking term |
| Context cost per recall | mean body 1,604 B; ~20 KB per 10-entry recall | Paid on **every** planning turn, gate-enforced |
| Silent unknown-project | `project:"*"` → 0, four times | 3 observed false claims caused by it (2 theirs, 1 mine) |
| Spine is unconsumed | 1,411 of 1,413 rows in one project; `source:"hook_spine"` never queried | Either wire it or cut it — currently pure write cost |
| Name fragmentation | ~4 slug families + 2 case/prefix twins | Worse than the single `.SAP-move` case reported |
| Behaviour change | 3/3 recurrences post-recall | Unproven; see §0.2 |

### Refuted or demoted — do not carry these forward

**Embeddings are not yet earned (field report iii raises them to High/P2 — demote to P3, gated).**
Observed query mix: **48 of 71 text queries (68%) carry an identifier-like token** — system object
names, ticket IDs, API symbol names. That is precisely the case the same report concedes FTS
handles better than semantics. In nine days of real use, **not one query** exhibited the
vocabulary-mismatch shape ("how do I safely relocate a synced folder…") that motivates the
investment. The report's own proposed experiment is the right gate: generate paraphrased queries
sharing no content words, measure recall@5. Run the experiment; buy the infrastructure only if it
collapses. It is a regression test either way.

**Schema friction is not distorting the corpus (field report iii, Finding C's prediction).** The
prediction was that `surprise` over-representation grows with session busyness. Over-representation
is real (Aug: surprise 52 / confidence 21, reversed from Jun's 57 / 22) but the gradient **inverts**:
61.8% surprise in 1–2-entry sessions, 55.2% at 3–4, **46.8% at 5+**. Busier sessions produce *less*
surprise. The August shift is better explained by the day-40 discipline change. Recorded as
`01KZV812JQ…`. Finding C stays — the validator defect is confirmed at source — but as an
author-experience and data-quality defect, not a corpus-integrity emergency, and the surprise share
must not be cited as its evidence.

**Scratch projects are not diluting the corpus.** 45 of 46 projects hold self-reports. The dilution
is *fragmentation* (same work under several slugs), not proliferation.

**`match` is not "not strict" (field report i).** It is strict — `hybrid-ranker.ts:47` returns only
FTS-matched rows with no recency padding. The cause is that `buildMatchExpr`
(`sqlite-repository.ts:137-145`) joins terms with **OR**, so one common token qualifies an entry.
This inverts the conclusion: an *empty* `match` **does** prove absence; a *non-empty* one proves
nothing about the concept. The reporter's actual need was an identity lookup, which no tool provides
— see `get_entry` in Sprint 1.

---

## Sprint 0 — Fix the timing *(revised 2026-08-13 after measuring)*

**Goal:** move the enforcement budget from the secondary path (read) to the primary one (write), and
shift corpus composition toward the scarce kinds.

### The finding that reshaped this sprint: adding ≠ converting

The 2026-08-12 review session ended with a *manual* version of the planned nudge — the owner asked
"aren't today's lessons worth recording?" — which produced one `dead_end` and one
`abandoned_branch`, taking `abandoned_branch` from 4 entries to 5. That was reported as the nudge
working. **Measured the next day, it wasn't:**

| Slice | Total | Scarce | Share |
|---|---|---|---|
| Pre-review baseline (< 2026-08-12 12:00) | 260 | 47 | **18.1%** |
| Written during the review session | 11 | 2 | **18.2%** |
| Corpus after | 271 | 49 | **18.1%** |

The session also produced nine abundant-kind entries, landing at exactly the baseline ratio.
**Composition is a ratio: an end-of-session nudge that *adds* scarce entries cannot move it while
the session keeps producing abundant ones at the same rate.** The nudge is additive; the metric
needs *conversion* — catching the `surprise` that is really a `dead_end` at the moment of writing.
That is where the 27 mislabelled entries live, and it reorders this sprint.

### 0a — journal nudge ✅ **SHIPPED 2026-08-13 (`8c02a11`)**

*Moved from `Stop` to `UserPromptSubmit`: Stop's `additionalContext` support is undocumented and its
loop guard unverified, and at user scope a misfiring Stop hook would block session termination in
every project. UserPromptSubmit is verified, loop-free, and fires mid-session with the work still in
context — better capture than a retrospective prompt.*

Not *"anything worth journaling?"* — that yields more `confidence`. Name the scarce kind:
**"what did you abandon, and why?"** For `abandoned_branch` and `dead_end` end-of-session is the
*correct* timing, since abandonment is only knowable retrospectively; the defect is that nothing
asks, not that it asks late. Works in every project, no spine dependency. Additive only — ship it
because it is nearly free, not because it will move the ratio.

### 0b — The conversion bundle ✅ **SHIPPED 2026-08-13 (`52c9664`)** ← **the leverage**

*All three landed; 120 tests (was 109), build clean. Requires `claude -c` before the tools appear in
a session. Validated against the live ledger: the entry a field report spent 8 days unable to
recover (`01KZ728YX5…`, filed under `vidaprofissional` while searched from `Jobs`) now returns from
any scope in one call. `list_projects` names all 45 projects.*

- **`ledger_get`** — expose the already-implemented `getEntry(id)`. Makes the corpus
  self-recoverable; an 8-day-lost entry was retrievable the whole time.
- **`list_projects`** — extend the existing `countProjects()`.
- **Kind disambiguation in `record_reasoning`'s tool description** — *"if you pursued an approach
  that failed, this is a `dead_end`, not a `surprise`; its `signal` field — what should have tipped
  you off — is what makes it worth recording."* The description is read every time recording is
  considered, so it converts **at source**. Roughly five lines, and on this evidence it outranks 0a.

Rationale for the pairing: `surprise` is a superset of `dead_end` with a cheaper payload, so the
broad kind absorbs the narrow one unless something intervenes before the write.

### 0c — Hook read path ✅ **SHIPPED 2026-08-13 (`8c02a11`)**

*Also added a retry/`dead_end` nudge. An independent review found 9 issues, 2 HIGH, of which the two
worst were invisible to 32 green unit tests because their fixtures replaced the queries that were
wrong (ledger `01KZY4KW3C`). All fixed; 146 tests.*

- **Suppress cold-project recall** — the gate hook counts entries in the resolved scope and skips
  injection at zero, removing ~41% of current ceremony.
- **Move the gate to first substantive tool use**, off plan-mode transitions: a session that
  *starts* in plan mode never fires `EnterPlanMode` (observed twice), and `ExitPlanMode` fires after
  the derivation it was meant to precede.
- **`retry_of` → mid-task `dead_end` trigger.** Already computed and stored by the spine
  (`ledger-service.ts:199`), consumed by nothing. **Blocked by open question 1** — it only exists
  where the spine runs, which today is this repo alone.

### Measurement *(design corrected 2026-08-13 — a point baseline would have manufactured success)*

**There is a large pre-existing upward trend.** Scarce-kind share by 50-entry block:

| Block | Span | Scarce | Share |
|---|---|---|---|
| #1 | Jun 22–28 | 7/50 | 14% |
| #2 | Jun 29–Jul 02 | 6/50 | 12% |
| #3 | Jul 02–21 | 4/50 | **8%** ← trough |
| #4 | Jul 21–Aug 05 | 12/50 | 24% |
| #5 | Aug 05–11 | 15/50 | **30%** ← peak |
| #6 | Aug 11–13 | 5/23 | 22% |

The share nearly **quadrupled from 8% to 30% with no intervention in place**. Consequences:

- **Do not use 18.1% as the baseline.** It is a lifetime average that no longer describes current
  behaviour — recent blocks run 22–30%. Comparing post-Sprint-0 output against 18.1% would score a
  pre-existing trend as a win.
- **Measure as an interrupted time series against the extrapolated trend**, in 50-entry blocks.
- The `dead_end` uptick is broad, not a task artifact: 7 entries since Aug 1 across **5 projects and
  4 sessions**, several sharply self-critical. This reads as genuine discipline change — plausibly
  the day-40 rule finally biting — which is a real confounder, not noise.

**Consequence for sequencing:** attribution for Sprint 0 will be muddy whatever we do, because the
metric is already improving. **Ship 0b on its own merits** — `ledger_get` and `list_projects` fix
reported, reproducible pain independently of composition — and treat composition attribution as
secondary. Do not let a measurement problem hold up fixing a broken tool surface.

**Decision gate (revised):** fund the server sprints if the tool-surface fixes prove out in use.
Composition is worth tracking but is currently too confounded to gate spending on.

---

## Sprint 1 — Stop failing quietly *(one server bundle + free hook fixes)*

**Goal:** every current silent failure becomes loud, and the facet decision ships in a form that
doesn't make the tool feel worse.

### 1a. Server bundle — all of this in ONE `npm run build` + restart

| Change | Justification |
|---|---|
| **Global default scope**; `scope: "all" \| "project"` | Owner decision. Converts most of the 41% cold-empty rate into signal. |
| **`project` as a ranking BOOST, not a filter** | Field report Part 0.1, and correct: a binary is what created the problem. Keep `scope:"project"` as an explicit escape hatch. |
| **Error on unknown project** / `unknown_project: true` | Three observed false claims from `"*"` silently returning 0. |
| **`verbosity: "titles" \| "summary" \| "full"`**, default not-full | 20 KB per 10-entry recall, on every gate-enforced planning turn. **Must ship with the scope change** — global recall returning 20 full bodies will read as a regression. |
| **`list_projects(name, entry_count, last_written, top_tags)`** | The facet is unusable as a filter if names are undiscoverable. |
| **`get_entry(entry_id)`** ← *not in any field report* | The strongest single argument in the set: a reporter held the exact ULID of a "lost" entry for **8 days** with no way to spend it. I resolved it in one SQL query — it was in `vidaprofissional`, not `Jobs`. Cheapest item here; it makes the corpus self-recoverable. |
| **Enumerate permitted values in validation errors** | `FrictionPayload.kind` is `Type.Union([Type.Literal…])` → Ajv `anyOf`+`const` → *"must be equal to constant"* ×4, values never named (`entry-kinds.ts:92-97`; same for `Level` at line 31). ~10 lines in `validatePayload`. |

**Acceptance:** replay the three reported failure transcripts. `project:"*"` errors; a friction
payload with a bad `kind` names the four permitted values; the 8-day-lost entry is retrievable by id
from any project.

### 1b. Hook fixes — ship immediately, no restart

Per field report (ii), all three findings confirmed against `~/.claude/settings.json` — every gate
hook emits `additionalContext` only, none uses `permissionDecision`:

1. **Fire on first substantive tool use**, not on plan-mode transitions. A session that *starts* in
   plan mode never calls `EnterPlanMode` — this recurred in the session that produced this document.
2. **Deny rather than inject** (`permissionDecision: "deny"`) so `ExitPlanMode` fails and must be
   retried after recall. Today the approval arrives in the same round-trip as the instruction, which
   makes the instruction unsatisfiable when read.
3. **Verify from the transcript** instead of asking for self-attestation. Note this needs the spine
   or transcript access — see Sprint 3, which is the same dependency.

---

## Sprint 2 — Make "useful" observable, and separate correction from deletion

**Goal:** produce the signal every later ranking decision depends on. Nothing downstream is
trustworthy without it.

- **A use signal.** Field report Finding I. Constraint from `01KWBWTQ1P…`: increment on
  **confirmed-useful only, never on "returned"** — otherwise it is a popularity counter and the
  rich-get-richer failure mode entrenches wrong-but-frequent entries. Constraint from field report §7
  and the T2 data: a self-reported flag has yes-bias. Prefer the behavioural signal (a later write in
  the same session references the entry) with an explicit `mark_useful` as a secondary channel.
- **Relation types on the link** — `supersedes | refines | extracts_from | relates_to`, with only
  `supersedes` driving the staleness signal. This does triple duty: it fixes field report §5 (a
  reporter omitted a real link because setting `ref_entry_id` would have wrongly marked a valid entry
  stale), it disambiguates the use signal above, and it resolves the column overloading recorded in
  `01KZ28ESP0…` — a hazard I re-introduced into my own analysis code this week despite having read
  the entry warning about it.
- **Metadata correction** (`kind`, `tags`, `salience`), body/payload still append-only.

> **Roadmap correction worth stating explicitly.** `REASONING-LEDGER-PLAN.md` §5/§7 sequenced
> deletion first; `01KWBWTQ1P…` revised it to deletion-last. Both treated "editing" as one thing. The
> field reports separate it correctly: **clerical correction** (a mistyped `kind`, permanently wrong
> because the validator was opaque) is not **pruning** (removing a stale lesson). Correction is safe,
> cheap, and belongs here. Pruning stays last, unchanged.

---

## Sprint 3 — Attack the north star *(the sprint no existing plan contains)*

**Goal:** move from "the right entry was returned" to "the lesson landed when it mattered". This is
the value hypothesis. See §0.2.

- **Wire the hook spine in 1–2 active ticket projects for two weeks.** One change, three payoffs:
  it makes gate *placement* testable (currently observable on 2 of 80 events); it gives Sprint 1b's
  deny-hook something to verify against; and it settles whether the spine is under-exposed or dead
  weight (1,411 of 1,413 rows sit in one project and no consumer has ever queried it).
- **Context-triggered retrieval, prototype.** Field report §2 names this the highest-leverage open
  problem and the T2 recurrence data backs it: session-start recall structurally cannot intervene
  where the error occurs — mid-task, at the moment of writing a claim. A `PreToolUse` tag/shape match
  that surfaces the lesson at that moment is the natural vehicle, and hooks need no restart.
- **Write-time near-duplicate detection.** Filed as "minor" in field report iii; on this data it is
  not minor. A write-time *"this is 0.9 similar to X — supersede it?"* prompt is a direct
  intervention on the 3-of-3 recurrence result, and it is where the judgement is cheapest. Promote.
- **Re-run the T2 script** (`scratchpad/t2-analysis.mjs`) in the 08-17…31 window, now conditioning
  recurrence on the Sprint 2 use signal rather than on supersessions alone.

---

## Sprint 4 — Precision, only once earned

- **Run the paraphrase experiment first.** 3 paraphrased queries per entry sharing no content words
  with the title; measure recall@5 under current `hybrid`. Quantified baseline and regression test.
- **Use-earned salience** replaces author-assigned, per `01KWBWTQ1P…`, now unblocked by Sprint 2.
  Do **not** ship calibration anchors as the fix — the data says authors saturate the scale
  regardless of guidance (91% at s2/s3 across 264 entries, three different reporting agents).
  Keep the salience-gated fade constraint: rare-but-vital lessons must not decay fastest.
- **Stable project identity** (marker file) + `rename`/`merge` to collapse the ~4 slug families.
  Under a global default this is a labelling and boost-accuracy defect, not data loss — so it lands
  here, not earlier. The three `.SAP-move` entries are the regression corpus.
- **Embeddings as a fifth hybrid signal — only if the paraphrase experiment collapses.** Never as an
  FTS replacement: 68% of real queries are identifier-bearing, where lexical is correct and semantic
  is noise.

---

---

## Alignment with the original plan *(added after reading the spec docs)*

Most of what the field reports raise is **unbuilt planned surface, not new scope**. From
`REASONING-LEDGER-ARCHITECTURE.md` §7: at the time of writing **2 of 6 planned tools** and **0 of 5 planned MCP
resources** existed. *(As of 2026-08-14: 5 of 6 tools, 7 total; resources still 0.)*

| Field-report finding | Actually is | Status |
|---|---|---|
| E — `list_projects` | planned `ledger://projects` resource | never built |
| *(mine)* `get_entry` | planned `ledger_get` tool | **`getEntry(id)` implemented, unexposed** |
| F — delete/retype | plan §5 Phase 7 named it the prerequisite for consolidation pruning | never built |
| A — project identity | plan §7 open question: "allow `RLX_PROJECT` / a marker file" | never resolved |
| Sprint 0 Stop-nudge | plan §7's **named top product risk**, with this exact mechanism | deferred at spec stage |

**Two divergences from the locked design, one of them causal:**

1. **`projects` and `sessions` were specified as tables and shipped denormalized.** The spec has
   `projects(id, slug UNIQUE, label, …)` and `sessions(id, project_id, external_id, …)` where
   `external_id` is *"the join key that lands hook-spine and self-report in the same session."*
   What exists is `project TEXT` / `session_id TEXT` on `entries`. The slug fragmentation, the
   absent project listing, and `session_id` NULL at 87% (patched with a `proc-<ulid>` stamp that
   identifies a *process*) all follow from that one drop. **Sprint 4's identity work is therefore
   implementing the written schema, not designing anything.**
2. **`@llm-pipe/core` is imported nowhere**, so the locked "sibling on Calane" decision is
   unimplemented — and with it the `redactSecrets` / `TelemetrySink` reuse that Phase 4 was to
   stand on. Close it or retire it explicitly.

**Effort revision.** `ledger_get` + `list_projects` drop to **~half a day** (`getEntry` and
`countProjects` already exist) and should move into Sprint 0's slot as the cheapest fix for the
most-reported pain — the 8-day-lost entry was retrievable the whole time.

### Deferred phases — the unlock conditions, named

| Phase | Gate |
|---|---|
| 4 — REST + `openai-tools.json`, OTel mirror | a non-MCP caller actually exists |
| 6 — Postgres + pgvector, `SemanticRanker` | the paraphrase recall@5 experiment collapses |
| **Hosting (Render)** | **a second device/agent needs the corpus, *or* a consolidation pass must run without a local session** |

Hosting is *not* unlocked by usage volume. 51 days of data are single-user, single-machine; no
multi-client need has appeared, and consolidation has been run manually and worked. Hosting would
also put the authoritative store on the network on a path the gate hits every planning turn,
against architecture invariant #1 (*store-first, never lossy*). **Separately and independently of
usage: the corpus contains real client material** (SAPSUP ticket numbers, named customers,
customer-facing root causes). Hosting it is a data-governance decision requiring the unbuilt
`redactSecrets` boundary — not a deployment step.

---

---

## ⚠️ SUPERSEDED IN PART — read the reconciliation first

**[`evaluagent-reconciliation-2026-08-13.md`](./evaluagent-reconciliation-2026-08-13.md)** re-baselines
this document against the original June phasing. Summary of what it changes:

- **Sprint 1 is on hold.** Its centrepiece (inverting recall's default scope) is not in the
  architecture — it came from a field report — is largely redundant now that `ledger_get` and
  `list_projects` exist, and conflicts with Sprint 0c: under a global default a "cold" project would
  still return useful lessons, so suppressing the gate there becomes wrong. Salvage only verbosity
  control, unknown-project errors, and enum values in validation messages.
- **Sprints 2–4 wait.** New behavioural invention is frozen.
- **Next build is the specified data model** — `projects` and `sessions` with `external_id`. Two
  unbuilt tables have generated ~10 workarounds, four shipped this week; that is the churn engine.
  Building them retires the `proc-<ulid>` stamp and both proxy fallbacks, makes gate placement
  testable, makes `rename_project`/`merge_projects` trivial, and unblocks three more planned tools.

The sprint numbering below is retained for traceability, not as a plan of record.

---

## Open questions for the owner

1. ~~**Spine: wire broadly or cut?**~~ **RESOLVED 2026-08-13 — wire broadly.** The six spine hook
   events are now wired at **user scope** (`~/.claude/settings.json`), so the spine captures in every
   project rather than this repo alone. The redundant repo-level wiring in
   `.claude/settings.local.json` was removed to avoid double-writing once both scopes load; that
   file's `env` block still pins `EVALUAGENT_PROJECT=evaluagent` here. Backup at
   `~/.claude/settings.json.bak-20260813-174308`.
   **Two limits to know before relying on the new data:** (a) at user scope there is no per-project
   `EVALUAGENT_PROJECT`, so the hook falls back to the **cwd basename** — spine and self-report
   entries for the same work can land under different project slugs; (b) spine rows carry the real
   host `session_id` while self-reports get a `proc-<ulid>` stamp, so **the two sources do not join
   on session either**. This is the unbuilt `sessions.external_id` from the architecture doc. Within
   -spine analysis (`retry_of`, pre/post duration, tool ordering) is unaffected and works today;
   cross-source joins need normalisation or the real fix.
2. **Does the deny-gate risk being disabled in practice?** A hard block on `ExitPlanMode` is the
   correct enforcement, but if it becomes an obstacle it will get switched off, and a disabled gate
   measures nothing. Worth deciding the escape hatch deliberately now.
3. **Is `kind` meant to be analysed?** Field report iii asks this and it is the right question. If
   yes, Sprint 2's correction tool is load-bearing (the taxonomy already contains at least one
   knowingly-mistyped entry). If `kind` is only a writing prompt, relax payload validation instead.
4. **Merge or alias for the slug families?** Re-pointing loses the historical fact that the work
   happened elsewhere; aliasing keeps it at the cost of permanent indirection.
