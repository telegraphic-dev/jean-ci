'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';

interface User {
  id: string;
  login: string;
  avatar: string;
}

function SearchBar() {
  return (
    <div className="relative w-full max-w-xs">
      <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
      </svg>
      <input
        type="text"
        placeholder="Search soon…"
        disabled
        className="w-full pl-10 pr-4 py-1.5 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-muted)] placeholder:text-[var(--text-muted)] opacity-70 cursor-not-allowed"
      />
    </div>
  );
}

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    let cancelled = false;

    fetch('/api/me')
      .then(r => r.json())
      .then(data => {
        if (cancelled) return;
        if (data.authenticated) {
          setUser(data.user);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setUser(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
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
    { href: '/admin/feature-sessions', label: 'Feature Sessions', icon: '🌳' },
    { href: '/admin/reviews', label: 'PR Reviews', icon: '🔍' },
    { href: '/admin/deployments', label: 'Deployments', icon: '🚀' },
    { href: '/admin/tasks', label: 'Scheduled Tasks', icon: '⏰' },
    { href: '/admin/events', label: 'Events', icon: '📋' },
    { href: '/admin/gateway', label: 'Gateway', icon: '🔌' },
    { href: '/admin/prompt', label: 'Prompt', icon: '📝' },
  ];

  const userLogin = user?.login ?? 'GitHub user';
  const userAvatar = user?.avatar ?? '';

  const isActive = (href: string) => {
    if (href === '/admin') return pathname === '/admin';
    return pathname.startsWith(href);
  };

  const generateBreadcrumbs = () => {
    const parts = pathname.split('/').filter(Boolean);
    const crumbs: { label: string; href: string }[] = [];
    let currentPath = '';

    for (const part of parts) {
      currentPath += `/${part}`;
      if (part === 'admin') continue;

      let label = part
        .split('-')
        .map(segment => segment.charAt(0).toUpperCase() + segment.slice(1))
        .join(' ');

      if (label.length > 40) label = `${label.slice(0, 37)}...`;
      crumbs.push({ label, href: currentPath });
    }

    return crumbs;
  };

  const breadcrumbs = generateBreadcrumbs();

  return (
    <div className="flex min-h-screen bg-[var(--bg-primary)]">
      <aside className={`fixed md:sticky top-0 left-0 h-screen w-64 bg-[var(--bg-card)] border-r border-[var(--border)] z-40 transform transition-transform duration-200 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}`}>
        <div className="px-4 py-3 border-b border-[var(--border)]">
          <Link href="/admin" className="flex items-center gap-2 text-lg font-bold">
            <span className="bg-gradient-to-r from-[#b7642b] to-[#9f5522] bg-clip-text text-transparent">jean-ci</span>
          </Link>
        </div>

        <nav className="p-4 space-y-1">
          {navItems.map(item => (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setSidebarOpen(false)}
              className={`flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm font-medium transition-colors ${
                isActive(item.href)
                  ? 'bg-[var(--accent)] text-[var(--on-accent)]'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              <span className="text-lg">{item.icon}</span>
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="absolute bottom-0 left-0 right-0 p-4 border-t border-[var(--border)] space-y-3">
          <div className="flex items-center gap-3 px-4">
            {userAvatar ? (
              <Image src={userAvatar} alt={userLogin} width={36} height={36} className="w-9 h-9 rounded-full" unoptimized />
            ) : (
              <div className="w-9 h-9 rounded-full bg-[var(--bg-secondary)] border border-[var(--border)] flex items-center justify-center text-sm text-[var(--text-muted)]">
                👤
              </div>
            )}
            <div className="min-w-0">
              <div className="text-sm font-medium text-[var(--text-primary)] truncate">{userLogin}</div>
              <div className="text-xs text-[var(--text-muted)]">GitHub account</div>
            </div>
          </div>
          <a href="/api/auth/logout" className="flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm font-medium text-[var(--text-muted)] hover:bg-[var(--bg-secondary)] hover:text-[var(--red)] transition-colors">
            <span className="text-lg">🚪</span>
            Logout
          </a>
        </div>
      </aside>

      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-30 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <main className="flex-1 overflow-y-auto min-w-0">
        <div className="sticky top-0 z-20 bg-[var(--bg-primary)]/80 backdrop-blur-xl border-b border-[var(--border)] px-4 md:px-8 py-3">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-4 min-w-0">
              <button
                onClick={() => setSidebarOpen(true)}
                className="md:hidden p-2 text-[var(--text-secondary)] hover:text-[var(--text-primary)] shrink-0"
                aria-label="Open menu"
              >
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <line x1="3" y1="6" x2="21" y2="6" />
                  <line x1="3" y1="12" x2="21" y2="12" />
                  <line x1="3" y1="18" x2="21" y2="18" />
                </svg>
              </button>

              <nav className="flex items-center gap-2 text-sm overflow-x-auto whitespace-nowrap">
                <Link href="/admin" className="text-[var(--text-secondary)] hover:text-[var(--accent)] transition-colors">Admin</Link>
                {breadcrumbs.map((crumb, idx) => (
                  <div key={crumb.href} className="flex items-center gap-2">
                    <span className="text-[var(--text-muted)]">/</span>
                    {idx === breadcrumbs.length - 1 ? (
                      <span className="text-[var(--text-primary)] font-medium">{crumb.label}</span>
                    ) : (
                      <Link href={crumb.href} className="text-[var(--text-secondary)] hover:text-[var(--accent)] transition-colors">
                        {crumb.label}
                      </Link>
                    )}
                  </div>
                ))}
              </nav>
            </div>

            <div className="hidden sm:block shrink-0">
              <SearchBar />
            </div>
          </div>
        </div>

        <div className="w-full px-4 md:px-8 py-8">
          <div className="max-w-7xl mx-auto w-full">
            {children}
          </div>
        </div>
      </main>
    </div>
  );
}
