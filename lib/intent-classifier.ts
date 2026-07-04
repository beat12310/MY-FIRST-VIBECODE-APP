/**
 * DWOMOH Vibe Code — message intent classifier.
 *
 * Extracted from app/builder/page.tsx (where it lived as an inline, closure-
 * only function) so it can be permanently unit-tested. Every regression test
 * for a classification bug found in this function should live in
 * lib/__tests__/intent-classifier.test.ts, not a throwaway script — this is
 * the single place natural-language build/edit/repair/question intent is
 * decided for the entire builder chat, so a bug here silently misroutes
 * whatever the user typed (confirmed live, more than once: build requests
 * treated as greetings, bug reports treated as build requests, detailed specs
 * treated as needing clarification).
 */
export type MessageIntent =
  | 'conversation'       // "thank you", "okay", "continue" — never re-intro
  | 'greeting'           // first-time hi/hello when conversation history is empty
  | 'question'           // explain / how does X work
  | 'research'           // find / compare / what API / best tool
  | 'web_research'       // "go online and search X", "browse alibaba", "check what amazon does"
  | 'planning'           // "how would X work", "something like Facebook"
  | 'design'             // "add my name to the logo", "modify the image"
  | 'logo_request'       // "generate a logo for..."
  | 'logo_edit'          // refine / edit the EXISTING selected logo
  | 'clarification_needed'
  | 'build'              // confirmed build with enough detail
  | 'debug'
  | 'deployment'
  | 'billing';           // pricing, subscription, upgrade questions

export function detectIntent(message: string, hasHistory: boolean, ctx?: { hasLogo: boolean; builderStage?: string }): MessageIntent {
  const lower = message.toLowerCase().trim();
  const words = lower.split(/\s+/).filter(Boolean);

  // 0. EXPLICIT BUILD TRIGGERS — must run BEFORE continuations check so
  //    "Build Now", "Create Now", "Go Build" don't get swallowed as small-talk.
  //    These are short imperative commands that confirm execution after planning.
  const BUILD_TRIGGERS = [
    'create now', 'build now', 'generate now', 'develop now', 'implement now',
    'start building', 'start build', 'start creating', 'start generating',
    'build it', 'build it now', 'create it', 'create it now', 'generate it',
    'build the app', 'create the app', 'generate the app', 'build this', 'create this',
    'make it', 'make now', 'go build', 'just build', 'just create',
    'build please', 'create please', 'generate please',
    'build the platform', 'create the platform', 'generate the platform',
    'build the project', 'create the project', 'generate the project',
    'build this app', 'create this app', 'build this project',
    'build my app', 'create my app', 'generate my app',
    'build my project', 'create my project', 'generate my project',
    'generate platform', 'generate project', 'generate app',
    'create project', 'create platform', 'build project', 'build platform',
    'deploy project', 'deploy app', 'deploy now',
    "let's build", 'lets build', "let's create", 'lets create', "let's go build",
    'execute', 'execute now', 'run the build', 'start the build',
    'proceed with build', 'proceed to build', 'go ahead and build',
  ];
  if (BUILD_TRIGGERS.includes(lower)) return 'build';
  // Also match "create now", "build now" when followed by an optional project name
  if (/^(create|build|generate|make|develop|implement)\s+(now|it|this|the\s+app|the\s+project|the\s+platform|my\s+app|my\s+project)\b/i.test(lower)) return 'build';

  // 1. CONTINUATIONS & SMALL TALK — never re-introduce the assistant
  // Exact-match acknowledgements and affirmatives
  const CONTINUATIONS = [
    'ok', 'okay', 'yes', 'yep', 'yeah', 'yup', 'no', 'nope', 'sure', 'of course',
    'thanks', 'thank you', 'ty', 'thx', 'thank u', 'great', 'cool', 'nice', 'wow',
    'perfect', 'got it', 'alright', 'sounds good', 'good', 'fine', 'interesting',
    'awesome', 'lol', 'haha', 'noted', 'understood', 'continue', 'proceed', 'go ahead',
    "let's go", 'go for it', 'do it', 'do that', 'that works', "that's great",
    "that's fine", "that's good", 'agreed', 'correct', 'exactly', 'right', 'fair enough',
    'makes sense', 'sounds great', 'love it', 'i like it', 'nice work', 'well done',
  ];
  if (CONTINUATIONS.includes(lower)) return 'conversation';
  // Short 2-3 word phrases that are clearly continuations
  if (words.length <= 3 && CONTINUATIONS.some(c => lower.startsWith(c))) return 'conversation';

  // 2. GREETING — only introduces the assistant when there is NO existing history
  // ROOT CAUSE fix: this previously matched on the message PREFIX alone,
  // with no length guard — the same class of bug already fixed for the
  // deployment/debug checks below (which DO guard on words.length). A
  // detailed build request that merely opened with a casual greeting
  // ("Hi, I want a website where people can predict football matches and
  // see who gets the most right") matched `lower.startsWith('hi' + ',')`
  // and returned 'greeting' immediately, discarding the entire request
  // that followed — confirmed live: a real customer's full football-
  // prediction-site description got the cold-start welcome/example-prompts
  // message instead of triggering a build. A genuine greeting is always
  // short; anything past a handful of words is content the classifier
  // must still evaluate on its own merits, so this now only fires for
  // short messages, exactly like the deployment (<=8 words) and debug
  // (<=6 words) checks already do.
  const GREET_WORDS  = ['hi', 'hello', 'hey', 'hiya', 'howdy', 'yo', 'sup', 'greetings'];
  const TIME_GREETS  = ['good morning', 'good afternoon', 'good evening', 'good night'];
  const isGreeting = words.length <= 6 && (
    GREET_WORDS.some(g =>
      lower === g || lower.startsWith(g + ' ') || lower.startsWith(g + ',') || lower.startsWith(g + '!'))
    || TIME_GREETS.some(t => lower === t || lower.startsWith(t + ' ') || lower.startsWith(t + '!')));
  if (isGreeting) return hasHistory ? 'conversation' : 'greeting';

  // 3. BILLING — only match EXPLICIT questions about THIS platform's pricing, not project domain words.
  // "What is the subscription model for my app?" must NOT trigger this — only "What is DWOMOH's pricing?"
  const billingKeywords = [
    'your pricing', 'your plan', 'your plans', 'your subscription', 'dwomoh pricing',
    'dwomoh plan', 'vibe code pricing', 'vibe code plan', 'this platform cost',
    'upgrade my plan', 'upgrade my account', 'downgrade my plan', 'cancel my plan',
    'cancel my subscription', 'cancel my account', 'my current plan', 'billing portal',
    'billing page', 'billing section', 'invoice from dwomoh', 'switch plan',
  ];
  const isExplicitBillingQ = billingKeywords.some(k => lower.includes(k))
    || /\bhow much (does|is) (dwomoh|vibe code|this (tool|platform|service))\b/i.test(lower)
    || /\bwhat (are|is) (the )?(dwomoh|vibe code) (plans?|pricing|tiers?|cost)\b/i.test(lower)
    || (/\b(free|pro|starter|business)\s+plan\b/i.test(lower) && !/\b(app|project|website|site|system|platform|user|role)\b/i.test(lower));
  if (isExplicitBillingQ) return 'billing';

  // 3b. WEB RESEARCH — browsing websites, competitor research, online search, docs, npm, RapidAPI
  const WEB_RESEARCH_PATTERNS = [
    // Explicit web browsing — user wants the AI to open/visit/read a live page
    /\b(go online|search (the )?web|browse (the )?web|search online|look online|go to the internet)\b/i,
    /\b(go online and (search|check|look|browse|find|research))\b/i,
    /\b(search for|look at|browse|visit|check out|research|analyse|analyze)\s+(the\s+)?(website|site|page|store)\s+(of|for|at)?\s+\w/i,
    // "open/visit/go to [site] homepage/page" — catches "open today's Google homepage"
    /\b(open|visit|go to|navigate to|load|show me)\s+.{0,30}(homepage|home page|website|web page|site|page)\b/i,
    /\b(open|visit|go to|navigate to|check out)\s+(today'?s?\s+)?(google|youtube|tiktok|twitter|facebook|instagram|amazon|github|wikipedia|reddit|bbc|cnn|apple|microsoft|netflix|airbnb|tripadvisor|linkedin|whatsapp|telegram|snapchat|pinterest|ebay|etsy|shopify|alibaba|jumia|konga)\b/i,
    // Named brands — check/browse/visit
    /\b(check|look at|browse|visit|search|analyze|analyse|research|open)\s+(alibaba|amazon|shopify|etsy|zara|asos|shein|temu|nike|h&m|zalando|ebay|pinterest|instagram|facebook|twitter|linkedin|apple|google|netflix|airbnb|booking|tripadvisor|jumia|konga|paypal|stripe|flutterwave)\b/i,
    /\b(what does|how does)\s+(alibaba|amazon|shopify|etsy|zara|asos|shein|temu|nike|h&m|zalando|ebay)\s+(do|look|show|handle|display|design|structure)\b/i,
    // Competitor comparison
    /\b(compare (my |our )?(site|store|app|website|project) (with|to|against))\b/i,
    /\b(advise|advice).{0,30}\b(website|site|store|app|design|ui|ux)\b/i,
    /\bsearch\s+\w+\s+(to (see|give|advise|advice|help|recommend|suggest|show))\b/i,
    // Documentation & package research
    /\b(search|look up|find|check|browse)\s+(npm|docs?|documentation|rapidapi|api docs?|sdk docs?)\s*(for|of|about)?\s+\w/i,
    /\b(find|look up|search for|check)\s+(the\s+)?(documentation|docs?|api reference|sdk|package|library|module)\s+(for|of|on)\s+\w/i,
    /\bnpm\s+(search|find|look up|docs?|registry)\b/i,
    /\b(rapidapi|programmableweb|api\.marketplace)\b/i,
    /\b(what (npm |)package|which (npm |)library|what (sdk|module|api client))\s+(should|do) i use\b/i,
    /\bfind (me )?(an? |the )?(npm |)package (for|to|that)\b/i,
    // How-to searches that need live docs
    /\bhow (do i|to|can i) (install|use|integrate|connect|add|set up|configure)\s+\w.{3,30}\s+(in|with|to|for)\s+(next\.?js|react|node|typescript|javascript)\b/i,
  ];
  if (WEB_RESEARCH_PATTERNS.some(p => p.test(lower))) return 'web_research';

  // 4. DEPLOYMENT (short questions about DWOMOH's own deployment process only —
  // same "short vague messages only" guard the DEBUG check below already uses.
  // ROOT CAUSE fix: this previously matched ANY message containing these words
  // ANYWHERE, with no length or context guard, so detailed build requests that
  // merely mentioned "publish", "production", "hosting", or "deploy" as part of
  // a feature description (e.g. "Build a blog platform where users can write
  // and publish articles") were misclassified as a deployment question and
  // NEVER reached the build pipeline at all — confirmed live: the Send button
  // returned a canned "DWOMOH is powered by AWS Amplify" response instead of
  // building. Fixed the same way the DEBUG check already guards itself: only
  // classify as 'deployment' for short messages, and never when the message
  // starts with an explicit build verb (unambiguously a build request).
  if (/\b(deploy|go live|connect domain|custom domain|production|publish|vercel|netlify|go to production|launch my site|hosting)\b/.test(lower)
    && words.length <= 8
    && !/^(build|create|make|generate|develop|implement|design|set up|produce)\b/i.test(lower))
    return 'deployment';

  // 5. DEBUG (short vague messages only — detailed ones are edits handled by editPipeline)
  if (/\b(fix|debug|broken|not working|crashed|crash|bug|issue|problem)\b/.test(lower) && words.length <= 6)
    return 'debug';

  // 5b. Logo guard — exclude logo commands from build verbs below.
  // (The greedy "any build verb + 2 words → build" gate was removed because it fired on vague
  // short messages like "Build a marketplace" before the user had described any features,
  // causing the pipeline to start immediately in the middle of a planning conversation.
  // Intent now falls through to the feature-score gate at step 11-12.)

  // 6. QUESTION STRUCTURE GUARD — compute early so logo/design checks can use it
  const isQuestion = lower.endsWith('?')
    || /^(how|what|why|when|where|who|which|whose|is|are|do|does|did|will|would|could|should|may|might|can)\s/.test(lower);

  // 6b. LOGO EDIT — only fires when a logo already exists in session
  if (!isQuestion && ctx?.hasLogo && (
    /\b(refine|edit|update|modify|adjust|improve|revise|redo|tweak)\s*(the\s+)?(logo|design|icon|brand|it)\b/i.test(lower)
    // color / style / font / sizing changes
    || /\b(change|swap|update|alter|make|use)\s*(the\s+)?(color|colour|font|typeface|typography|text|style|size|background|icon|shape|name|weight)\b/i.test(lower)
    || /\b(darker|lighter|bolder|thinner|bigger|smaller|larger|wider|taller|rounder|sharper)\b/i.test(lower)
    || /\b(use|try|apply)\s+(a\s+)?(modern|minimal|bold|elegant|serif|sans.serif|script|condensed|geometric|rounded)\s*(font|typeface|style|look)?\b/i.test(lower)
    || /\bmake\s*(the\s+)?(text|font|icon|logo|design|colors?|background)\s*(bigger|smaller|bolder|lighter|darker|cleaner|minimal|modern|thicker|thinner|larger)\b/i.test(lower)
    || /\bmake\s*(it|the\s*logo)\s*(more|less|bolder|cleaner|darker|lighter|bigger|smaller|professional|minimal|modern|elegant|bold|clean|vibrant|muted|simple|complex)\b/i.test(lower)
    // add elements
    || /\badd\s*(my\s+)?(brand\s+)?(name|text|tagline|slogan|title|subtitle|icon|symbol)/i.test(lower)
    // explicit name reveal
    || /\b(the\s+)?name\s+is\s+\w+/i.test(lower)
    // general intent when logo present
    || /\bgive\s*(it|the\s*logo)\s*(a\s+)?(new|different|more|fresh|better)/i.test(lower)
    || /\blogo\s*(needs|should|must|has to)\s*(be|have|look|use)/i.test(lower)
    || /\b(remove|delete|hide)\s*(the\s+)?(icon|symbol|circle|background|border|text|name|tagline)\b/i.test(lower)
    || /\b(center|align|left|right|stack|arrange|reorder|move)\s*(the\s+)?(text|icon|logo|elements?)\b/i.test(lower)
  ))
    return 'logo_edit';

  // 7. DESIGN — image/logo modification (only non-questions)
  // All patterns use bounded .{0,80} to prevent spanning across long build prompts.
  if (!isQuestion && (
    /add.{0,60}(?:text|name|brand|company|title|label).{0,60}(?:logo|image|design|photo)/i.test(lower)
    || /(?:modify|change|edit|update|adjust|redesign|restyle).{0,80}(?:logo|image|design|photo)/i.test(lower)
    || /(?:logo|image|design).{0,80}(?:modify|change|edit|update|adjust)/i.test(lower)
    || /put.{0,50}(?:name|brand|text).{0,50}(?:on|in).{0,30}(?:logo|image)/i.test(lower)
    || /add.{0,30}logo.{0,30}to|add.{0,30}image.{0,30}to/i.test(lower)
    || /\bcreate.{0,40}variation\b|\bmake.{0,40}logo.{0,40}look\b|\bstyle.{0,30}logo\b/i.test(lower)))
    return 'design';

  // 8. LOGO GENERATION — imperative requests only, never questions
  // "Can you create a logo?" → question (answered by AI), "Create a logo for my brand" → logo_request
  if (!isQuestion && (
    /\b(generate|create|make|design)\s+(a\s+|me\s+a\s+)?logo\b/i.test(lower)
    || /\blogo\s+(for|generation|design|generator)\b/i.test(lower)
    || /\bi\s+(want|need)\s+(a\s+)?logo\b/i.test(lower)
    || /\bbuild\s+(a\s+)?logo\b/i.test(lower)))
    return 'logo_request';

  // (isQuestion already computed above — used below)

  if (isQuestion) {
    // Research-flavoured questions: "Find me X", "What API should I use", "Which is best"
    if (/\b(find|search|look for|look up|discover)\b/i.test(lower)
      || /api for|apis for|api do i need|api to use|best api|which api|what api|payment api|sports api|weather api|maps api/i.test(lower)
      || /best framework|best library|best tool|best database|best approach|compare|versus|\bvs\b|difference between|which is better|alternatives|how to choose/i.test(lower))
      return 'research';

    // Everything else is an explanatory question
    return 'question';
  }

  // 9. NON-QUESTION RESEARCH: "Find me X", "Search for X", "Recommend an API"
  if (/^(find|search|look for|discover|recommend|suggest|compare)\b/i.test(lower) && words.length >= 3)
    return 'research';

  // 10. PLANNING / EXPLORATION — informational, not a build trigger
  if (/want to know|want to understand|how it goes|how would it work|tell me how|explain how|something like|similar to|like facebook|like uber|like airbnb|like amazon|like instagram|like twitter|like whatsapp|thinking of building|curious about|wondering about|help me understand/i.test(lower))
    return 'planning';

  // 11. BUILD VOCABULARY
  const BUILD_VERBS    = ['build', 'create', 'generate', 'make', 'develop', 'design', 'code', 'write', 'implement', 'set up'];
  const INTENT_PHRASES = ['i want', 'i need', 'i would like', "i'd like", 'please build', 'please create', 'please make'];
  const APP_TYPES      = [
    'app', 'application', 'website', 'web app', 'platform', 'marketplace',
    'dashboard', 'store', 'shop', 'ecommerce', 'e-commerce', 'portal', 'system',
    'landing page', 'landing', 'site', 'saas', 'crm', 'cms', 'booking', 'forum',
    'blog', 'portfolio', 'tool', 'directory', 'social network', 'mobile app', 'pwa',
    'social media', 'management system', 'tracking system', 'generator', 'engine',
    'service', 'solution', 'software', 'product', 'api', 'bot', 'agent',
    // Utility / tool types
    'downloader', 'converter', 'calculator', 'tracker', 'analyzer', 'analyser',
    'scraper', 'extractor', 'viewer', 'player', 'editor', 'manager', 'monitor',
    'notifier', 'aggregator', 'scheduler', 'automator', 'processor', 'scanner',
    'builder', 'creator', 'designer', 'shortener', 'checker', 'validator',
    // Common suffixes in branded app names — "Ghana Music Hub", "DeliverGH Pro", etc.
    'hub', 'suite', 'pro', 'plus', 'zone', 'space', 'base', 'core', 'lab', 'labs',
    'studio', 'connect', 'flow', 'go', 'link', 'net', 'box', 'pad', 'io', 'ai',
    'market', 'central', 'center', 'point', 'place', 'spot', 'gate', 'pass',
    'watch', 'track', 'view', 'scope', 'lens', 'dash', 'pulse', 'stream',
  ];
  const hasBuildVerb    = BUILD_VERBS.some(v => { const i = lower.indexOf(v); return i !== -1 && (i === 0 || lower[i - 1] === ' '); });
  const hasIntentPhrase = INTENT_PHRASES.some(p => lower.includes(p));
  // ROOT CAUSE fix: plain .includes() substring matching on short APP_TYPES
  // entries (2-4 letters — 'ai', 'go', 'io', 'pass', 'pro', 'net', 'dash',
  // 'lab', 'hub', 'box', 'pad') false-positived constantly on ordinary
  // English words that merely CONTAIN those letters — confirmed live: "demo
  // email and password is invalid fix it" (a plain bug report on an
  // already-open project, not a build request at all) matched 'ai' inside
  // "email" AND 'pass' inside "password", setting hasAppType=true and
  // causing the whole message to be misclassified as 'build' — which then
  // fell through past the currentProject repair-detection entirely and
  // reached the server-side planner, which correctly couldn't plan an app
  // from this text and asked "what kind of app is...?". Also confirmed:
  // 'ai' alone additionally matches inside "paid", "main", "again",
  // "detail", "maintain", "contain" — all ordinary words with zero
  // relation to building an app. Words of 5+ letters ('portal', 'website',
  // 'dashboard', 'ecommerce', ...) keep using substring matching since a
  // false hit within another word is vanishingly rare at that length;
  // multi-word phrases ('management system', 'social network') are
  // unaffected for the same reason — only the handful of short, high-risk
  // entries below need word-boundary matching instead of a bare substring test.
  const hasAppType = APP_TYPES.some(t =>
    t.length <= 4 ? new RegExp(`\\b${t}\\b`).test(lower) : lower.includes(t));
  const hasAction       = hasBuildVerb || hasIntentPhrase;

  // DIRECT BUILD COMMAND: imperative verb + enough detail to build without clarification.
  // Short commands ("Build a marketplace", "Create an app") fall through to feature-score
  // analysis so DWOMOH can ask clarifying questions rather than building blindly.
  // Only bypass feature-score when the message is long enough to be self-descriptive (8+ words).
  const IMPERATIVE_BUILD_VERBS = /^(build|create|generate|make|develop|produce|code|write|implement)\b/i;
  const isDirectCommand = IMPERATIVE_BUILD_VERBS.test(lower) && words.length >= 8
    && !/^(build|create|generate|make|design|implement)\s+(a\s+|me\s+a\s+)?logo\b/i.test(lower);
  if (isDirectCommand) return 'build';

  // NAMED APP BUILD: "Build [ProperCaseName]" — user names their app directly.
  // Detect: imperative verb + capitalized app name (2–6 words, each starting with uppercase or known word).
  // Examples: "Build Ghana Music Hub", "Create DeliverGH", "Generate KidLearn AI"
  const isNamedAppBuild = IMPERATIVE_BUILD_VERBS.test(lower)
    && words.length >= 2 && words.length <= 8
    && !/^(build|create|generate|make|design|implement)\s+(a\s+|me\s+a\s+)?logo\b/i.test(lower)
    && words.slice(1).some(w => /^[A-Z]/.test(w));  // at least one ProperCase word after the verb
  if (isNamedAppBuild) return 'build';

  // Build request referencing unknown external API → research APIs first
  if (hasAction && hasAppType && /sports api|football api|weather api|stock api|crypto api|news api|using an api|using a sports|using weather|real.time score|live score/i.test(lower))
    return 'research';

  if (!hasAction && !hasAppType && words.length <= 4) return 'conversation';
  if (!hasAction && !hasAppType) return 'question';

  // 12. CONFIRMED BUILD — app type + enough detail (2+ features OR 8+ words)
  //
  // ROOT CAUSE fix: this used to require hasAction (an imperative verb like
  // "build"/"create" or an "I want"/"I need" phrase) as well as hasAppType
  // before ever computing featureScore — a detailed, feature-rich spec with
  // no imperative verb (e.g. answering "what kind of app?" with just
  // "School Management System with Student Portal, Teacher Portal, Parent
  // Portal, Admin Dashboard, Authentication, ... Reports" — a description,
  // not a command) fell straight to the separate `!hasAction && hasAppType
  // → 'clarification_needed'` branch below WITHOUT ever looking at how
  // detailed/feature-rich it was. Confirmed: by this point in the function
  // every question/greeting/conversation/research case has already
  // returned, so anything reaching here mentioning an app type is
  // overwhelmingly a build description, whether or not it happens to use
  // an imperative verb. Fixed by running the SAME featureScore/detailed-
  // spec analysis whenever hasAppType is true, regardless of hasAction.
  if (hasAppType) {
    const FEATURE_WORDS = ['with', 'including', 'featuring', 'login', 'auth', 'authentication',
      'payment', 'paystack', 'stripe', 'search', 'filter', 'map', 'maps', 'chart', 'analytics',
      'user', 'users', 'admin', 'cart', 'checkout', 'booking', 'calendar', 'profile', 'notification',
      'email', 'upload', 'gallery', 'rating', 'review', 'category', 'listing', 'listings', 'property',
      'product', 'products', 'menu', 'order', 'orders', 'delivery', 'messaging', 'chat', 'feed',
      'post', 'follow', 'subscription', 'report', 'invoice', 'inventory', 'responsive',
      'video', 'audio', 'stream', 'live', 'ai', 'ml', 'generate', 'detection', 'recognition'];
    const featureScore = FEATURE_WORDS.filter(f => lower.includes(f)).length;

    // Well-known app categories: build immediately with smart defaults, no clarification needed
    const KNOWN_DOMAINS = [
      'football', 'soccer', 'sports prediction', 'match prediction', 'score predictor',
      'food delivery', 'restaurant', 'recipe', 'meal planner', 'ordering',
      'real estate', 'property', 'housing', 'rental', 'airbnb',
      'e-commerce', 'ecommerce', 'online store', 'marketplace',
      'todo', 'task manager', 'project management', 'kanban',
      'blog', 'news', 'article', 'content',
      'chat', 'messaging', 'social network', 'social media',
      'fintech', 'finance', 'banking', 'payment', 'wallet',
      'healthcare', 'hospital', 'clinic', 'medical', 'appointment',
      'education', 'learning', 'school', 'course', 'quiz',
      'hotel', 'travel', 'booking', 'event', 'ticket',
      'crypto', 'stock', 'trading', 'portfolio',
      'job board', 'recruitment', 'hiring', 'freelance',
      'logistics', 'delivery', 'tracking', 'fleet',
      'fitness', 'gym', 'workout', 'nutrition',
      'crm', 'inventory', 'invoicing', 'accounting', 'erp',
      'weather', 'agriculture', 'farming', 'agri',
      'church', 'charity', 'non.profit', 'community',
      'pharmacy', 'grocery', 'supermarket', 'retail',
      // AI / content / media
      'ai', 'artificial intelligence', 'machine learning', 'video generation', 'image generation',
      'text generation', 'content creation', 'video platform', 'streaming', 'media', 'podcast',
      'music', 'photo', 'photography', 'gallery', 'portfolio',
      // Productivity / SaaS
      'saas', 'productivity', 'collaboration', 'team', 'workspace', 'project tracker',
      'time tracker', 'note', 'notes', 'wiki', 'knowledge base', 'documentation',
      // Other common domains
      'donation', 'crowdfunding', 'nft', 'marketplace', 'auction', 'bidding',
      'survey', 'poll', 'quiz', 'game', 'gaming', 'leaderboard', 'tournament',
      'service directory', 'services directory', 'directory',
      // Specific platform downloaders / tools — always build, never ask for clarification
      'tiktok', 'youtube', 'instagram', 'twitter', 'facebook', 'whatsapp', 'telegram',
      'tiktok downloader', 'youtube downloader', 'instagram downloader', 'video downloader',
      'pdf converter', 'pdf to word', 'image converter', 'file converter',
      'url shortener', 'link shortener', 'qr code', 'barcode generator', 'barcode scanner',
      'password manager', 'password generator', 'color picker', 'unit converter',
      'currency converter', 'tax calculator', 'loan calculator', 'mortgage calculator',
      'countdown timer', 'stopwatch', 'pomodoro', 'habit tracker', 'mood tracker',
      'expense tracker', 'budget tracker', 'calorie tracker', 'workout tracker',
      'price tracker', 'stock tracker', 'crypto tracker', 'weather dashboard',
      'ip lookup', 'dns lookup', 'whois lookup', 'speed test', 'uptime monitor',
      'web scraper', 'data scraper', 'email extractor', 'contact extractor',
      'resume builder', 'cv builder', 'invoice generator', 'contract generator',
      'flashcard', 'typing test', 'text summarizer', 'paraphraser', 'translator',
      'code formatter', 'json viewer', 'csv viewer', 'markdown editor', 'diff tool',
      'drawing tool', 'whiteboard', 'mind map', 'flowchart', 'diagram',
      'chat app', 'forum', 'community', 'discord', 'slack',
      'clone', 'like', 'similar to', 'inspired by',
    ];
    const isWellKnownDomain = KNOWN_DOMAINS.some(d => lower.includes(d));
    // Long detailed specifications (12+ words) with any app vocabulary reliably signal a build intent
    const isDetailedSpec = words.length >= 12 && (hasAppType || featureScore >= 1);
    // Build only when the request is specific enough to generate without guessing:
    //   • 2+ feature words  (e.g. "with listings, search, and Paystack")
    //   • 1 feature + 8 words  (e.g. "a property site with map search for Accra")
    //   • known domain + 1 feature  (e.g. "e-commerce store with cart and checkout")
    //   • known domain + 8 words  (enough context for smart defaults)
    //   • 12+ words with any app vocabulary  (long specification)
    // Everything else asks for clarification — never build from a vague short command.
    if (isDetailedSpec
      || featureScore >= 2
      || (featureScore >= 1 && words.length >= 8)
      || (featureScore >= 1 && isWellKnownDomain)
      || (isWellKnownDomain && words.length >= 8)
    ) return 'build';
    return 'clarification_needed';
  }
  // hasAppType is always handled above now — only !hasAppType reaches here.
  if (hasAction && !hasAppType) return 'planning';

  return 'conversation';
}
