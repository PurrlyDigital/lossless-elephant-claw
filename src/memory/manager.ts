import type { ContextEngine } from 'openclaw/plugin-sdk';
import type { LcmConfig, LcmMemoryConfig } from '../db/config.js';
import type { SummaryStore, SummaryRecord } from '../store/summary-store.js';
import type { MessageRecord } from '../store/conversation-store.js';
import { extractMemoryCandidates, type MemoryKind, type MemoryStage } from './extractor.js';
import { LtmMemoryStore, type MemoryRecord } from './store.js';

type AgentMessage = Parameters<ContextEngine['ingest']>[0]['message'];

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function extractTextFromUnknown(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    const chunks: string[] = [];
    for (const item of value) {
      chunks.push(extractTextFromUnknown(item));
    }
    return chunks.filter(Boolean).join('\n').trim();
  }
  if (!value || typeof value !== 'object') {
    return '';
  }

  const record = value as Record<string, unknown>;
  if (typeof record.text === 'string' && record.text.trim()) {
    return record.text;
  }

  const keys = ['content', 'output', 'result', 'message', 'summary', 'value'];
  const chunks: string[] = [];
  for (const key of keys) {
    const nested = extractTextFromUnknown(record[key]);
    if (nested) {
      chunks.push(nested);
    }
  }

  return chunks.join('\n').trim();
}

function normalizeCaptureStages(stages: string[]): Set<MemoryStage> {
  const allowed: MemoryStage[] = ['pre', 'during', 'post'];
  const selected = new Set<MemoryStage>();

  for (const stage of stages) {
    const normalized = stage.trim().toLowerCase();
    if (allowed.includes(normalized as MemoryStage)) {
      selected.add(normalized as MemoryStage);
    }
  }

  if (selected.size === 0) {
    selected.add('pre');
    selected.add('during');
    selected.add('post');
  }

  return selected;
}

function summarizeForMemory(text: string): string | null {
  const singleLine = text.replace(/\s+/g, ' ').trim();
  if (!singleLine) {
    return null;
  }
  if (singleLine.length <= 260) {
    return singleLine;
  }
  return `${singleLine.slice(0, 257)}...`;
}

export class LtmMemoryManager {
  private captureStages: Set<MemoryStage>;
  private memoryConfig: LcmMemoryConfig;

  constructor(
    private readonly store: LtmMemoryStore,
    private readonly config: LcmConfig,
  ) {
    this.memoryConfig = this.resolveMemoryConfig();
    this.captureStages = normalizeCaptureStages(this.memoryConfig.captureStages);
  }

  private stageEnabled(stage: MemoryStage): boolean {
    return this.memoryConfig.enabled && this.captureStages.has(stage);
  }

  private resolveMemoryConfig(): LcmMemoryConfig {
    const memory = (
      this.config as LcmConfig & {
        memory?: Partial<LcmMemoryConfig>;
      }
    ).memory;

    return {
      enabled: memory?.enabled ?? true,
      autoRecall: memory?.autoRecall ?? true,
      recallBudgetTokens: Math.max(120, Math.floor(memory?.recallBudgetTokens ?? 1000)),
      topK: Math.max(1, Math.floor(memory?.topK ?? 8)),
      captureStages: Array.isArray(memory?.captureStages)
        ? memory.captureStages
        : ['pre', 'during', 'post'],
      backfillEnabled: memory?.backfillEnabled ?? true,
      vectorEnabled: memory?.vectorEnabled ?? false,
    };
  }

  private async persistCandidates(input: {
    conversationId: number;
    sourceType: 'message' | 'summary' | 'manual' | 'backfill';
    sourceRef?: string;
    stage: MemoryStage;
    role?: string;
    text: string;
    fallbackKind?: MemoryKind;
  }): Promise<number> {
    const text = input.text.trim();
    if (!text) {
      return 0;
    }

    let candidates = extractMemoryCandidates({
      text,
      stage: input.stage,
      role: input.role,
    });

    if (candidates.length === 0 && input.fallbackKind === 'summary') {
      const summary = summarizeForMemory(text);
      if (summary) {
        candidates = [
          {
            kind: 'summary',
            content: summary,
            confidence: 0.58,
            importance: 0.46,
            decayClass: 'normal',
          },
        ];
      }
    }

    let persisted = 0;
    for (const candidate of candidates) {
      const stored = await this.store.upsertMemory({
        conversationId: input.conversationId,
        kind: candidate.kind,
        content: candidate.content,
        confidence: candidate.confidence,
        importance: candidate.importance,
        decayClass: candidate.decayClass,
        stage: input.stage,
        sourceType: input.sourceType,
        sourceRef: input.sourceRef,
        metadata: {
          role: input.role,
          sourceType: input.sourceType,
        },
      });
      if (stored) {
        persisted += 1;
      }
    }

    return persisted;
  }

  async capturePreCompaction(input: {
    conversationId: number;
    messages: MessageRecord[];
  }): Promise<void> {
    if (!this.stageEnabled('pre')) {
      return;
    }

    for (const message of input.messages) {
      if (message.role !== 'user' && message.role !== 'assistant') {
        continue;
      }
      await this.persistCandidates({
        conversationId: input.conversationId,
        sourceType: 'message',
        sourceRef: String(message.messageId),
        stage: 'pre',
        role: message.role,
        text: message.content,
      });
    }
  }

  async captureDuringCompaction(input: {
    conversationId: number;
    summaries: SummaryRecord[];
  }): Promise<void> {
    if (!this.stageEnabled('during')) {
      return;
    }

    for (const summary of input.summaries) {
      await this.persistCandidates({
        conversationId: input.conversationId,
        sourceType: 'summary',
        sourceRef: summary.summaryId,
        stage: 'during',
        text: summary.content,
        fallbackKind: 'summary',
      });
    }
  }

  async capturePostTurn(input: {
    conversationId: number;
    messages: MessageRecord[];
  }): Promise<void> {
    if (!this.stageEnabled('post')) {
      return;
    }

    for (const message of input.messages) {
      if (message.role !== 'assistant' && message.role !== 'user') {
        continue;
      }
      await this.persistCandidates({
        conversationId: input.conversationId,
        sourceType: 'message',
        sourceRef: String(message.messageId),
        stage: 'post',
        role: message.role,
        text: message.content,
      });
    }
  }

  async runBackfillBatch(input: {
    conversationId: number;
    summaryStore: SummaryStore;
    limit?: number;
  }): Promise<number> {
    if (!this.memoryConfig.enabled || !this.memoryConfig.backfillEnabled) {
      return 0;
    }

    const workerKey = `conversation:${input.conversationId}`;
    const cursor = await this.store.getBackfillCursor(workerKey);
    const summaries = await input.summaryStore.getSummariesAfterCursor({
      conversationId: input.conversationId,
      cursor: cursor
        ? {
          createdAt: cursor.cursorCreatedAt,
          summaryId: cursor.cursorSummaryId,
        }
        : null,
      limit:
        typeof input.limit === 'number' && Number.isFinite(input.limit) && input.limit > 0
          ? Math.min(100, Math.floor(input.limit))
          : 25,
    });

    if (summaries.length === 0) {
      return 0;
    }

    let persisted = 0;
    for (const summary of summaries) {
      const added = await this.persistCandidates({
        conversationId: input.conversationId,
        sourceType: 'backfill',
        sourceRef: summary.summaryId,
        stage: 'backfill',
        text: summary.content,
        fallbackKind: 'summary',
      });
      persisted += added;
      await this.store.upsertBackfillCursor({
        workerKey,
        cursorCreatedAt: summary.createdAt.toISOString(),
        cursorSummaryId: summary.summaryId,
      });
    }

    return persisted;
  }

  async recall(input: {
    query?: string;
    conversationId?: number;
    limit?: number;
    scope?: 'session' | 'global' | 'all';
  }): Promise<MemoryRecord[]> {
    return this.store.search({
      query: input.query,
      conversationId: input.conversationId,
      limit: input.limit,
      scope: input.scope,
    });
  }

  async storeManual(input: {
    content: string;
    kind?: MemoryKind;
    conversationId?: number;
    ttlHours?: number;
    confidence?: number;
    importance?: number;
  }): Promise<MemoryRecord | null> {
    const expiresAt =
      typeof input.ttlHours === 'number' && Number.isFinite(input.ttlHours) && input.ttlHours > 0
        ? new Date(Date.now() + Math.floor(input.ttlHours) * 60 * 60 * 1000)
        : null;

    return this.store.upsertMemory({
      conversationId: input.conversationId,
      kind: input.kind ?? 'fact',
      content: input.content,
      confidence:
        typeof input.confidence === 'number' && Number.isFinite(input.confidence)
          ? input.confidence
          : 0.92,
      importance:
        typeof input.importance === 'number' && Number.isFinite(input.importance)
          ? input.importance
          : 0.85,
      decayClass: 'durable',
      stage: 'manual',
      sourceType: 'manual',
      sourceRef: undefined,
      metadata: { manual: true },
      expiresAt,
    });
  }

  async forget(input: {
    memoryId?: string;
    query?: string;
    reason?: string;
  }): Promise<{ forgotten: number }> {
    return this.store.forget(input);
  }

  async buildAutoRecallBlock(input: {
    conversationId: number;
    liveMessages: AgentMessage[];
  }): Promise<string | undefined> {
    if (!this.memoryConfig.enabled || !this.memoryConfig.autoRecall) {
      return undefined;
    }

    const query = this.buildLiveQuery(input.liveMessages);
    const results = await this.store.search({
      query,
      conversationId: input.conversationId,
      limit: this.memoryConfig.topK,
      scope: 'all',
    });

    if (results.length === 0) {
      return undefined;
    }

    const budget = this.memoryConfig.recallBudgetTokens;
    const lines: string[] = [
      '## Long-Term Memory',
      '',
      'Use relevant durable facts/preferences/decisions from this section when helpful. Verify specifics with tools when uncertain.',
      '',
    ];

    let usedTokens = estimateTokens(lines.join('\n'));
    for (const memory of results) {
      const line = this.store.formatMemoryLine(memory);
      const lineTokens = estimateTokens(line);
      if (usedTokens + lineTokens > budget) {
        break;
      }
      lines.push(line);
      usedTokens += lineTokens;
    }

    if (lines.length <= 4) {
      return undefined;
    }

    return lines.join('\n');
  }

  private buildLiveQuery(messages: AgentMessage[]): string {
    const userChunks: string[] = [];
    const assistantChunks: string[] = [];

    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i] as { role?: unknown; content?: unknown };
      if (message.role !== 'user' && message.role !== 'assistant') {
        continue;
      }
      const text = extractTextFromUnknown(message.content).trim();
      if (!text) {
        continue;
      }

      if (message.role === 'user') {
        userChunks.push(text);
      } else {
        assistantChunks.push(text);
      }

      if (userChunks.length >= 2 && assistantChunks.length >= 1) {
        break;
      }
    }

    return [...userChunks, ...assistantChunks].join(' ').slice(0, 600);
  }
}
