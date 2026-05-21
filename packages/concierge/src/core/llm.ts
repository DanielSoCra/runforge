export interface PromptTurn {
  role: 'operator' | 'assistant' | 'tool';
  text: string;
}

export interface PromptBlockInput {
  systemPrompt: string;
  toolDescriptions: string;
  operatorProfile: string;
  rollingSummary: string;
  recentTurns: PromptTurn[];
}

export interface PromptBlocks {
  cachedPrefix: string;
  cachedSummary: string;
  uncachedRecent: string;
}

export function buildPromptBlocks(input: PromptBlockInput): PromptBlocks {
  const cachedPrefix = [
    '# System',
    input.systemPrompt,
    '# Tools',
    input.toolDescriptions,
    '# Operator Profile',
    input.operatorProfile,
  ].join('\n');
  const cachedSummary = input.rollingSummary;

  assertNoDynamicContent(cachedPrefix);
  assertNoDynamicContent(cachedSummary);

  return {
    cachedPrefix,
    cachedSummary,
    uncachedRecent: JSON.stringify(input.recentTurns),
  };
}

function assertNoDynamicContent(value: string): void {
  const dynamicPatterns = [
    /\brun[_-]?id\s*=/i,
    /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/,
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
  ];
  if (dynamicPatterns.some((pattern) => pattern.test(value))) {
    throw new Error('cached block contains dynamic content');
  }
}
