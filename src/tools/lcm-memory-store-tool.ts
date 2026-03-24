import { Type } from '@sinclair/typebox';
import type { LcmContextEngine } from '../engine.js';
import type { LcmDependencies } from '../types.js';
import type { MemoryKind } from '../memory/extractor.js';
import type { AnyAgentTool } from './common.js';
import { jsonResult } from './common.js';
import { resolveLcmConversationScope } from './lcm-conversation-scope.js';

const LcmMemoryStoreSchema = Type.Object({
  text: Type.String({
    minLength: 1,
    description: 'Durable memory text to store.',
  }),
  kind: Type.Optional(
    Type.String({
      enum: ['profile', 'preference', 'decision', 'constraint', 'commitment', 'fact', 'summary'],
      description: 'Optional memory kind classification.',
    }),
  ),
  confidence: Type.Optional(
    Type.Number({
      minimum: 0,
      maximum: 1,
      description: 'Optional confidence override (0.0-1.0).',
    }),
  ),
  importance: Type.Optional(
    Type.Number({
      minimum: 0,
      maximum: 1,
      description: 'Optional importance override (0.0-1.0).',
    }),
  ),
  ttlHours: Type.Optional(
    Type.Number({
      minimum: 1,
      maximum: 24 * 365,
      description: 'Optional TTL in hours.',
    }),
  ),
  scope: Type.Optional(
    Type.String({
      enum: ['session', 'global'],
      description: 'session (default) stores against current conversation; global stores with no conversation_id.',
    }),
  ),
  conversationId: Type.Optional(
    Type.Number({
      description: 'Optional conversation override for session scope.',
    }),
  ),
  allConversations: Type.Optional(
    Type.Boolean({
      description: 'When true, resolves conversation scope as all.',
    }),
  ),
});

export function createLcmMemoryStoreTool(input: {
  deps: LcmDependencies;
  lcm: LcmContextEngine;
  sessionId?: string;
  sessionKey?: string;
}): AnyAgentTool {
  return {
    name: 'lcm_memory_store',
    label: 'LCM Memory Store',
    description: 'Store an explicit long-term memory item.',
    parameters: LcmMemoryStoreSchema,
    async execute(_toolCallId, params) {
      const p = params as Record<string, unknown>;
      const text = typeof p.text === 'string' ? p.text.trim() : '';
      if (!text) {
        return jsonResult({ error: 'text is required.' });
      }

      const scope = (typeof p.scope === 'string' ? p.scope : 'session') as 'session' | 'global';

      const scopeResolution = await resolveLcmConversationScope({
        lcm: input.lcm,
        deps: input.deps,
        sessionId: input.sessionId,
        sessionKey: input.sessionKey,
        params: p,
      });

      if (scope === 'session' && scopeResolution.conversationId == null) {
        return jsonResult({
          error:
            'No conversation is available for this session. Provide conversationId or use scope="global".',
        });
      }

      const stored = await input.lcm.getMemoryManager().storeManual({
        content: text,
        kind: typeof p.kind === 'string' ? (p.kind as MemoryKind) : undefined,
        conversationId: scope === 'global' ? undefined : scopeResolution.conversationId,
        ttlHours:
          typeof p.ttlHours === 'number' && Number.isFinite(p.ttlHours)
            ? Math.floor(p.ttlHours)
            : undefined,
        confidence: typeof p.confidence === 'number' && Number.isFinite(p.confidence)
          ? p.confidence
          : undefined,
        importance: typeof p.importance === 'number' && Number.isFinite(p.importance)
          ? p.importance
          : undefined,
      });

      if (!stored) {
        return jsonResult({
          error: 'Memory was not stored. The supplied text did not produce a valid durable memory item.',
        });
      }

      return {
        content: [
          {
            type: 'text',
            text: `Stored memory ${stored.memoryId} (${stored.kind}).`,
          },
        ],
        details: {
          memoryId: stored.memoryId,
          kind: stored.kind,
          confidence: stored.confidence,
          importance: stored.importance,
          conversationId: stored.conversationId,
          content: stored.content,
        },
      };
    },
  };
}
