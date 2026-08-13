# Evaluagent — lessons from a live 8-day investigation

> Field notes from **SAPSUP-6636**, an SAP support investigation run 04–11.08.2026 across ~10
> sessions with the ledger connected throughout. 12 self-report entries were written and recalled in
> anger. This document is about **what the episode revealed about the ledger as a product** — not
> about SAP. Each observation is followed by the evidence and a concrete design implication.
>
> Companion to [`REASONING-LEDGER-ARCHITECTURE.md`](./REASONING-LEDGER-ARCHITECTURE.md) and
> [`REASONING-LEDGER-PLAN.md`](./REASONING-LEDGER-PLAN.md). Written from the *caller's* side.

---

## 1. Portable lessons have no home in a project-scoped store

**The sharpest finding.** The entries with lasting value were never the findings — those die with
the ticket. They were the ones naming a **failure shape**: *"an absence that is a property of your
query, not the world"*, *"a negative rules out a role, not an object"*, *"ask what predicate produced
the extract"*, *"can this instrument resolve the difference at all?"*. Those are reusable on any
task in any domain.

But `recall_reasoning` scopes to the current project by default, and the response confirms it —
`scope.projects_total: 38` tells you 37 other projects exist and you are not seeing them. So the
most valuable class of entry is filed in the one place it will never be read from again.

**Evidence.** At the end of this investigation the user asked for the key lesson to be duplicated
under a generic project name, because there was no other way to make it reachable. Two copies of the
same entry now exist (`01KZRSSC38…` under the ticket, `01KZRT04T8…` under `_portable-lessons`).
Manual duplication is a workaround with a known decay mode: the copies drift, and nothing links
them except prose in the body.

**Implications.**
- A first-class notion of scope beyond `project` — e.g. `scope: "project" | "portable"`, or a
  reserved project that recall *always* unions in.
- Or: make tag-based retrieval cross project boundaries explicitly (`tags:[…], scope:"all"`), so a
  `portable-lesson` tag is sufficient without duplication.
- Whichever route: **entry duplication should never be the recommended answer.** If a user has to
  copy an entry to make it findable, the retrieval model is wrong.

## 2. Recording a lesson does not prevent repeating it

**The most uncomfortable data point in the set.** Entry `01KZE3BHEAJX59VRPEDX02YBYN` contains, in my
own words:

> "This is the THIRD time on this ticket that a scoping claim was an artefact of an extract
> predicate — and I had already recorded the lesson both times. **Recording it did not stop it.**"

Three occurrences, two prior entries, no behavioural change. The store worked exactly as designed —
write, then recall at task start — and the failure still recurred, because the error happens in the
middle of a task, at the moment of *writing a claim*, not at the moment of starting one.

**Implication — this is the highest-leverage open problem.** Session-start recall is necessary but
structurally cannot intervene where the mistakes occur. Worth exploring:
- **Context-triggered retrieval**: surface an entry when the *shape* of the current action matches
  it (about to state a scope/onset claim; about to conclude from an empty result set).
- The existing hook bridge is the natural vehicle — it already sees tool calls. A `PreToolUse`-style
  match on entry tags would land the lesson at the moment of the error rather than 40 minutes before.
- Absent that, entries should at least be *written* to be recognisable mid-task: lead with the
  trigger condition, not the conclusion.

## 3. The mandated-recall gate sits on the wrong edge

Recorded live as friction `01KZB3FCNPMJD5BP2RFM2493C7`. The user's `CLAUDE.md` makes recall before
planning mandatory and hook-enforces it on `ExitPlanMode`. In practice I read the corpus, a new
dataset, six screenshots, formed a full reassessment and wrote the entire plan — and only then did
the hook fire. **By the time the gate triggered, recall could not change anything.** It was ceremony.

That project had zero stored entries, so nothing was lost. The same ordering on a populated project
means re-deriving conclusions a prior instance already recorded — precisely the failure the gate
exists to prevent, and the hook cannot catch it because it fires *after* the derivation.

**Implication.** Gate on the **first substantive read**, not on the plan-mode transition. The trigger
should be the user's opening request. This is a hook-placement fix, not a prompt fix — "remember the
hook exists" was already true and didn't help.

## 4. Payload schemas are not discoverable from the tool surface

Twice in this project the correct move was to open `src/domain/entry-kinds.ts` in the repo and read
the TypeBox definitions, because the MCP tool description says only *"Kind-specific fields (validated
per kind)"*. The first time cost two failed calls before reading the schema (recorded in
`01KZB3FCNPMJD5BP2RFM2493C7`); the second time I read the file first specifically because that entry
said to.

That is a memory entry compensating for a discoverability gap in the API. It works, but only for
callers who happen to have the repo checked out — which is not a property the MCP contract should
depend on.

**Implications.**
- Inline the per-kind field lists in the `record_reasoning` tool description (six kinds, three to
  four fields each — it is perhaps 15 lines).
- Or expose a `describe_kinds` tool.
- Or return the expected schema in the validation error, so the failed call teaches the correct one.
  Currently `validatePayload` returns `"<path> <message>"` per Ajv error, which says what is wrong
  but not what was expected.

## 5. `ref_entry_id` collapses several relations into one

The field is documented as *"supersedes, corrects, or refines"*. Those are three different
relations, and the read-side behaviour — surfacing `superseded_by` so a stale entry is visibly
outdated — is correct only for the first.

**Evidence.** At the end of this investigation I wanted to link a method lesson to the ticket-specific
finding it was extracted from. That is *neither* supersession nor correction — the original stays
fully valid. Setting `ref_entry_id` would have wrongly marked it stale, so I omitted the link and
cited the id in prose. **Recall cannot traverse prose.** The relation is now invisible to the system.

**Implication.** A relation type on the link: `supersedes` | `refines` | `extracts_from` |
`relates_to`. Only `supersedes` should drive the staleness signal. Cheap to add, and it is the
difference between a linked graph and a pile.

## 6. What the store got right — do not regress these

- **`superseded_by` on recall.** Four root causes in this investigation were falsified within hours
  of being written. Seeing the chain (`v2 superseded_by v3 superseded_by v4…`) at recall time is
  exactly what stops a future instance re-adopting a dead theory. This is the single best feature.
- **The six kinds are well chosen.** `dead_end` in particular forces `{approach, reason, signal,
  recoverable}` — and the **`signal`** field is the one that produces insight, because it asks *what
  should have tipped me off, and when?* Answering it is what surfaced that I had the disconfirming
  evidence four days before I acted on it. Kinds that force a question the author would not ask
  unprompted are doing real work.
- **Free-text `body` with no length pressure.** The valuable entries are 300–600 words of
  introspection. A terser format would have destroyed them.
- **Confidence + salience on the envelope, not in the payload.** Correct separation.

## 7. Confidence at write time predicts nothing — and the store knows better than the author

Four superseded root causes in this project carry author confidence **0.9–0.95**. All four were
falsified, three of them within about an hour of being written.

Self-reported confidence measured *coherence*, not correctness — and coherence is exactly what a
plausible-but-wrong theory has most of. The system already holds the disconfirming evidence: those
entries have `superseded_by` links.

**Implication.** Do not present stored `confidence` to a reader as if calibrated. Either
- decay it when an entry is superseded, or
- show it alongside the supersession record so the reader sees `0.95 — later superseded`, or
- consider surfacing an author-level calibration signal ("entries at ≥0.9 in this project were
  superseded 4/12 times"). That would have been genuinely useful to me mid-investigation.

## 8. Smaller observations

| Observation | Implication |
|---|---|
| `recall` returned 11 entries and I used ~4. The ranking was fine; the volume was the issue at session start when context is scarce. | A summary mode — titles + one-line `signal`/`payload` gist — with drill-down on demand. |
| Every entry I wrote was authored *after* the insight, when the reasoning was already tidy. The messy middle is never captured. | The hook spine (`source: hook_spine`) is the right instrument for this; it was not used here. Worth making the spine easier to reach from the same tool. |
| Entries accreted a house style (bold lead, evidence, "what I want to carry") purely by imitation of my own earlier entries. | That is emergent and good. Do not impose a template — but *do* consider surfacing the author's own recent entries when writing, since imitation is doing the work a template would. |
| Nothing in the flow ever prompted me to record. Every entry came from the user's `CLAUDE.md` instruction or my own judgement. | Recording at the right moment is the same problem as retrieval at the right moment (§2). One mechanism could serve both. |

---

## The one-paragraph version

The ledger's write side is good: the kinds force useful questions, `superseded_by` prevents
re-adopting dead theories, and free-text bodies preserve what matters. **The read side is where the
value leaks.** Portable lessons — the most reusable entries — are filed per-project and therefore
unreachable; recall fires at session start, which is the wrong moment to prevent a mid-task error;
and the enforcement hook sits on the plan-mode edge rather than the first substantive read. All three
are retrieval-timing and retrieval-scope problems, not storage problems. The evidence that this
matters is in the store itself: a lesson recorded twice, and repeated a third time anyway.
