import type { ReactNode } from 'react';
import { useEffect } from 'react';

/** The plain page around public screens: no sidebar, no sign-in, comfortable on a phone. */
export function PublicFrame({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  useEffect(() => { document.title = `${title} · Book online`; }, [title]);
  return (
    <div className="min-h-dvh bg-bg text-fg">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto max-w-2xl px-4 py-5"><h1 className="text-xl font-semibold">{title}</h1>{subtitle && <p className="text-sm text-muted">{subtitle}</p>}</div>
      </header>
      <main className="mx-auto max-w-2xl px-4 py-6">{children}</main>
    </div>
  );
}
