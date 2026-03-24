import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { MemoryKind, MemoryStage } from './extractor.js';
import { normalizeMemoryContent } from './extractor.js';

type Scope = 'session' | 'global' | 'all';

type MemoryRow = {
  memory_id: string;
  conversation_id: number | null;
  kind: string;
  content: string;
  normalized_content: string;
  confidence: number;
  importance: number;
  decay_class: string;
  source_stage: string;
  metadata: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string | null;
  suppressed: number;
};

type BackfillCursorRow = {
  worker_key: string;
  cursor_created_at: string | null;
  cursor_summary_id: string | null;
  updated_at: string;
};

export type MemoryRecord = {
  memoryId: string;
  conversationId: number | null;
  kind: MemoryKind;
  content: string;
  normalizedContent: string;
  confidence: number;
  importance: number;
  decayClass: string;
  sourceStage: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date | null;
  suppressed: boolean;
  score?: number;
};

export type MemoryBackfillCursor = {
  workerKey: string;
  cursorCreatedAt: string | null;
  cursorSummaryId: string | null;
  updatedAt: Date;
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 1;
  }
  return value;
}

function toDateOrNull(value: string | null | undefined): Date | null {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

function toMemoryRecord(row: MemoryRow): MemoryRecord {
  let metadata: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.metadata);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      metadata = parsed as Record<string, unknown>;
    }
  } catch {
    metadata = {};
  }

  return {
    memoryId: row.memory_id,
    conversationId: row.conversation_id,
    kind: row.kind as MemoryKind,
    content: row.content,
    normalizedContent: row.normalized_content,
    confidence: clamp01(row.confidence),
    importance: clamp01(row.importance),
    decayClass: row.decay_class,
    sourceStage: row.source_stage,
    metadata,
    createdAt: new Date(row.created_at),
    lastSeenAt: new Date(row.last_seen_at),
    expiresAt: toDateOrNull(row.expires_at),
    suppressed: row.suppressed === 1,
  };
}

function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4);
}

const QUERY_STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'how',
  'i',
  'in',
  'is',
  'it',
  'long',
  'me',
  'my',
  'of',
  'on',
  'or',
  'our',
  'that',
  'the',
  'this',
  'to',
  'was',
  'were',
  'what',
  'when',
  'where',
  'who',
  'why',
  'with',
]);

function normalizeQueryTerms(query: string): string[] {
  const terms = query
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2)
    .filter((term) => !QUERY_STOPWORDS.has(term));

  const deduped = [...new Set(terms)];
  return deduped.slice(0, 8);
}

function computeScore(input: {
  memory: MemoryRecord;
  now: Date;
  queryTerms: string[];
  conversationId?: number;
}): number {
  const { memory, now, queryTerms, conversationId } = input;

  const lower = memory.content.toLowerCase();
  const termHits = queryTerms.length === 0
    ? 0
    : queryTerms.reduce((hits, term) => (lower.includes(term) ? hits + 1 : hits), 0);
  const lexicalScore = queryTerms.length === 0 ? 0.4 : termHits / queryTerms.length;

  const daysSinceSeen = Math.max(
    0,
    (now.getTime() - memory.lastSeenAt.getTime()) / (1000 * 60 * 60 * 24),
  );
  const recencyScore = Math.max(0, 1 - daysSinceSeen / 30);

  const affinityBoost =
    conversationId != null && memory.conversationId === conversationId
      ? 0.35
      : memory.conversationId == null
        ? 0.2
        : 0;

  return (
    lexicalScore * 1.6 +
    memory.importance * 1.2 +
    memory.confidence * 0.9 +
    recencyScore * 0.4 +
    affinityBoost
  );
}

export class LtmMemoryStore {
  constructor(
    private db: DatabaseSync,
    private options?: { fts5Available?: boolean },
  ) {}

  private get fts5Available(): boolean {
    return this.options?.fts5Available ?? true;
  }

  async upsertMemory(input: {
    conversationId?: number;
    kind: MemoryKind;
    content: string;
    confidence: number;
    importance: number;
    decayClass: string;
    stage: MemoryStage;
    sourceType: 'message' | 'summary' | 'manual' | 'backfill';
    sourceRef?: string;
    metadata?: Record<string, unknown>;
    expiresAt?: Date | null;
  }): Promise<MemoryRecord | null> {
    const content = input.content.trim();
    if (!content) {
      return null;
    }

    const normalizedContent = normalizeMemoryContent(content);
    if (!normalizedContent) {
      return null;
    }

    const existing = this.db.prepare(
      `SELECT
         memory_id,
         conversation_id,
         kind,
         content,
         normalized_content,
         confidence,
         importance,
         decay_class,
         source_stage,
         metadata,
         created_at,
         last_seen_at,
         expires_at,
         suppressed
       FROM ltm_memories
       WHERE kind = ?
         AND normalized_content = ?
       LIMIT 1`,
    ).get(input.kind, normalizedContent) as MemoryRow | undefined;

    const nextConfidence = clamp01(input.confidence);
    const nextImportance = clamp01(input.importance);
    const metadataJson = JSON.stringify(input.metadata ?? {});
    const expiresAt = input.expiresAt instanceof Date ? input.expiresAt.toISOString() : null;

    let memoryId: string;
    if (existing) {
      memoryId = existing.memory_id;
      this.db.prepare(
        `UPDATE ltm_memories
         SET conversation_id = COALESCE(conversation_id, ?),
             content = CASE WHEN ? > confidence THEN ? ELSE content END,
             confidence = MAX(confidence, ?),
             importance = MAX(importance, ?),
             decay_class = ?,
             source_stage = ?,
             metadata = ?,
             last_seen_at = datetime('now'),
             expires_at = COALESCE(?, expires_at),
             suppressed = 0
         WHERE memory_id = ?`,
      ).run(
        input.conversationId ?? null,
        nextConfidence,
        content,
        nextConfidence,
        nextImportance,
        input.decayClass,
        input.stage,
        metadataJson,
        expiresAt,
        memoryId,
      );
    } else {
      memoryId = `mem_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
      this.db.prepare(
        `INSERT INTO ltm_memories (
          memory_id,
          conversation_id,
          kind,
          content,
          normalized_content,
          confidence,
          importance,
          decay_class,
          source_stage,
          metadata,
          expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        memoryId,
        input.conversationId ?? null,
        input.kind,
        content,
        normalizedContent,
        nextConfidence,
        nextImportance,
        input.decayClass,
        input.stage,
        metadataJson,
        expiresAt,
      );
    }

    if (this.fts5Available) {
      try {
        this.db.prepare(`DELETE FROM ltm_memories_fts WHERE memory_id = ?`).run(memoryId);
        this.db.prepare(
          `INSERT INTO ltm_memories_fts(memory_id, content) VALUES (?, ?)`,
        ).run(memoryId, content);
      } catch {
        // Memory persistence remains authoritative when FTS indexing fails.
      }
    }

    const normalizedSourceRef =
      typeof input.sourceRef === "string" && input.sourceRef.trim().length > 0
        ? input.sourceRef.trim()
        : `${input.sourceType}:${input.stage}`;

    this.db.prepare(
      `INSERT INTO ltm_memory_sources (
        memory_source_id,
        memory_id,
        source_type,
        source_ref,
        conversation_id,
        stage
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(memory_id, source_type, source_ref)
      DO UPDATE SET stage = excluded.stage`,
    ).run(
      randomUUID(),
      memoryId,
      input.sourceType,
      normalizedSourceRef,
      input.conversationId ?? null,
      input.stage,
    );

    return this.getMemoryById(memoryId);
  }

  async getMemoryById(memoryId: string): Promise<MemoryRecord | null> {
    const row = this.db.prepare(
      `SELECT
         memory_id,
         conversation_id,
         kind,
         content,
         normalized_content,
         confidence,
         importance,
         decay_class,
         source_stage,
         metadata,
         created_at,
         last_seen_at,
         expires_at,
         suppressed
       FROM ltm_memories
       WHERE memory_id = ?`,
    ).get(memoryId) as MemoryRow | undefined;

    return row ? toMemoryRecord(row) : null;
  }

  async search(input: {
    query?: string;
    limit?: number;
    conversationId?: number;
    scope?: Scope;
  }): Promise<MemoryRecord[]> {
    const query = (input.query ?? '').trim();
    const limit =
      typeof input.limit === 'number' && Number.isFinite(input.limit) && input.limit > 0
        ? Math.min(200, Math.floor(input.limit))
        : 20;
    const scope = input.scope ?? 'all';

    const where: string[] = [
      `m.suppressed = 0`,
      `(m.expires_at IS NULL OR julianday(m.expires_at) > julianday('now'))`,
    ];
    const args: Array<string | number> = [];

    if (scope === 'session') {
      if (input.conversationId == null) {
        return [];
      }
      where.push('m.conversation_id = ?');
      args.push(input.conversationId);
    } else if (scope === 'global') {
      where.push('m.conversation_id IS NULL');
    }

    const queryTerms = normalizeQueryTerms(query);

    let rows: MemoryRow[] = [];
    if (queryTerms.length > 0) {
      if (this.fts5Available) {
        try {
          const ftsWhere = [...where, 'ltm_memories_fts MATCH ?'];
          rows = this.db.prepare(
            `SELECT
               m.memory_id,
               m.conversation_id,
               m.kind,
               m.content,
               m.normalized_content,
               m.confidence,
               m.importance,
               m.decay_class,
               m.source_stage,
               m.metadata,
               m.created_at,
               m.last_seen_at,
               m.expires_at,
               m.suppressed
             FROM ltm_memories_fts
             JOIN ltm_memories m ON m.memory_id = ltm_memories_fts.memory_id
             WHERE ${ftsWhere.join(' AND ')}
             LIMIT ?`,
          ).all(
            ...args,
            queryTerms.join(' OR '),
            limit * 3,
          ) as MemoryRow[];
        } catch {
          rows = [];
        }
      }

      if (rows.length === 0) {
        const likeWhere = [...where];
        const likeClauses: string[] = [];
        const likeArgs = [...args];
        for (const term of queryTerms) {
          likeClauses.push('LOWER(m.content) LIKE ?');
          likeArgs.push(`%${term}%`);
        }
        likeWhere.push(`(${likeClauses.join(' OR ')})`);

        rows = this.db.prepare(
          `SELECT
             m.memory_id,
             m.conversation_id,
             m.kind,
             m.content,
             m.normalized_content,
             m.confidence,
             m.importance,
             m.decay_class,
             m.source_stage,
             m.metadata,
             m.created_at,
             m.last_seen_at,
             m.expires_at,
             m.suppressed
           FROM ltm_memories m
           WHERE ${likeWhere.join(' AND ')}
           ORDER BY m.last_seen_at DESC
           LIMIT ?`,
        ).all(...likeArgs, limit * 3) as MemoryRow[];
      }
    } else {
      rows = this.db.prepare(
        `SELECT
           m.memory_id,
           m.conversation_id,
           m.kind,
           m.content,
           m.normalized_content,
           m.confidence,
           m.importance,
           m.decay_class,
           m.source_stage,
           m.metadata,
           m.created_at,
           m.last_seen_at,
           m.expires_at,
           m.suppressed
         FROM ltm_memories m
         WHERE ${where.join(' AND ')}
         ORDER BY m.importance DESC, m.last_seen_at DESC
         LIMIT ?`,
      ).all(...args, limit * 3) as MemoryRow[];
    }

    const now = new Date();
    return rows
      .map(toMemoryRecord)
      .map((record) => ({
        ...record,
        score: computeScore({
          memory: record,
          now,
          queryTerms,
          conversationId: input.conversationId,
        }),
      }))
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, limit);
  }

  async forget(input: {
    memoryId?: string;
    query?: string;
    reason?: string;
  }): Promise<{ forgotten: number }> {
    const memoryId = input.memoryId?.trim();
    const query = input.query?.trim();

    if (!memoryId && !query) {
      return { forgotten: 0 };
    }

    const nowIso = new Date().toISOString();
    if (memoryId) {
      const update = this.db.prepare(
        `UPDATE ltm_memories
         SET suppressed = 1
         WHERE memory_id = ?
           AND suppressed = 0`,
      ).run(memoryId);

      if (update.changes > 0) {
        this.db.prepare(
          `INSERT INTO ltm_memory_tombstones (
            tombstone_id,
            memory_id,
            query,
            reason,
            created_at
          ) VALUES (?, ?, ?, ?, ?)`,
        ).run(randomUUID(), memoryId, null, input.reason ?? null, nowIso);
      }

      return { forgotten: Number(update.changes ?? 0) };
    }

    const queryTerms = normalizeQueryTerms(query ?? '');
    if (queryTerms.length === 0) {
      return { forgotten: 0 };
    }

    const where: string[] = ['suppressed = 0'];
    const args: string[] = [];
    for (const term of queryTerms) {
      where.push('LOWER(content) LIKE ?');
      args.push(`%${term}%`);
    }

    const rows = this.db.prepare(
      `SELECT memory_id
       FROM ltm_memories
       WHERE ${where.join(' AND ')}
       LIMIT 200`,
    ).all(...args) as Array<{ memory_id: string }>;

    let forgotten = 0;
    const suppressStmt = this.db.prepare(
      `UPDATE ltm_memories SET suppressed = 1 WHERE memory_id = ?`,
    );
    const tombstoneStmt = this.db.prepare(
      `INSERT INTO ltm_memory_tombstones (
        tombstone_id,
        memory_id,
        query,
        reason,
        created_at
      ) VALUES (?, ?, ?, ?, ?)`,
    );

    for (const row of rows) {
      const result = suppressStmt.run(row.memory_id);
      if ((result.changes ?? 0) <= 0) {
        continue;
      }
      forgotten += 1;
      tombstoneStmt.run(randomUUID(), row.memory_id, query ?? null, input.reason ?? null, nowIso);
    }

    return { forgotten };
  }

  async getBackfillCursor(workerKey: string): Promise<MemoryBackfillCursor | null> {
    const row = this.db.prepare(
      `SELECT worker_key, cursor_created_at, cursor_summary_id, updated_at
       FROM ltm_backfill_state
       WHERE worker_key = ?`,
    ).get(workerKey) as BackfillCursorRow | undefined;

    if (!row) {
      return null;
    }

    return {
      workerKey: row.worker_key,
      cursorCreatedAt: row.cursor_created_at,
      cursorSummaryId: row.cursor_summary_id,
      updatedAt: new Date(row.updated_at),
    };
  }

  async upsertBackfillCursor(input: {
    workerKey: string;
    cursorCreatedAt: string | null;
    cursorSummaryId: string | null;
  }): Promise<void> {
    this.db.prepare(
      `INSERT INTO ltm_backfill_state (
         worker_key,
         cursor_created_at,
         cursor_summary_id,
         updated_at
       ) VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(worker_key)
       DO UPDATE SET
         cursor_created_at = excluded.cursor_created_at,
         cursor_summary_id = excluded.cursor_summary_id,
         updated_at = datetime('now')`,
    ).run(input.workerKey, input.cursorCreatedAt, input.cursorSummaryId);
  }

  formatMemoryLine(memory: MemoryRecord): string {
    const confidence = memory.confidence.toFixed(2);
    const importance = memory.importance.toFixed(2);
    const tokenCount = estimateTokens(memory.content);
    return `- [${memory.memoryId}] (${memory.kind}; conf=${confidence}; imp=${importance}; ~${tokenCount} tok) ${memory.content}`;
  }
}
