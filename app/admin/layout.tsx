'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

interface User {
  id: string;
  login: string;
  avatar: string;
}

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const pathname = usePathname();

  useEffect(() => {
    fetch('/api/me').then(r => r.json()).then(data => {
      setLoading(false);
      if (data.authenticated) {
        setUser(data.user);
      }
    });
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="inline-block w-8 h-8 border-4 border-[var(--accent)] border-t-transparent rounded-full animate-spin mb-4"></div>
          <p className="text-[var(--text-muted)]">Loading...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <div className="max-w-md w-full">
          <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-8 text-center shadow-lg">
            <h1 className="text-3xl font-bold mb-4">
              <span className="bg-gradient-to-r from-[#b7642b] to-[#9f5522] bg-clip-text text-transparent">jean-ci Admin</span>
            </h1>
            <p className="text-[var(--text-secondary)] mb-6">Sign in with GitHub to manage PR reviews and deployments.</p>
            <a href="/api/auth/github" className="inline-block bg-[var(--accent)] text-[var(--on-accent)] px-8 py-3 rounded-full font-medium hover:bg-[var(--accent-hover)] transition-colors">
              Sign in with GitHub
            </a>
          </div>
        </div>
      </div>
    );
  }

  const navItems = [
    { href: '/admin', label: 'Overview', icon: '📊' },
    { href: '/admin/repos', label: 'Repositories', icon: '📦' },
    { href: '/admin/reviews', label: 'PR Reviews', icon: '🔍' },
    { href: '/admin/deployments', label: 'Deployments', icon: '🚀' },
    { href: '/admin/tasks', label: 'Tasks', icon: '⏰' },
    { href: '/admin/events', label: 'Events', icon: '📋' },
    { href: '/admin/prompt', label: 'Prompt', icon: '📝' },
  ];

  const isActive = (href: string) => {
    if (href === '/admin') return pathname === '/admin';
    return pathname.startsWith(href);
  };

  return (
    <div className="min-h-screen">
      {/* Top Navigation */}
      <nav className="bg-[var(--bg-card)] border-b border-[var(--border)] sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center gap-8">
              <Link href="/admin" className="text-xl font-bold">
                <span className="bg-gradient-to-r from-[#b7642b] to-[#9f5522] bg-clip-text text-transparent">jean-ci</span>
              </Link>
              <div className="hidden md:flex items-center gap-1">
                {navItems.map(item => (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                      isActive(item.href)
                        ? 'bg-[var(--accent)]/10 text-[var(--accent)]'
                        : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-secondary)]'
                    }`}
                  >
                    <span>{item.icon}</span>
                    {item.label}
                  </Link>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <img src={user.avatar} alt={user.login} className="w-8 h-8 rounded-full" />
                <span className="text-sm font-medium hidden sm:block">{user.login}</span>
              </div>
              <a href="/api/auth/logout" className="text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)]">
                Logout
              </a>
            </div>
          </div>
        </div>
      </nav>

      {/* Mobile Navigation */}
      <div className="md:hidden bg-[var(--bg-card)] border-b border-[var(--border)] px-4 py-2 flex gap-2 overflow-x-auto">
        {navItems.map(item => (
          <Link
            key={item.href}
            href={item.href}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm whitespace-nowrap ${
              isActive(item.href)
                ? 'bg-[var(--accent)]/10 text-[var(--accent)]'
                : 'text-[var(--text-secondary)]'
            }`}
          >
            <span>{item.icon}</span>
            {item.label}
          </Link>
        ))}
      </div>

      {/* Page Content */}
      <main className="max-w-7xl mx-auto px-4 py-8">
        {children}
      </main>
    </div>
  );
}
