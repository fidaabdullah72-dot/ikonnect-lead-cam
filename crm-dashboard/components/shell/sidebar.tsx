'use client';

import * as React from 'react';
import Link, { useLinkStatus } from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useTheme } from 'next-themes';
import { Check, ChevronsUpDown, LoaderCircle, LogOut, Monitor, Moon, Plus, Sun, UserRound } from 'lucide-react';
import { ROLE_LABELS } from '@batsols/shared';
import { Logo } from '@/components/brand';
import { Avatar } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Tooltip,
} from '@/components/ui/menu';
import { getSupabase } from '@/lib/supabase/client';
import { qk, useAccounts, useEngineStatus, useRealtime } from '@/lib/queries';
import { useWorkspace } from '@/lib/workspace';
import { cn, timeAgo } from '@/lib/utils';
import { switchWorkspace } from '@/app/(app)/actions';
import { NAV, SETTINGS_ITEM, type NavItem } from './nav';

function useShellCounts() {
  const { workspace, userId } = useWorkspace();
  const inboxKey = [...qk.conversations(workspace.id), 'unread'];
  useRealtime('conversations', `workspace_id=eq.${workspace.id}`, [inboxKey]);
  const inbox = useQuery({
    queryKey: inboxKey,
    queryFn: async () => {
      const { data } = await getSupabase()
        .from('conversations')
        .select('unread_count')
        .eq('workspace_id', workspace.id)
        .gt('unread_count', 0)
        .limit(1000);
      return (data ?? []).reduce((s, c) => s + c.unread_count, 0);
    },
    refetchInterval: 60_000,
  });
  const tasks = useQuery({
    queryKey: [...qk.tasks(workspace.id), 'due-count', userId],
    queryFn: async () => {
      const end = new Date();
      end.setHours(23, 59, 59, 999);
      const { count } = await getSupabase()
        .from('tasks')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspace.id)
        .eq('assignee_id', userId)
        .is('completed_at', null)
        .lte('due_at', end.toISOString());
      return count ?? 0;
    },
    refetchInterval: 5 * 60_000,
  });
  const chatKey = ['chat-channels', workspace.id];
  const chat = useQuery({
    queryKey: [...chatKey, 'unread'],
    queryFn: async () => {
      const { data } = await getSupabase().rpc('chat_overview', { p_workspace: workspace.id });
      return ((data ?? []) as Array<{ unread: number }>).reduce((s, c) => s + c.unread, 0);
    },
    refetchInterval: 30_000,
  });
  useRealtime('chat_messages', `workspace_id=eq.${workspace.id}`, [[...chatKey, 'unread']]);
  return { inbox: inbox.data ?? 0, tasks: tasks.data ?? 0, chat: chat.data ?? 0 };
}

/** The item's icon, swapped for a spinner while its page is opening. */
function NavIcon({ icon: Icon, active }: { icon: NavItem['icon']; active: boolean }) {
  const { pending } = useLinkStatus();
  if (pending) return <LoaderCircle className="size-4 shrink-0 animate-spin text-primary" />;
  return <Icon className={cn('size-4 shrink-0', active ? 'text-primary' : 'text-subtle group-hover:text-muted')} />;
}

function NavLink({ item, counts, waState, onNavigate }: { item: NavItem; counts: { inbox: number; tasks: number; chat: number }; waState: 'ok' | 'warn' | 'none'; onNavigate?: () => void }) {
  const pathname = usePathname();
  const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
  const badge = item.badge ? counts[item.badge] : 0;
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      className={cn(
        'group relative flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] font-medium transition-colors',
        active ? 'bg-surface text-foreground shadow-sm ring-1 ring-border' : 'text-muted hover:bg-surface-2/70 hover:text-foreground',
      )}
    >
      <NavIcon icon={Icon} active={active} />
      <span className="truncate">{item.label}</span>
      {badge > 0 && (
        <span
          className={cn(
            'tabular ml-auto rounded-full px-1.5 text-[11px] font-semibold leading-[18px]',
            item.badge === 'inbox' ? 'bg-whatsapp-bright text-black/80' : 'bg-primary text-white',
          )}
        >
          {badge > 99 ? '99+' : badge}
        </span>
      )}
      {item.status === 'whatsapp' && waState !== 'none' && (
        <span className={cn('ml-auto size-2 rounded-full', waState === 'ok' ? 'bg-whatsapp-bright' : 'bg-warning animate-pulse-ring')} />
      )}
    </Link>
  );
}

function WorkspaceSwitcher() {
  const { workspace, workspaces, role } = useWorkspace();
  const router = useRouter();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-surface-2/70">
          <Avatar name={workspace.name} size="md" square />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13.5px] font-semibold leading-tight">{workspace.name}</div>
            <div className="text-xs text-subtle">{ROLE_LABELS[role]}</div>
          </div>
          <ChevronsUpDown className="size-3.5 text-subtle" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
        {workspaces.map((w) => (
          <DropdownMenuItem
            key={w.id}
            onSelect={async () => {
              if (w.id === workspace.id) return;
              await switchWorkspace(w.id);
              router.push('/dashboard');
              router.refresh();
            }}
          >
            <Avatar name={w.name} size="xs" square />
            <span className="truncate">{w.name}</span>
            {w.id === workspace.id && <Check className="ml-auto !text-primary" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => router.push('/onboarding')}>
          <Plus /> New workspace
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function UserMenu() {
  const { profile, email } = useWorkspace();
  const { theme, setTheme } = useTheme();
  const router = useRouter();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-surface-2/70">
          <Avatar name={profile.full_name || email} src={profile.avatar_url} size="sm" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium leading-tight">{profile.full_name || 'You'}</div>
            <div className="truncate text-[11.5px] text-subtle">{email}</div>
          </div>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-60">
        <DropdownMenuItem onSelect={() => router.push('/settings/profile')}>
          <UserRound /> Profile
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        {[
          { v: 'dark', label: 'Dark', icon: Moon },
          { v: 'light', label: 'Light', icon: Sun },
          { v: 'system', label: 'System', icon: Monitor },
        ].map(({ v, label, icon: Icon }) => (
          <DropdownMenuItem key={v} onSelect={() => setTheme(v)}>
            <Icon /> {label}
            {theme === v && <Check className="ml-auto !text-primary" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          danger
          onSelect={async () => {
            await getSupabase().auth.signOut();
            router.replace('/login');
            router.refresh();
          }}
        >
          <LogOut /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function EngineIndicator() {
  const { online, status, isLoading } = useEngineStatus();
  if (isLoading) return null;
  const tip = online
    ? `Engine online · ${status?.info?.connected ?? 0} WhatsApp connected`
    : status?.heartbeat_at
      ? `Engine offline since ${timeAgo(status.heartbeat_at)}. Campaigns, scraping and WhatsApp are paused until it’s back.`
      : 'Engine has not started yet. Start the engine service to send messages and scrape.';
  return (
    <Tooltip content={tip} side="right">
      <div className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-subtle">
        <span className="relative flex size-2">
          {online && <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-50" />}
          <span className={cn('relative inline-flex size-2 rounded-full', online ? 'bg-success' : 'bg-danger')} />
        </span>
        {online ? 'Engine online' : 'Engine offline'}
      </div>
    </Tooltip>
  );
}

export function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const counts = useShellCounts();
  const { accounts } = useAccounts();
  const { userId, can } = useWorkspace();
  const mine = accounts.filter((a) => a.owner_id === userId);
  const waState: 'ok' | 'warn' | 'none' = !mine.length ? 'none' : mine.every((a) => a.status === 'connected') ? 'ok' : 'warn';

  return (
    <div className="flex h-full flex-col gap-2 px-3 py-3">
      <div className="flex items-center justify-between px-2 pb-1 pt-1">
        <Logo />
      </div>
      <WorkspaceSwitcher />
      <nav className="no-scrollbar mt-2 flex-1 space-y-5 overflow-y-auto">
        {NAV.map((g, i) => (
          <div key={g.group ?? i} className="space-y-0.5">
            {g.group && <div className="px-2.5 pb-1 text-[11px] font-medium uppercase tracking-wider text-subtle">{g.group}</div>}
            {g.items
              .filter((item) => !item.requires || can[item.requires])
              .map((item) => (
                <NavLink key={item.href} item={item} counts={counts} waState={waState} onNavigate={onNavigate} />
              ))}
          </div>
        ))}
      </nav>
      <div className="space-y-0.5 border-t border-border pt-2">
        <NavLink item={SETTINGS_ITEM} counts={counts} waState="none" onNavigate={onNavigate} />
        <EngineIndicator />
        <UserMenu />
      </div>
    </div>
  );
}
