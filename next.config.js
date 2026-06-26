const path = require('path');

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ['stripe'],
    outputFileTracingRoot: path.join(__dirname),
  },
  webpack: (config, { dev }) => {
    if (!dev) {
      config.devtool = false;
    }
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
};

module.exports = nextConfig;
