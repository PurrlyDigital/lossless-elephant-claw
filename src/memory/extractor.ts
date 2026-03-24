export type MemoryKind =
  | 'profile'
  | 'preference'
  | 'decision'
  | 'constraint'
  | 'commitment'
  | 'fact'
  | 'summary';

export type MemoryStage = 'pre' | 'during' | 'post' | 'manual' | 'backfill';

export type MemoryCandidate = {
  kind: MemoryKind;
  content: string;
  confidence: number;
  importance: number;
  decayClass: 'durable' | 'normal';
};

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[a-z0-9]{16,}\b/i,
  /\b(api[_ -]?key|access[_ -]?token|secret|password)\b\s*[:=]/i,
  /\bghp_[a-z0-9]{20,}\b/i,
  /\bxox[baprs]-[a-z0-9-]{20,}\b/i,
];

const EPHEMERAL_HINTS: RegExp[] = [
  /\b(today|tomorrow|yesterday|this morning|this afternoon|right now|currently|for now)\b/i,
  /\bjust now\b/i,
  /\btemporary\b/i,
  /\bquick update\b/i,
  /\bheartbeat_ok\b/i,
];

const DURABLE_HINTS = {
  profile: /\b(my name is|i am|i'm|my timezone is|i live in|i work as)\b/i,
  preference: /\b(i prefer|i like|i dislike|please always|please never|always|never)\b/i,
  decision: /\b(we decided|decision:|we will|agreed to|final decision|chosen approach)\b/i,
  constraint: /\b(must|must not|cannot|can't|constraint|requirement|non-negotiable)\b/i,
  commitment: /\b(i will|i'll|todo:|next step|follow up|i commit)\b/i,
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

export function normalizeMemoryContent(content: string): string {
  return content
    .toLowerCase()
    .replace(/[^a-z0-9\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitCandidateLines(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  const normalized = trimmed
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[\u2022\u25cf\u25aa]/g, '-')
    .replace(/\t/g, ' ');

  const lines: string[] = [];
  for (const block of normalized.split('\n')) {
    const line = block.trim();
    if (!line) {
      continue;
    }

    const sentenceParts = line
      .split(/(?<=[.!?])\s+(?=[A-Z0-9\"'])/)
      .map((part) => part.trim())
      .filter((part) => part.length > 0);

    if (sentenceParts.length === 0) {
      continue;
    }

    lines.push(...sentenceParts);
  }

  return lines;
}

function stripPrefix(line: string): string {
  return line
    .replace(/^[-*]\s+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .replace(/^(fact|decision|constraint|preference|remember|profile|commitment)\s*[:\-]\s*/i, '')
    .trim();
}

function isLikelySecret(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

function isLikelyEphemeral(text: string): boolean {
  return EPHEMERAL_HINTS.some((pattern) => pattern.test(text));
}

function classifyMemoryKind(text: string): MemoryKind {
  if (DURABLE_HINTS.profile.test(text)) {
    return 'profile';
  }
  if (DURABLE_HINTS.preference.test(text)) {
    return 'preference';
  }
  if (DURABLE_HINTS.decision.test(text)) {
    return 'decision';
  }
  if (DURABLE_HINTS.constraint.test(text)) {
    return 'constraint';
  }
  if (DURABLE_HINTS.commitment.test(text)) {
    return 'commitment';
  }
  return 'fact';
}

function confidenceBaseline(stage: MemoryStage): number {
  switch (stage) {
    case 'manual':
      return 0.92;
    case 'post':
      return 0.74;
    case 'during':
      return 0.7;
    case 'backfill':
      return 0.66;
    case 'pre':
    default:
      return 0.62;
  }
}

function importanceForKind(kind: MemoryKind): number {
  switch (kind) {
    case 'constraint':
      return 0.96;
    case 'decision':
      return 0.9;
    case 'commitment':
      return 0.86;
    case 'preference':
      return 0.8;
    case 'profile':
      return 0.78;
    case 'summary':
      return 0.52;
    case 'fact':
    default:
      return 0.64;
  }
}

function looksDurable(text: string, kind: MemoryKind): boolean {
  if (kind !== 'fact') {
    return true;
  }
  return /(decid|prefer|always|never|must|important|remember|project|repo|service|workflow)/i.test(text);
}

export function extractMemoryCandidates(input: {
  text: string;
  stage: MemoryStage;
  role?: string;
}): MemoryCandidate[] {
  const lines = splitCandidateLines(input.text);
  if (lines.length === 0) {
    return [];
  }

  const baseline = confidenceBaseline(input.stage);
  const byNormalized = new Map<string, MemoryCandidate>();

  for (const rawLine of lines) {
    const line = stripPrefix(rawLine);
    if (line.length < 12 || line.length > 280) {
      continue;
    }
    if (!/[a-z]/i.test(line)) {
      continue;
    }
    if (isLikelySecret(line) || isLikelyEphemeral(line)) {
      continue;
    }

    const kind = classifyMemoryKind(line);
    if (!looksDurable(line, kind)) {
      continue;
    }

    let confidence = baseline;
    if (/\b(decision|constraint|must|never|always|final|agreed|remember)\b/i.test(line)) {
      confidence += 0.1;
    }
    if (input.role === 'assistant' && input.stage === 'pre') {
      confidence -= 0.04;
    }
    if (input.role === 'user' && input.stage !== 'manual') {
      confidence += 0.04;
    }

    const normalized = normalizeMemoryContent(line);
    if (!normalized) {
      continue;
    }

    const candidate: MemoryCandidate = {
      kind,
      content: line,
      confidence: clamp01(confidence),
      importance: clamp01(importanceForKind(kind)),
      decayClass: kind === 'decision' || kind === 'constraint' || kind === 'profile'
        ? 'durable'
        : 'normal',
    };

    const existing = byNormalized.get(normalized);
    if (!existing || candidate.confidence > existing.confidence) {
      byNormalized.set(normalized, candidate);
    }
  }

  return [...byNormalized.values()].slice(0, 20);
}
