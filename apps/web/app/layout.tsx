import type { Metadata, Viewport } from 'next';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import { Providers } from '@/components/providers';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Castlane CRM', template: '%s · Castlane' },
  description: 'Internal CRM for AI series, AI models and AI influencer production.',
  robots: { index: false, follow: false },
  icons: { icon: '/favicon.svg', apple: '/apple-touch-icon.png' },
  manifest: '/manifest.webmanifest',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#F5F7F6' },
    { media: '(prefers-color-scheme: dark)', color: '#111715' },
  ],
};

/** Applies the stored theme before paint to avoid a flash of the wrong theme. */
const themeScript = `(function(){try{var t=localStorage.getItem('castlane.theme');if(t==='light'||t==='dark'){document.documentElement.dataset.theme=t}}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
