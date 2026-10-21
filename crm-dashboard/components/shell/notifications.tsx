'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, CheckCheck, MessageCircle, Send, UserPlus, MapPin, Smartphone, ListTodo } from 'lucide-react';
import { toast } from 'sonner';
import type { Notification } from '@batsols/shared';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/menu';
import { EmptyState } from '@/components/ui/feedback';
import { getSupabase } from '@/lib/supabase/client';
import { qk, useRealtime } from '@/lib/queries';
import { useWorkspace } from '@/lib/workspace';
import { cn, timeAgo } from '@/lib/utils';

const ICONS: Record<string, React.ElementType> = {
  reply: MessageCircle,
  campaign_completed: Send,
  campaign_paused: Send,
  lead_assigned: UserPlus,
  task_assigned: ListTodo,
  scrape_completed: MapPin,
  scrape_failed: MapPin,
  whatsapp_disconnected: Smartphone,
  whatsapp_connected: Smartphone,
};

export function NotificationsBell() {
  const { workspace, userId } = useWorkspace();
  const qc = useQueryClient();
  const key = qk.notifications(workspace.id, userId);
  const [open, setOpen] = React.useState(false);

  useRealtime('notifications', `user_id=eq.${userId}`, [key], (p) => {
    if (p.eventType === 'INSERT' && p.new.workspace_id === workspace.id) {
      const n = p.new as unknown as Notification;
      toast(n.title, { description: n.body ?? undefined, action: n.link ? { label: 'Open', onClick: () => (window.location.href = n.link!) } : undefined });
    }
  });

  const { data = [] } = useQuery({
    queryKey: key,
    queryFn: async () => {
      const { data, error } = await getSupabase()
        .from('notifications')
        .select('*')
        .eq('workspace_id', workspace.id)
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(40);
      if (error) throw error;
      return data as Notification[];
    },
  });
  const unread = data.filter((n) => !n.read_at).length;

  async function markAllRead() {
    await getSupabase()
      .from('notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('workspace_id', workspace.id)
      .eq('user_id', userId)
      .is('read_at', null);
    qc.invalidateQueries({ queryKey: key });
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Notifications" className="relative">
          <Bell />
          {unread > 0 && (
            <span className="absolute right-1 top-1 flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-4 text-white ring-2 ring-panel">
              {unread > 9 ? '9+' : unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[380px] p-0">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="text-[14px] font-semibold">Notifications</div>
          {unread > 0 && (
            <Button variant="ghost" size="xs" onClick={markAllRead}>
              <CheckCheck /> Mark all read
            </Button>
          )}
        </div>
        <div className="max-h-[420px] overflow-y-auto">
          {data.length === 0 ? (
            <EmptyState compact icon={<Bell />} title="You’re all caught up" description="Replies, finished campaigns and assignments show up here." />
          ) : (
            data.map((n) => {
              const Icon = ICONS[n.type] ?? Bell;
              const body = (
                <div className={cn('flex gap-3 border-b border-border px-4 py-3 last:border-0 hover:bg-surface-2/60', !n.read_at && 'bg-primary-soft/40')}>
                  <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted">
                    <Icon className="size-3.5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <div className="text-[13px] font-medium">{n.title}</div>
                      {!n.read_at && <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" />}
                    </div>
                    {n.body && <div className="line-clamp-2 text-[12.5px] text-muted">{n.body}</div>}
                    <div className="mt-1 text-[11px] text-subtle">{timeAgo(n.created_at)}</div>
                  </div>
                </div>
              );
              return n.link ? (
                <Link
                  key={n.id}
                  href={n.link}
                  onClick={() => {
                    setOpen(false);
                    if (!n.read_at) {
                      void getSupabase().from('notifications').update({ read_at: new Date().toISOString() }).eq('id', n.id).then(() => qc.invalidateQueries({ queryKey: key }));
                    }
                  }}
                >
                  {body}
                </Link>
              ) : (
                <div key={n.id}>{body}</div>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
