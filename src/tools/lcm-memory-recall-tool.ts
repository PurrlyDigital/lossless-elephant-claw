import { Type } from '@sinclair/typebox';
import type { LcmContextEngine } from '../engine.js';
import type { LcmDependencies } from '../types.js';
import type { AnyAgentTool } from './common.js';
import { jsonResult } from './common.js';
import { resolveLcmConversationScope } from './lcm-conversation-scope.js';

const LcmMemoryRecallSchema = Type.Object({
  query: Type.Optional(
    Type.String({
      description:
        'Optional search query. When omitted, returns the most relevant recent durable memories.',
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      minimum: 1,
      maximum: 50,
      description: 'Maximum memories to return (default 10).',
    }),
  ),
  scope: Type.Optional(
    Type.String({
      enum: ['session', 'global', 'all'],
      description:
        'Recall scope: session (default), global (conversation_id IS NULL), or all.',
    }),
  ),
  conversationId: Type.Optional(
    Type.Number({
      description: 'Optional conversation ID override for session-scoped lookup.',
    }),
  ),
  allConversations: Type.Optional(
    Type.Boolean({
      description: 'When true, resolve session scope as all conversations.',
    }),
  ),
});

function formatMemoryLine(memory: {
  memoryId: string;
  kind: string;
  confidence: number;
  importance: number;
  content: string;
}): string {
  return `- [${memory.memoryId}] (${memory.kind}; conf=${memory.confidence.toFixed(2)}; imp=${memory.importance.toFixed(2)}) ${memory.content}`;
}

export function createLcmMemoryRecallTool(input: {
  deps: LcmDependencies;
  lcm: LcmContextEngine;
  sessionId?: string;
  sessionKey?: string;
}): AnyAgentTool {
  return {
    name: 'lcm_memory_recall',
    label: 'LCM Memory Recall',
    description:
      'Recall durable long-term memories captured by lossless-claw across pre/during/post compaction stages.',
    parameters: LcmMemoryRecallSchema,
    async execute(_toolCallId, params) {
      const p = params as Record<string, unknown>;
      const scope = (typeof p.scope === 'string' ? p.scope : 'session') as 'session' | 'global' | 'all';
      const query = typeof p.query === 'string' ? p.query.trim() : undefined;
      const limit =
        typeof p.limit === 'number' && Number.isFinite(p.limit) && p.limit > 0
          ? Math.min(50, Math.floor(p.limit))
          : 10;

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
            'No conversation is available for this session. Provide conversationId, set allConversations=true, or use scope="global".',
        });
      }

      const memories = await input.lcm.getMemoryManager().recall({
        query,
        limit,
        scope,
        conversationId: scopeResolution.conversationId,
      });

      if (memories.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: 'No long-term memories matched this request.',
            },
          ],
          details: {
            count: 0,
            scope,
            conversationId: scopeResolution.conversationId,
          },
        };
      }

      const lines: string[] = [
        '## Long-Term Memory Recall',
        '',
        `Scope: ${scope}${scopeResolution.conversationId != null ? ` (conversation ${scopeResolution.conversationId})` : ''}`,
      ];
      if (query) {
        lines.push(`Query: ${query}`);
      }
      lines.push('', ...memories.map(formatMemoryLine));

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        details: {
          count: memories.length,
          scope,
          conversationId: scopeResolution.conversationId,
          memories: memories.map((memory) => ({
            id: memory.memoryId,
            kind: memory.kind,
            confidence: memory.confidence,
            importance: memory.importance,
            score: memory.score,
            content: memory.content,
          })),
        },
      };
    },
  };
}
