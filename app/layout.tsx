import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'jean-ci - LLM-Powered CI',
  description: 'Automated pull request reviews with intelligent code analysis',
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
