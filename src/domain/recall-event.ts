/** The recall query as logged — enough to replay/analyze, no results duplicated. */
export interface RecallEventQuery {
  text?: string;
  rank: string;
  source: string;
  kinds?: string[];
  tags?: string[];
  limit: number;
}

/** One returned entry with its 1-based rank in the response. */
export interface RecallEventHit {
  entry_id: string;
  rank: number;
}

/** Input to log one recall invocation. Identity/time are assigned by the repository. */
export interface NewRecallEvent {
  project: string;
  sessionId?: string | null;
  query: RecallEventQuery;
  returned: RecallEventHit[];
}

/** A stored recall event. */
export interface RecallEvent {
  id: string;
  project: string;
  sessionId: string | null;
  query: RecallEventQuery;
  returned: RecallEventHit[];
  resultCount: number;
  createdAt: string;
}
