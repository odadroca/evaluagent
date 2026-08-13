# T2/T3 measurement — first read of the recall-event data

> Run 2026-08-12 (~16:20 WEDT), nine days into the T2 epoch (2026-08-03 ~08:26Z, bundle `873a041`).
> Five days ahead of the scheduled 08-17…31 window, because the data already exists.
> Read-only analysis over `~/.evaluagent/ledger.db`; script kept out of the repo.
>
> Structure follows the house rule: **observed facts → inferences → recommendations**, kept apart.
> Companion to the caller's-side field report written during a live support investigation, which
> several of these numbers quantify.
>
> **The ledger is live.** Counts moved during the session (`ref_entry_id` self-reports went 17 → 19
> as other sessions wrote). All figures are as of the run.

---

## 1. Observed facts

### 1.1 The instrumentation works

| Measure | Value |
|---|---|
| `recall_events` rows | **80** (2026-08-03T08:29Z → 2026-08-12T13:42Z) |
| Active days | 8 (no rows 08-08 / 08-09 — a weekend) |
| Post-epoch `self_report` entries | **82** across 21 normalized projects |
| `session_id` NULL, post-epoch | **1 of 82** (76 `proc-*`, 3 explicit) |
| `ref_entry_id` set, post-epoch | **19** |
| Corpus total | 260 `self_report` + 1343 `hook_spine`, 45 projects |

Three of the day-40 blockers (`01KZ1ZDHZW…`) are now closed by construction: the recall-event log
exists (this analysis is only possible because of it), session stamping works (NULL fell from
83–87% to ~1%), and `ref_entry_id` went from 0/175 to 19 post-epoch uses.

### 1.2 Empty recalls are cold-project, not retrieval failures

33 of 80 recalls (**41.3%**) returned zero results. Decomposed:

- **27** were text queries against a project that held **no entries at all** at that moment.
- **6** were `rank: "recency"` with no text — also against projects with zero prior entries.
- **0** were queries against a populated project that failed to retrieve.

There are **no warm-project misses in the entire dataset.** The recency+text defect fixed in the
bundle (`01KY223HH7…`) does not reappear: every empty is explained by an empty corpus, not by the
ranker. Mean returned set is **2.55** entries.

### 1.2b Correction (added later the same day): recall reaches *prior* sessions routinely

An earlier draft of this report measured the recall→behaviour link only through supersessions and so
under-read what recall is doing. Splitting the 47 non-empty recalls by whether they returned an entry
written by a **different** session:

| | Count |
|---|---|
| Returned a **prior session's** entry (the case that carries a lesson forward) | **41** |
| Returned only the current session's own writes (self-retrieval) | 6 |

Cross-session retrieval is the *normal* case, not the exception. §1.4's thin recall→action link is a
statement about the **use signal**, not about reach. Also corrected: an earlier note read the four
`project:"*"` events as successful cross-project reads. All four returned **zero** — `"*"` is a
literal project name matching nothing, not a wildcard.

**Query mix**, which bears on ranking investment: **48 of 71** text queries (68%) contain an
identifier-like token — system object names, ticket IDs, API symbol names. Not one query in nine
days exhibited the pure vocabulary-mismatch shape that semantic search exists to solve.

### 1.3 Coverage

Recall fires nearly everywhere entries exist. Only 2 of 21 post-epoch projects have entries and
zero recalls (1 entry each). Recall-to-entry ratios vary widely — several projects sit near 2:1
(8 recalls / 4 entries), against roughly 0.6:1 for the busiest project (12 recalls / 19 entries).

### 1.4 The recall→action link (T3 north-star, first real measurement)

Of the 19 post-epoch entries carrying `ref_entry_id`, was the superseded target ever surfaced by a
prior recall?

| | Count |
|---|---|
| Surfaced in the **same session** before the superseding write | **5** |
| Surfaced in the same project, any time | 6 |
| **Never surfaced by any recall** | **13** |

Ranks in the 5 same-session cases: **2, 2, 3, 3, 4** — never rank 1.

### 1.5 Recurrence, conditioned on recall

8 candidate recurrence pairs (same project, tag Jaccard ≥ 0.5, ≥2 shared tags). Of these, **3 had a
recall fire between the two entries, and in all 3 that recall returned the earlier entry.**

Anchor case `01KZE3BHEA…` — the entry whose own body says a scoping lesson "killed the scoping for
the third time": **4 recalls fired in that project before it, returning 9 entries.** Recall was in
active use and the lesson recurred anyway.

### 1.6 Corpus quality

Post-epoch kind mix is strongly failure-weighted — the day-40 inversion held and deepened:

`surprise` 46 · `confidence` 17 · `friction` 10 · `dead_end` 6 · `abandoned_branch` 2 · `reconstruction` 1

Salience post-epoch: **s3 = 38, s2 = 42, s1 = 2, s0 = 0.**

### 1.7 Ordering is unobservable; project names fragment

The tool-call spine exists in **one** project (`evaluagent`), covering **2 of 80** recall events.
Two normalized projects have split raw names: `evaluagent`/`Evaluagent` and `.SAP-move`/`SAP-move` —
the latter recalled seconds apart in one session, one side returning zero.

---

## 2. Inferences

Labelled as inference, not fact.

**The 41.3% empty rate is the gate's cost, not a bug.** I first read it as a retrieval defect; the
cold/warm split refutes that. Mandating recall before planning in *every* project necessarily fires
it in projects with empty corpora. The ceremony is real — ~4 in 10 recalls can return nothing useful
by construction — but the retrieval path is clean. This is the quantified form of
`evaluagent-lesson-learned.md` §3's "it was ceremony".

**Supersede-linking is mostly not recall-driven.** 13 of 19 supersessions targeted entries no recall
ever returned. The likely mechanism is that the author already had the entry in context from the
same session's own work. So the `ref_entry_id` adoption — a genuine practice win — is **not**
evidence of recall efficacy, and should not be reported as such.

**The 5 same-session cases are, however, the first concrete recall→write chain in the dataset:**
recall returned entry X, and later in that same session a new entry explicitly superseded X. That
they cluster at ranks 2–4 rather than rank 1 is weak evidence that the useful entry is often not the
top hit — consistent with §8's "returned 11, used ~4", though n=5 is far too small to weight ranking on.

**The north-star result is unfavourable so far.** In 3 of 3 measurable cases, recall surfaced a prior
lesson and a closely-related lesson was logged again anyway. Caveat that materially weakens this:
tag-overlap clustering cannot distinguish *repetition* from *legitimate refinement* — one pair is
literally titled "Correction: …", which is the supersede mechanism working as designed. Treat 3/3 as
an upper bound on failure, not a measured recurrence rate. The anchor case is the sturdier data
point, because its own author documented the recurrence as a recurrence.

**Salience has inflated at the top.** Zero entries rated s0 and 46% rated s3 post-epoch. July's
problem was a bimodal split with an empty middle; day-40 reported the middle filling in. The middle
did fill, but the floor vanished — if nothing is unimportant, salience no longer discriminates and
its contribution to hybrid ranking degrades toward a constant. This is a new drift, opposite in sign
to the day-40 note about three reconstructions under-rated at s0.

**The CLAUDE.md confound is untouched** and remains the binding constraint on any causal claim.
Nothing here separates "recall carried the lesson" from "the always-loaded rule carried it".

---

## 3. Recommendations

1. **Do not act on the 41.3% figure as a defect.** If gate ceremony is to be reduced, the lever is
   gate placement (§3 of the field report), not the ranker.
2. **Normalize the project key at write time**, or at minimum warn when a new project name collides
   with an existing one under case/punctuation folding. Two collisions in 45 projects is small but
   it silently splits a corpus, and one instance already produced a zero-result recall next to a
   populated sibling.
3. **Re-check salience calibration before touching ranking weights.** With s0 unused and s3 at 46%,
   any reweighting would be tuned against a degraded signal. This supersedes nothing yet — it is a
   reason to hold the ranking-weight work still deferred.
4. **The "used" signal remains the missing primitive.** `ref_entry_id` proved to be a poor proxy
   (13/19 unrelated to recall), and it is already overloaded — on `hook_spine` rows the same column
   means pre/post correlation, which corrupted my first pass at rank utilization until restricted to
   `self_report` (the hazard recorded in `01KZ28ESP0…`, hit in practice here). A distinct relation
   type, as argued in field-report §5, would serve measurement as well as retrieval.
5. **Ordering claims need spine coverage beyond this repo.** At 2/80 events, whether the gate fires
   before or after the derivation it guards cannot be tested from data. Wiring the hook bridge in one
   active SAP ticket project for a week would settle §3 empirically.
6. **Re-run in the 08-17…31 window** with the same script. The recall→action chain (n=5) and
   recurrence (n=3) are the numbers that most need more data before anything is concluded from them.

---

## 4. Verdict

The measurement gap named in July and again at day 40 is **closed as a gap** — the join key exists,
sessions are stamped, and the north-star question can now be asked of data instead of argued from
impressions. That is the bundle delivering exactly what it was built for.

The first answer it returns is mixed, and the two halves must not be collapsed:

**Reach is good.** Recall is invoked broadly, retrieves cleanly whenever the corpus is non-empty
(zero warm-project misses in 80 events), and **41 of 47 non-empty recalls surfaced a prior session's
entry** — the case that carries a lesson forward is the normal case.

**Effect is unproven.** Against that reach: 3 of 3 measurable recurrences happened *after* recall
surfaced the earlier lesson, one documented case recurred a third time with 4 recalls behind it, and
13 of 19 supersessions had no recall involvement at all. Nothing in the store records whether a
returned entry was *used*, so effect cannot be attributed either way.

Stated plainly: **the read path is working; the behaviour change is now measurable and, on nine days
of data, not yet demonstrated.** The binding constraint has therefore moved — it is no longer
*getting the right entry returned* (that demonstrably happens) but *intervening at the moment the
lesson applies*, and *observing whether it did*. Those are the two things nothing currently does.
