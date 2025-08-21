import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
import { Toaster } from '@/components/ui/sonner';
import { Providers } from '@/app/providers';
import { ThemeProvider } from '@/components/theme-provider';
import { GitHubStars } from '@/components/github-stars';
import AuroraBackground from '@/components/aurora-background';
import { JSX } from 'react';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin']
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin']
});

export const metadata: Metadata = {
  metadataBase: new URL('https://www.querykit.dev/'),
  title: {
    default: 'QueryKit · Next.js Demo',
    template: '%s · QueryKit'
  },
  applicationName: 'QueryKit',
  description:
    'Interactive demo for QueryKit — a type-safe DSL that translates human-friendly filters into Drizzle/SQL for both server and client.',
  keywords: [
    'QueryKit',
    'query dsl',
    'filter language',
    'sql translation',
    'drizzle orm',
    'pglite',
    'typescript',
    'next.js',
    'drizzle',
    'sql',
    'npm',
    'npm-package',
    'nextjs'
  ],
  authors: [{ name: 'gblikas', url: 'https://github.com/gblikas' }],
  creator: 'QueryKit',
  publisher: 'QueryKit',
  category: 'software',
  generator: 'Next.js',
  referrer: 'origin-when-cross-origin',
  formatDetection: {
    email: false,
    address: false,
    telephone: false
  },
  openGraph: {
    title: 'QueryKit · Next.js Demo',
    description:
      'Filter tasks using the QueryKit DSL and inspect the generated SQL and EXPLAIN ANALYZE.',
    url: '/',
    siteName: 'QueryKit',
    locale: 'en_US',
    type: 'website'
  },
  twitter: {
    card: 'summary',
    title: 'QueryKit · Next.js Demo',
    description:
      'Filter tasks using the QueryKit DSL and inspect the generated SQL and EXPLAIN ANALYZE.',
    creator: '@querykit'
  },
  robots: {
    index: true,
    follow: true
  },
  alternates: {
    canonical: '/'
  },
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#0B0B0E' },
    { media: '(prefers-color-scheme: light)', color: '#ffffff' }
  ]
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover'
};

export default function RootLayout({
  children
}: {
  children: React.ReactNode;
}): JSX.Element {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className="min-h-screen overflow-hidden"
    >
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased min-h-screen overflow-hidden`}
      >
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem={false}
          disableTransitionOnChange
        >
          <div className="relative min-h-screen">
            {/* Global Aurora background behind header and content */}
            <div className="fixed inset-0 -z-10 pointer-events-none">
              <AuroraBackground />
            </div>
            <div className="fixed top-3 right-3 z-40">
              <a
                href="https://github.com/gblikas/querykit"
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-9 items-center justify-center gap-2 rounded-md border px-3 text-xs hover:bg-accent transition-colors"
                aria-label="GitHub stars"
              >
                <GitHubStars />
              </a>
            </div>
            <Providers>{children}</Providers>
            <Toaster />
          </div>
        </ThemeProvider>
      </body>
    </html>
  );
}
