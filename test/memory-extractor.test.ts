import { describe, expect, it } from 'vitest';
import { extractMemoryCandidates, normalizeMemoryContent } from '../src/memory/extractor.js';

describe('memory extractor', () => {
  it('extracts durable decisions and preferences while filtering secrets/ephemeral text', () => {
    const text = [
      'We decided to keep SQLite as the source of truth for long-term memory.',
      'I prefer concise responses and no fluff.',
      'My API key is sk-1234567890abcdefghijklmnop',
      'Right now this is a quick update only.',
    ].join('\n');

    const candidates = extractMemoryCandidates({
      text,
      stage: 'post',
      role: 'user',
    });

    const contents = candidates.map((candidate) => candidate.content.toLowerCase());
    expect(contents.some((line) => line.includes('sqlite'))).toBe(true);
    expect(contents.some((line) => line.includes('i prefer concise responses'))).toBe(true);
    expect(contents.some((line) => line.includes('api key'))).toBe(false);
    expect(contents.some((line) => line.includes('quick update'))).toBe(false);
  });

  it('normalizes punctuation/spacing for dedupe keys', () => {
    const a = normalizeMemoryContent('We decided: use SQLite.');
    const b = normalizeMemoryContent('we decided use sqlite');
    expect(a).toBe(b);
  });
});
