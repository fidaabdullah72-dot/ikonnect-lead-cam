'use client';

import * as React from 'react';
import { usePathname, useSearchParams } from 'next/navigation';

/**
 * A thin bar at the top of the window from the moment a link is clicked until
 * the next page is on screen, so a slow page never feels like a dead click.
 */
export function NavProgress() {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const here = `${pathname}?${search}`;
  // The URL we were on when a link was clicked; the bar shows until the URL changes.
  const [leaving, setLeaving] = React.useState<string | null>(null);
  const loading = leaving === here;

  React.useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download')) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      setLeaving(`${window.location.pathname}?${window.location.search.replace(/^\?/, '')}`);
      clearTimeout(timer);
      timer = setTimeout(() => setLeaving(null), 20_000); // never stick around if a navigation is abandoned
    };
    document.addEventListener('click', onClick, true);
    return () => {
      document.removeEventListener('click', onClick, true);
      clearTimeout(timer);
    };
  }, []);

  return (
    <div aria-hidden className={`pointer-events-none fixed inset-x-0 top-0 z-[60] h-[3px] transition-opacity duration-300 ${loading ? 'opacity-100' : 'opacity-0'}`}>
      {loading && <div className="nav-progress h-full w-full bg-gradient-to-r from-[#6366f1] via-[#3b82f6] to-[#06b6d4] shadow-[0_0_8px_rgba(59,130,246,0.6)]" />}
    </div>
  );
}
