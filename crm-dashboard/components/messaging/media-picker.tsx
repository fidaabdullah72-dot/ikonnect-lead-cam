'use client';

import * as React from 'react';
import { FileText, ImageIcon, Paperclip, Video, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { getSupabase } from '@/lib/supabase/client';
import { useWorkspace } from '@/lib/workspace';
import { errorMessage } from '@/lib/utils';

export interface Media {
  media_url: string | null;
  media_type: 'image' | 'document' | 'video' | null;
  media_name: string | null;
}

const MAX_MB = 16;

export function MediaPicker({ value, onChange }: { value: Media; onChange: (m: Media) => void }) {
  const { workspace } = useWorkspace();
  const [uploading, setUploading] = React.useState(false);
  const input = React.useRef<HTMLInputElement>(null);

  async function upload(file: File) {
    if (file.size > MAX_MB * 1024 * 1024) {
      toast.error(`Files must be under ${MAX_MB} MB`);
      return;
    }
    setUploading(true);
    const ext = file.name.split('.').pop()?.toLowerCase() ?? 'bin';
    const path = `${workspace.id}/${crypto.randomUUID()}.${ext}`;
    const sb = getSupabase();
    const { error } = await sb.storage.from('media').upload(path, file, { contentType: file.type || undefined, upsert: false });
    setUploading(false);
    if (error) {
      toast.error(errorMessage(error));
      return;
    }
    const url = sb.storage.from('media').getPublicUrl(path).data.publicUrl;
    const type = file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : 'document';
    onChange({ media_url: url, media_type: type, media_name: file.name });
  }

  if (value.media_url) {
    const Icon = value.media_type === 'image' ? ImageIcon : value.media_type === 'video' ? Video : FileText;
    return (
      <div className="flex items-center gap-3 rounded-lg border border-border bg-surface-2/50 p-2 pr-3">
        {value.media_type === 'image' ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={value.media_url} alt="" className="size-12 rounded-md object-cover" />
        ) : (
          <span className="flex size-12 items-center justify-center rounded-md bg-surface text-muted">
            <Icon className="size-5" />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium">{value.media_name ?? 'Attachment'}</div>
          <div className="text-xs capitalize text-subtle">{value.media_type} · sent with the message as its caption</div>
        </div>
        <Button size="icon-sm" variant="ghost" onClick={() => onChange({ media_url: null, media_type: null, media_name: null })} aria-label="Remove attachment">
          <X />
        </Button>
      </div>
    );
  }

  return (
    <>
      <Button type="button" size="sm" variant="ghost" onClick={() => input.current?.click()} disabled={uploading}>
        {uploading ? <Spinner className="size-3.5" /> : <Paperclip />} {uploading ? 'Uploading…' : 'Attach image, video or PDF'}
      </Button>
      <input
        ref={input}
        type="file"
        className="sr-only"
        accept="image/*,video/mp4,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void upload(f);
          e.target.value = '';
        }}
      />
    </>
  );
}
