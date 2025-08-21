import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  swcMinify: false,
  transpilePackages: ['@electric-sql/pglite-react', '@electric-sql/pglite']
};

export default nextConfig;
