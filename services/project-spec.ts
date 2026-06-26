/**
 * Project Specification Engine
 *
 * Solves the "context amnesia" problem: after a long planning conversation,
 * the builder sometimes generates something completely unrelated (weather app,
 * finance dashboard, etc.) because the AI receives a dump of many messages
 * and latches onto incidental keywords from its own planning responses.
 *
 * This service:
 *  1. Extracts a structured ProjectSpec from the conversation (deterministic, no AI call)
 *  2. Formats it as a compact "anchor block" injected at the TOP of every prompt
 *  3. Saves it to disk so repair cycles can reload it without re-reading history
 *
 * The anchor block is intentionally short (~10 lines) so it fits in every
 * strategy prompt, including the MVP fallback (strategy 3) which previously
 * dropped context to 400 chars.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ProjectType =
  | 'marketplace'
  | 'booking'
  | 'saas'
  | 'social'
  | 'ecommerce'
  | 'management'
  | 'real-estate'
  | 'education'
  | 'health'
  | 'food-delivery'
  | 'travel'
  | 'finance'
  | 'custom';

export interface ProjectSpec {
  name: string;
  type: ProjectType;
  description: string;
  goals: string[];        // core user goal statements (first 3 user messages)
  features: string[];     // extracted feature list
  pages: string[];        // page/route names detected
  dataEntities: string[]; // db table / data entity names
  designNotes: string;    // style, theme, color preferences
  apiNeeds: string[];     // external API categories explicitly mentioned by user
  lockedAt: string;       // ISO timestamp — when spec was extracted
}

// ─── Extraction ───────────────────────────────────────────────────────────────

const SKIP_MESSAGES = /^(create now|build now|start building|generate now|build it|make it|go build|proceed|execute|yes|ok|okay|sure|let's go|yep|yeah|alright|great|perfect|sounds good|do it|go ahead|absolutely|exactly)$/i;

const TYPE_KEYWORDS: Record<ProjectType, string[]> = {
  marketplace:   ['marketplace', 'list products', 'list services', 'sellers', 'buyers', 'vendors', 'listing', 'listings', 'sell', 'buy'],
  booking:       ['book', 'booking', 'reservation', 'reserve', 'appointment', 'schedule', 'availability', 'check-in', 'check-out', 'stay', 'accommodation'],
  saas:          ['saas', 'subscription', 'plans', 'dashboard', 'analytics', 'reports', 'workspace', 'team', 'admin panel', 'metrics'],
  social:        ['social', 'feed', 'posts', 'follow', 'followers', 'likes', 'comments', 'community', 'network', 'profile', 'friends'],
  ecommerce:     ['shop', 'store', 'cart', 'checkout', 'products', 'inventory', 'orders', 'payment', 'shipping'],
  management:    ['manage', 'management', 'tracker', 'tracking', 'tasks', 'projects', 'assign', 'workflow', 'crm', 'hr', 'inventory management'],
  'real-estate': ['property', 'properties', 'real estate', 'rent', 'rental', 'house', 'apartment', 'flat', 'landlord', 'tenant'],
  education:     ['course', 'courses', 'learn', 'learning', 'student', 'teacher', 'lms', 'quiz', 'lesson', 'tutor', 'e-learning'],
  health:        ['health', 'medical', 'patient', 'doctor', 'clinic', 'hospital', 'appointment', 'health records', 'pharmacy'],
  'food-delivery': ['food', 'delivery', 'restaurant', 'menu', 'order food', 'cuisine', 'chef', 'meals', 'recipe'],
  travel:        ['travel', 'tourism', 'tour', 'trip', 'destination', 'itinerary', 'guide', 'tourist', 'hotel', 'flight'],
  finance:       ['finance', 'budget', 'expense', 'invoice', 'payment', 'transaction', 'accounting', 'billing', 'wallet', 'fintech'],
  custom:        [],
};

function detectProjectType(userText: string): ProjectType {
  const lower = userText.toLowerCase();
  const scores: Record<string, number> = {};

  for (const [type, keywords] of Object.entries(TYPE_KEYWORDS)) {
    scores[type] = keywords.reduce((n, kw) => n + (lower.includes(kw) ? 1 : 0), 0);
  }

  // Booking + marketplace overlap: if booking score ≥ 2 AND marketplace score ≥ 1 → 'booking'
  const top = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  if (top && top[1] > 0) return top[0] as ProjectType;
  return 'custom';
}

function extractProjectName(userMessages: string[]): string {
  const candidates = userMessages.slice(0, 4).join(' ');

  // Explicit: "called X", "named X", "app name is X"
  const explicit = /(?:called|named|app name(?:\s+is)?|name(?:\s+it)?)\s+["']?([A-Z][A-Za-z0-9]{2,30}(?:\s+[A-Za-z0-9]+){0,4})["']?/i.exec(candidates);
  if (explicit) return explicit[1].trim();

  // CamelCase word anywhere in the first 3 messages (e.g. "BookStays", "EduLink", "GhanaStays")
  // Looks for a CapitalCase run like BookStays / VibeHub / EduFlow
  const camelMatch = /(?:build|create|make|develop|launch|called|named|my app)\s+(?:a\s+|an\s+)?([A-Z][a-z]+[A-Z][A-Za-z]+(?:\s+[A-Z][a-z]+)*)/i.exec(candidates);
  if (camelMatch) return camelMatch[1].trim();

  // "build/create X" anywhere in the first messages — no ^ anchor
  const buildMatch = /(?:build|create|make|develop|generate)\s+(?:a\s+|an\s+|me\s+a\s+|me\s+an\s+)?["']?([A-Z][A-Za-z0-9\s]{2,40}?)["']?\s*(?:—|-|–|:|\.|,|for\s|that\s|with\s|where\s)/i.exec(candidates);
  if (buildMatch) return buildMatch[1].trim();

  // Any capitalised multi-word phrase in quotes
  const quoted = /"([A-Z][A-Za-z0-9\s]{2,30})"/.exec(candidates);
  if (quoted) return quoted[1].trim();

  return '';
}

function extractFeatures(userMessages: string[]): string[] {
  const features: Set<string> = new Set();

  for (const msg of userMessages) {
    // Bullet points
    const bullets = msg.match(/^[\-•*]\s+(.+)/gm) ?? [];
    bullets.forEach(b => features.add(b.replace(/^[\-•*]\s+/, '').trim()));

    // Numbered lists
    const numbered = msg.match(/^\d+[\.\)]\s+(.+)/gm) ?? [];
    numbered.forEach(b => features.add(b.replace(/^\d+[\.\)]\s+/, '').trim()));

    // Explicit "I want X", "should have X", "needs X", "include X", "with X"
    const explicit = msg.matchAll(/(?:i want|we need|should have|must have|needs? to|include|add|with)\s+(?:a\s+|an\s+|the\s+)?([a-z][a-z\s\/]{4,60}?)(?:\.|,|;|$|\n)/gi);
    for (const m of explicit) {
      const f = m[1].trim();
      if (f.length > 4 && f.length < 80) features.add(f);
    }
  }

  return [...features].slice(0, 20);
}

function extractPages(userMessages: string[]): string[] {
  const pageKeywords = [
    'homepage', 'home page', 'landing page',
    'dashboard', 'admin panel', 'admin dashboard',
    'profile', 'user profile', 'account', 'settings',
    'search', 'search results', 'filter',
    'listings', 'listing', 'browse',
    'detail page', 'product page', 'property page',
    'booking', 'checkout', 'payment', 'confirmation',
    'sign in', 'sign up', 'login', 'register', 'auth',
    'messages', 'notifications', 'inbox',
    'reviews', 'ratings',
    'host dashboard', 'seller dashboard', 'vendor dashboard',
    'analytics', 'reports', 'statistics',
    'map view', 'map page',
  ];

  const found: Set<string> = new Set();
  const lower = userMessages.join(' ').toLowerCase();

  for (const kw of pageKeywords) {
    if (lower.includes(kw)) found.add(kw);
  }

  return [...found];
}

function extractDataEntities(userMessages: string[]): string[] {
  const entityKeywords = [
    'user', 'users', 'account', 'profile',
    'listing', 'listings', 'product', 'products', 'property', 'properties', 'service', 'services',
    'booking', 'bookings', 'reservation', 'order', 'orders',
    'review', 'reviews', 'rating', 'ratings', 'comment',
    'category', 'categories', 'tag', 'tags',
    'message', 'messages', 'notification', 'notifications',
    'payment', 'payments', 'transaction', 'invoice',
    'host', 'hosts', 'seller', 'sellers', 'vendor', 'vendors', 'buyer', 'buyers',
    'image', 'images', 'photo', 'photos', 'media',
    'favourite', 'wishlist', 'saved',
  ];

  const found: Set<string> = new Set();
  const lower = userMessages.join(' ').toLowerCase();

  for (const kw of entityKeywords) {
    if (lower.includes(kw)) found.add(kw.replace(/s$/, '')); // singularise
  }

  return [...found].slice(0, 12);
}

function extractDesignNotes(userMessages: string[]): string {
  const lower = userMessages.join(' ').toLowerCase();
  const notes: string[] = [];

  if (/dark\s+(?:theme|mode|design)/.test(lower)) notes.push('dark theme');
  else if (/light\s+(?:theme|mode|design)/.test(lower)) notes.push('light theme');

  if (/minimali?s/.test(lower)) notes.push('minimal');
  if (/modern/.test(lower)) notes.push('modern');
  if (/professional/.test(lower)) notes.push('professional');
  if (/colorful/.test(lower)) notes.push('colorful');

  const colors = lower.match(/\b(blue|green|red|purple|orange|pink|teal|yellow|indigo|emerald)\b/g);
  if (colors) notes.push(`color: ${[...new Set(colors)].join('/')}`);

  if (/tailwind/.test(lower)) notes.push('Tailwind CSS');
  if (/shadcn|shad cn/.test(lower)) notes.push('shadcn/ui');
  if (/framer/.test(lower)) notes.push('Framer Motion');

  return notes.join(', ') || 'clean, modern, Tailwind CSS';
}

function extractApiNeeds(userMessages: string[]): string[] {
  const lower = userMessages.join(' ').toLowerCase();
  const needs: string[] = [];

  if (/weather|forecast|temperature|climate/.test(lower)) needs.push('weather');
  if (/payment|stripe|paystack|paypal|mpesa|momo/.test(lower)) needs.push('payments');
  if (/map|location|google maps|geolocation|coordinates/.test(lower)) needs.push('maps');
  if (/email|smtp|sendgrid|mailgun/.test(lower)) needs.push('email');
  if (/sms|twilio|text message/.test(lower)) needs.push('sms');
  if (/exchange rate|currency|forex/.test(lower)) needs.push('currency');
  if (/image upload|cloudinary|s3|file upload/.test(lower)) needs.push('file-storage');

  return needs;
}

/**
 * Extract a structured ProjectSpec from conversation history.
 * Deterministic — no AI call, runs in <5ms.
 */
export function extractSpecFromConversation(
  turns: Array<{ role: string; content: string }>
): ProjectSpec {
  const userMessages = turns
    .filter(t => t.role === 'user')
    .map(t => t.content.replace('[READY_TO_BUILD]', '').trim())
    .filter(c => c && c.length > 3 && !SKIP_MESSAGES.test(c));

  const allUserText = userMessages.join('\n');

  const name = extractProjectName(userMessages);
  const type = detectProjectType(allUserText);
  const features = extractFeatures(userMessages);
  const pages = extractPages(userMessages);
  const dataEntities = extractDataEntities(userMessages);
  const designNotes = extractDesignNotes(userMessages);
  const apiNeeds = extractApiNeeds(userMessages);

  // Goals = first 3 substantive user messages (what the user originally described)
  const goals = userMessages.slice(0, 3).map(m => m.slice(0, 300));

  // Description = name + type + first goal summary
  const typeLabel = type.replace('-', ' ');
  const description = name
    ? `${name} — ${typeLabel} platform`
    : goals[0]?.slice(0, 120) ?? `${typeLabel} application`;

  return {
    name,
    type,
    description,
    goals,
    features,
    pages,
    dataEntities,
    designNotes,
    apiNeeds,
    lockedAt: new Date().toISOString(),
  };
}

// ─── Prompt Formatting ────────────────────────────────────────────────────────

/**
 * Format the spec as a compact anchor block for injection into any prompt.
 * Designed to be short (~10-15 lines) so it fits in ALL strategy prompts,
 * including the MVP fallback that previously truncated to 400 chars.
 */
export function formatSpecAnchor(spec: ProjectSpec): string {
  const lines: string[] = [
    '┌─────────────────────────────────────────────────────────────────┐',
    '│  PROJECT SPECIFICATION — LOCKED — BUILD THIS EXACT PROJECT      │',
    '├─────────────────────────────────────────────────────────────────┤',
  ];

  if (spec.name) lines.push(`│  NAME:    ${spec.name.padEnd(54)}│`);
  lines.push(`│  TYPE:    ${spec.type.padEnd(54)}│`);
  if (spec.description) lines.push(`│  WHAT:    ${spec.description.slice(0, 54).padEnd(54)}│`);

  if (spec.features.length > 0) {
    const featureStr = spec.features.slice(0, 6).join(' · ');
    const wrapped = featureStr.slice(0, 54);
    lines.push(`│  FEATS:   ${wrapped.padEnd(54)}│`);
    if (featureStr.length > 54) {
      const rest = featureStr.slice(54, 108);
      lines.push(`│           ${rest.padEnd(54)}│`);
    }
  }

  if (spec.pages.length > 0) {
    const pageStr = spec.pages.slice(0, 6).join(', ');
    lines.push(`│  PAGES:   ${pageStr.slice(0, 54).padEnd(54)}│`);
  }

  if (spec.dataEntities.length > 0) {
    const entityStr = spec.dataEntities.slice(0, 8).join(', ');
    lines.push(`│  DATA:    ${entityStr.slice(0, 54).padEnd(54)}│`);
  }

  lines.push(`│  DESIGN:  ${spec.designNotes.slice(0, 54).padEnd(54)}│`);
  lines.push('├─────────────────────────────────────────────────────────────────┤');
  lines.push('│  ⛔ DO NOT BUILD: weather app, finance dashboard, sports hub,   │');
  lines.push('│     generic template, or ANY project not described above.       │');
  lines.push('└─────────────────────────────────────────────────────────────────┘');

  if (spec.goals.length > 0) {
    lines.push('');
    lines.push('USER\'S ORIGINAL REQUEST:');
    spec.goals.slice(0, 2).forEach((g, i) => lines.push(`  ${i + 1}. ${g.slice(0, 200)}`));
  }

  return lines.join('\n');
}

// ─── Persistence ──────────────────────────────────────────────────────────────

const SPEC_FILE = '.dwomoh/spec.json';

/**
 * Save the project spec to disk so repair cycles can reload it.
 * Path: <projectPath>/.dwomoh/spec.json
 */
export async function saveSpec(projectPath: string, spec: ProjectSpec): Promise<void> {
  const dir = join(projectPath, '.dwomoh');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'spec.json'), JSON.stringify(spec, null, 2), 'utf-8');
}

/**
 * Load the saved spec for a project. Returns null if not found.
 */
export async function loadSpec(projectPath: string): Promise<ProjectSpec | null> {
  try {
    const raw = await readFile(join(projectPath, SPEC_FILE), 'utf-8');
    return JSON.parse(raw) as ProjectSpec;
  } catch {
    return null;
  }
}
