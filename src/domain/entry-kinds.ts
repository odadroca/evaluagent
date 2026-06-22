import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Ajv, type ValidateFunction } from "ajv";
import addFormatsImport from "ajv-formats";

// ajv-formats is a default-only CJS module; under NodeNext the callable can sit
// behind `.default`. Normalize once so the call site is clean and type-safe.
const addFormats = ((addFormatsImport as { default?: unknown }).default ??
  addFormatsImport) as (ajv: Ajv) => void;

/**
 * The six introspective entry kinds. The behavioral-spine kinds (spine_tool,
 * spine_lifecycle) arrive via the hook bridge in a later phase and are NOT part
 * of this self-report set.
 */
export const ENTRY_KINDS = [
  "surprise",
  "dead_end",
  "confidence",
  "abandoned_branch",
  "reconstruction",
  "friction",
] as const;

export type EntryKind = (typeof ENTRY_KINDS)[number];

export function isEntryKind(k: string): k is EntryKind {
  return (ENTRY_KINDS as readonly string[]).includes(k);
}

/** A 1..3 severity/cost/intensity scale shared by several kinds. */
const Level = Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3)]);

const objectOpts = { additionalProperties: false } as const;

/** (1) prediction-error: what I expected vs what actually happened. */
export const SurprisePayload = Type.Object(
  {
    expected: Type.String({ minLength: 1 }),
    actual: Type.String({ minLength: 1 }),
    magnitude: Level,
    trigger: Type.Optional(Type.String()),
  },
  objectOpts,
);

/** (2) an approach that failed, and why. */
export const DeadEndPayload = Type.Object(
  {
    approach: Type.String({ minLength: 1 }),
    reason: Type.String({ minLength: 1 }),
    signal: Type.String({ minLength: 1 }),
    recoverable: Type.Boolean(),
  },
  objectOpts,
);

/** (3) a decision point (the 0..1 score lives on the envelope, not here). */
export const ConfidencePayload = Type.Object(
  {
    decision: Type.String({ minLength: 1 }),
    options_considered: Type.Optional(Type.Array(Type.String())),
    chosen: Type.String({ minLength: 1 }),
  },
  objectOpts,
);

/** (4) a reasoning branch left unexplored, and why. */
export const AbandonedBranchPayload = Type.Object(
  {
    branch: Type.String({ minLength: 1 }),
    progress_pct: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
    why_abandoned: Type.String({ minLength: 1 }),
    could_revisit: Type.Boolean(),
  },
  objectOpts,
);

/** (5) context that was expensive to reconstruct. */
export const ReconstructionPayload = Type.Object(
  {
    what_was_lost: Type.String({ minLength: 1 }),
    cost: Level,
    how_recovered: Type.String({ minLength: 1 }),
  },
  objectOpts,
);

/** (6) a "felt tangled" friction point. */
export const FrictionPayload = Type.Object(
  {
    where: Type.String({ minLength: 1 }),
    kind: Type.Union([
      Type.Literal("tooling"),
      Type.Literal("ambiguity"),
      Type.Literal("context-loss"),
      Type.Literal("other"),
    ]),
    intensity: Level,
  },
  objectOpts,
);

export const PAYLOAD_SCHEMAS: Record<EntryKind, TSchema> = {
  surprise: SurprisePayload,
  dead_end: DeadEndPayload,
  confidence: ConfidencePayload,
  abandoned_branch: AbandonedBranchPayload,
  reconstruction: ReconstructionPayload,
  friction: FrictionPayload,
};

export type SurprisePayload = Static<typeof SurprisePayload>;
export type DeadEndPayload = Static<typeof DeadEndPayload>;
export type ConfidencePayload = Static<typeof ConfidencePayload>;
export type AbandonedBranchPayload = Static<typeof AbandonedBranchPayload>;
export type ReconstructionPayload = Static<typeof ReconstructionPayload>;
export type FrictionPayload = Static<typeof FrictionPayload>;

// TypeBox emits Ajv-compatible JSON Schema; strict:false avoids spurious throws
// on TypeBox's keyword shapes (the same posture Calane uses with TypeBox + Ajv).
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

const validators = new Map<EntryKind, ValidateFunction>();
for (const k of ENTRY_KINDS) validators.set(k, ajv.compile(PAYLOAD_SCHEMAS[k]));

export type PayloadValidation = { valid: true } | { valid: false; errors: string[] };

/** Validate a payload against the schema for `kind`. Unknown kinds fail clearly. */
export function validatePayload(kind: string, payload: unknown): PayloadValidation {
  const validate = validators.get(kind as EntryKind);
  if (!validate) return { valid: false, errors: [`unknown entry kind: ${kind}`] };
  if (validate(payload)) return { valid: true };
  const errors = (validate.errors ?? []).map((e) =>
    `${e.instancePath || "(root)"} ${e.message ?? "is invalid"}`.trim(),
  );
  return { valid: false, errors: errors.length > 0 ? errors : ["invalid payload"] };
}
