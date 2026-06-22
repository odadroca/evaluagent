import type { LedgerEntry, LedgerQuery } from "../domain/entry.js";
import type { LedgerRepository } from "../repo/ledger-repository.js";
import type { Ranker } from "../repo/ranker.js";
import { isEntryKind, validatePayload } from "../domain/entry-kinds.js";
import { SimpleRanker } from "./simple-ranker.js";

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
}

/** Input to `recall` — `project` may be omitted when a default is configured. */
export type RecallInput = Omit<LedgerQuery, "project"> & { project?: string };

export interface LedgerServiceOptions {
  repo: LedgerRepository;
  ranker?: Ranker;
  defaultProject?: string;
}

export class LedgerService {
  private readonly repo: LedgerRepository;
  private readonly ranker: Ranker;
  private readonly defaultProject?: string;

  constructor(opts: LedgerServiceOptions) {
    this.repo = opts.repo;
    this.ranker = opts.ranker ?? new SimpleRanker();
    this.defaultProject = opts.defaultProject;
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
      sessionId: input.sessionId,
      occurredAt: input.occurredAt,
    });
  }

  async recall(input: RecallInput): Promise<LedgerEntry[]> {
    const project = input.project ?? this.defaultProject;
    if (!project) {
      throw new LedgerValidationError("project is required (no defaultProject configured)");
    }
    const query: LedgerQuery = { ...input, project };
    const candidates = await this.repo.query(query);
    return this.ranker.rank(query, candidates);
  }
}
