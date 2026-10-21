-- ============================================================================
-- Realtime + Storage (guarded so the migration also runs on plain Postgres)
-- ============================================================================

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table
      public.whatsapp_accounts,
      public.whatsapp_link_codes,
      public.scrape_jobs,
      public.messages,
      public.conversations,
      public.campaigns,
      public.campaign_recipients,
      public.notifications,
      public.engine_jobs,
      public.engine_status;
  end if;
end $$;

-- Media attachments for campaigns/templates: public-read bucket, uploads only
-- into a folder named after a workspace the user can write to:
--   media/<workspace_id>/<random>.<ext>
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage')
     and exists (select 1 from pg_tables where schemaname = 'storage' and tablename = 'buckets') then
    insert into storage.buckets (id, name, public, file_size_limit)
    values ('media', 'media', true, 16777216)
    on conflict (id) do nothing;

    execute $p$
      create policy "media: writers upload" on storage.objects
        for insert to authenticated
        with check (bucket_id = 'media' and public.can_write(public.try_uuid((storage.foldername(name))[1])))
    $p$;
    execute $p$
      create policy "media: writers delete" on storage.objects
        for delete to authenticated
        using (bucket_id = 'media' and public.can_write(public.try_uuid((storage.foldername(name))[1])))
    $p$;
  end if;
end $$;
