import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: [
    '@electric-sql/pglite-react',
    '@electric-sql/pglite',
    '@gblikas/querykit'
  ]
};

export default nextConfig;
