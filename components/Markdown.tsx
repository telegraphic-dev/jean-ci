'use client';

import ReactMarkdown from 'react-markdown';

interface MarkdownProps {
  content: string;
  className?: string;
}

export function Markdown({ content, className = '' }: MarkdownProps) {
  return (
    <div className={`prose prose-sm prose-invert max-w-none ${className}`}>
      <ReactMarkdown
        components={{
          h1: ({ children }) => <h1 className="text-lg font-bold mt-4 mb-2">{children}</h1>,
          h2: ({ children }) => <h2 className="text-base font-bold mt-3 mb-2">{children}</h2>,
          h3: ({ children }) => <h3 className="text-sm font-bold mt-2 mb-1">{children}</h3>,
          p: ({ children }) => <p className="mb-2 leading-relaxed">{children}</p>,
          ul: ({ children }) => <ul className="list-disc pl-5 mb-2 space-y-1">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal pl-5 mb-2 space-y-1">{children}</ol>,
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          code: ({ className, children }) => {
            const isInline = !className;
            return isInline ? (
              <code className="px-1.5 py-0.5 bg-[var(--bg-card)] border border-[var(--border)] rounded text-xs font-mono text-[var(--accent)]">
                {children}
              </code>
            ) : (
              <code className="block bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-3 text-xs font-mono overflow-x-auto">
                {children}
              </code>
            );
          },
          pre: ({ children }) => <pre className="mb-2">{children}</pre>,
          strong: ({ children }) => <strong className="font-semibold text-[var(--text-primary)]">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-[var(--accent)] pl-3 italic text-[var(--text-secondary)] my-2">
              {children}
            </blockquote>
          ),
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer" className="text-[var(--accent)] hover:underline">
              {children}
            </a>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
