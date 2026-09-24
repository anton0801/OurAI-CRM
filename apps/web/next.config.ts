import type { NextConfig } from 'next';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// The monorepo keeps one .env at the root; load it for `next dev/build/start` (existing env wins).
if (existsSync(join(root, '.env'))) process.loadEnvFile(join(root, '.env'));

const isDev = process.env.NODE_ENV !== 'production';

/** Content Security Policy: no unsafe-eval in production, same-origin connections only. */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self'",
  "connect-src 'self'" + (isDev ? ' ws: wss:' : ''),
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
].join('; ');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Do not generate AGENTS.md / CLAUDE.md into the app directory.
  agentRules: false,
  poweredByHeader: false,
  // A separate build directory lets the e2e server run next to a development server.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  output: 'standalone',
  outputFileTracingRoot: root,
  turbopack: { root },
  transpilePackages: [
    '@castlane/analytics',
    '@castlane/api-client',
    '@castlane/api-contracts',
    '@castlane/application',
    '@castlane/authorization',
    '@castlane/database',
    '@castlane/domain',
    '@castlane/notifications',
    '@castlane/storage',
    '@castlane/ui',
  ],
  serverExternalPackages: ['pg', '@node-rs/argon2', 'sharp', 'pdfkit', 'exceljs', 'archiver', 'nodemailer', 'qrcode'],
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
          ...(isDev ? [] : [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' }]),
        ],
      },
    ];
  },
};

export default nextConfig;
