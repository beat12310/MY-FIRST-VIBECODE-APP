/**
 * DWOMOH Vibe Code — Probe Registry
 *
 * 150+ known RapidAPI hosts across all major categories.
 * Each entry has a real test endpoint so the dynamic-registry can determine
 * subscription status by probing it with the user's RAPIDAPI_KEY.
 *
 * Subscription detection rule (per RapidAPI behaviour):
 *   - 403 + "not subscribed" in body → NOT subscribed
 *   - Any other response (200, 400, 401, 404, 429, 500) → subscribed
 *   - Timeout / network error → uncertain (treated as not subscribed)
 */

export interface ProbeEntry {
  host: string;
  name: string;
  categories: string[];
  testEndpoint: string;
  testParams?: Record<string, string>;
  testMethod?: 'GET' | 'POST';
  testBody?: Record<string, unknown>;
  /** If present, used by the proxy to build the real call URL instead of _categoryToUrl() */
  buildUrl?: (params: Record<string, string>) => {
    url: string;
    params?: Record<string, string>;
    body?: unknown;
    method?: 'GET' | 'POST';
  };
  description: string;
}

export const PROBE_REGISTRY: ProbeEntry[] = [

  // ── Sports / Football ────────────────────────────────────────────────────────
  {
    host: 'livescore6.p.rapidapi.com',
    name: 'LiveScore 6',
    categories: ['sports', 'football', 'soccer', 'live-scores'],
    testEndpoint: 'https://livescore6.p.rapidapi.com/matches/v2/list-live',
    testParams: { Category: 'soccer', Timezone: '0' },
    buildUrl: (p) => {
      if (p.date) {
        const d = p.date.replace(/-/g, '');
        return { url: 'https://livescore6.p.rapidapi.com/matches/v2/list-by-date', params: { Category: 'soccer', Date: d, Timezone: '0' } as Record<string, string> };
      }
      return { url: 'https://livescore6.p.rapidapi.com/matches/v2/list-live', params: { Category: 'soccer', Timezone: '0' } as Record<string, string> };
    },
    description: 'Live football scores, fixtures, standings — World Cup, Premier League, Champions League',
  },
  {
    host: 'api-football-v1.p.rapidapi.com',
    name: 'API-Football v3',
    categories: ['sports', 'football', 'soccer', 'fixtures', 'standings'],
    testEndpoint: 'https://api-football-v1.p.rapidapi.com/v3/leagues',
    testParams: { country: 'Ghana' },
    buildUrl: (p) => ({
      url: 'https://api-football-v1.p.rapidapi.com/v3/fixtures',
      params: { league: p.league || '39', season: p.season || '2025', date: p.date || new Date().toISOString().split('T')[0] },
    }),
    description: 'Live scores, fixtures, standings, player stats — 900+ leagues',
  },
  {
    host: 'sofascores.p.rapidapi.com',
    name: 'SofaScore',
    categories: ['sports', 'football', 'live-scores', 'player-ratings'],
    testEndpoint: 'https://sofascores.p.rapidapi.com/v1/category/list',
    testParams: { sport_id: '1' },
    buildUrl: (p) => ({
      url: 'https://sofascores.p.rapidapi.com/v1/events/schedule/sport',
      params: { sport_id: '1', date: p.date || new Date().toISOString().split('T')[0] },
    }),
    description: 'Live scores, match events, player ratings, lineups',
  },
  {
    host: 'footapi7.p.rapidapi.com',
    name: 'FootAPI',
    categories: ['sports', 'football', 'soccer', 'tournaments'],
    testEndpoint: 'https://footapi7.p.rapidapi.com/api/tournaments',
    description: 'Football tournaments, fixtures, scores, and stats',
  },
  {
    host: 'football-web-pages1.p.rapidapi.com',
    name: 'Football Web Pages',
    categories: ['sports', 'football', 'premier-league'],
    testEndpoint: 'https://football-web-pages1.p.rapidapi.com/league-table.json',
    testParams: { comp: '1' },
    description: 'English football leagues — Premier League, Championship tables and fixtures',
  },
  {
    host: 'sportscore1.p.rapidapi.com',
    name: 'SportsCore',
    categories: ['sports', 'football', 'basketball', 'tennis'],
    testEndpoint: 'https://sportscore1.p.rapidapi.com/sports',
    description: 'Multi-sport data including football, basketball, and tennis',
  },
  {
    host: 'sport-highlights-api.p.rapidapi.com',
    name: 'Sport Highlights API',
    categories: ['sports', 'highlights', 'football', 'video'],
    testEndpoint: 'https://sport-highlights-api.p.rapidapi.com/football/highlights',
    testParams: { limit: '5' },
    description: 'Sports highlight videos for football and other sports',
  },
  {
    host: 'nba-api-free-data.p.rapidapi.com',
    name: 'NBA API Free',
    categories: ['sports', 'basketball', 'nba'],
    testEndpoint: 'https://nba-api-free-data.p.rapidapi.com/games',
    testParams: { date: new Date().toISOString().split('T')[0] },
    description: 'NBA game scores, schedules, player and team stats',
  },
  {
    host: 'nba.p.rapidapi.com',
    name: 'NBA (API-NBA)',
    categories: ['sports', 'basketball', 'nba', 'standings'],
    testEndpoint: 'https://nba.p.rapidapi.com/leagues',
    description: 'Official NBA data — games, players, teams, standings',
  },
  {
    host: 'cricket-live-data.p.rapidapi.com',
    name: 'Cricket Live Data',
    categories: ['sports', 'cricket'],
    testEndpoint: 'https://cricket-live-data.p.rapidapi.com/fixtures/series/1',
    description: 'Live cricket scores, series, and match data',
  },
  {
    host: 'cricbuzz-cricket.p.rapidapi.com',
    name: 'Cricbuzz Cricket',
    categories: ['sports', 'cricket', 'live-scores'],
    testEndpoint: 'https://cricbuzz-cricket.p.rapidapi.com/series/v1/list',
    description: 'Cricbuzz-powered cricket scores, commentary, and stats',
  },
  {
    host: 'american-football-api.p.rapidapi.com',
    name: 'American Football (NFL)',
    categories: ['sports', 'american-football', 'nfl'],
    testEndpoint: 'https://american-football-api.p.rapidapi.com/nfl/teams',
    description: 'NFL teams, games, players, and standings',
  },
  {
    host: 'tennis-live-data.p.rapidapi.com',
    name: 'Tennis Live Data',
    categories: ['sports', 'tennis'],
    testEndpoint: 'https://tennis-live-data.p.rapidapi.com/categories',
    description: 'ATP/WTA tennis scores, rankings, and tournament data',
  },
  {
    host: 'formula-1.p.rapidapi.com',
    name: 'Formula 1',
    categories: ['sports', 'formula1', 'f1', 'racing'],
    testEndpoint: 'https://formula-1.p.rapidapi.com/v1/drivers',
    description: 'F1 race results, driver standings, team info',
  },
  {
    host: 'motorsport.p.rapidapi.com',
    name: 'Motorsport API',
    categories: ['sports', 'motorsport', 'racing', 'formula1'],
    testEndpoint: 'https://motorsport.p.rapidapi.com/api/races/latest.json',
    description: 'Motorsport data including F1, NASCAR, and MotoGP',
  },

  // ── Betting / Odds ────────────────────────────────────────────────────────────
  {
    host: 'odds-api1.p.rapidapi.com',
    name: 'The Odds API',
    categories: ['sports', 'betting', 'odds', 'football'],
    testEndpoint: 'https://odds-api1.p.rapidapi.com/sports',
    description: 'Sports betting odds from major bookmakers worldwide',
  },
  {
    host: 'betway2.p.rapidapi.com',
    name: 'Betway Odds',
    categories: ['sports', 'betting', 'odds'],
    testEndpoint: 'https://betway2.p.rapidapi.com/sports',
    description: 'Betway sportsbook odds and markets',
  },
  {
    host: 'bet365.p.rapidapi.com',
    name: 'Bet365 Sports Odds',
    categories: ['sports', 'betting', 'odds'],
    testEndpoint: 'https://bet365.p.rapidapi.com/v1/bet365/upcoming',
    testParams: { sport_id: '1' },
    description: 'Bet365 live and pre-match betting odds',
  },

  // ── Weather ────────────────────────────────────────────────────────────────────
  {
    host: 'community-open-weather-map.p.rapidapi.com',
    name: 'OpenWeatherMap',
    categories: ['weather', 'forecast', 'climate'],
    testEndpoint: 'https://community-open-weather-map.p.rapidapi.com/weather',
    testParams: { q: 'London', units: 'metric' },
    buildUrl: (p) => ({ url: 'https://community-open-weather-map.p.rapidapi.com/weather', params: { q: p.city || p.q || 'London', units: p.units || 'metric' } }),
    description: 'Current weather, 5-day forecast, air quality by city or coordinates',
  },
  {
    host: 'weatherapi-com.p.rapidapi.com',
    name: 'WeatherAPI.com',
    categories: ['weather', 'forecast', 'astronomy'],
    testEndpoint: 'https://weatherapi-com.p.rapidapi.com/v1/current.json',
    testParams: { q: 'London' },
    buildUrl: (p) => ({ url: 'https://weatherapi-com.p.rapidapi.com/v1/current.json', params: { q: p.city || p.q || 'London' } }),
    description: 'Real-time weather, 14-day forecast, astronomy data',
  },
  {
    host: 'foreca-weather.p.rapidapi.com',
    name: 'Foreca Weather',
    categories: ['weather', 'forecast', 'hourly'],
    testEndpoint: 'https://foreca-weather.p.rapidapi.com/current/102339354',
    buildUrl: (p) => ({ url: `https://foreca-weather.p.rapidapi.com/current/${p.locationId || '102339354'}` }),
    description: 'Hourly and daily forecasts with detailed weather data',
  },
  {
    host: 'visual-crossing-weather.p.rapidapi.com',
    name: 'Visual Crossing Weather',
    categories: ['weather', 'forecast', 'historical'],
    testEndpoint: 'https://visual-crossing-weather.p.rapidapi.com/VisualCrossingWebServices/rest/services/timeline/London/today',
    testParams: { unitGroup: 'metric', include: 'current', elements: 'temp,humidity,windspeed' },
    description: 'Weather timeline, historical data, and forecasts',
  },
  {
    host: 'open-weather-map.p.rapidapi.com',
    name: 'OpenWeatherMap (Alt)',
    categories: ['weather', 'forecast'],
    testEndpoint: 'https://open-weather-map.p.rapidapi.com/weather',
    testParams: { q: 'London', units: 'metric' },
    description: 'Alternative OpenWeatherMap connector with extended data',
  },
  {
    host: 'aerisweather1.p.rapidapi.com',
    name: 'AerisWeather',
    categories: ['weather', 'forecast', 'alerts'],
    testEndpoint: 'https://aerisweather1.p.rapidapi.com/observations/london,uk',
    description: 'Weather observations, forecasts, and severe weather alerts',
  },

  // ── News ──────────────────────────────────────────────────────────────────────
  {
    host: 'bing-news-search1.p.rapidapi.com',
    name: 'Bing News Search',
    categories: ['news', 'search', 'articles'],
    testEndpoint: 'https://bing-news-search1.p.rapidapi.com/news/search',
    testParams: { q: 'technology', mkt: 'en-US', safeSearch: 'Off', textFormat: 'Raw', freshness: 'Day', count: '3' },
    buildUrl: (p) => ({ url: 'https://bing-news-search1.p.rapidapi.com/news/search', params: { q: p.q || 'world news', mkt: 'en-US', count: p.count || '10', safeSearch: 'Off', textFormat: 'Raw' } }),
    description: 'Real-time news articles from around the web via Bing',
  },
  {
    host: 'newscatcher.p.rapidapi.com',
    name: 'NewsCatcher',
    categories: ['news', 'headlines', 'articles', 'sources'],
    testEndpoint: 'https://newscatcher.p.rapidapi.com/v2/latest_headlines',
    testParams: { lang: 'en', country: 'US', page_size: '3', page: '1' },
    buildUrl: (p) => ({ url: 'https://newscatcher.p.rapidapi.com/v2/search', params: { q: p.q || 'latest', lang: 'en', sort_by: 'relevancy', page_size: p.count || '10', page: '1' } }),
    description: 'News from 60,000+ sources — headlines, keyword search, trending',
  },
  {
    host: 'google-news13.p.rapidapi.com',
    name: 'Google News',
    categories: ['news', 'google', 'articles', 'search'],
    testEndpoint: 'https://google-news13.p.rapidapi.com/v1/search',
    testParams: { q: 'technology', lr: 'en-US', gl: 'US', num: '3', start: '0' },
    buildUrl: (p) => ({ url: 'https://google-news13.p.rapidapi.com/v1/search', params: { q: p.q || 'latest', lr: 'en-US', gl: 'US', num: p.count || '10', start: '0' } }),
    description: 'Google News search with full article access',
  },
  {
    host: 'real-time-news-data.p.rapidapi.com',
    name: 'Real-Time News Data',
    categories: ['news', 'articles', 'search'],
    testEndpoint: 'https://real-time-news-data.p.rapidapi.com/search',
    testParams: { query: 'latest news', limit: '3', time_published: 'anytime', country: 'US', lang: 'en' },
    description: 'Real-time news search with filtering by source and topic',
  },
  {
    host: 'news-api14.p.rapidapi.com',
    name: 'News API 14',
    categories: ['news', 'articles', 'headlines'],
    testEndpoint: 'https://news-api14.p.rapidapi.com/v2/trendings',
    testParams: { language: 'en' },
    description: 'Trending news and headlines from global sources',
  },
  {
    host: 'the-news-api.p.rapidapi.com',
    name: 'The News API',
    categories: ['news', 'articles', 'global'],
    testEndpoint: 'https://the-news-api.p.rapidapi.com/v1/news/top',
    testParams: { language: 'en', limit: '3' },
    description: 'Top news from global publishers with category filtering',
  },

  // ── Finance / Currency / Stocks ────────────────────────────────────────────────
  {
    host: 'currency-exchange.p.rapidapi.com',
    name: 'Currency Exchange',
    categories: ['finance', 'currency', 'forex'],
    testEndpoint: 'https://currency-exchange.p.rapidapi.com/exchange',
    testParams: { from: 'USD', to: 'EUR', q: '1.0' },
    buildUrl: (p) => ({ url: 'https://currency-exchange.p.rapidapi.com/exchange', params: { from: p.from || 'USD', to: p.to || 'GHS', q: '1.0' } }),
    description: 'Real-time currency exchange rates for 170+ currencies',
  },
  {
    host: 'exchange-rate-api.p.rapidapi.com',
    name: 'Exchange Rate API',
    categories: ['finance', 'currency', 'forex', 'historical'],
    testEndpoint: 'https://exchange-rate-api.p.rapidapi.com/rapid/latest/USD',
    buildUrl: (p) => ({ url: `https://exchange-rate-api.p.rapidapi.com/rapid/latest/${p.from || 'USD'}` }),
    description: 'Exchange rates with historical data support',
  },
  {
    host: 'coinranking1.p.rapidapi.com',
    name: 'Coinranking',
    categories: ['finance', 'crypto', 'cryptocurrency', 'bitcoin'],
    testEndpoint: 'https://coinranking1.p.rapidapi.com/coins',
    testParams: { limit: '3' },
    buildUrl: (p) => ({ url: 'https://coinranking1.p.rapidapi.com/coins', params: { limit: p.limit || '20' } }),
    description: 'Cryptocurrency prices, market cap, and historical data',
  },
  {
    host: 'coingecko.p.rapidapi.com',
    name: 'CoinGecko',
    categories: ['finance', 'crypto', 'cryptocurrency', 'defi'],
    testEndpoint: 'https://coingecko.p.rapidapi.com/coins/markets',
    testParams: { vs_currency: 'usd', order: 'market_cap_desc', per_page: '10', page: '1' },
    description: 'Comprehensive crypto data — prices, charts, exchanges, DeFi',
  },
  {
    host: 'alpha-vantage.p.rapidapi.com',
    name: 'Alpha Vantage',
    categories: ['finance', 'stocks', 'stock-market', 'equities'],
    testEndpoint: 'https://alpha-vantage.p.rapidapi.com/query',
    testParams: { function: 'TIME_SERIES_DAILY', symbol: 'AAPL', outputsize: 'compact' },
    buildUrl: (p) => ({ url: 'https://alpha-vantage.p.rapidapi.com/query', params: { function: 'TIME_SERIES_DAILY', symbol: p.symbol || 'AAPL', outputsize: 'compact' } }),
    description: 'Stock prices, technical indicators, forex, crypto — Alpha Vantage',
  },
  {
    host: 'yahoo-finance1.p.rapidapi.com',
    name: 'Yahoo Finance',
    categories: ['finance', 'stocks', 'stock-market', 'market-data'],
    testEndpoint: 'https://yahoo-finance1.p.rapidapi.com/stock/v3/get-summary',
    testParams: { symbol: 'AAPL', region: 'US' },
    buildUrl: (p) => ({ url: 'https://yahoo-finance1.p.rapidapi.com/stock/v3/get-summary', params: { symbol: p.symbol || 'AAPL', region: 'US' } }),
    description: 'Yahoo Finance — stock quotes, summary, financials, news',
  },
  {
    host: 'twelve-data1.p.rapidapi.com',
    name: 'Twelve Data',
    categories: ['finance', 'stocks', 'forex', 'crypto', 'time-series'],
    testEndpoint: 'https://twelve-data1.p.rapidapi.com/price',
    testParams: { symbol: 'AAPL', format: 'JSON', outputsize: '30' },
    buildUrl: (p) => ({ url: 'https://twelve-data1.p.rapidapi.com/price', params: { symbol: p.symbol || 'AAPL', format: 'JSON', outputsize: '30' } }),
    description: 'Stock and forex time-series, indicators, earnings data',
  },
  {
    host: 'seeking-alpha.p.rapidapi.com',
    name: 'Seeking Alpha',
    categories: ['finance', 'stocks', 'analysis', 'news'],
    testEndpoint: 'https://seeking-alpha.p.rapidapi.com/symbols/list',
    testParams: { q: 'AAPL' },
    description: 'Stock analysis, financial news, and investment research from Seeking Alpha',
  },
  {
    host: 'mboum-finance.p.rapidapi.com',
    name: 'Mboum Finance',
    categories: ['finance', 'stocks', 'market-data'],
    testEndpoint: 'https://mboum-finance.p.rapidapi.com/qu/quote',
    testParams: { symbol: 'AAPL' },
    description: 'Real-time stock quotes, options data, and market metrics',
  },
  {
    host: 'apidojo-yahoo-finance-v1.p.rapidapi.com',
    name: 'Yahoo Finance v1 (ApiDojo)',
    categories: ['finance', 'stocks', 'market-data'],
    testEndpoint: 'https://apidojo-yahoo-finance-v1.p.rapidapi.com/market/v2/get-quotes',
    testParams: { region: 'US', symbols: 'AAPL' },
    description: 'Yahoo Finance alternative with quotes, options, news',
  },
  {
    host: 'crypto-asset-prices.p.rapidapi.com',
    name: 'Crypto Asset Prices',
    categories: ['finance', 'crypto', 'cryptocurrency'],
    testEndpoint: 'https://crypto-asset-prices.p.rapidapi.com/coins/latest',
    description: 'Latest cryptocurrency prices and market data',
  },

  // ── Music ──────────────────────────────────────────────────────────────────────
  {
    host: 'shazam-core.p.rapidapi.com',
    name: 'Shazam Core',
    categories: ['music', 'charts', 'song-recognition', 'lyrics'],
    testEndpoint: 'https://shazam-core.p.rapidapi.com/v1/charts/world',
    buildUrl: (p) => ({ url: 'https://shazam-core.p.rapidapi.com/v1/search/multi', params: { search_type: 'SONGS_ARTISTS', query: p.q || p.query || 'top hits' } }),
    description: 'Song recognition, search, charts, and lyrics via Shazam Core',
  },
  {
    host: 'shazam.p.rapidapi.com',
    name: 'Shazam',
    categories: ['music', 'charts', 'song-recognition', 'search'],
    testEndpoint: 'https://shazam.p.rapidapi.com/search',
    testParams: { term: 'One Dance', locale: 'en-US', offset: '0', limit: '3' },
    buildUrl: (p) => ({ url: 'https://shazam.p.rapidapi.com/search', params: { term: p.q || p.query || 'top hits', locale: 'en-US', offset: '0', limit: '10' } }),
    description: 'Search songs, get charts, detect music via Shazam',
  },
  {
    host: 'deezerdevs-deezer.p.rapidapi.com',
    name: 'Deezer',
    categories: ['music', 'search', 'artist', 'album', 'playlist'],
    testEndpoint: 'https://deezerdevs-deezer.p.rapidapi.com/search',
    testParams: { q: 'drake' },
    buildUrl: (p) => ({ url: 'https://deezerdevs-deezer.p.rapidapi.com/search', params: { q: p.q || p.query || 'top hits' } }),
    description: 'Music search, artist info, albums, playlists via Deezer',
  },
  {
    host: 'spotify23.p.rapidapi.com',
    name: 'Spotify (Unofficial)',
    categories: ['music', 'spotify', 'playlists', 'artist', 'album'],
    testEndpoint: 'https://spotify23.p.rapidapi.com/search',
    testParams: { q: 'One Dance', type: 'multi', offset: '0', limit: '10', numberOfTopResults: '5' },
    buildUrl: (p) => ({ url: 'https://spotify23.p.rapidapi.com/search', params: { q: p.q || p.query || 'top hits', type: 'multi', offset: '0', limit: '10', numberOfTopResults: '5' } }),
    description: 'Unofficial Spotify API — search, tracks, playlists, artist info',
  },
  {
    host: 'genius-song-lyrics1.p.rapidapi.com',
    name: 'Genius Song Lyrics',
    categories: ['music', 'lyrics', 'songs', 'search'],
    testEndpoint: 'https://genius-song-lyrics1.p.rapidapi.com/search',
    testParams: { q: 'drake' },
    description: 'Song lyrics search and retrieval from Genius',
  },
  {
    host: 'youtube-music.p.rapidapi.com',
    name: 'YouTube Music',
    categories: ['music', 'youtube', 'search', 'charts'],
    testEndpoint: 'https://youtube-music.p.rapidapi.com/charts/list',
    description: 'YouTube Music charts, search, and artist info',
  },
  {
    host: 'soundcloud4.p.rapidapi.com',
    name: 'SoundCloud',
    categories: ['music', 'soundcloud', 'tracks', 'artists'],
    testEndpoint: 'https://soundcloud4.p.rapidapi.com/search-music',
    testParams: { q: 'ambient', limit: '3' },
    description: 'SoundCloud music search, tracks, and user profiles',
  },
  {
    host: 'musixmatch.p.rapidapi.com',
    name: 'Musixmatch',
    categories: ['music', 'lyrics', 'translation', 'charts'],
    testEndpoint: 'https://musixmatch.p.rapidapi.com/ws/1.1/chart.tracks.get',
    testParams: { chart_name: 'top', page_size: '5', page: '1', f_has_lyrics: '1', country: 'us' },
    description: 'Lyrics, translations, and music charts via Musixmatch',
  },

  // ── Video / TikTok / Instagram / YouTube ──────────────────────────────────────
  {
    host: 'tiktok-downloader-download-tiktok-videos-without-watermark.p.rapidapi.com',
    name: 'TikTok Downloader (No Watermark)',
    categories: ['video', 'tiktok', 'downloader', 'social-media'],
    testEndpoint: 'https://tiktok-downloader-download-tiktok-videos-without-watermark.p.rapidapi.com/index',
    testParams: { url: 'https://www.tiktok.com/@tiktok/video/7106594312292453675', hd: '1' },
    buildUrl: (p) => ({ url: 'https://tiktok-downloader-download-tiktok-videos-without-watermark.p.rapidapi.com/index', params: { url: p.url, hd: '1' } }),
    description: 'Download TikTok videos without watermark — returns direct MP4 URLs',
  },
  {
    host: 'social-media-video-downloader.p.rapidapi.com',
    name: 'Social Media Video Downloader',
    categories: ['video', 'tiktok', 'instagram', 'youtube', 'downloader'],
    testEndpoint: 'https://social-media-video-downloader.p.rapidapi.com/smvd/get/all',
    testParams: { url: 'https://www.tiktok.com/@tiktok/video/7106594312292453675' },
    buildUrl: (p) => ({ url: 'https://social-media-video-downloader.p.rapidapi.com/smvd/get/all', params: { url: p.url } }),
    description: 'Download videos from TikTok, Instagram, YouTube, Facebook, Twitter',
  },
  {
    host: 'tiktok-scraper7.p.rapidapi.com',
    name: 'TikTok Scraper 7',
    categories: ['video', 'tiktok', 'scraper', 'downloader'],
    testEndpoint: 'https://tiktok-scraper7.p.rapidapi.com/video/info',
    testParams: { url: 'https://www.tiktok.com/@tiktok/video/7106594312292453675' },
    description: 'TikTok video info, trending, hashtag scraping',
  },
  {
    host: 'instagram-looter2.p.rapidapi.com',
    name: 'Instagram Looter 2',
    categories: ['instagram', 'social-media', 'scraper', 'profile'],
    testEndpoint: 'https://instagram-looter2.p.rapidapi.com/profile/',
    testParams: { username: 'instagram' },
    description: 'Instagram profile, posts, stories, and reels scraper',
  },
  {
    host: 'instagram-bulk-profile-scrapper.p.rapidapi.com',
    name: 'Instagram Bulk Profile Scrapper',
    categories: ['instagram', 'social-media', 'scraper', 'profile'],
    testEndpoint: 'https://instagram-bulk-profile-scrapper.p.rapidapi.com/get_user_info_public',
    testParams: { user_name: 'instagram' },
    description: 'Bulk Instagram profile scraping — followers, posts, bio, reels',
  },
  {
    host: 'instagram-scraper-api2.p.rapidapi.com',
    name: 'Instagram Scraper API 2',
    categories: ['instagram', 'social-media', 'scraper'],
    testEndpoint: 'https://instagram-scraper-api2.p.rapidapi.com/v1/info',
    testParams: { username_or_id_or_url: 'instagram' },
    description: 'Instagram posts, reels, stories, and highlights scraper',
  },
  {
    host: 'youtube-v3-alternative.p.rapidapi.com',
    name: 'YouTube v3 Alternative',
    categories: ['youtube', 'video', 'search', 'social-media'],
    testEndpoint: 'https://youtube-v3-alternative.p.rapidapi.com/search',
    testParams: { query: 'javascript tutorial', type: 'video', part: 'id,snippet', maxResults: '3' },
    buildUrl: (p) => ({ url: 'https://youtube-v3-alternative.p.rapidapi.com/search', params: { query: p.q || p.query || 'javascript tutorial', type: 'video', part: 'id,snippet', maxResults: p.limit || '10' } }),
    description: 'YouTube search, video info, channel data, comments',
  },
  {
    host: 'yt-api.p.rapidapi.com',
    name: 'YT API',
    categories: ['youtube', 'video', 'search'],
    testEndpoint: 'https://yt-api.p.rapidapi.com/search',
    testParams: { q: 'javascript' },
    buildUrl: (p) => ({ url: 'https://yt-api.p.rapidapi.com/search', params: { q: p.q || p.query || 'javascript tutorial' } }),
    description: 'YouTube search, transcripts, channel stats, trending',
  },
  {
    host: 'youtube-search-and-download.p.rapidapi.com',
    name: 'YouTube Search & Download',
    categories: ['youtube', 'video', 'download', 'search'],
    testEndpoint: 'https://youtube-search-and-download.p.rapidapi.com/search',
    testParams: { query: 'programming', type: 'v' },
    description: 'YouTube video search, download links, and subtitles',
  },

  // ── AI / Image Generation ──────────────────────────────────────────────────────
  {
    host: 'chatgpt-42.p.rapidapi.com',
    name: 'ChatGPT (via RapidAPI)',
    categories: ['ai', 'chatgpt', 'text-generation', 'nlp'],
    testEndpoint: 'https://chatgpt-42.p.rapidapi.com/chat/completions',
    testMethod: 'POST',
    testBody: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
    description: 'ChatGPT text generation, summarization, Q&A via RapidAPI',
  },
  {
    host: 'open-ai21.p.rapidapi.com',
    name: 'OpenAI (via RapidAPI)',
    categories: ['ai', 'openai', 'text-generation', 'nlp'],
    testEndpoint: 'https://open-ai21.p.rapidapi.com/chat/completions',
    testMethod: 'POST',
    testBody: { model: 'gpt-3.5-turbo', messages: [{ role: 'user', content: 'hi' }] },
    description: 'OpenAI GPT models via RapidAPI proxy',
  },
  {
    host: 'text-summarizer-api.p.rapidapi.com',
    name: 'Text Summarizer',
    categories: ['ai', 'nlp', 'summarization', 'text'],
    testEndpoint: 'https://text-summarizer-api.p.rapidapi.com/summarize-text',
    testMethod: 'POST',
    testBody: { text: 'Artificial intelligence is transforming many industries.', percent: 50 },
    description: 'Summarize long texts and articles',
  },
  {
    host: 'ai-text-to-image-generator-api.p.rapidapi.com',
    name: 'AI Text-to-Image Generator',
    categories: ['ai', 'image-generation', 'text-to-image'],
    testEndpoint: 'https://ai-text-to-image-generator-api.p.rapidapi.com/generate',
    testMethod: 'POST',
    testBody: { prompt: 'a beautiful sunset over the ocean', resolution: '512x512' },
    description: 'Generate images from text prompts using AI',
  },
  {
    host: 'open-ai-image-generation.p.rapidapi.com',
    name: 'DALL-E Image Generation',
    categories: ['ai', 'image-generation', 'dalle'],
    testEndpoint: 'https://open-ai-image-generation.p.rapidapi.com/tti/',
    testMethod: 'POST',
    testBody: { text: 'beautiful landscape', resolution: '256x256' },
    description: 'DALL-E image generation from text via RapidAPI',
  },
  {
    host: 'chat-gpt26.p.rapidapi.com',
    name: 'Chat GPT 26',
    categories: ['ai', 'chatgpt', 'conversational'],
    testEndpoint: 'https://chat-gpt26.p.rapidapi.com/',
    testMethod: 'POST',
    testBody: { messages: [{ role: 'user', content: 'hi' }] },
    description: 'GPT-based chat API for conversational AI apps',
  },
  {
    host: 'face-detection3.p.rapidapi.com',
    name: 'Face Detection',
    categories: ['ai', 'computer-vision', 'face-detection'],
    testEndpoint: 'https://face-detection3.p.rapidapi.com/v1/detect',
    testMethod: 'POST',
    testBody: { url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/ec/Mona_Lisa%2C_by_Leonardo_da_Vinci%2C_from_C2RMF_retouched.jpg/250px-Mona_Lisa%2C_by_Leonardo_da_Vinci%2C_from_C2RMF_retouched.jpg' },
    description: 'Face detection and recognition in images',
  },
  {
    host: 'background-removal.p.rapidapi.com',
    name: 'Background Removal',
    categories: ['ai', 'image-processing', 'background-removal'],
    testEndpoint: 'https://background-removal.p.rapidapi.com/remove',
    testMethod: 'POST',
    testBody: { image_url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/41/Sunflower_from_Silesia2.jpg/250px-Sunflower_from_Silesia2.jpg' },
    description: 'AI-powered background removal from images',
  },

  // ── Maps / Geocoding ───────────────────────────────────────────────────────────
  {
    host: 'trueway-places.p.rapidapi.com',
    name: 'TrueWay Places',
    categories: ['maps', 'geocoding', 'places', 'poi'],
    testEndpoint: 'https://trueway-places.p.rapidapi.com/FindPlacesNearby',
    testParams: { location: '51.5074,-0.1278', radius: '1000', language: 'en' },
    description: 'Find nearby places, geocode addresses, Google Maps-compatible',
  },
  {
    host: 'geocodeapi.p.rapidapi.com',
    name: 'GeocodeAPI',
    categories: ['maps', 'geocoding', 'coordinates'],
    testEndpoint: 'https://geocodeapi.p.rapidapi.com/GetSearchResults',
    testParams: { text: 'London', maxRows: '3' },
    description: 'Convert addresses to coordinates and reverse geocode',
  },
  {
    host: 'geocoding-api.p.rapidapi.com',
    name: 'Geocoding API',
    categories: ['maps', 'geocoding', 'address'],
    testEndpoint: 'https://geocoding-api.p.rapidapi.com/v1/geocode',
    testParams: { address: 'London, UK' },
    description: 'Geocoding and reverse geocoding service',
  },
  {
    host: 'forward-reverse-geocoding.p.rapidapi.com',
    name: 'Forward/Reverse Geocoding',
    categories: ['maps', 'geocoding', 'coordinates'],
    testEndpoint: 'https://forward-reverse-geocoding.p.rapidapi.com/v1/forward',
    testParams: { city: 'London', country: 'UK' },
    description: 'Forward and reverse geocoding with address lookup',
  },
  {
    host: 'google-maps-geocoding.p.rapidapi.com',
    name: 'Google Maps Geocoding',
    categories: ['maps', 'google-maps', 'geocoding'],
    testEndpoint: 'https://google-maps-geocoding.p.rapidapi.com/geocode/json',
    testParams: { address: 'London', language: 'en' },
    description: 'Google Maps Geocoding API via RapidAPI',
  },
  {
    host: 'maps-distance-matrix.p.rapidapi.com',
    name: 'Maps Distance Matrix',
    categories: ['maps', 'distance', 'routing'],
    testEndpoint: 'https://maps-distance-matrix.p.rapidapi.com/v1/distancematrix',
    testParams: { origins: '51.5074,0.1278', destinations: '48.8566,2.3522' },
    description: 'Distance and travel time matrix between locations',
  },

  // ── Travel / Flights / Hotels ─────────────────────────────────────────────────
  {
    host: 'skyscanner44.p.rapidapi.com',
    name: 'Skyscanner',
    categories: ['travel', 'flights', 'airfare', 'booking'],
    testEndpoint: 'https://skyscanner44.p.rapidapi.com/flights/auto-complete',
    testParams: { query: 'London' },
    description: 'Flight search, price comparison, and booking via Skyscanner',
  },
  {
    host: 'booking-com.p.rapidapi.com',
    name: 'Booking.com',
    categories: ['travel', 'hotels', 'accommodation', 'booking'],
    testEndpoint: 'https://booking-com.p.rapidapi.com/v1/hotels/search',
    testParams: {
      room_number: '1',
      checkin_date: (() => { const d = new Date(); d.setDate(d.getDate() + 14); return d.toISOString().split('T')[0]; })(),
      checkout_date: (() => { const d = new Date(); d.setDate(d.getDate() + 15); return d.toISOString().split('T')[0]; })(),
      units: 'metric', adults_number: '1', dest_id: '-2601889', dest_type: 'city',
      locale: 'en-gb', currency: 'GBP', order_by: 'popularity',
    },
    description: 'Hotel search, room availability, and booking via Booking.com',
  },
  {
    host: 'tripadvisor15.p.rapidapi.com',
    name: 'TripAdvisor',
    categories: ['travel', 'hotels', 'restaurants', 'reviews'],
    testEndpoint: 'https://tripadvisor15.p.rapidapi.com/api/v1/restaurant/searchRestaurants',
    testParams: { locationId: '187147' },
    description: 'TripAdvisor hotels, restaurants, and attraction reviews',
  },
  {
    host: 'flight-radar1.p.rapidapi.com',
    name: 'FlightRadar',
    categories: ['travel', 'flights', 'live-tracking', 'aviation'],
    testEndpoint: 'https://flight-radar1.p.rapidapi.com/flights/get-most-tracked',
    description: 'Live flight tracking, airport status, and airline data',
  },
  {
    host: 'hotels4.p.rapidapi.com',
    name: 'Hotels.com',
    categories: ['travel', 'hotels', 'accommodation'],
    testEndpoint: 'https://hotels4.p.rapidapi.com/locations/v3/search',
    testParams: { q: 'London', locale: 'en_US', langid: '1033', siteid: '300000001' },
    description: 'Hotels.com hotel search and availability',
  },

  // ── Real Estate ────────────────────────────────────────────────────────────────
  {
    host: 'zillow-com1.p.rapidapi.com',
    name: 'Zillow',
    categories: ['real-estate', 'property', 'homes', 'us-real-estate'],
    testEndpoint: 'https://zillow-com1.p.rapidapi.com/propertyExtendedSearch',
    testParams: { location: 'Chicago, IL', home_type: 'Houses' },
    description: 'US real estate listings, home values, and mortgage estimates via Zillow',
  },
  {
    host: 'realty-mole-property-api.p.rapidapi.com',
    name: 'Realty Mole Property API',
    categories: ['real-estate', 'property', 'rental'],
    testEndpoint: 'https://realty-mole-property-api.p.rapidapi.com/properties',
    testParams: { address: '5500 Grand Lake Drive, San Antonio, TX 78244' },
    description: 'US property data — listing, ownership, rental estimates',
  },
  {
    host: 'us-real-estate.p.rapidapi.com',
    name: 'US Real Estate',
    categories: ['real-estate', 'property', 'homes'],
    testEndpoint: 'https://us-real-estate.p.rapidapi.com/v2/for-sale',
    testParams: { state_code: 'CA', city: 'Los Angeles', limit: '5', offset: '0' },
    description: 'US property for sale and rent listings',
  },
  {
    host: 'bayut.p.rapidapi.com',
    name: 'Bayut UAE Real Estate',
    categories: ['real-estate', 'property', 'uae', 'middle-east'],
    testEndpoint: 'https://bayut.p.rapidapi.com/properties/list',
    testParams: { locationExternalIDs: '5002', purpose: 'for-sale', hitsPerPage: '5', page: '0', lang: 'en' },
    description: 'UAE real estate listings for sale and rent via Bayut',
  },

  // ── Social Media / Twitter / LinkedIn ─────────────────────────────────────────
  {
    host: 'twitter-api45.p.rapidapi.com',
    name: 'Twitter API 45',
    categories: ['twitter', 'social-media', 'tweets'],
    testEndpoint: 'https://twitter-api45.p.rapidapi.com/timeline.php',
    testParams: { screenname: 'twitter' },
    description: 'Twitter timeline, user info, tweets, and trends',
  },
  {
    host: 'twitter241.p.rapidapi.com',
    name: 'Twitter 241',
    categories: ['twitter', 'social-media', 'search'],
    testEndpoint: 'https://twitter241.p.rapidapi.com/user/info',
    testParams: { userName: 'twitter' },
    description: 'Twitter search, user profiles, and tweet data',
  },
  {
    host: 'twttrapi.p.rapidapi.com',
    name: 'Twtttr API',
    categories: ['twitter', 'social-media', 'scraper'],
    testEndpoint: 'https://twttrapi.p.rapidapi.com/get-user',
    testParams: { username: 'twitter' },
    description: 'Twitter scraper — user profiles, tweets, followers',
  },
  {
    host: 'linkedin-data-api.p.rapidapi.com',
    name: 'LinkedIn Data API',
    categories: ['linkedin', 'social-media', 'professional', 'company'],
    testEndpoint: 'https://linkedin-data-api.p.rapidapi.com/get-company-by-domain',
    testParams: { domain: 'microsoft.com' },
    description: 'LinkedIn company and person data via RapidAPI',
  },
  {
    host: 'linkedin-profiles.p.rapidapi.com',
    name: 'LinkedIn Profiles',
    categories: ['linkedin', 'social-media', 'professional'],
    testEndpoint: 'https://linkedin-profiles.p.rapidapi.com/get-company-by-linkedin-url',
    testParams: { linkedin_url: 'https://www.linkedin.com/company/microsoft/' },
    description: 'LinkedIn profile and company data enrichment',
  },
  {
    host: 'reddit3.p.rapidapi.com',
    name: 'Reddit',
    categories: ['reddit', 'social-media', 'community', 'posts'],
    testEndpoint: 'https://reddit3.p.rapidapi.com/r/popular/hot',
    testParams: { limit: '5' },
    description: 'Reddit subreddits, posts, comments, and search',
  },
  {
    host: 'facebook-scraper3.p.rapidapi.com',
    name: 'Facebook Scraper',
    categories: ['facebook', 'social-media', 'scraper'],
    testEndpoint: 'https://facebook-scraper3.p.rapidapi.com/profile_info',
    testParams: { username: 'facebook' },
    description: 'Facebook public page and profile scraper',
  },

  // ── Search / Web ───────────────────────────────────────────────────────────────
  {
    host: 'google-search72.p.rapidapi.com',
    name: 'Google Search',
    categories: ['search', 'google', 'web-search', 'seo'],
    testEndpoint: 'https://google-search72.p.rapidapi.com/search',
    testParams: { query: 'hello', limit: '5' },
    description: 'Google web search results via RapidAPI',
  },
  {
    host: 'google-web-search1.p.rapidapi.com',
    name: 'Google Web Search',
    categories: ['search', 'google', 'web'],
    testEndpoint: 'https://google-web-search1.p.rapidapi.com/',
    testParams: { query: 'openai', limit: '5', related_keywords: 'false' },
    description: 'Google web search with knowledge graph integration',
  },
  {
    host: 'bing-web-search1.p.rapidapi.com',
    name: 'Bing Web Search',
    categories: ['search', 'bing', 'web-search'],
    testEndpoint: 'https://bing-web-search1.p.rapidapi.com/search',
    testParams: { q: 'artificial intelligence', mkt: 'en-US', safeSearch: 'Off', textDecorations: 'false', textFormat: 'Raw', count: '3' },
    description: 'Bing web search results including web, news, images',
  },
  {
    host: 'domainr.p.rapidapi.com',
    name: 'Domainr',
    categories: ['seo', 'domain', 'dns', 'search'],
    testEndpoint: 'https://domainr.p.rapidapi.com/v2/search',
    testParams: { query: 'openai', client_id: 'rapidapi' },
    description: 'Domain name search and availability checker',
  },

  // ── E-commerce / Shopping ──────────────────────────────────────────────────────
  {
    host: 'amazon-data1.p.rapidapi.com',
    name: 'Amazon Data',
    categories: ['ecommerce', 'amazon', 'shopping', 'products'],
    testEndpoint: 'https://amazon-data1.p.rapidapi.com/search',
    testParams: { query: 'laptop', country: 'US' },
    buildUrl: (p) => ({ url: 'https://amazon-data1.p.rapidapi.com/search', params: { query: p.q || p.query || 'laptop', country: 'US' } }),
    description: 'Amazon product search, prices, reviews, and bestsellers',
  },
  {
    host: 'real-time-product-search.p.rapidapi.com',
    name: 'Real-Time Product Search',
    categories: ['ecommerce', 'shopping', 'products', 'price-comparison'],
    testEndpoint: 'https://real-time-product-search.p.rapidapi.com/search',
    testParams: { q: 'laptop', limit: '3' },
    buildUrl: (p) => ({ url: 'https://real-time-product-search.p.rapidapi.com/search', params: { q: p.q || p.query || 'laptop', limit: p.limit || '10' } }),
    description: 'Product search and price comparison across multiple retailers',
  },
  {
    host: 'ebay.p.rapidapi.com',
    name: 'eBay',
    categories: ['ecommerce', 'ebay', 'auction', 'shopping'],
    testEndpoint: 'https://ebay.p.rapidapi.com/buy/browse/v1/item_summary/search',
    testParams: { q: 'laptop', limit: '3' },
    description: 'eBay product listings, auctions, and buy-it-now items',
  },

  // ── Jobs ───────────────────────────────────────────────────────────────────────
  {
    host: 'jsearch.p.rapidapi.com',
    name: 'JSearch',
    categories: ['jobs', 'employment', 'careers', 'search'],
    testEndpoint: 'https://jsearch.p.rapidapi.com/search',
    testParams: { query: 'software developer', page: '1', num_pages: '1' },
    buildUrl: (p) => ({ url: 'https://jsearch.p.rapidapi.com/search', params: { query: p.q || p.query || 'software developer', page: '1', num_pages: '1' } }),
    description: 'Unified job search across Indeed, Glassdoor, LinkedIn, and more',
  },
  {
    host: 'jobs-api14.p.rapidapi.com',
    name: 'Jobs API 14',
    categories: ['jobs', 'employment', 'remote-work'],
    testEndpoint: 'https://jobs-api14.p.rapidapi.com/list',
    testParams: { query: 'developer', location: 'Remote', distance: '1.0', language: 'en_GB', remoteOnly: 'false', datePosted: 'month', employmentTypes: 'fulltime', index: '0' },
    description: 'Job listings from LinkedIn, Glassdoor, and other major boards',
  },
  {
    host: 'active-jobs-db.p.rapidapi.com',
    name: 'Active Jobs DB',
    categories: ['jobs', 'employment', 'tech-jobs'],
    testEndpoint: 'https://active-jobs-db.p.rapidapi.com/active-ats-7d',
    testParams: { limit: '5', offset: '0' },
    description: 'Active tech job listings from ATS systems, updated daily',
  },

  // ── Education ─────────────────────────────────────────────────────────────────
  {
    host: 'udemy-unofficial.p.rapidapi.com',
    name: 'Udemy (Unofficial)',
    categories: ['education', 'courses', 'learning', 'online-education'],
    testEndpoint: 'https://udemy-unofficial.p.rapidapi.com/courses',
    testParams: { search: 'javascript', is_paid: 'true', rating: '4', page: '1', page_size: '3' },
    description: 'Udemy course search, ratings, and instructor data',
  },
  {
    host: 'dictionary-by-api-ninjas.p.rapidapi.com',
    name: 'Dictionary API',
    categories: ['education', 'dictionary', 'language', 'definitions'],
    testEndpoint: 'https://dictionary-by-api-ninjas.p.rapidapi.com/v1/dictionary',
    testParams: { word: 'eloquent' },
    description: 'English dictionary with definitions, synonyms, and examples',
  },

  // ── Health / Fitness ──────────────────────────────────────────────────────────
  {
    host: 'fitness-calculator.p.rapidapi.com',
    name: 'Fitness Calculator',
    categories: ['health', 'fitness', 'calculator', 'bmi'],
    testEndpoint: 'https://fitness-calculator.p.rapidapi.com/dailycalorie',
    testParams: { age: '25', gender: 'male', height: '175', weight: '75', activitylevel: 'level_1' },
    description: 'BMI, BMR, daily calories, and fitness metrics calculator',
  },
  {
    host: 'exercisedb.p.rapidapi.com',
    name: 'ExerciseDB',
    categories: ['health', 'fitness', 'exercise', 'workout'],
    testEndpoint: 'https://exercisedb.p.rapidapi.com/exercises',
    testParams: { limit: '5', offset: '0' },
    description: 'Exercise database with GIF demos, muscle groups, and equipment',
  },

  // ── Government / Countries ─────────────────────────────────────────────────────
  {
    host: 'countries3.p.rapidapi.com',
    name: 'Countries Info',
    categories: ['government', 'countries', 'geography', 'data'],
    testEndpoint: 'https://countries3.p.rapidapi.com/countries/',
    description: 'Country data — capitals, currencies, languages, flags, regions',
  },
  {
    host: 'restcountries.p.rapidapi.com',
    name: 'REST Countries',
    categories: ['government', 'countries', 'geography'],
    testEndpoint: 'https://restcountries.p.rapidapi.com/v3.1/all',
    description: 'Country info — name, flag, currency, capital, population',
  },
  {
    host: 'world-population.p.rapidapi.com',
    name: 'World Population',
    categories: ['government', 'population', 'demographics'],
    testEndpoint: 'https://world-population.p.rapidapi.com/worldpopulation',
    description: 'World population statistics by country, year, and age group',
  },

  // ── Translation ────────────────────────────────────────────────────────────────
  {
    host: 'google-translate113.p.rapidapi.com',
    name: 'Google Translate',
    categories: ['translation', 'language', 'nlp', 'localization'],
    testEndpoint: 'https://google-translate113.p.rapidapi.com/api/v1/translator/text',
    testMethod: 'POST',
    testBody: { from: 'en', to: 'es', text: 'Hello World' },
    buildUrl: (p) => ({
      url: 'https://google-translate113.p.rapidapi.com/api/v1/translator/text',
      method: 'POST',
      body: { from: p.from || 'en', to: p.to || 'fr', text: p.text || 'Hello' },
    }),
    description: 'Translate text between 100+ languages via Google Translate',
  },
  {
    host: 'deep-translate1.p.rapidapi.com',
    name: 'Deep Translate',
    categories: ['translation', 'language', 'nlp'],
    testEndpoint: 'https://deep-translate1.p.rapidapi.com/language/translate/v2',
    testMethod: 'POST',
    testBody: { q: 'Hello World', source: 'en', target: 'de' },
    description: 'Google Neural Machine Translation for 100+ languages',
  },
  {
    host: 'microsoft-translator-text.p.rapidapi.com',
    name: 'Microsoft Translator',
    categories: ['translation', 'language', 'microsoft'],
    testEndpoint: 'https://microsoft-translator-text.p.rapidapi.com/translate',
    testMethod: 'POST',
    testBody: { texts: [{ Text: 'Hello, how are you?' }] },
    description: 'Microsoft Azure Cognitive Services translation',
  },

  // ── IP / Geolocation ──────────────────────────────────────────────────────────
  {
    host: 'ip-geo-location.p.rapidapi.com',
    name: 'IP Geolocation',
    categories: ['ip', 'geolocation', 'networking', 'security'],
    testEndpoint: 'https://ip-geo-location.p.rapidapi.com/ip/check',
    testParams: { format: 'json', ip: '8.8.8.8' },
    description: 'IP address geolocation — country, city, timezone, ISP',
  },
  {
    host: 'ip-address-location.p.rapidapi.com',
    name: 'IP Address Location',
    categories: ['ip', 'geolocation'],
    testEndpoint: 'https://ip-address-location.p.rapidapi.com/ip',
    testParams: { ip: '8.8.8.8' },
    description: 'Detailed IP address location and organization info',
  },

  // ── Miscellaneous ─────────────────────────────────────────────────────────────
  {
    host: 'barcode-lookup.p.rapidapi.com',
    name: 'Barcode Lookup',
    categories: ['tools', 'barcode', 'ecommerce', 'products'],
    testEndpoint: 'https://barcode-lookup.p.rapidapi.com/v3/products',
    testParams: { barcode: '9780140328721' },
    description: 'Look up product details by UPC, EAN, ISBN barcode',
  },
  {
    host: 'random-user-data.p.rapidapi.com',
    name: 'Random User Data',
    categories: ['tools', 'testing', 'mock-data'],
    testEndpoint: 'https://random-user-data.p.rapidapi.com/user',
    testParams: { count: '3' },
    description: 'Generate random user data for testing and prototyping',
  },
  {
    host: 'jokes-by-api-ninjas.p.rapidapi.com',
    name: 'Jokes API',
    categories: ['tools', 'entertainment', 'jokes'],
    testEndpoint: 'https://jokes-by-api-ninjas.p.rapidapi.com/v1/jokes',
    description: 'Random jokes and humor content via API Ninjas',
  },
  {
    host: 'trivia-by-api-ninjas.p.rapidapi.com',
    name: 'Trivia API',
    categories: ['tools', 'trivia', 'entertainment', 'education'],
    testEndpoint: 'https://trivia-by-api-ninjas.p.rapidapi.com/v1/trivia',
    description: 'Random trivia questions and answers',
  },
  {
    host: 'quotes15.p.rapidapi.com',
    name: 'Quotes API',
    categories: ['tools', 'quotes', 'inspiration'],
    testEndpoint: 'https://quotes15.p.rapidapi.com/Quotes/random/',
    description: 'Famous quotes by author, category, and topic',
  },
  {
    host: 'recipe-by-api-ninjas.p.rapidapi.com',
    name: 'Recipe API',
    categories: ['food', 'recipes', 'cooking'],
    testEndpoint: 'https://recipe-by-api-ninjas.p.rapidapi.com/v1/recipe',
    testParams: { query: 'pasta' },
    description: 'Recipe search with ingredients, instructions, and nutrition',
  },
  {
    host: 'spoonacular-recipe-food-nutrition.p.rapidapi.com',
    name: 'Spoonacular',
    categories: ['food', 'recipes', 'nutrition', 'meal-planning'],
    testEndpoint: 'https://spoonacular-recipe-food-nutrition.p.rapidapi.com/recipes/search',
    testParams: { query: 'pasta', number: '3' },
    description: 'Recipe database, nutrition analysis, and meal planning',
  },
];

/** All unique categories in the registry */
export function allProbeCategories(): string[] {
  return [...new Set(PROBE_REGISTRY.flatMap(e => e.categories))].sort();
}

/** Get entries for a specific category */
export function getProbeEntriesByCategory(category: string): ProbeEntry[] {
  return PROBE_REGISTRY.filter(e => e.categories.includes(category));
}

/** Find an entry by host */
export function getProbeEntryByHost(host: string): ProbeEntry | undefined {
  return PROBE_REGISTRY.find(e => e.host === host);
}
