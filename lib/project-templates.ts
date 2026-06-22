export interface ProjectTemplate {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: 'Business' | 'E-commerce' | 'Media' | 'Productivity' | 'Portfolio' | 'Social';
  tags: string[];
  prompt: string;
  estimatedTime: string;
  complexity: 'Beginner' | 'Intermediate' | 'Advanced';
  features: string[];
}

export const PROJECT_TEMPLATES: ProjectTemplate[] = [
  {
    id: 'music-streaming',
    name: 'Music Streaming App',
    description: 'Boomplay-style music platform with songs, albums, artists, and an audio player.',
    icon: '🎵',
    category: 'Media',
    tags: ['music', 'streaming', 'dark theme', 'next-auth'],
    complexity: 'Intermediate',
    estimatedTime: '~90s',
    features: ['Song catalog', 'Album grid', 'Audio player bar', 'Artist pages', 'Search', 'Auth'],
    prompt: `Build a music streaming app like Boomplay.
It must include:
- A homepage with featured albums and trending songs
- Song list with artist, title, duration, and a play button
- Album detail pages
- An audio player bar fixed at the bottom
- Search that queries a real API route
- At least 25 mock songs and 8 albums in lib/data/
- Dark theme with purple/violet accents
- Authentication with next-auth (login/logout in header)
- API routes: /api/songs (with ?q= search), /api/albums, /api/artists
Use Next.js 15 App Router, TypeScript, Tailwind CSS. No external music APIs.`,
  },
  {
    id: 'saas-dashboard',
    name: 'SaaS Analytics Dashboard',
    description: 'Admin dashboard with charts, user management, metrics, and subscription tracking.',
    icon: '📊',
    category: 'Business',
    tags: ['dashboard', 'analytics', 'charts', 'admin'],
    complexity: 'Intermediate',
    estimatedTime: '~90s',
    features: ['KPI cards', 'Revenue chart', 'User table', 'Activity feed', 'Settings', 'Auth'],
    prompt: `Build a SaaS analytics dashboard with a professional dark theme.
It must include:
- Overview page with KPI cards (revenue, users, conversions, churn)
- Revenue chart (monthly, bar or line)
- User management table with search and pagination
- Recent activity feed
- Subscription management page
- Account settings page
- Sidebar navigation with icons
- Authentication with next-auth
- API routes: /api/metrics, /api/users, /api/activity
- At least 50 mock users and 12 months of revenue data in lib/data/
Use Next.js 15 App Router, TypeScript, Tailwind CSS.`,
  },
  {
    id: 'ecommerce-store',
    name: 'E-commerce Store',
    description: 'Full online shop with product catalog, cart, checkout, and order management.',
    icon: '🛍️',
    category: 'E-commerce',
    tags: ['shop', 'cart', 'products', 'orders'],
    complexity: 'Advanced',
    estimatedTime: '~120s',
    features: ['Product grid', 'Cart', 'Checkout', 'Order history', 'Search + filter', 'Auth'],
    prompt: `Build a full e-commerce store for an African fashion brand called "Adepas Collection".
It must include:
- Product listing page with category filter and search
- Product detail page with images, size selector, add to cart
- Shopping cart with quantity controls and subtotal
- Checkout page with form (no payment gateway needed, just UI)
- Order confirmation page
- Order history page (authenticated)
- API routes: /api/products (with ?category= and ?q=), /api/orders
- At least 30 products with realistic names, prices (GHS/NGN), and categories
- Bright, modern design with accent color #F97316 (orange)
- Authentication with next-auth
Use Next.js 15 App Router, TypeScript, Tailwind CSS.`,
  },
  {
    id: 'crm',
    name: 'CRM System',
    description: 'Customer relationship manager with contacts, deals pipeline, and activity tracking.',
    icon: '🤝',
    category: 'Business',
    tags: ['CRM', 'contacts', 'sales', 'pipeline'],
    complexity: 'Advanced',
    estimatedTime: '~120s',
    features: ['Contact list', 'Deal pipeline', 'Activity log', 'Company profiles', 'Notes', 'Auth'],
    prompt: `Build a CRM system for a B2B sales team.
It must include:
- Contacts list with search, filter by status (lead/prospect/customer)
- Contact detail page with notes, activity history, linked deals
- Deals pipeline with Kanban view (drag to reorder not needed, columns only)
- Company profiles page
- Activity log across all contacts
- Dashboard with pipeline summary and conversion stats
- API routes: /api/contacts, /api/deals, /api/companies, /api/activity
- At least 40 mock contacts and 20 deals in lib/data/
- Clean, professional dark theme
- Authentication with next-auth
Use Next.js 15 App Router, TypeScript, Tailwind CSS.`,
  },
  {
    id: 'inventory',
    name: 'Inventory Manager',
    description: 'Stock management system with products, warehouses, low-stock alerts, and reports.',
    icon: '📦',
    category: 'Business',
    tags: ['inventory', 'stock', 'warehouse', 'reports'],
    complexity: 'Intermediate',
    estimatedTime: '~90s',
    features: ['Stock list', 'Low-stock alerts', 'Category view', 'Add/edit items', 'Reports', 'Auth'],
    prompt: `Build an inventory management system for a retail business.
It must include:
- Products list with stock levels, category, SKU, and supplier
- Color-coded stock status (in stock / low stock / out of stock)
- Product detail with edit form
- Category management page
- Stock report (total value, low stock items, out of stock count)
- Supplier directory
- API routes: /api/products, /api/categories, /api/suppliers, /api/reports/stock
- At least 60 mock products across 8 categories in lib/data/
- Clean, utilitarian design with dark sidebar and light content area
- Authentication with next-auth
Use Next.js 15 App Router, TypeScript, Tailwind CSS.`,
  },
  {
    id: 'blog',
    name: 'Blog & CMS',
    description: 'Content platform with posts, categories, author profiles, and a rich reading experience.',
    icon: '✍️',
    category: 'Portfolio',
    tags: ['blog', 'CMS', 'articles', 'writing'],
    complexity: 'Beginner',
    estimatedTime: '~60s',
    features: ['Post list', 'Article view', 'Categories', 'Author pages', 'Search', 'Comments'],
    prompt: `Build a blog and CMS platform for a tech publication.
It must include:
- Homepage with featured article and recent posts grid
- Article detail page with table of contents, reading time, share buttons
- Category pages
- Author profile pages
- Search (API-powered, not client-side)
- Comment section (mock comments from API)
- Admin: simple list of posts (read-only dashboard)
- API routes: /api/posts (with ?category= and ?q=), /api/authors, /api/comments
- At least 20 mock articles across 5 categories in lib/data/
- Clean editorial design, light mode, serif headings
Use Next.js 15 App Router, TypeScript, Tailwind CSS.`,
  },
  {
    id: 'portfolio',
    name: 'Developer Portfolio',
    description: 'Personal portfolio with projects, skills, timeline, and contact form.',
    icon: '💼',
    category: 'Portfolio',
    tags: ['portfolio', 'personal', 'projects', 'resume'],
    complexity: 'Beginner',
    estimatedTime: '~60s',
    features: ['Hero section', 'Projects grid', 'Skills matrix', 'Timeline', 'Contact', 'Dark mode'],
    prompt: `Build a professional developer portfolio for a full-stack engineer named "Kofi Mensah".
It must include:
- Hero section with name, title, tagline, and CTA buttons
- Projects grid with tech stack tags, description, and GitHub/live links
- Skills section grouped by category (Frontend, Backend, DevOps, etc.)
- Career timeline (education + work experience)
- Contact form (no email sending needed, just UI with success state)
- Dark/light mode toggle
- Smooth scroll navigation
- API routes: /api/projects, /api/skills, /api/timeline
- At least 8 projects and 20 skills in lib/data/
- Dark default theme with green accent (#10b981)
Use Next.js 15 App Router, TypeScript, Tailwind CSS. No next-auth needed.`,
  },
  {
    id: 'fintech',
    name: 'Fintech Wallet App',
    description: 'Mobile-first digital wallet with balance, transactions, transfers, and history.',
    icon: '💳',
    category: 'Business',
    tags: ['fintech', 'wallet', 'payments', 'mobile-first'],
    complexity: 'Advanced',
    estimatedTime: '~120s',
    features: ['Balance card', 'Transactions list', 'Send/receive UI', 'History', 'Stats', 'Auth'],
    prompt: `Build a fintech wallet app for African mobile payments (like Chipper Cash or Flutterwave).
It must include:
- Dashboard with balance card, quick actions (Send, Receive, Top Up)
- Transaction list with type icons, amounts (GHS/NGN), and status badges
- Send money form with contact search
- Receive money page with mock QR code
- Transaction history with date filter
- Spending analytics (pie chart by category: food, transport, utilities, etc.)
- API routes: /api/wallet, /api/transactions, /api/contacts, /api/analytics
- At least 50 mock transactions in lib/data/
- Mobile-first design, dark theme, green accent (#16a34a)
- Authentication with next-auth
Use Next.js 15 App Router, TypeScript, Tailwind CSS.`,
  },
];

export const TEMPLATE_CATEGORIES = ['All', 'Business', 'E-commerce', 'Media', 'Portfolio', 'Productivity', 'Social'] as const;

export function getTemplatesByCategory(category: string) {
  if (category === 'All') return PROJECT_TEMPLATES;
  return PROJECT_TEMPLATES.filter(t => t.category === category);
}
