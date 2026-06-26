/**
 * Deterministic Build Templates
 *
 * For known project types, defines the mandatory architecture: which API routes
 * MUST exist, which pages MUST exist, which DB tables MUST be generated, and
 * what architecture patterns to follow.
 *
 * These are injected into the build prompt so the AI "fills in the template"
 * rather than inventing an architecture from scratch (which is how weather apps
 * appear when building a booking platform — the AI defaults to its generic
 * full-stack demo pattern when context is thin).
 *
 * Usage: inject `getArchitectureHints(spec.type)` into the build prompt
 * AFTER the spec anchor block.
 */

import type { ProjectType } from './project-spec';

export interface ArchitectureTemplate {
  type: ProjectType;
  mandatoryRoutes: string[];   // app/api routes that MUST exist
  mandatoryPages: string[];    // app/ pages that MUST exist
  mandatoryTables: string[];   // DB tables that MUST be created
  patterns: string[];          // code/architecture patterns to follow
}

const TEMPLATES: Record<ProjectType, ArchitectureTemplate> = {
  marketplace: {
    type: 'marketplace',
    mandatoryRoutes: [
      'app/api/listings/route.ts (GET all listings with search/filter, POST create listing)',
      'app/api/listings/[id]/route.ts (GET single listing, PUT update, DELETE)',
      'app/api/search/route.ts (GET — full-text search across listings)',
      'app/api/orders/route.ts (GET user orders, POST create order)',
      'app/api/auth/[...route]/route.ts (signup, login, logout)',
    ],
    mandatoryPages: [
      'app/page.tsx — homepage with featured listings grid and search bar',
      'app/listings/page.tsx — browse all listings with filter sidebar',
      'app/listings/[id]/page.tsx — listing detail with booking/purchase CTA',
      'app/dashboard/page.tsx — seller dashboard with my listings, orders, earnings',
      'app/account/page.tsx — buyer account, purchase history',
      'app/auth/page.tsx — unified sign-in / sign-up',
    ],
    mandatoryTables: ['listings', 'orders', 'users', 'reviews', 'categories'],
    patterns: [
      'Listings are the core entity — everything links back to a listing',
      'Users have a role field: buyer | seller | admin',
      'Search must be server-side via /api/search (never client-side filter)',
      'Images stored as URL strings, not blobs',
    ],
  },

  booking: {
    type: 'booking',
    mandatoryRoutes: [
      'app/api/properties/route.ts (GET list with filters, POST create)',
      'app/api/properties/[id]/route.ts (GET detail, PUT update, DELETE)',
      'app/api/bookings/route.ts (GET my bookings, POST create booking)',
      'app/api/bookings/[id]/route.ts (GET booking detail, PUT update status)',
      'app/api/availability/route.ts (GET available dates for a property)',
      'app/api/auth/[...route]/route.ts (signup, login, logout)',
    ],
    mandatoryPages: [
      'app/page.tsx — homepage with search (location, dates, guests)',
      'app/browse/page.tsx — search results with map or grid view',
      'app/property/[id]/page.tsx — property detail with photo gallery, amenities, calendar, booking widget',
      'app/booking/[id]/page.tsx — booking confirmation/details',
      'app/host/dashboard/page.tsx — host view: my properties, bookings, earnings',
      'app/account/page.tsx — guest: my bookings, profile',
      'app/auth/page.tsx — sign-in / sign-up',
    ],
    mandatoryTables: ['properties', 'bookings', 'users', 'reviews', 'availability_blocks'],
    patterns: [
      'Properties have availability_blocks table to mark unavailable dates',
      'Bookings have status: pending | confirmed | cancelled | completed',
      'Host and Guest are both in the users table (role field: host | guest | both)',
      'Search uses location + date range + guest count filters',
    ],
  },

  saas: {
    type: 'saas',
    mandatoryRoutes: [
      'app/api/dashboard/route.ts (GET aggregated stats and metrics)',
      'app/api/users/route.ts (GET team members, POST invite)',
      'app/api/settings/route.ts (GET/PUT workspace settings)',
      'app/api/subscription/route.ts (GET plan, POST upgrade)',
      'app/api/auth/[...route]/route.ts (signup, login, logout)',
    ],
    mandatoryPages: [
      'app/page.tsx — marketing landing page with pricing and CTA',
      'app/dashboard/page.tsx — main dashboard with KPI cards and charts',
      'app/settings/page.tsx — workspace settings, billing, team',
      'app/auth/page.tsx — sign-in / sign-up / forgot password',
    ],
    mandatoryTables: ['users', 'workspaces', 'workspace_members', 'subscriptions', 'events'],
    patterns: [
      'Multi-tenant: every resource belongs to a workspace_id',
      'Users can belong to multiple workspaces (workspace_members join table)',
      'Dashboard uses recharts or similar for visualisations',
      'Subscription tiers: free | pro | enterprise',
    ],
  },

  social: {
    type: 'social',
    mandatoryRoutes: [
      'app/api/posts/route.ts (GET feed, POST create)',
      'app/api/posts/[id]/route.ts (GET, PUT, DELETE)',
      'app/api/posts/[id]/like/route.ts (POST toggle like)',
      'app/api/posts/[id]/comments/route.ts (GET, POST)',
      'app/api/users/[id]/follow/route.ts (POST toggle follow)',
      'app/api/auth/[...route]/route.ts (signup, login)',
    ],
    mandatoryPages: [
      'app/page.tsx — feed page showing posts from followed users',
      'app/explore/page.tsx — discover trending posts and users',
      'app/profile/[username]/page.tsx — user profile with posts grid',
      'app/post/[id]/page.tsx — single post with comments',
      'app/auth/page.tsx — sign-in / sign-up',
    ],
    mandatoryTables: ['users', 'posts', 'likes', 'comments', 'follows', 'notifications'],
    patterns: [
      'Feed is posts from followed users ordered by created_at DESC',
      'Likes and follows are their own tables (not arrays in posts)',
      'Images in posts stored as URL strings',
      'Notifications triggered on like/comment/follow events',
    ],
  },

  ecommerce: {
    type: 'ecommerce',
    mandatoryRoutes: [
      'app/api/products/route.ts (GET all with search/category, POST create)',
      'app/api/products/[id]/route.ts (GET, PUT, DELETE)',
      'app/api/cart/route.ts (GET, POST add item, DELETE clear)',
      'app/api/orders/route.ts (GET my orders, POST checkout)',
      'app/api/auth/[...route]/route.ts',
    ],
    mandatoryPages: [
      'app/page.tsx — storefront homepage with featured products',
      'app/products/page.tsx — product catalogue with category filter',
      'app/products/[id]/page.tsx — product detail with add-to-cart',
      'app/cart/page.tsx — cart with quantity controls and checkout CTA',
      'app/orders/page.tsx — order history',
      'app/admin/page.tsx — admin panel: inventory, orders',
      'app/auth/page.tsx — sign-in / sign-up',
    ],
    mandatoryTables: ['products', 'cart_items', 'orders', 'order_items', 'users', 'categories'],
    patterns: [
      'Cart stored server-side in cart_items (linked to user_id)',
      'Orders snapshot product price at time of purchase',
      'Product has stock_count — orders decrement it',
      'Admin role can CRUD products and see all orders',
    ],
  },

  management: {
    type: 'management',
    mandatoryRoutes: [
      'app/api/items/route.ts (core resource — GET list, POST create)',
      'app/api/items/[id]/route.ts (GET, PUT, DELETE)',
      'app/api/stats/route.ts (GET aggregate stats)',
      'app/api/auth/[...route]/route.ts',
    ],
    mandatoryPages: [
      'app/page.tsx — dashboard with summary cards and recent activity',
      'app/items/page.tsx — list/table view with search and filter',
      'app/items/[id]/page.tsx — detail/edit view',
      'app/auth/page.tsx — sign-in',
    ],
    mandatoryTables: ['users', 'items', 'activity_log'],
    patterns: [
      'Table/list view is the primary UI — rows with actions (edit, delete)',
      'Activity log tracks all create/update/delete events',
      'Search and filter on the list view are server-side',
    ],
  },

  'real-estate': {
    type: 'real-estate',
    mandatoryRoutes: [
      'app/api/properties/route.ts (GET list, POST create)',
      'app/api/properties/[id]/route.ts (GET detail, PUT, DELETE)',
      'app/api/inquiries/route.ts (POST send inquiry to agent)',
      'app/api/auth/[...route]/route.ts',
    ],
    mandatoryPages: [
      'app/page.tsx — homepage with search and featured listings',
      'app/properties/page.tsx — property grid with map and filter',
      'app/properties/[id]/page.tsx — full property detail, gallery, agent contact',
      'app/agent/dashboard/page.tsx — agent: manage listings, inquiries',
      'app/auth/page.tsx — sign-in',
    ],
    mandatoryTables: ['properties', 'inquiries', 'agents', 'users', 'favourites'],
    patterns: [
      'Properties have: title, price, bedrooms, bathrooms, sqft, location, images[]',
      'Map integration for property locations (use static coords if no map API)',
      'Agents link to properties via agent_id foreign key',
    ],
  },

  education: {
    type: 'education',
    mandatoryRoutes: [
      'app/api/courses/route.ts (GET list, POST create)',
      'app/api/courses/[id]/route.ts (GET detail with lessons)',
      'app/api/courses/[id]/enroll/route.ts (POST enroll)',
      'app/api/progress/route.ts (GET/PUT lesson progress)',
      'app/api/auth/[...route]/route.ts',
    ],
    mandatoryPages: [
      'app/page.tsx — course catalogue homepage',
      'app/courses/[id]/page.tsx — course detail with curriculum and enroll CTA',
      'app/learn/[courseId]/[lessonId]/page.tsx — lesson player',
      'app/dashboard/page.tsx — student progress dashboard',
      'app/instructor/page.tsx — instructor: manage courses',
      'app/auth/page.tsx — sign-in / sign-up',
    ],
    mandatoryTables: ['courses', 'lessons', 'enrollments', 'progress', 'users'],
    patterns: [
      'Lessons belong to a course (course_id FK)',
      'Progress table tracks completed lesson IDs per user',
      'Courses have: enrolled_count, rating, duration, level fields',
    ],
  },

  health: {
    type: 'health',
    mandatoryRoutes: [
      'app/api/appointments/route.ts (GET, POST)',
      'app/api/appointments/[id]/route.ts (GET, PUT, DELETE)',
      'app/api/doctors/route.ts (GET list with specialty filter)',
      'app/api/auth/[...route]/route.ts',
    ],
    mandatoryPages: [
      'app/page.tsx — landing page with book appointment CTA',
      'app/doctors/page.tsx — find a doctor with specialty/location filter',
      'app/doctors/[id]/page.tsx — doctor profile, availability, book',
      'app/appointments/page.tsx — my appointments (past and upcoming)',
      'app/dashboard/page.tsx — doctor/admin dashboard',
      'app/auth/page.tsx',
    ],
    mandatoryTables: ['users', 'doctors', 'appointments', 'specialties', 'availability'],
    patterns: [
      'Appointments have: patient_id, doctor_id, date, time, status, notes',
      'Availability table defines doctor working hours per weekday',
      'Status: scheduled | completed | cancelled',
    ],
  },

  'food-delivery': {
    type: 'food-delivery',
    mandatoryRoutes: [
      'app/api/restaurants/route.ts (GET list, POST)',
      'app/api/restaurants/[id]/menu/route.ts (GET menu items)',
      'app/api/orders/route.ts (GET my orders, POST create order)',
      'app/api/orders/[id]/route.ts (GET status, PUT update status)',
      'app/api/auth/[...route]/route.ts',
    ],
    mandatoryPages: [
      'app/page.tsx — homepage with restaurant grid and search',
      'app/restaurants/[id]/page.tsx — restaurant menu with add-to-cart',
      'app/cart/page.tsx — order cart and checkout',
      'app/orders/page.tsx — order history and live tracking',
      'app/restaurant/dashboard/page.tsx — restaurant owner panel',
      'app/auth/page.tsx',
    ],
    mandatoryTables: ['restaurants', 'menu_items', 'orders', 'order_items', 'users'],
    patterns: [
      'Cart is per-restaurant: starting a new restaurant clears the cart',
      'Orders have status: placed | confirmed | preparing | out-for-delivery | delivered',
      'Menu items have: name, description, price, category, image_url, available (bool)',
    ],
  },

  travel: {
    type: 'travel',
    mandatoryRoutes: [
      'app/api/destinations/route.ts (GET list, POST)',
      'app/api/destinations/[id]/route.ts (GET detail with tours)',
      'app/api/tours/route.ts (GET, POST)',
      'app/api/bookings/route.ts (GET my bookings, POST book a tour)',
      'app/api/auth/[...route]/route.ts',
    ],
    mandatoryPages: [
      'app/page.tsx — travel homepage with search and featured destinations',
      'app/destinations/page.tsx — browse all destinations',
      'app/destinations/[id]/page.tsx — destination detail with tours, photos, reviews',
      'app/tours/[id]/page.tsx — tour detail with booking form',
      'app/account/bookings/page.tsx — my trips / bookings',
      'app/guide/dashboard/page.tsx — tour guide dashboard',
      'app/auth/page.tsx',
    ],
    mandatoryTables: ['destinations', 'tours', 'bookings', 'reviews', 'users'],
    patterns: [
      'Tours belong to destinations (destination_id FK)',
      'Bookings link user → tour with date, group_size, total_price, status',
      'Reviews are for tours (not destinations directly)',
    ],
  },

  finance: {
    type: 'finance',
    mandatoryRoutes: [
      'app/api/transactions/route.ts (GET, POST)',
      'app/api/accounts/route.ts (GET balance and account info)',
      'app/api/budgets/route.ts (GET, POST, PUT)',
      'app/api/reports/route.ts (GET summary reports)',
      'app/api/auth/[...route]/route.ts',
    ],
    mandatoryPages: [
      'app/page.tsx — dashboard: balance, recent transactions, budget summary',
      'app/transactions/page.tsx — transaction history with filter',
      'app/budgets/page.tsx — budget tracker with category breakdown',
      'app/reports/page.tsx — charts: spending by category, monthly trend',
      'app/auth/page.tsx',
    ],
    mandatoryTables: ['users', 'accounts', 'transactions', 'budgets', 'categories'],
    patterns: [
      'Transactions have: type (income | expense), amount, category, date, note',
      'Budgets track spent vs limit per category per month',
      'Reports aggregate transactions by month and category',
    ],
  },

  custom: {
    type: 'custom',
    mandatoryRoutes: [
      'app/api/items/route.ts (GET list, POST create)',
      'app/api/items/[id]/route.ts (GET, PUT, DELETE)',
      'app/api/auth/[...route]/route.ts',
    ],
    mandatoryPages: [
      'app/page.tsx — homepage with core feature',
      'app/dashboard/page.tsx — main user area',
      'app/auth/page.tsx — sign-in / sign-up',
    ],
    mandatoryTables: ['users', 'items'],
    patterns: ['Follow the user\'s requirements exactly'],
  },
};

/**
 * Get architecture hints for a project type.
 * Returns a compact block injected into the build prompt to ensure the AI
 * generates the right pages, routes, and tables — not a generic dashboard.
 */
export function getArchitectureHints(type: ProjectType): string {
  const tmpl = TEMPLATES[type] ?? TEMPLATES.custom;

  const lines = [
    '',
    `ARCHITECTURE REQUIREMENTS FOR ${type.toUpperCase()} PROJECT:`,
    '',
    'REQUIRED API ROUTES (generate ALL of these):',
    ...tmpl.mandatoryRoutes.map(r => `  • ${r}`),
    '',
    'REQUIRED PAGES (generate ALL of these):',
    ...tmpl.mandatoryPages.map(p => `  • ${p}`),
    '',
    'REQUIRED DATABASE TABLES:',
    `  ${tmpl.mandatoryTables.join(', ')}`,
    '',
    'ARCHITECTURE PATTERNS:',
    ...tmpl.patterns.map(p => `  ✓ ${p}`),
    '',
    '⚠️  If the user spec mentions ADDITIONAL features beyond the above, include those too.',
    '⚠️  Do NOT replace these requirements with weather/sports/finance/generic widgets.',
  ];

  return lines.join('\n');
}
