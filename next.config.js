const path = require('path');

module.exports = {
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
  serverExternalPackages: ['better-sqlite3'],
  images: { remotePatterns: [{ protocol: 'https', hostname: '**' }] },
  webpack: (config, { dev }) => {
    config.resolve.alias['@'] = path.resolve(process.cwd());
    if (!dev) config.devtool = false;
    config.watchOptions = {
      ...(config.watchOptions ?? {}),
      ignored: [
        '**/node_modules/**',
        '**/generated-projects/**',
        '**/.dwomoh/**',
        '**/public/browser-screenshots/**',
      ],
    };
    return config;
  },
  experimental: {
    // Exclude build-only packages from Lambda trace so output stays under 230MB Amplify limit
    outputFileTracingExcludes: {
      '*': [
        'node_modules/@swc/core*/**',
        'node_modules/@next/swc*/**',
        'node_modules/typescript/lib/**',
        'node_modules/webpack/**',
        'node_modules/eslint/**',
        'node_modules/@eslint/**',
        'node_modules/postcss/**',
        'node_modules/esbuild/**',
        'node_modules/@esbuild/**',
        'node_modules/terser/**',
        'node_modules/puppeteer/**',
        'node_modules/playwright/**',
        'node_modules/sharp/**',
        'node_modules/better-sqlite3/build/**',
        'node_modules/.cache/**',
        '.next/cache/**',
      ],
    },
  },
};
