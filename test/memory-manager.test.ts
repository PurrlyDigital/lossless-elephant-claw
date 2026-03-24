import { describe, expect, it } from 'vitest';
import { resolveLcmConfig } from '../src/db/config.js';
import { LtmMemoryManager } from '../src/memory/manager.js';

describe('memory manager live-query construction', () => {
  it('prioritizes latest user message in auto-recall query text', async () => {
    let capturedQuery = '';

    const store = {
      search: async (input: { query?: string }) => {
        capturedQuery = input.query ?? '';
        return [];
      },
    };

    const manager = new LtmMemoryManager(store as any, resolveLcmConfig({}, {}));

    await manager.buildAutoRecallBlock({
      conversationId: 5,
      liveMessages: [
        {
          role: 'user',
          content: 'A new session was started via /new. Run startup sequence.',
        } as any,
        {
          role: 'assistant',
          content: 'Hey there. What do you want to do right now?',
        } as any,
        {
          role: 'user',
          content: 'I forgot: how long have I lived in this house?',
        } as any,
      ],
    });

    expect(capturedQuery.toLowerCase().startsWith('i forgot: how long have i lived in this house')).toBe(true);
  });

  it('strips metadata wrappers and keeps trailing user ask for recall query', async () => {
    let capturedQuery = '';

    const store = {
      search: async (input: { query?: string }) => {
        capturedQuery = input.query ?? '';
        return [];
      },
    };

    const manager = new LtmMemoryManager(store as any, resolveLcmConfig({}, {}));

    await manager.buildAutoRecallBlock({
      conversationId: 5,
      liveMessages: [
        {
          role: 'user',
          content: [
            'Conversation info (untrusted metadata):',
            '```json',
            '{ "message_id":"1204", "sender_id":"8503569627" }',
            '```',
            '',
            'Sender (untrusted metadata):',
            '```json',
            '{ "label":"Example User" }',
            '```',
            '',
            'I forgot... how long have I lived in this house?',
          ].join('\n'),
        } as any,
      ],
    });

    const lower = capturedQuery.toLowerCase();
    expect(lower.includes('how long have i lived in this house')).toBe(true);
    expect(lower.includes('untrusted metadata')).toBe(false);
  });
});
