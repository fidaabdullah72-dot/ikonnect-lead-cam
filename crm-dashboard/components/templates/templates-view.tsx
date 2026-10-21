'use client';

import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Copy, FileText, Globe2, Lock, MoreHorizontal, Pencil, Plus, Search, Share2, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { TEMPLATE_VARIABLE_KEYS, lintTemplate, type MessageTemplate } from '@batsols/shared';
import { Page } from '@/components/shell/app-shell';
import { ShareDialog } from '@/components/access/share-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Segmented } from '@/components/ui/controls';
import { Dialog, DialogBody, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { EmptyState, Skeleton, useConfirm } from '@/components/ui/feedback';
import { Field, Input, NativeSelect } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/layout';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/menu';
import { MessageEditor } from '@/components/messaging/message-editor';
import { MediaPicker, type Media } from '@/components/messaging/media-picker';
import { useTemplates } from '@/components/whatsapp/chat';
import { getSupabase } from '@/lib/supabase/client';
import { qk, useMembers } from '@/lib/queries';
import { useWorkspace } from '@/lib/workspace';
import { errorMessage, timeAgo } from '@/lib/utils';

export const TEMPLATE_CATEGORIES = [
  { value: 'opener', label: 'First message' },
  { value: 'follow_up', label: 'Follow-up' },
  { value: 'reply', label: 'Quick reply' },
  { value: 'offer', label: 'Offer / pricing' },
  { value: 'meeting', label: 'Meeting' },
  { value: 'general', label: 'General' },
];

const STARTERS: Array<{ name: string; category: string; body: string }> = [
  {
    name: 'Website pitch (no website)',
    category: 'opener',
    body: '{Hi|Hello|Assalam o Alaikum} {{business_name}} {team|}! I came across your listing on Google Maps{ in {{city}}|}. {I noticed|It looks like} you don’t have a website yet — {customers often check one before calling|a website helps new customers trust you}. We build {fast, affordable|professional} websites for {{category|local businesses}}. {Would you like to see a few examples?|Can I send you some recent examples?}',
  },
  {
    name: 'Chatbot pitch (has website)',
    category: 'opener',
    body: '{Hi|Hello} {{business_name}}! {I had a look at|I visited} {{website}} — {nice work|great site}. {Quick idea:|One suggestion:} an AI chat assistant can answer visitors 24/7 and capture leads while you sleep. {Would a 2-minute demo be useful?|Want me to show you how it would look on your site?}',
  },
  {
    name: 'Gentle follow-up',
    category: 'follow_up',
    body: '{Hi again|Just following up}, {{business_name}} — {did you get a chance to see my last message?|any thoughts on my message above?} {Happy to share examples|No pressure at all}, {{sender_name}}',
  },
  {
    name: 'Book a call',
    category: 'meeting',
    body: 'Great! {Would|Does} {tomorrow|later this week} {work|suit you} for a quick 10-minute call? {Just share a time that’s convenient.|Let me know a time and I’ll call you.}',
  },
];

export function TemplatesView() {
  const { workspace, userId, can } = useWorkspace();
  const { data: templates = [], isLoading } = useTemplates();
  const { byId } = useMembers();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [q, setQ] = React.useState('');
  const [cat, setCat] = React.useState('all');
  const [editing, setEditing] = React.useState<MessageTemplate | 'new' | null>(null);
  const [sharing, setSharing] = React.useState<MessageTemplate | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: qk.templates(workspace.id) });
  const filtered = templates.filter((t) => (cat === 'all' || t.category === cat) && (`${t.name} ${t.body}`.toLowerCase().includes(q.toLowerCase())));
  const canEdit = (t: MessageTemplate) => can.admin || t.created_by === userId;

  async function duplicate(t: MessageTemplate) {
    const { error } = await getSupabase()
      .from('message_templates')
      .insert({ workspace_id: workspace.id, name: `${t.name} (copy)`, body: t.body, category: t.category, media_url: t.media_url, media_type: t.media_type, media_name: t.media_name, created_by: userId, scope: can.admin ? t.scope : 'personal' });
    if (error) return toast.error(errorMessage(error));
    toast.success('Template duplicated');
    refresh();
  }

  async function remove(t: MessageTemplate) {
    if (!(await confirm({ title: `Delete “${t.name}”?`, description: 'Campaigns that already copied this text are not affected.', confirmLabel: 'Delete', danger: true }))) return;
    const { error } = await getSupabase().from('message_templates').delete().eq('id', t.id);
    if (error) return toast.error(errorMessage(error));
    refresh();
  }

  async function addStarters() {
    const { error } = await getSupabase()
      .from('message_templates')
      .insert(STARTERS.map((s) => ({ ...s, workspace_id: workspace.id, created_by: userId, scope: can.admin ? 'workspace' : 'personal' } as const)));
    if (error) return toast.error(errorMessage(error));
    toast.success('Added 4 proven starter templates');
    refresh();
  }

  return (
    <Page>
      <PageHeader
        icon={<FileText />}
        title="Templates"
        description="Reusable messages with personalisation and spintax. Use them in campaigns, the inbox and automations."
        actions={
          can.write && (
            <Button variant="primary" onClick={() => setEditing('new')}>
              <Plus /> New template
            </Button>
          )
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Input inputSize="sm" className="w-64" leading={<Search />} placeholder="Search templates…" value={q} onChange={(e) => setQ(e.target.value)} />
        <Segmented
          size="sm"
          value={cat}
          onChange={setCat}
          options={[{ value: 'all', label: 'All' }, ...TEMPLATE_CATEGORIES.map((c) => ({ value: c.value, label: c.label, count: templates.filter((t) => t.category === c.value).length || undefined }))]}
        />
      </div>

      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-48 rounded-xl" />
          ))}
        </div>
      ) : templates.length === 0 ? (
        <Card>
          <EmptyState
            icon={<FileText />}
            title="No templates yet"
            description="Start from proven openers and follow-ups, or write your own."
            action={
              can.write && (
                <>
                  <Button variant="primary" onClick={addStarters}>
                    Add starter templates
                  </Button>
                  <Button onClick={() => setEditing('new')}>
                    <Plus /> Write one
                  </Button>
                </>
              )
            }
          />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((t) => {
            const author = t.created_by ? byId.get(t.created_by) : undefined;
            const issues = lintTemplate(t.body, TEMPLATE_VARIABLE_KEYS).filter((i) => i.level === 'error');
            return (
              <Card key={t.id} className="group flex flex-col p-4 transition-shadow hover:shadow-md">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <button className="truncate text-left text-[14px] font-semibold hover:text-primary" onClick={() => canEdit(t) && setEditing(t)}>
                      {t.name}
                    </button>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <Badge tone="neutral">{TEMPLATE_CATEGORIES.find((c) => c.value === t.category)?.label ?? t.category}</Badge>
                      {t.scope === 'workspace' ? (
                        <Badge tone="primary">
                          <Globe2 /> Team
                        </Badge>
                      ) : (
                        <Badge tone="outline">
                          <Lock /> Personal
                        </Badge>
                      )}
                      {issues.length > 0 && <Badge tone="danger">Fix variables</Badge>}
                    </div>
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="icon-sm" variant="ghost" aria-label="Template actions">
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent>
                      {canEdit(t) && (
                        <DropdownMenuItem onSelect={() => setEditing(t)}>
                          <Pencil /> Edit
                        </DropdownMenuItem>
                      )}
                      {can.write && (
                        <DropdownMenuItem onSelect={() => duplicate(t)}>
                          <Copy /> Duplicate
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem
                        onSelect={() => {
                          void navigator.clipboard.writeText(t.body);
                          toast.success('Copied');
                        }}
                      >
                        <Copy /> Copy text
                      </DropdownMenuItem>
                      {canEdit(t) && t.scope === 'personal' && (
                        <DropdownMenuItem onSelect={() => setSharing(t)}>
                          <Share2 /> Share
                        </DropdownMenuItem>
                      )}
                      {canEdit(t) && (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem danger onSelect={() => remove(t)}>
                            <Trash2 /> Delete
                          </DropdownMenuItem>
                        </>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                <p className="mt-3 line-clamp-5 flex-1 whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-muted">{t.body}</p>
                <div className="mt-3 flex items-center justify-between border-t border-border pt-3 text-xs text-subtle">
                  <span className="truncate">{author ? author.profile.full_name || author.profile.email : '—'}</span>
                  <span>Updated {timeAgo(t.updated_at)}</span>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <TemplateDialog template={editing} onClose={() => setEditing(null)} onSaved={refresh} />
      {sharing && <ShareDialog open={!!sharing} onOpenChange={(o) => !o && setSharing(null)} type="template" resourceId={sharing.id} resourceName={sharing.name} />}
    </Page>
  );
}

function TemplateDialog({ template, onClose, onSaved }: { template: MessageTemplate | 'new' | null; onClose: () => void; onSaved: () => void }) {
  const { workspace, userId, can } = useWorkspace();
  const existing = template && template !== 'new' ? template : null;
  const [name, setName] = React.useState('');
  const [category, setCategory] = React.useState('opener');
  const [body, setBody] = React.useState('');
  const [scope, setScope] = React.useState<'workspace' | 'personal'>('workspace');
  const [media, setMedia] = React.useState<Media>({ media_url: null, media_type: null, media_name: null });
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (!template) return;
    setName(existing?.name ?? '');
    setCategory(existing?.category ?? 'opener');
    setBody(existing?.body ?? '');
    setScope(existing?.scope ?? (can.admin ? 'workspace' : 'personal'));
    setMedia({ media_url: existing?.media_url ?? null, media_type: existing?.media_type ?? null, media_name: existing?.media_name ?? null });
  }, [template, existing, can.admin]);

  async function save() {
    if (!name.trim() || !body.trim()) return toast.error('Give the template a name and a message');
    setSaving(true);
    const row = { name: name.trim(), category, body, ...media, scope: can.admin ? scope : 'personal' as const };
    const sb = getSupabase();
    const { error } = existing
      ? await sb.from('message_templates').update(row).eq('id', existing.id)
      : await sb.from('message_templates').insert({ ...row, workspace_id: workspace.id, created_by: userId });
    setSaving(false);
    if (error) return toast.error(errorMessage(error));
    toast.success(existing ? 'Template saved' : 'Template created');
    onSaved();
    onClose();
  }

  return (
    <Dialog open={!!template} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="xl" title={existing ? 'Edit template' : 'New template'}>
        <DialogBody className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-[1fr_200px_180px]">
            <Field label="Name">
              <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Website pitch — dentists" />
            </Field>
            <Field label="Type">
              <NativeSelect value={category} onChange={(e) => setCategory(e.target.value)}>
                {TEMPLATE_CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            {can.admin && (
              <Field label="Visible to">
                <NativeSelect value={scope} onChange={(e) => setScope(e.target.value as 'workspace' | 'personal')}>
                  <option value="workspace">Whole team</option>
                  <option value="personal">Only me</option>
                </NativeSelect>
              </Field>
            )}
          </div>
          <MessageEditor value={body} onChange={setBody} rows={8} footer={<MediaPicker value={media} onChange={setMedia} />} />
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} loading={saving}>
            {existing ? 'Save changes' : 'Create template'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
