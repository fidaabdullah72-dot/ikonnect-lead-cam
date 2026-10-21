import { beforeAll, describe, expect, it } from 'vitest';
import { asService, asUser, createDb, createUser, one, rows, type Db } from './harness';

let db: Db;
let owner: string; // owner of ws
let member: string;
let viewer: string;
let outsider: string; // owner of another workspace
let ws: string;
let other: string;

async function lead(user: string, fields: Record<string, unknown>, workspace = ws) {
  const keys = ['workspace_id', ...Object.keys(fields)];
  const vals = [workspace, ...Object.values(fields)];
  return asUser(db, user, (tx) =>
    one<{ id: string; score: number; score_tier: string }>(
      tx,
      `insert into public.leads (${keys.join(', ')}) values (${vals.map((_, i) => `$${i + 1}`).join(', ')}) returning id, score, score_tier`,
      vals,
    ),
  );
}

beforeAll(async () => {
  db = await createDb();
  owner = await createUser(db, 'owner@ws.test', 'Olivia Owner');
  member = await createUser(db, 'member@ws.test', 'Max Member');
  viewer = await createUser(db, 'viewer@ws.test', 'Vera Viewer');
  outsider = await createUser(db, 'out@x.test', 'Oscar Outsider');
  ws = (await asUser(db, owner, (tx) => one<{ id: string }>(tx, `select public.create_workspace('Agency') as id`))).id;
  other = (await asUser(db, outsider, (tx) => one<{ id: string }>(tx, `select public.create_workspace('Other') as id`))).id;
  await db.query(`insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member'), ($1, $3, 'viewer')`, [ws, member, viewer]);
}, 60_000);

describe('lead scoring', () => {
  it('scores a strong lead hot and a weak one cold', async () => {
    const hot = await lead(member, { business_name: 'Great Clinic', phone: '923001110001', phone_type: 'mobile', rating: 4.7, reviews_count: 150, website: 'https://great.pk' });
    // phone 15 + mobile 15 + rating 15 + reviews 10 + website(any) 5 = 60 → warm until WhatsApp is verified
    expect(hot.score).toBe(60);
    expect(hot.score_tier).toBe('warm');
    const verified = await asUser(db, member, (tx) =>
      one<{ score: number; score_tier: string }>(tx, `update public.leads set wa_status = 'valid' where id = $1 returning score, score_tier`, [hot.id]),
    );
    expect(verified).toEqual({ score: 80, score_tier: 'hot' });

    const cold = await lead(member, { business_name: 'Weak Shop', phone: '924235760000', phone_type: 'landline', rating: 3.1, reviews_count: 2 });
    expect(cold.score_tier).toBe('cold');
  });

  it('opted-out leads score zero', async () => {
    const l = await lead(member, { business_name: 'Opted Clinic', phone: '923001110002', phone_type: 'mobile', opted_out: true });
    expect(l.score).toBe(0);
  });

  it('rescoring follows the workspace target without bumping updated_at', async () => {
    const l = await lead(member, { business_name: 'No Site Gym', phone: '923001110003', phone_type: 'mobile' });
    const before = await one<{ score: number; updated_at: string }>(db, `select score, updated_at from public.leads where id = $1`, [l.id]);
    await asUser(db, owner, (tx) =>
      tx.query(`update public.workspaces set settings = jsonb_set(settings, '{scoring,website_target}', '"without"') where id = $1`, [ws]),
    );
    const n = await asUser(db, owner, (tx) => one<{ n: number }>(tx, `select public.rescore_leads($1) n`, [ws]));
    expect(n.n).toBeGreaterThan(0);
    const after = await one<{ score: number; updated_at: string }>(db, `select score, updated_at from public.leads where id = $1`, [l.id]);
    expect(after.score).toBe(before.score + 10); // 'any' gave +5, 'without' gives +15
    expect(after.updated_at).toEqual(before.updated_at);
    await expect(asUser(db, member, (tx) => tx.query(`select public.rescore_leads($1)`, [ws]))).rejects.toThrow(/Not allowed/);
  });

  it('filters by tier and minimum score', async () => {
    const hot = await asUser(db, member, (tx) => one<{ n: number }>(tx, `select count(*)::int n from public.filtered_leads($1, '{"tiers":["hot"]}')`, [ws]));
    expect(hot.n).toBe(1);
    const min = await asUser(db, member, (tx) => one<{ n: number }>(tx, `select count(*)::int n from public.filtered_leads($1, '{"min_score": 50}')`, [ws]));
    expect(min.n).toBeGreaterThanOrEqual(1);
  });
});

describe('no double outreach', () => {
  it('excludes leads that sit in another active campaign', async () => {
    const l = await lead(member, { business_name: 'Shared Target', phone: '923001110010', phone_type: 'mobile' });
    const c1 = await asUser(db, member, (tx) => one<{ id: string }>(tx, `insert into public.campaigns (workspace_id, name, created_by, status) values ($1, 'A', $2, 'running') returning id`, [ws, member]));
    await asUser(db, member, (tx) => tx.query(`select public.campaign_add_recipients($1, null, $2)`, [c1.id, [l.id]]));
    const c2 = await asUser(db, owner, (tx) => one<{ id: string }>(tx, `insert into public.campaigns (workspace_id, name, created_by) values ($1, 'B', $2) returning id`, [ws, owner]));
    const added = await asUser(db, owner, (tx) =>
      one<{ n: number }>(tx, `select public.campaign_add_recipients($1, $2, $3) n`, [c2.id, JSON.stringify({ not_in_active_campaign: true, exclude_campaign_id: c2.id }), [l.id]]),
    );
    expect(added.n).toBe(0);
    const forced = await asUser(db, owner, (tx) => one<{ n: number }>(tx, `select public.campaign_add_recipients($1, null, $2) n`, [c2.id, [l.id]]));
    expect(forced.n).toBe(1);
  });
});

describe('duplicates & merge', () => {
  let keep: string;
  let dup: string;

  it('finds same-name-same-city and same-website groups, and dismissals hide them', async () => {
    keep = (await lead(member, { business_name: 'Smile Dental Care', city: 'Lahore', phone: '923001110020', tags: ['a'] })).id;
    dup = (await lead(member, { business_name: 'Smile Dental-Care', city: 'lahore', email: 'hi@smile.pk', website: 'https://www.smile.pk/home', tags: ['b'], deal_value: 500 })).id;
    await lead(member, { business_name: 'Smile Branch Two', city: 'Karachi', website: 'http://smile.pk' });
    const groups = await asUser(db, member, (tx) => rows<{ match_type: string; match_key: string; total: number }>(tx, `select * from public.lead_duplicate_groups($1)`, [ws]));
    expect(groups.map((g) => g.match_type).sort()).toEqual(['name_city', 'website']);
    const site = groups.find((g) => g.match_type === 'website')!;
    expect(site.match_key).toBe('smile.pk');
    await asUser(db, member, (tx) => tx.query(`insert into public.duplicate_dismissals (workspace_id, match_type, match_key, dismissed_by) values ($1, 'website', 'smile.pk', $2)`, [ws, member]));
    const after = await asUser(db, member, (tx) => rows(tx, `select * from public.lead_duplicate_groups($1)`, [ws]));
    expect(after).toHaveLength(1);
  });

  it('merges history and fills blanks', async () => {
    await asUser(db, member, (tx) => tx.query(`insert into public.lead_notes (workspace_id, lead_id, author_id, body) values ($1, $2, $3, 'note on dup')`, [ws, dup, member]));
    const n = await asUser(db, member, (tx) => one<{ n: number }>(tx, `select public.merge_leads($1, $2) n`, [keep, [dup]]));
    expect(n.n).toBe(1);
    const k = await one<{ email: string; website: string; tags: string[]; deal_value: string; phone: string }>(db, `select email, website, tags, deal_value, phone from public.leads where id = $1`, [keep]);
    expect(k.email).toBe('hi@smile.pk');
    expect(k.phone).toBe('923001110020');
    expect(k.tags.sort()).toEqual(['a', 'b']);
    expect(Number(k.deal_value)).toBe(500);
    expect(await rows(db, `select 1 from public.leads where id = $1`, [dup])).toHaveLength(0);
    expect(await rows(db, `select 1 from public.lead_notes where lead_id = $1`, [keep])).toHaveLength(1);
    const acts = await rows<{ type: string }>(db, `select type from public.activities where lead_id = $1`, [keep]);
    expect(acts.map((a) => a.type)).toContain('merged');
  });

  it('viewers and outsiders cannot merge', async () => {
    const a = (await lead(member, { business_name: 'M1' })).id;
    const b = (await lead(member, { business_name: 'M2' })).id;
    await expect(asUser(db, viewer, (tx) => tx.query(`select public.merge_leads($1, $2)`, [a, [b]]))).rejects.toThrow(/Not allowed/);
    await expect(asUser(db, outsider, (tx) => tx.query(`select public.merge_leads($1, $2)`, [a, [b]]))).rejects.toThrow(/Not allowed/);
  });
});

describe('team chat', () => {
  let general: string;
  let secret: string;

  it('creates #general and auto-joins every member', async () => {
    general = (await one<{ id: string }>(db, `select id from public.chat_channels where workspace_id = $1 and name = 'general'`, [ws])).id;
    const members = await rows<{ user_id: string }>(db, `select user_id from public.chat_members where channel_id = $1`, [general]);
    expect(new Set(members.map((m) => m.user_id))).toEqual(new Set([owner, member, viewer]));
  });

  it('private channels are invisible to non-members', async () => {
    secret = (await asUser(db, owner, (tx) => one<{ id: string }>(tx, `select public.chat_create_channel($1, 'Sales Leads', 'deal talk', true, $2) id`, [ws, [member]]))).id;
    const name = await one<{ name: string }>(db, `select name from public.chat_channels where id = $1`, [secret]);
    expect(name.name).toBe('sales-leads');
    expect(await asUser(db, member, (tx) => rows(tx, `select 1 from public.chat_channels where id = $1`, [secret]))).toHaveLength(1);
    expect(await asUser(db, viewer, (tx) => rows(tx, `select 1 from public.chat_channels where id = $1`, [secret]))).toHaveLength(0);
    expect(await asUser(db, outsider, (tx) => rows(tx, `select 1 from public.chat_channels where workspace_id = $1`, [ws]))).toHaveLength(0);
  });

  it('only members post; mentions notify', async () => {
    await asUser(db, member, (tx) =>
      tx.query(`insert into public.chat_messages (workspace_id, channel_id, author_id, body, mentions) values ($1, $2, $3, 'hey @olivia', $4)`, [ws, secret, member, [owner]]),
    );
    await expect(
      asUser(db, viewer, (tx) => tx.query(`insert into public.chat_messages (workspace_id, channel_id, author_id, body) values ($1, $2, $3, 'sneaky')`, [ws, secret, viewer])),
    ).rejects.toThrow(/row-level security/);
    expect(await asUser(db, viewer, (tx) => rows(tx, `select 1 from public.chat_messages where channel_id = $1`, [secret]))).toHaveLength(0);
    const notes = await asUser(db, owner, (tx) => rows<{ type: string; link: string }>(tx, `select type, link from public.notifications where type = 'mention'`));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.link).toBe(`/chat?c=${secret}`);
  });

  it('viewers can chat in #general and empty messages are rejected', async () => {
    await asUser(db, viewer, (tx) => tx.query(`insert into public.chat_messages (workspace_id, channel_id, author_id, body) values ($1, $2, $3, 'hello team')`, [ws, general, viewer]));
    await expect(
      asUser(db, viewer, (tx) => tx.query(`insert into public.chat_messages (workspace_id, channel_id, author_id, body) values ($1, $2, $3, '   ')`, [ws, general, viewer])),
    ).rejects.toThrow(/row-level security/);
  });

  it('unread counts and read markers', async () => {
    const ov = await asUser(db, owner, (tx) => rows<{ channel_id: string; unread: number; mentions: number }>(tx, `select * from public.chat_overview($1)`, [ws]));
    expect(ov.find((o) => o.channel_id === secret)).toMatchObject({ unread: 1, mentions: 1 });
    expect(ov.find((o) => o.channel_id === general)).toMatchObject({ unread: 1 });
    await asUser(db, owner, (tx) => tx.query(`update public.chat_members set last_read_at = now() where channel_id = $1 and user_id = $2`, [secret, owner]));
    const ov2 = await asUser(db, owner, (tx) => rows<{ channel_id: string; unread: number }>(tx, `select * from public.chat_overview($1)`, [ws]));
    expect(ov2.find((o) => o.channel_id === secret)!.unread).toBe(0);
  });

  it('DMs are reused, not duplicated', async () => {
    const a = await asUser(db, member, (tx) => one<{ id: string }>(tx, `select public.chat_open_dm($1, $2) id`, [ws, [owner]]));
    const b = await asUser(db, owner, (tx) => one<{ id: string }>(tx, `select public.chat_open_dm($1, $2) id`, [ws, [member]]));
    expect(a.id).toBe(b.id);
    expect(await asUser(db, viewer, (tx) => rows(tx, `select 1 from public.chat_channels where id = $1`, [a.id]))).toHaveLength(0);
    await expect(asUser(db, outsider, (tx) => tx.query(`select public.chat_open_dm($1, $2)`, [ws, [owner]]))).rejects.toThrow(/Not allowed/);
  });

  it('public channels can be joined; leaving the workspace leaves its chats', async () => {
    const pub = (await asUser(db, owner, (tx) => one<{ id: string }>(tx, `select public.chat_create_channel($1, 'Wins', null, false, '{}') id`, [ws]))).id;
    await asUser(db, viewer, (tx) => tx.query(`insert into public.chat_members (channel_id, workspace_id, user_id) values ($1, $2, $3)`, [pub, ws, viewer]));
    await expect(
      asUser(db, viewer, (tx) => tx.query(`insert into public.chat_members (channel_id, workspace_id, user_id) values ($1, $2, $3)`, [secret, ws, viewer])),
    ).rejects.toThrow(/row-level security/);
    await db.query(`delete from public.workspace_members where workspace_id = $1 and user_id = $2`, [ws, viewer]);
    expect(await rows(db, `select 1 from public.chat_members where workspace_id = $1 and user_id = $2`, [ws, viewer])).toHaveLength(0);
    await db.query(`insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, 'viewer')`, [ws, viewer]);
  });

  it('reactions belong to visible messages', async () => {
    const msg = await one<{ id: string }>(db, `select id from public.chat_messages where channel_id = $1 limit 1`, [general]);
    await asUser(db, member, (tx) => tx.query(`insert into public.chat_reactions (message_id, workspace_id, user_id, emoji) values ($1, $2, $3, '👍')`, [msg.id, ws, member]));
    expect(await asUser(db, owner, (tx) => rows(tx, `select 1 from public.chat_reactions where message_id = $1`, [msg.id]))).toHaveLength(1);
    expect(await asUser(db, outsider, (tx) => rows(tx, `select 1 from public.chat_reactions where message_id = $1`, [msg.id]))).toHaveLength(0);
  });
});

describe('saved views', () => {
  it('shared views are visible to the team, private ones only to the creator', async () => {
    await asUser(db, member, (tx) => tx.query(`insert into public.saved_views (workspace_id, name, filters, shared, created_by) values ($1, 'Hot Lahore', '{"tiers":["hot"]}', true, $2), ($1, 'Mine only', '{}', false, $2)`, [ws, member]));
    expect(await asUser(db, owner, (tx) => rows(tx, `select name from public.saved_views`))).toHaveLength(1);
    expect(await asUser(db, member, (tx) => rows(tx, `select name from public.saved_views`))).toHaveLength(2);
  });
});

describe('automations', () => {
  it('only admins manage automations', async () => {
    await expect(
      asUser(db, member, (tx) => tx.query(`insert into public.automations (workspace_id, name, trigger, created_by) values ($1, 'x', 'stage_changed', $2)`, [ws, member])),
    ).rejects.toThrow(/row-level security/);
    await asUser(db, owner, (tx) =>
      tx.query(`insert into public.automations (workspace_id, name, trigger, actions, created_by) values ($1, 'On stage', 'stage_changed', '[{"type":"add_tag","tag":"moved"}]', $2)`, [ws, owner]),
    );
  });

  it('stage changes enqueue events for the engine, except from automation requests', async () => {
    const l = (await lead(member, { business_name: 'Queue Me' })).id;
    const stage = await one<{ id: string }>(db, `select id from public.pipeline_stages where workspace_id = $1 and name = 'Interested'`, [ws]);
    await asUser(db, member, (tx) => tx.query(`update public.leads set stage_id = $1 where id = $2`, [stage.id, l]));
    const q = await rows<{ trigger: string; lead_id: string }>(db, `select trigger, lead_id from public.automation_queue where lead_id = $1`, [l]);
    expect(q).toEqual([{ trigger: 'stage_changed', lead_id: l }]);

    const won = await one<{ id: string }>(db, `select id from public.pipeline_stages where workspace_id = $1 and name = 'Won'`, [ws]);
    await asService(db, async (tx) => {
      await tx.query(`select set_config('request.headers', '{"x-batsols-automation":"1"}', false)`);
      await tx.query(`update public.leads set stage_id = $1 where id = $2`, [won.id, l]);
      await tx.query(`select set_config('request.headers', '', false)`);
    });
    expect(await rows(db, `select 1 from public.automation_queue where lead_id = $1`, [l])).toHaveLength(1);
    await expect(asUser(db, owner, (tx) => tx.query(`select * from public.automation_queue`))).rejects.toThrow(/permission denied/);
  });

  it('no queue spam when no automation listens', async () => {
    const before = await one<{ n: number }>(db, `select count(*)::int n from public.automation_queue where trigger = 'lead_created'`);
    await lead(member, { business_name: 'Quiet Lead' });
    const after = await one<{ n: number }>(db, `select count(*)::int n from public.automation_queue where trigger = 'lead_created'`);
    expect(after.n).toBe(before.n);
  });
});

describe('engine lease & health', () => {
  it('one engine at a time; handover after release or expiry', async () => {
    const acquire = (id: string, ttl = 45) => asService(db, (tx) => one<{ ok: boolean }>(tx, `select public.engine_acquire_lease($1, $2) ok`, [id, ttl]));
    expect((await acquire('engine-a')).ok).toBe(true);
    expect((await acquire('engine-b')).ok).toBe(false);
    expect((await acquire('engine-a')).ok).toBe(true); // renew
    await asService(db, (tx) => tx.query(`select public.engine_release_lease('engine-a')`));
    expect((await acquire('engine-b', 1)).ok).toBe(true);
    await db.query(`update public.engine_status set lease_until = now() - interval '1 second' where id = 'main'`);
    expect((await acquire('engine-c')).ok).toBe(true);
    await expect(asUser(db, owner, (tx) => tx.query(`select public.engine_acquire_lease('x', 10)`))).rejects.toThrow(/permission denied/);
  });

  it('account_health returns one row per number', async () => {
    await asUser(db, member, (tx) => tx.query(`insert into public.whatsapp_accounts (workspace_id, owner_id, label) values ($1, $2, 'Max phone')`, [ws, member]));
    const h = await asUser(db, viewer, (tx) => rows<{ sent_today: number }>(tx, `select * from public.account_health($1, 7)`, [ws]));
    expect(h).toHaveLength(1);
    expect(h[0]!.sent_today).toBe(0);
    await expect(asUser(db, outsider, (tx) => tx.query(`select * from public.account_health($1, 7)`, [ws]))).rejects.toThrow(/Not a member/);
  });

  it('campaign events are readable by members only', async () => {
    const c = await one<{ id: string }>(db, `select id from public.campaigns where workspace_id = $1 limit 1`, [ws]);
    await asService(db, (tx) => tx.query(`insert into public.campaign_events (workspace_id, campaign_id, type, message) values ($1, $2, 'info', 'hello')`, [ws, c.id]));
    expect(await asUser(db, viewer, (tx) => rows(tx, `select 1 from public.campaign_events where campaign_id = $1`, [c.id]))).toHaveLength(1);
    expect(await asUser(db, outsider, (tx) => rows(tx, `select 1 from public.campaign_events where campaign_id = $1`, [c.id]))).toHaveLength(0);
    await expect(
      asUser(db, owner, (tx) => tx.query(`insert into public.campaign_events (workspace_id, campaign_id, type) values ($1, $2, 'info')`, [ws, c.id])),
    ).rejects.toThrow(/permission denied/);
  });
});

void other;
