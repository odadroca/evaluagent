# Reasoning Ledger — Plan

> Status: **brainstorm / spec stage**. No code exists yet. This document and
> [`REASONING-LEDGER-ARCHITECTURE.md`](./REASONING-LEDGER-ARCHITECTURE.md) capture the design
> agreed during brainstorming, so a future build can start from a settled foundation.

## 1. What this is

A portable **reasoning ledger** for LLM agents: capture the introspective texture of an
agent's own reasoning/orchestration — the surprises, dead-ends, confidence calls, abandoned
branches, and friction that are normally discarded the instant a session ends — so that:

- **(a)** a human can analyze an agent's reasoning patterns over time, and
- **(b)** a **future agent instance** can read the *relevant* past entries and reason better.

### Origin

The idea is a direct analogy to **ComeCome**, a meal-intake tracker the user built for his
ADHD son: take an otherwise-ephemeral, low-priority activity, *track it over time* so patterns
emerge and the actor is empowered by seeing their own history. Here the actor is an LLM agent
and the ephemeral activity is its reasoning.

## 2. Landscape research — are we reinventing the wheel?

Short answer: **the *primitives* are mature and must not be rebuilt; the *specific combination*
— a typed, agent-authored *introspective* ledger captured ambiently and consumed by the next
instance — is a real, mostly-unfilled niche.**

| Camp | State of the art | Relevance |
|---|---|---|
| **Behavioral spine** (LLM calls, tool calls, latency, cost) | Langfuse (OSS), LangSmith, Phoenix; **OpenTelemetry GenAI semantic conventions** now cover agent + MCP spans; Claude Code emits native OTel | SOLVED & standardized — **reuse, don't rebuild** |
| **Cross-session memory + MCP delivery** | Mem0, Zep, Letta, Cognee; official MCP "memory" knowledge-graph server | MATURE — storage/retrieval/MCP plumbing is a commodity |
| **"Learn from your mistakes"** | **Reflexion** (post-mortem → prepend next attempt); Generative-Agents memory stream + reflection; CoALA | WELL-ESTABLISHED in research, not novel |
| **Recognized memory taxonomy** | episodic / semantic / **procedural** | Does **not** treat agent *introspection* (confidence, surprise, dead-ends-with-reason, abandoned branches, friction) as first-class — **this is the whitespace** |

**Documented pitfalls to design against (free input):**
- ⚠️ **Self-reinforcing error** — reflective memory can entrench a false belief ("API X always
  fails with param Y") and never re-test it.
- **Staleness** — outdated entries become "confidently wrong."
- **Privacy/consent & cross-session identity** — listed as top open gaps.

**The actual whitespace (defensible core):** nobody cleanly does all three together — a
*typed introspective ledger* + *agent-authored for next-instance consumption fused with the
behavioral spine* + *local-first/portable (MCP + OpenAI), not enterprise-API-billed SaaS*.

**Sources:** [Langfuse](https://langfuse.com/docs/observability/overview) ·
[LangSmith](https://www.langchain.com/langsmith/observability) ·
[OTel GenAI agent spans](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/) ·
[OTel traces LLM/agent/MCP](https://greptime.com/blogs/2026-05-09-opentelemetry-genai-semantic-conventions) ·
[Claude Code monitoring](https://code.claude.com/docs/en/monitoring-usage) ·
[claude-code-hooks-observability](https://github.com/disler/claude-code-hooks-multi-agent-observability) ·
[Mem0 vs Zep vs Letta](https://www.agenticwire.news/article/mem0-zep-letta-agent-memory) ·
[State of AI Agent Memory 2026](https://mem0.ai/blog/state-of-ai-agent-memory-2026) ·
[official MCP memory server](https://a2a-mcp.org/entry/memory-mcp) ·
[Reflexion](https://arxiv.org/pdf/2303.11366) ·
[Self-reflection survey](https://shermwong.com/2025/01/03/llm-agent-studies-chapter-2-self-reflection/)

## 3. Calane fit — does the existing kernel already suffice?

The user's existing repo **`odadroca/Calane`** (a.k.a. `llm-pipeline-kernel`) is an
inspectable, library-first **LLM-pipeline kernel**. It provides ~⅔ of the foundation but
**does not suffice as-is.**

**Fundamental mismatch:** Calane's unit of record is a **`RunResult`** — the schema-validated
output of a *deliberately invoked, versioned pipeline* against an `input`. The ledger's unit
is an **introspective moment captured during arbitrary, free-form work**. Three gaps follow:

1. **Capture is pull, not push.** Calane runs when you call `run_pipeline`. The ledger must
   capture reasoning *as it happens* during work done for other reasons.
2. **The schema doesn't fit.** `ChannelResult` models provider/model/usage/latency/validation.
   The six introspective kinds don't map onto it; stuffing them into `metadata`/`parsedOutput`
   hides them from `stats` (only cost/latency/validation) and `diff` (same-pipeline parsed
   outputs only).
3. **No relevance recall.** Calane reads = get-by-id, list, filter-by-pipeline/status/time,
   diff, aggregate stats. There is no "given my current task, surface relevant past lessons."

**But Calane gets us most of the way** and reframes the work from "build a server + store +
surfaces" down to "add an entry schema + a capture path + a recall path, reusing Calane's
machinery." See the reuse map in the architecture doc.

## 4. Locked decisions

- **Purpose:** all three — agent logs → human analyzes → next instance consumes.
- **Capture:** hybrid — MCP self-report tools **+** a Claude Code **hook bridge** (behavioral
  spine), into one shared store.
- **Stack:** TypeScript. **Schemas in TypeBox + Ajv** (Calane's rule: *no Zod authored*).
- **Storage:** SQLite first, behind a swappable repository; Postgres (+ **pgvector** for
  semantic) later — mirroring Calane's SQLite store pattern (canonical JSON verbatim +
  denormalized projection tables for indexed querying).
- **Entry types:** all six introspective kinds + the always-on behavioral spine.
- **Retrieval:** simple match (project + tags + recency + FTS) for v1; semantic-ranking seam.
- **Interop:** MCP + OpenAI-legacy (function schemas) + REST — coarse-grained, small surface.
- **Relationship to Calane → Option 3 (sibling).** A separate package that **imports
  `@llm-pipe/core`**; Calane's kernel and its binding non-goals stay untouched; the hook
  bridge lives in the sibling; the ledger is a separately-attributed observability citizen
  (`service.name = reasoning-ledger`). Rationale: cleanest external-observability boundaries
  (see architecture doc §"Two-plane discipline").

## 5. Build phasing (thin end-to-end first)

0. **Skeleton** — package depending on `@llm-pipe/core`; TypeBox entry schemas (no I/O).
1. **MVP slice** — SQLite repo + `LedgerService.record/query` + MCP
   `record_reasoning`/`recall_reasoning` over stdio. An agent can journal and recall.
2. **Full model** — all 6 kinds, projects/sessions, tags + FTS + hybrid `SimpleRanker`, recall
   carryover preface, MCP resources.
3. **Hook bridge** — `rlx-hook` CLI, event mapping, pre/post correlation + retry detection,
   `hooks install` (prints the settings snippet).
4. **Interop + observability** — REST + `openai-tools.json`; optional OTel mirror
   (GenAI-semconv-aligned, redaction-at-boundary).
5. **Guards + DX** — anti-self-reinforcement/staleness in recall; pagination; redaction;
   quickstart.
6. **(Future, unblocked)** — Postgres + pgvector repo behind the same interface;
   `SemanticRanker`; optional Calane-native reflection pipeline.
7. **Consolidation / reflection — the third beat of the loop.** The loop is
   **capture → recall → consolidate**: a periodic pass reads accumulated `self_report` entries,
   distils the recurring/durable ones, and **promotes** them to always-on memory (`CLAUDE.md`
   / project memory) — because the ledger is queried on demand, whereas `CLAUDE.md` loads every
   session. Mirrors the memory-consolidation / higher-order-reflection step from the research
   (Generative Agents, Reflexion). Principles: ruthless selectivity (salience is the dial —
   record little, high-signal; noise drowns signal); **prune what rots** (a lesson invalidated
   by code changes actively misleads — deleting matters as much as adding); two tiers (ledger =
   on-demand long tail; `CLAUDE.md` = the few universals).
   Mechanism note: consolidation needs *judgment* (an agent), so it can't be a pure shell hook,
   and the ledger is a **local** SQLite file (a cloud-scheduled routine can't read it) — so v1
   runs **on request in a local session**; an optional `SessionStart` *nudge* hook (count new
   `self_report` since last pass) and a first-class `consolidate` routine are later options.
   Don't automate prematurely — wait until ~15-20 lessons accumulate so a pass has signal.

## 6. Verification (of the future build)

- **Unit:** TypeBox/Ajv round-trips for all 6 kinds + spine; reject malformed.
- **Storage** (SQLite `:memory:`, contract tests reusable against Postgres): insert→get
  fidelity; tag/FTS; project-scope isolation; pagination; pre/post spine correlation + retry.
- **Ranker** (pure): ordering for recency/match/hybrid + decay/staleness behavior.
- **MCP** (in-memory transport): `record`/`recall` round-trip; resources.
- **Interop:** REST parity; `openai-tools.json` shape; OTel mirror emits GenAI-semconv events
  and redacts at the boundary; ledger spans carry `service.name=reasoning-ledger`.
- **Hook bridge:** real hook JSON fixtures → rows; always exits 0.

## 7. Open questions (defaults chosen; revisit during build)

- **Self-report adoption** (top product risk) — mitigated by the spine guaranteeing some
  signal + a `reflect_now` prompt; consider a `Stop`-hook journaling nudge.
- **Project slug derivation** — allow `RLX_PROJECT` / a marker file.
- **Reflection pipeline home** — Calane `examples/` vs the sibling.
- **OTel GenAI attribute mapping** — exact attributes for the 6 kinds (semconv still
  experimental).
