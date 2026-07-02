/**
 * DWOMOH VIBE CODE — App-type → capability map (DATA ONLY).
 *
 * Tells the (future) Planner which platform capabilities an app of a given type
 * needs by default, so the engine wires real services instead of guessing from
 * keywords alone. PURE DATA — no logic, no imports of runtime modules, no side
 * effects. Nothing imports this yet.
 */
import type { AppType, CapabilityId } from '@/services/engine/types';

export interface AppTypeProfile {
  type: AppType;
  label: string;
  /** Capabilities almost always required for this app type. */
  requiredCapabilities: CapabilityId[];
  /** Capabilities commonly useful but optional. */
  optionalCapabilities: CapabilityId[];
  /** Typical pages the Planner should ensure exist. */
  typicalPages: string[];
  /** Keywords that hint at this type (fallback when model classification is weak). */
  keywords: string[];
}

export const APP_TYPE_PROFILES: Record<AppType, AppTypeProfile> = {
  ecommerce: {
    type: 'ecommerce', label: 'E-Commerce Store',
    requiredCapabilities: ['payments', 'auth', 'database', 'storage', 'email', 'seo'],
    optionalCapabilities: ['analytics', 'sms', 'notifications'],
    typicalPages: ['/', '/products', '/products/[id]', '/cart', '/checkout', '/orders', '/login', '/signup', '/account'],
    keywords: ['shop', 'store', 'ecommerce', 'e-commerce', 'sell products', 'cart', 'checkout', 'buy'],
  },
  marketplace: {
    type: 'marketplace', label: 'Marketplace',
    requiredCapabilities: ['payments', 'auth', 'database', 'storage', 'email', 'seo'],
    optionalCapabilities: ['sms', 'maps', 'analytics', 'notifications'],
    typicalPages: ['/', '/listings', '/listings/[id]', '/sell', '/vendor/[id]', '/orders', '/login', '/signup', '/dashboard'],
    keywords: ['marketplace', 'vendors', 'sellers', 'multi-vendor', 'listings', 'payouts'],
  },
  booking: {
    type: 'booking', label: 'Booking & Reservations',
    requiredCapabilities: ['auth', 'database', 'email', 'sms'],
    optionalCapabilities: ['payments', 'maps', 'notifications', 'analytics'],
    typicalPages: ['/', '/services', '/book', '/availability', '/confirmation', '/login', '/signup', '/dashboard'],
    keywords: [
      'booking', 'reservation', 'appointment', 'schedule', 'availability', 'calendar',
      'clinic', 'doctor', 'consultation', 'patient appointment', 'salon booking', 'spa booking',
    ],
  },
  saas: {
    type: 'saas', label: 'SaaS / Dashboard',
    requiredCapabilities: ['auth', 'database', 'payments', 'email'],
    optionalCapabilities: ['analytics', 'ai_text', 'notifications'],
    typicalPages: ['/', '/pricing', '/login', '/signup', '/dashboard', '/settings', '/billing'],
    keywords: ['saas', 'subscription tool', 'dashboard', 'admin panel', 'b2b tool', 'b2b', 'workflow', 'productivity tool', 'project management', 'team tool'],
  },
  social: {
    type: 'social', label: 'Social / Community',
    requiredCapabilities: ['auth', 'database', 'storage'],
    optionalCapabilities: ['notifications', 'ai_text', 'analytics', 'sms'],
    typicalPages: ['/', '/feed', '/profile/[id]', '/post/[id]', '/login', '/signup', '/dashboard'],
    // NOTE: bare 'chat' removed — it matches any AI-chat/assistant prompt as a
    // substring (found via live testing: misclassified an AI chatbot prompt as
    // social, since 'chat' tied with ai_assistant's more specific match and
    // 'social' wins ties by definition order). 'group chat'/'live chat' are
    // specific enough to still catch genuine social/community messaging apps.
    keywords: ['social', 'community', 'feed', 'posts', 'followers', 'group chat', 'live chat', 'forum'],
  },
  blog: {
    type: 'blog', label: 'Blog / Publication',
    requiredCapabilities: ['database', 'seo'],
    optionalCapabilities: ['auth', 'email', 'analytics', 'ai_text'],
    typicalPages: ['/', '/blog', '/blog/[slug]', '/about', '/contact'],
    keywords: ['blog', 'articles', 'publication', 'news site', 'cms'],
  },
  portfolio: {
    type: 'portfolio', label: 'Portfolio',
    requiredCapabilities: ['seo'],
    optionalCapabilities: ['email', 'storage', 'analytics'],
    typicalPages: ['/', '/work', '/work/[slug]', '/about', '/contact'],
    keywords: ['portfolio', 'personal site', 'showcase', 'resume', 'cv'],
  },
  landing: {
    type: 'landing', label: 'Landing Page',
    requiredCapabilities: ['seo'],
    optionalCapabilities: ['email', 'analytics'],
    typicalPages: ['/', '/about', '/contact'],
    keywords: ['landing page', 'one page', 'coming soon', 'waitlist', 'product page'],
  },
  dashboard: {
    type: 'dashboard', label: 'Analytics Dashboard',
    requiredCapabilities: ['auth', 'database'],
    optionalCapabilities: ['analytics', 'ai_text'],
    typicalPages: ['/', '/login', '/dashboard', '/reports', '/settings'],
    keywords: [
      'dashboard', 'analytics', 'reporting', 'metrics', 'kpi', 'data viz',
      // Common internal business / management systems → admin+auth+database apps:
      'crm', 'customer relationship', 'visitor management', 'visitor', 'inventory',
      'inventory management', 'stock management', 'erp', 'pos', 'point of sale',
      'hr system', 'hr platform', 'human resource', 'staff management', 'employee management', 'payroll system',
      'admin system', 'management system', 'internal tool', 'records management',
      'asset management', 'fleet management', 'hospital management', 'clinic management',
      'patient records', 'medical records', 'health records', 'ehr', 'emr', 'healthcare',
      'school management', 'tenant management',
    ],
  },
  media: {
    type: 'media', label: 'Music / Media',
    requiredCapabilities: ['auth', 'database', 'storage'],
    optionalCapabilities: ['payments', 'ai_image', 'analytics'],
    typicalPages: ['/', '/browse', '/artist/[id]', '/player', '/library', '/upload', '/login', '/signup'],
    keywords: ['music', 'streaming', 'media', 'audio', 'video library', 'podcast', 'upload tracks'],
  },
  education: {
    type: 'education', label: 'Education / Learning',
    requiredCapabilities: ['auth', 'database', 'email'],
    optionalCapabilities: ['payments', 'storage', 'ai_text', 'notifications'],
    typicalPages: ['/', '/courses', '/courses/[id]', '/lessons', '/dashboard', '/login', '/signup'],
    keywords: ['course', 'learning', 'lms', 'school', 'exam', 'student', 'lessons', 'quiz', 'training', 'e-learning', 'elearning', 'tutoring', 'classroom'],
  },
  real_estate: {
    type: 'real_estate', label: 'Real Estate / Property',
    requiredCapabilities: ['database', 'storage', 'maps', 'seo'],
    optionalCapabilities: ['auth', 'email', 'sms', 'payments'],
    typicalPages: ['/', '/properties', '/properties/[id]', '/list-property', '/contact', '/login', '/signup'],
    // NOTE: bare 'rent' removed — it matches as a substring inside common words
    // like "diffeRENT" (found via live testing: misclassified a currency
    // converter prompt as real_estate). 'for rent'/'rental' are specific enough.
    keywords: ['real estate', 'property', 'property management', 'listings', 'for rent', 'rental', 'houses', 'apartments', 'tenant', 'landlord', 'lease'],
  },
  restaurant: {
    type: 'restaurant', label: 'Restaurant / Food',
    requiredCapabilities: ['database', 'maps', 'email'],
    optionalCapabilities: ['payments', 'sms', 'storage', 'notifications'],
    typicalPages: ['/', '/menu', '/order', '/reservations', '/contact', '/login'],
    keywords: ['restaurant', 'menu', 'food delivery', 'cafe', 'order food', 'reservation'],
  },
  fintech: {
    type: 'fintech', label: 'Finance / Fintech',
    requiredCapabilities: ['auth', 'database', 'payments', 'email'],
    optionalCapabilities: ['sms', 'analytics', 'notifications'],
    typicalPages: ['/', '/login', '/signup', '/dashboard', '/transactions', '/wallet', '/settings'],
    keywords: [
      'fintech', 'wallet', 'payments app', 'banking', 'transactions', 'money transfer',
      'cashflow', 'cash flow', 'accounting', 'invoicing', 'invoice app', 'expenses',
      'expense tracker', 'payroll', 'bookkeeping', 'finance app', 'budgeting', 'budget app',
    ],
  },
  downloader: {
    type: 'downloader', label: 'Downloader / Converter Tool',
    requiredCapabilities: ['database'],
    optionalCapabilities: ['auth', 'storage', 'analytics'],
    typicalPages: ['/', '/history', '/login'],
    keywords: [
      'downloader', 'download video', 'download audio', 'video downloader', 'audio downloader',
      'tiktok downloader', 'youtube downloader', 'instagram downloader', 'reels downloader',
      'video converter', 'youtube to mp3', 'youtube video', 'mp3 converter', 'save video', 'no watermark',
      'download from', 'link downloader', 'media downloader',
    ],
  },
  utility: {
    type: 'utility', label: 'Utility Tool',
    requiredCapabilities: [],
    optionalCapabilities: ['auth', 'database', 'analytics'],
    typicalPages: ['/'],
    // NOTE: intentionally no bare 'converter'/'generator'/'formatter'/'validator'/
    // 'compressor' — those single generic words collide as substrings with more
    // specific media_tool/browser_tool phrases (e.g. "image compressor", "json
    // formatter" should win their own category). Keep entries multi-word/specific.
    keywords: [
      'utility', 'utility app', 'calculator', 'unit converter', 'currency converter',
      'password generator', 'qr code generator', 'random generator', 'text tool', 'file converter', 'pdf tool',
    ],
  },
  media_tool: {
    type: 'media_tool', label: 'Media Processing Tool',
    requiredCapabilities: ['storage'],
    optionalCapabilities: ['auth', 'database', 'analytics'],
    typicalPages: ['/', '/upload', '/history'],
    keywords: [
      'image compressor', 'image editor', 'video editor', 'photo editor', 'background remover',
      'image resizer', 'video trimmer', 'audio editor', 'watermark remover', 'image converter',
      'video compressor', 'gif maker', 'meme generator', 'thumbnail generator', 'photo tool',
    ],
  },
  browser_tool: {
    type: 'browser_tool', label: 'Browser / Developer Tool',
    requiredCapabilities: [],
    optionalCapabilities: ['auth', 'database'],
    typicalPages: ['/'],
    keywords: [
      'browser extension', 'chrome extension', 'bookmarklet', 'json viewer', 'regex tester',
      'color picker', 'css generator', 'markdown editor', 'code playground', 'diff checker',
      'dev tool', 'developer tool', 'api tester', 'html preview', 'snippet tool',
    ],
  },
  ai_assistant: {
    type: 'ai_assistant', label: 'AI Assistant / Chatbot',
    requiredCapabilities: ['ai_text', 'database'],
    optionalCapabilities: ['auth', 'storage', 'notifications'],
    typicalPages: ['/', '/chat', '/login', '/signup', '/history'],
    keywords: [
      'ai assistant', 'chatbot', 'ai chat', 'ai agent', 'virtual assistant', 'ai helper',
      'conversational ai', 'gpt app', 'ai companion', 'customer support bot', 'ai tutor',
    ],
  },
  custom: {
    type: 'custom', label: 'Custom Application',
    requiredCapabilities: ['database'],
    optionalCapabilities: ['auth', 'email', 'storage', 'seo'],
    typicalPages: ['/'],
    keywords: [],
  },
  // ── Multi-category types — the planner MERGES profiles instead of picking one ──
  hybrid: {
    type: 'hybrid', label: 'Hybrid App (multiple categories)',
    // Intentionally minimal here: the planner fills these by merging the
    // requiredCapabilities of every secondary type in DetectedIntent.secondaryTypes.
    requiredCapabilities: ['auth', 'database'],
    optionalCapabilities: ['payments', 'storage', 'email', 'seo', 'maps', 'notifications'],
    typicalPages: ['/', '/login', '/signup', '/dashboard'],
    // NOTE: deliberately no bare 'and' here — it matches almost any multi-clause
    // sentence as a substring and would dilute/derail classification for every
    // other app type (found via testing: it silently added a phantom point to
    // 'hybrid' for completely unrelated prompts). Keep this list specific.
    keywords: ['plus', 'combined', 'all-in-one', 'multi-purpose', 'hybrid app'],
  },
  multi_domain: {
    type: 'multi_domain', label: 'Multi-domain App (distinct sub-apps)',
    requiredCapabilities: ['auth', 'database'],
    optionalCapabilities: ['payments', 'storage', 'email', 'seo', 'analytics', 'notifications'],
    typicalPages: ['/', '/login', '/signup', '/dashboard'],
    keywords: ['multiple apps', 'sub-app', 'modules', 'suite', 'platform with'],
  },
  unknown: {
    type: 'unknown', label: 'Unclassified (conservative defaults)',
    // When classification fails, build a safe minimal app; the planner can refine
    // after asking the user one clarification question.
    requiredCapabilities: ['database'],
    optionalCapabilities: ['auth', 'seo'],
    typicalPages: ['/'],
    keywords: [],
  },
};

export const ALL_APP_TYPES = Object.keys(APP_TYPE_PROFILES) as AppType[];
