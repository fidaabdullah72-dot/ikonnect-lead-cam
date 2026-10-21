'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Building2, KanbanSquare, Plug, UserRound, Users } from 'lucide-react';
import { cn } from '@/lib/utils';

const ITEMS = [
  { href: '/settings/general', label: 'Workspace', icon: Building2 },
  { href: '/settings/team', label: 'Team', icon: Users },
  { href: '/settings/pipeline', label: 'Pipeline stages', icon: KanbanSquare },
  { href: '/settings/integrations', label: 'Integrations', icon: Plug },
  { href: '/settings/profile', label: 'Your profile', icon: UserRound },
];

export function SettingsNav() {
  const pathname = usePathname();
  return (
    <nav className="no-scrollbar flex gap-1 overflow-x-auto lg:flex-col">
      {ITEMS.map(({ href, label, icon: Icon }) => {
        const active = pathname === href;
        return (
          <Link
            key={href}
            href={href}
            className={cn(
              'flex h-8 shrink-0 items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] font-medium transition-colors',
              active ? 'bg-surface text-foreground shadow-sm ring-1 ring-border' : 'text-muted hover:bg-surface-2 hover:text-foreground',
            )}
          >
            <Icon className={cn('size-4', active ? 'text-primary' : 'text-subtle')} />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
