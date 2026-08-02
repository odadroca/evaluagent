import type { EntrySource, LedgerEntry, LedgerQuery, RankMode, RecallResult } from "../domain/entry.js";
import type { LedgerRepository } from "../repo/ledger-repository.js";
import type { Ranker } from "../repo/ranker.js";
import type { SpineWrite } from "../domain/spine.js";
import { isEntryKind, validatePayload } from "../domain/entry-kinds.js";
import { clampLimit, RECALL_MAX_LIMIT } from "../domain/limits.js";
import { HybridRanker } from "./hybrid-ranker.js";

export class LedgerValidationError extends Error {
  readonly errors: string[];
  constructor(message: string, errors: string[] = []) {
    super(message);
    this.name = "LedgerValidationError";
    this.errors = errors;
  }
}

/** Input to `record` — `project` may be omitted when a default is configured. */
export interface RecordInput {
  kind: string;
  title: string;
  body: string;
  payload: unknown;
  project?: string;
  confidence?: number | null;
  salience?: number;
  tags?: string[];
  sessionId?: string | null;
  occurredAt?: string | null;
  /** Earlier entry this one supersedes/corrects/refines. Must exist. */
  refEntryId?: string | null;
}

/**
 * Input to `recall` — `project` may be omitted when a default is configured.
 * `source` defaults to "self_report" so spine noise never drowns the lessons;
 * pass an explicit source (e.g. "hook_spine") to widen.
 */
export type RecallInput = Omit<LedgerQuery, "project"> & { project?: string };

export interface LedgerServiceOptions {
  repo: LedgerRepository;
  ranker?: Ranker;
  defaultProject?: string;
  /** Stamped on writes that carry no explicit session id (e.g. a per-process proxy id). */
  defaultSessionId?: string;
}

export class LedgerService {
  private readonly repo: LedgerRepository;
  private readonly ranker: Ranker;
  private readonly defaultProject?: string;
  private readonly defaultSessionId?: string;

  constructor(opts: LedgerServiceOptions) {
    this.repo = opts.repo;
    this.ranker = opts.ranker ?? new HybridRanker();
    this.defaultProject = opts.defaultProject;
    this.defaultSessionId = opts.defaultSessionId;
  }

  async record(input: RecordInput): Promise<LedgerEntry> {
    if (!isEntryKind(input.kind)) {
      throw new LedgerValidationError(`unknown entry kind: ${input.kind}`);
    }
    if (!input.title || input.title.trim() === "") {
      throw new LedgerValidationError("title is required");
    }
    if (!input.body || input.body.trim() === "") {
      throw new LedgerValidationError("body is required");
    }

    const payloadCheck = validatePayload(input.kind, input.payload);
    if (!payloadCheck.valid) {
      throw new LedgerValidationError(`invalid ${input.kind} payload`, payloadCheck.errors);
    }

    if (input.confidence != null && (input.confidence < 0 || input.confidence > 1)) {
      throw new LedgerValidationError("confidence must be in [0,1]");
    }
    if (input.kind === "confidence" && typeof input.confidence !== "number") {
      throw new LedgerValidationError(
        "the 'confidence' kind requires a confidence score in [0,1]",
      );
    }
    if (
      input.salience != null &&
      (!Number.isInteger(input.salience) || input.salience < 0 || input.salience > 3)
    ) {
      throw new LedgerValidationError("salience must be an integer in [0,3]");
    }

    if (input.refEntryId != null && typeof input.refEntryId !== "string") {
      throw new LedgerValidationError("ref_entry_id must be a string");
    }

    if (input.refEntryId != null) {
      const ref = await this.repo.getEntry(input.refEntryId);
      if (!ref) {
        throw new LedgerValidationError(`ref_entry_id does not match any stored entry: ${input.refEntryId}`);
      }
    }

    const project = input.project ?? this.defaultProject;
    if (!project) {
      throw new LedgerValidationError("project is required (no defaultProject configured)");
    }

    return this.repo.insertEntry({
      kind: input.kind,
      project,
      title: input.title,
      body: input.body,
      payload: input.payload,
      confidence: input.confidence ?? null,
      salience: input.salience,
      tags: input.tags,
      sessionId: input.sessionId ?? this.defaultSessionId ?? null,
      occurredAt: input.occurredAt,
      refEntryId: input.refEntryId ?? null,
    });
  }

  async recall(input: RecallInput): Promise<RecallResult> {
    const project = input.project ?? this.defaultProject;
    if (!project) {
      throw new LedgerValidationError("project is required (no defaultProject configured)");
    }
    const source: EntrySource = input.source ?? "self_report";
    const rank: RankMode = input.rank ?? "hybrid";
    const limit = clampLimit(input.limit, RECALL_MAX_LIMIT);
    const query: LedgerQuery = { ...input, project, source, rank, limit };

    const candidates =
      rank === "recency"
        ? query.text?.trim()
          ? // Tokenized FTS (same interpretation as match/hybrid) — the whole-phrase LIKE
            // in query() silently false-empties on multi-word text.
            await this.repo.search({ ...query, rank: "match" })
          : (await this.repo.query({ ...query, text: undefined })).map((entry) => ({ entry, textScore: null }))
        : await this.repo.search(query);

    const ranked = this.ranker.rank(query, candidates);

    try {
      await this.repo.insertRecallEvent({
        project,
        sessionId: this.defaultSessionId ?? null,
        query: {
          ...(query.text !== undefined ? { text: query.text } : {}),
          rank,
          source,
          ...(query.kinds && query.kinds.length > 0 ? { kinds: query.kinds } : {}),
          ...(query.tags && query.tags.length > 0 ? { tags: query.tags } : {}),
          limit,
        },
        returned: ranked.map((e, i) => ({ entry_id: e.id, rank: i + 1 })),
      });
    } catch (err) {
      // Telemetry must never break recall — the lesson store is the product, the log is the meter.
      process.stderr.write(`recall-event logging failed: ${(err as Error).message}\n`);
    }

    const [projectsTotal, referrers] = await Promise.all([
      this.repo.countProjects(),
      this.repo.findReferrers(ranked.map((e) => e.id)),
    ]);

    return { entries: ranked, scope: { project, projectsTotal }, referrers };
  }

  /**
   * Persist a behavioral-spine entry from the hook bridge. Bypasses introspective
   * payload validation (the mapper is trusted) and tags it source="hook_spine".
   */
  async recordSpine(write: SpineWrite, project?: string): Promise<LedgerEntry> {
    const proj = project ?? this.defaultProject;
    if (!proj) {
      throw new LedgerValidationError("project is required (no defaultProject configured)");
    }

    const sessionId = write.sessionId ?? this.defaultSessionId ?? null;
    const payload: Record<string, unknown> = { ...(write.payload ?? {}) };
    let refEntryId: string | null = null;

    const tool = write.toolName ?? null;
    const argsDigest = typeof payload.args_digest === "string" ? payload.args_digest : null;
    if (write.kind === "spine_tool" && tool && argsDigest) {
      const match = { project: proj, sessionId, tool, argsDigest };
      if (payload.phase === "post") {
        const pre = await this.repo.findOpenPre(match);
        if (pre) {
          refEntryId = pre.id;
          payload.duration_ms = Math.max(0, Date.now() - Date.parse(pre.createdAt));
        }
      } else if (payload.phase === "pre") {
        const priorPost = await this.repo.findLatestPost(match);
        if (priorPost) payload.retry_of = priorPost.id;
      }
    }

    return this.repo.insertEntry({
      kind: write.kind,
      project: proj,
      title: write.title,
      body: write.body,
      payload,
      source: "hook_spine",
      toolName: write.toolName ?? null,
      sessionId,
      refEntryId,
    });
  }
}
