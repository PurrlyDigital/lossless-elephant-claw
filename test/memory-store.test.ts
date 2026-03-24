import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { runLcmMigrations } from '../src/db/migration.js';
import { LtmMemoryStore } from '../src/memory/store.js';

describe('LtmMemoryStore', () => {
  it('deduplicates similar facts and keeps strongest confidence', async () => {
    const db = new DatabaseSync(':memory:');
    runLcmMigrations(db, { fts5Available: false });
    const created = db
      .prepare(`INSERT INTO conversations (session_id, session_key, title) VALUES (?, ?, ?)`)
      .run('session-1', 'agent:main:session-1', 'test');
    const conversationId = Number(created.lastInsertRowid);

    const store = new LtmMemoryStore(db, { fts5Available: false });

    const first = await store.upsertMemory({
      conversationId,
      kind: 'decision',
      content: 'We decided to keep SQLite as source of truth.',
      confidence: 0.62,
      importance: 0.8,
      decayClass: 'durable',
      stage: 'post',
      sourceType: 'message',
      sourceRef: '101',
    });

    const second = await store.upsertMemory({
      conversationId,
      kind: 'decision',
      content: 'We decided: to keep SQLite as source of truth.',
      confidence: 0.88,
      importance: 0.9,
      decayClass: 'durable',
      stage: 'post',
      sourceType: 'summary',
      sourceRef: 'sum_abc',
    });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second?.memoryId).toBe(first?.memoryId);
    expect(second?.confidence).toBeCloseTo(0.88, 3);

    const recalled = await store.search({
      query: 'sqlite source truth',
      conversationId,
      scope: 'session',
      limit: 5,
    });

    expect(recalled).toHaveLength(1);
    expect(recalled[0]?.memoryId).toBe(first?.memoryId);
  });

  it('suppresses memories via query forget', async () => {
    const db = new DatabaseSync(':memory:');
    runLcmMigrations(db, { fts5Available: false });
    const created = db
      .prepare(`INSERT INTO conversations (session_id, session_key, title) VALUES (?, ?, ?)`)
      .run('session-2', 'agent:main:session-2', 'test');
    const conversationId = Number(created.lastInsertRowid);
    const store = new LtmMemoryStore(db, { fts5Available: false });

    await store.upsertMemory({
      conversationId,
      kind: 'preference',
      content: 'I prefer short responses.',
      confidence: 0.9,
      importance: 0.7,
      decayClass: 'normal',
      stage: 'manual',
      sourceType: 'manual',
    });

    const forget = await store.forget({ query: 'short responses', reason: 'user changed preference' });
    expect(forget.forgotten).toBe(1);

    const recalled = await store.search({
      query: 'short responses',
      conversationId,
      scope: 'all',
      limit: 5,
    });

    expect(recalled).toHaveLength(0);
  });

  it('matches hyphenated natural-language queries in fallback search mode', async () => {
    const db = new DatabaseSync(':memory:');
    runLcmMigrations(db, { fts5Available: false });
    const created = db
      .prepare(`INSERT INTO conversations (session_id, session_key, title) VALUES (?, ?, ?)`)
      .run('session-3', 'agent:main:session-3', 'test');
    const conversationId = Number(created.lastInsertRowid);
    const store = new LtmMemoryStore(db, { fts5Available: false });

    await store.upsertMemory({
      conversationId,
      kind: 'profile',
      content: 'I have lived in this house since 2011.',
      confidence: 0.92,
      importance: 0.86,
      decayClass: 'durable',
      stage: 'post',
      sourceType: 'message',
      sourceRef: '301',
    });

    const recalled = await store.search({
      query: 'move-in date how long lived in this house',
      scope: 'all',
      limit: 10,
    });

    expect(recalled.length).toBeGreaterThan(0);
    expect(
      recalled.some((memory) => memory.content.toLowerCase().includes('lived in this house since 2011')),
    ).toBe(true);
  });
});
