'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Dialog as D } from 'radix-ui';
import { MapPin, Menu, Plus, Search, Send, Smartphone, UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/controls';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/menu';
import { useWorkspace } from '@/lib/workspace';
import { cn } from '@/lib/utils';
import { SidebarContent } from './sidebar';
import { NotificationsBell } from './notifications';
import { CommandPalette, openCommandPalette } from './command-palette';
import { NavProgress } from './nav-progress';

function QuickCreate() {
  const router = useRouter();
  const { can } = useWorkspace();
  if (!can.write) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="primary" size="sm">
          <Plus /> <span className="hidden sm:inline">New</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56">
        <DropdownMenuItem onSelect={() => router.push('/leads?new=1')}>
          <Plus /> Lead
        </DropdownMenuItem>
        {can.scrape && (
          <DropdownMenuItem onSelect={() => router.push('/scraper?new=1')}>
            <MapPin /> Lead search (Google Maps)
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={() => router.push('/campaigns/new')}>
          <Send /> Campaign
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => router.push('/whatsapp?connect=1')}>
          <Smartphone /> WhatsApp number
        </DropdownMenuItem>
        {can.admin && (
          <DropdownMenuItem onSelect={() => router.push('/settings/team?invite=1')}>
            <UserPlus /> Teammate
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = React.useState(false);

  return (
    <div className="flex h-dvh overflow-hidden bg-background">
      <React.Suspense fallback={null}>
        <NavProgress />
      </React.Suspense>
      <aside className="hidden w-[248px] shrink-0 lg:block">
        <SidebarContent />
      </aside>

      <D.Root open={mobileOpen} onOpenChange={setMobileOpen}>
        <D.Portal>
          <D.Overlay className="fixed inset-0 z-50 bg-overlay data-[state=open]:animate-fade-in lg:hidden" />
          <D.Content aria-describedby={undefined} className="fixed inset-y-0 left-0 z-50 w-[272px] border-r border-border bg-background shadow-lg data-[state=open]:animate-fade-in lg:hidden">
            <D.Title className="sr-only">Navigation</D.Title>
            <SidebarContent onNavigate={() => setMobileOpen(false)} />
          </D.Content>
        </D.Portal>
      </D.Root>

      <div className="flex min-w-0 flex-1 flex-col lg:py-2 lg:pr-2">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-panel lg:rounded-2xl lg:border lg:border-border lg:shadow-sm">
          <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-3 sm:px-5">
            <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Open navigation">
              <Menu />
            </Button>
            <button
              onClick={openCommandPalette}
              className="group flex h-8 w-full max-w-[420px] items-center gap-2 rounded-lg border border-border bg-surface px-3 text-[13px] text-subtle shadow-sm transition-colors hover:border-border-strong hover:text-muted"
            >
              <Search className="size-3.5" />
              <span className="truncate">Search leads, pages, actions…</span>
              <span className="ml-auto hidden items-center gap-0.5 sm:flex">
                <Kbd>⌘</Kbd>
                <Kbd>K</Kbd>
              </span>
            </button>
            <div className="ml-auto flex items-center gap-1.5">
              <NotificationsBell />
              <QuickCreate />
            </div>
          </header>
          <main id="main" className={cn('relative min-h-0 flex-1 overflow-y-auto')}>
            {children}
          </main>
        </div>
      </div>
      <CommandPalette />
    </div>
  );
}

/** Standard padded page container. Full-bleed pages (inbox, pipeline) skip it. */
export function Page({ children, className, wide }: { children: React.ReactNode; className?: string; wide?: boolean }) {
  return <div className={cn('mx-auto w-full px-4 py-6 sm:px-8 sm:py-8', wide ? 'max-w-[1600px]' : 'max-w-[1320px]', className)}>{children}</div>;
}
