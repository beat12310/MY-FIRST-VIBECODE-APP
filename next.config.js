/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // stripe is an optional billing dependency — don't bundle it; require it at runtime
    serverComponentsExternalPackages: ['stripe'],
  },
};

module.exports = nextConfig;
