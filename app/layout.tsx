import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import './app.css';
import ConfigureAmplify from './components/ConfigureAmplify';
import { AuthProvider } from '@/lib/auth-context';

const inter = Inter({ subsets: ['latin'] });

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  minimumScale: 1,
  maximumScale: 1,
  userScalable: false,
  interactiveWidget: 'resizes-content',
};

export const metadata: Metadata = {
  title: 'DWOMOH Vibe Code — AI App Builder',
  description: 'Build real apps with a single sentence. DWOMOH Vibe Code generates, installs, fixes, and previews full-stack Next.js applications — autonomously.',
  keywords: ['AI app builder', 'DWOMOH', 'Next.js generator', 'no-code', 'vibe code'],
  openGraph: {
    title: 'DWOMOH Vibe Code',
    description: 'Build real apps with a single sentence.',
    type: 'website',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <ConfigureAmplify />
        <AuthProvider>
          {children}
        </AuthProvider>
      </body>
    </html>
  );
}
