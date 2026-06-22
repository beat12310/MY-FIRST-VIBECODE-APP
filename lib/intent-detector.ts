const CHAT_KEYWORDS = [
  'who',
  'what',
  'explain',
  'how',
  'tell me',
  'describe',
  'search',
  'find',
  'show me',
  'help',
  'why',
  'when',
  'where',
  'question',
  'ask',
];

const BUILD_KEYWORDS = [
  'build',
  'create',
  'generate',
  'develop',
  'make',
  'design',
  'build me',
  'create a',
  'create an',
  'build a',
  'build an',
  'generate a',
  'generate an',
  'develop a',
  'develop an',
  'make a',
  'make an',
  'design a',
  'design an',
  'i want',
  'i need',
  'can you build',
  'can you create',
  'can you generate',
  'app',
  'website',
  'tool',
  'application',
  'system',
  'platform',
];

const NEGATIVE_KEYWORDS = [
  'question about building',
  'question about creating',
  'how do i build',
  'how do i create',
  'how do i develop',
  'how to build',
  'how to create',
  'how to develop',
];

export function detectIntent(prompt: string): 'chat' | 'build' {
  const lower = prompt.toLowerCase().trim();

  // Check for negative indicators (questions about building)
  const hasNegative = NEGATIVE_KEYWORDS.some(keyword => lower.includes(keyword));
  if (hasNegative) {
    return 'chat';
  }

  // Count build keyword matches
  const buildMatches = BUILD_KEYWORDS.filter(keyword => lower.includes(keyword)).length;

  // Count chat keyword matches
  const chatMatches = CHAT_KEYWORDS.filter(keyword => lower.includes(keyword)).length;

  // Build keywords take priority if any match
  if (buildMatches > 0) {
    return 'build';
  }

  // Default to chat if has chat keywords or uncertain
  if (chatMatches > 0) {
    return 'chat';
  }

  // Default to chat for unknown prompts
  return 'chat';
}

export function isBuildRequest(prompt: string): boolean {
  return detectIntent(prompt) === 'build';
}

export function isChatRequest(prompt: string): boolean {
  return detectIntent(prompt) === 'chat';
}