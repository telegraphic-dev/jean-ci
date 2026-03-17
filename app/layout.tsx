import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'jean-ci | OpenClaw review buddy for pull requests',
  description: 'Human-first pull request reviews, copyable OpenClaw prompts, and GitHub checks that teams can act on.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
