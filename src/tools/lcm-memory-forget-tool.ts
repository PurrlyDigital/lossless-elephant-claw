import { Type } from '@sinclair/typebox';
import type { LcmContextEngine } from '../engine.js';
import type { AnyAgentTool } from './common.js';
import { jsonResult } from './common.js';

const LcmMemoryForgetSchema = Type.Object({
  memoryId: Type.Optional(
    Type.String({
      description: 'Specific memory ID to suppress (preferred when known).',
    }),
  ),
  query: Type.Optional(
    Type.String({
      description: 'Fallback query to suppress matching memories when memoryId is unknown.',
    }),
  ),
  reason: Type.Optional(
    Type.String({
      description: 'Optional reason for the forget tombstone.',
    }),
  ),
});

export function createLcmMemoryForgetTool(input: {
  lcm: LcmContextEngine;
}): AnyAgentTool {
  return {
    name: 'lcm_memory_forget',
    label: 'LCM Memory Forget',
    description:
      'Suppress long-term memory entries by ID or query. Suppressed memories are excluded from auto-recall and search.',
    parameters: LcmMemoryForgetSchema,
    async execute(_toolCallId, params) {
      const p = params as Record<string, unknown>;
      const memoryId = typeof p.memoryId === 'string' ? p.memoryId.trim() : undefined;
      const query = typeof p.query === 'string' ? p.query.trim() : undefined;
      const reason = typeof p.reason === 'string' ? p.reason.trim() : undefined;

      if (!memoryId && !query) {
        return jsonResult({ error: 'Either memoryId or query is required.' });
      }

      const result = await input.lcm.getMemoryManager().forget({
        memoryId,
        query,
        reason,
      });

      return {
        content: [
          {
            type: 'text',
            text: `Suppressed ${result.forgotten} memory entr${result.forgotten === 1 ? 'y' : 'ies'}.`,
          },
        ],
        details: {
          forgotten: result.forgotten,
          memoryId,
          query,
          reason,
        },
      };
    },
  };
}
