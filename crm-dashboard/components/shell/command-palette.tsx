'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Command } from 'cmdk';
import { Dialog as D } from 'radix-ui';
import { useTheme } from 'next-themes';
import { Building2, MapPin, Moon, Plus, Search, Send, Smartphone, UserPlus, Users } from 'lucide-react';
import { formatPhone } from '@batsols/shared';
import { Kbd } from '@/components/ui/controls';
import { getSupabase } from '@/lib/supabase/client';
import { useWorkspace } from '@/lib/workspace';
import { ALL_NAV_ITEMS } from './nav';

export const openCommandPalette = () => window.dispatchEvent(new Event('bs:command-palette'));

const groupClass =
  '[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-2 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-subtle';

type LeadHit = { id: string; business_name: string; phone: string | null; city: string | null };

export function CommandPalette() {
  const router = useRouter();
  const { workspace, can } = useWorkspace();
  const { resolvedTheme, setTheme } = useTheme();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [leads, setLeads] = React.useState<LeadHit[]>([]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('bs:command-palette', onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('bs:command-palette', onOpen);
    };
  }, []);

  React.useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setLeads([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      const { data } = await getSupabase()
        .rpc('filtered_leads', { p_workspace: workspace.id, p_filters: { q } })
        // PostgREST can only sort an RPC result by columns it returns.
        .select('id, business_name, phone, city, score')
        .order('score', { ascending: false })
        .limit(6);
      if (!cancelled) setLeads((data ?? []) as LeadHit[]);
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, workspace.id]);

  const go = (href: string) => {
    setOpen(false);
    setQuery('');
    router.push(href);
  };

  const q = query.trim().toLowerCase();
  const match = (text: string) => !q || text.toLowerCase().includes(q);

  const actions = [
    can.write && { label: 'Add a lead', icon: Plus, href: '/leads?new=1', keywords: 'create new contact' },
    can.scrape && { label: 'Find leads on Google Maps', icon: MapPin, href: '/scraper?new=1', keywords: 'scrape search' },
    can.write && { label: 'New campaign', icon: Send, href: '/campaigns/new', keywords: 'create broadcast' },
    can.write && { label: 'Connect a WhatsApp number', icon: Smartphone, href: '/whatsapp?connect=1', keywords: 'qr scan link' },
    can.admin && { label: 'Invite a teammate', icon: UserPlus, href: '/settings/team?invite=1', keywords: 'member add user' },
  ].filter(Boolean) as Array<{ label: string; icon: React.ElementType; href: string; keywords: string }>;

  const itemClass =
    'flex h-10 cursor-default items-center gap-3 rounded-lg px-3 text-[13.5px] text-foreground data-[selected=true]:bg-surface-2 [&_svg]:size-4 [&_svg]:text-muted';

  const pages = ALL_NAV_ITEMS.filter((i) => (!i.requires || can[i.requires]) && match(`${i.label} ${i.keywords ?? ''}`));
  const shownActions = actions.filter((a) => match(`${a.label} ${a.keywords}`));

  return (
    <D.Root open={open} onOpenChange={setOpen}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-overlay backdrop-blur-[2px] data-[state=open]:animate-fade-in" />
        <D.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-[14vh] z-50 w-[calc(100vw-32px)] max-w-[600px] -translate-x-1/2 overflow-hidden rounded-2xl border border-border bg-surface shadow-lg data-[state=open]:animate-scale-in"
        >
          <D.Title className="sr-only">Command palette</D.Title>
          <Command shouldFilter={false} loop>
            <div className="flex items-center gap-3 border-b border-border px-4">
              <Search className="size-4 text-subtle" />
              <Command.Input
                value={query}
                onValueChange={setQuery}
                placeholder="Search leads, pages and actions…"
                className="h-14 flex-1 bg-transparent text-[15px] outline-none placeholder:text-subtle"
              />
              <Kbd>Esc</Kbd>
            </div>
            <Command.List className="max-h-[min(60vh,440px)] overflow-y-auto p-2">
              <Command.Empty className="py-10 text-center text-[13px] text-subtle">No results for “{query}”.</Command.Empty>
              {leads.length > 0 && (
                <Command.Group heading="Leads" className={groupClass}>
                  {leads.map((l) => (
                    <Command.Item key={l.id} value={`lead-${l.id}`} onSelect={() => go(`/leads?lead=${l.id}`)} className={itemClass}>
                      <Building2 />
                      <span className="truncate">{l.business_name}</span>
                      <span className="ml-auto truncate text-xs text-subtle">{[l.city, formatPhone(l.phone)].filter(Boolean).join(' · ')}</span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              {shownActions.length > 0 && (
                <Command.Group heading="Quick actions" className={groupClass}>
                  {shownActions.map((a) => (
                    <Command.Item key={a.href} value={a.label} onSelect={() => go(a.href)} className={itemClass}>
                      <a.icon />
                      {a.label}
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              {pages.length > 0 && (
                <Command.Group heading="Go to" className={groupClass}>
                  {pages.map((p) => (
                    <Command.Item key={p.href} value={p.label} onSelect={() => go(p.href)} className={itemClass}>
                      <p.icon />
                      {p.label}
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              {match('theme dark light mode') && (
                <Command.Group heading="Preferences" className={groupClass}>
                  <Command.Item
                    value="toggle theme"
                    onSelect={() => {
                      setTheme(resolvedTheme === 'dark' ? 'light' : 'dark');
                      setOpen(false);
                    }}
                    className={itemClass}
                  >
                    <Moon />
                    Switch to {resolvedTheme === 'dark' ? 'light' : 'dark'} mode
                  </Command.Item>
                </Command.Group>
              )}
            </Command.List>
            <div className="flex items-center gap-4 border-t border-border bg-surface-2/50 px-4 py-2 text-[11.5px] text-subtle">
              <span className="flex items-center gap-1.5">
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd> navigate
              </span>
              <span className="flex items-center gap-1.5">
                <Kbd>↵</Kbd> open
              </span>
              <span className="ml-auto flex items-center gap-1.5">
                <Users className="size-3" /> {workspace.name}
              </span>
            </div>
          </Command>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
