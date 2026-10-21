import { beforeAll, describe, expect, it } from 'vitest';
import { asService, asUser, createDb, createUser, one, rows, type Db } from './harness';

let db: Db;
let alice: string; // owner of workspace A
let bob: string; // owner of workspace B
let carol: string; // member of A
let victor: string; // viewer of A
let wsA: string;
let wsB: string;

async function addMember(ws: string, user: string, role: string) {
  await db.query(`insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, $3)`, [ws, user, role]);
}

async function insertLead(user: string, ws: string, fields: Record<string, unknown>) {
  const keys = ['workspace_id', ...Object.keys(fields)];
  const vals = [ws, ...Object.values(fields)];
  const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ');
  return asUser(db, user, (tx) =>
    one<{ id: string; stage_id: string }>(tx, `insert into public.leads (${keys.join(', ')}) values (${placeholders}) returning id, stage_id`, vals),
  );
}

beforeAll(async () => {
  db = await createDb();
  alice = await createUser(db, 'alice@a.test', 'Alice');
  bob = await createUser(db, 'bob@b.test', 'Bob');
  carol = await createUser(db, 'carol@a.test', 'Carol');
  victor = await createUser(db, 'victor@a.test', 'Victor');
  wsA = (await asUser(db, alice, (tx) => one<{ id: string }>(tx, `select public.create_workspace('Agency A') as id`))).id;
  wsB = (await asUser(db, bob, (tx) => one<{ id: string }>(tx, `select public.create_workspace('Agency B') as id`))).id;
  await addMember(wsA, carol, 'member');
  await addMember(wsA, victor, 'viewer');
  // These tests cover the classic "everyone sees every lead" mode; personal spaces are tested in spaces.test.ts.
  await db.query(`update public.workspaces set settings = settings || '{"members_see_all_leads": true}' where id = $1`, [wsA]);
}, 60_000);

describe('signup & workspaces', () => {
  it('creates a profile for each auth user', async () => {
    const p = await one<{ full_name: string; email: string }>(db, `select full_name, email from public.profiles where id = $1`, [alice]);
    expect(p).toEqual({ full_name: 'Alice', email: 'alice@a.test' });
  });

  it('create_workspace makes the caller owner and seeds 8 pipeline stages', async () => {
    const m = await one<{ role: string }>(db, `select role from public.workspace_members where workspace_id = $1 and user_id = $2`, [wsA, alice]);
    expect(m.role).toBe('owner');
    const stages = await rows<{ name: string; kind: string }>(db, `select name, kind from public.pipeline_stages where workspace_id = $1 order by position`, [wsA]);
    expect(stages.map((s) => s.name)).toEqual(['New', 'Contacted', 'Replied', 'Interested', 'Meeting Booked', 'Proposal Sent', 'Won', 'Lost']);
  });

  it('users only see their own workspaces', async () => {
    const seen = await asUser(db, bob, (tx) => rows<{ id: string }>(tx, `select id from public.workspaces`));
    expect(seen.map((w) => w.id)).toEqual([wsB]);
  });

  it('members cannot change workspace settings, admins can', async () => {
    const res = await asUser(db, carol, (tx) => tx.query(`update public.workspaces set name = 'Hacked' where id = $1`, [wsA]));
    expect(res.affectedRows).toBe(0);
    await asUser(db, alice, (tx) => tx.query(`update public.workspaces set name = 'Agency A+' where id = $1`, [wsA]));
    expect((await one<{ name: string }>(db, `select name from public.workspaces where id = $1`, [wsA])).name).toBe('Agency A+');
  });

  it('cannot insert workspaces or memberships directly', async () => {
    await expect(asUser(db, bob, (tx) => tx.query(`insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')`, [wsA, bob]))).rejects.toThrow();
    await expect(asUser(db, bob, (tx) => tx.query(`insert into public.workspaces (name) values ('x')`))).rejects.toThrow();
  });

  it('profiles are visible to teammates only', async () => {
    const seen = await asUser(db, carol, (tx) => rows<{ id: string }>(tx, `select id from public.profiles`));
    expect(new Set(seen.map((p) => p.id))).toEqual(new Set([alice, carol, victor]));
  });
});

describe('membership guards', () => {
  it('keeps at least one owner', async () => {
    await expect(asUser(db, alice, (tx) => tx.query(`update public.workspace_members set role = 'admin' where workspace_id = $1 and user_id = $2`, [wsA, alice]))).rejects.toThrow(/at least one owner/);
    await expect(asUser(db, alice, (tx) => tx.query(`delete from public.workspace_members where workspace_id = $1 and user_id = $2`, [wsA, alice]))).rejects.toThrow(/at least one owner/);
  });

  it('members cannot promote themselves', async () => {
    const res = await asUser(db, carol, (tx) => tx.query(`update public.workspace_members set role = 'admin' where workspace_id = $1 and user_id = $2`, [wsA, carol]));
    expect(res.affectedRows).toBe(0);
  });

  it('admins cannot grant owner', async () => {
    const dave = await createUser(db, 'dave@a.test');
    await addMember(wsA, dave, 'admin');
    await expect(asUser(db, dave, (tx) => tx.query(`update public.workspace_members set role = 'owner' where workspace_id = $1 and user_id = $2`, [wsA, carol]))).rejects.toThrow(/Only owners/);
    await db.query(`delete from public.workspace_members where user_id = $1`, [dave]);
  });

  it('deleting a workspace cascades past the owner guard', async () => {
    const zed = await createUser(db, 'zed@z.test');
    const ws = (await asUser(db, zed, (tx) => one<{ id: string }>(tx, `select public.create_workspace('Temp') as id`))).id;
    await asUser(db, zed, (tx) => tx.query(`delete from public.workspaces where id = $1`, [ws]));
    expect(await rows(db, `select 1 from public.workspace_members where workspace_id = $1`, [ws])).toHaveLength(0);
  });
});

describe('invites', () => {
  it('admin invites, invitee previews and accepts once', async () => {
    const inv = await asUser(db, alice, (tx) =>
      one<{ token: string }>(tx, `insert into public.workspace_invites (workspace_id, role, invited_by) values ($1, 'member', $2) returning token`, [wsA, alice]),
    );
    expect(inv.token).toMatch(/^[0-9a-f]{64}$/);

    await db.exec(`set role anon`);
    const preview = await one<{ workspace_name: string; expired: boolean }>(db, `select * from public.get_invite($1)`, [inv.token]);
    await db.exec(`reset role`);
    expect(preview.workspace_name).toBe('Agency A+');
    expect(preview.expired).toBe(false);

    const erin = await createUser(db, 'erin@x.test');
    const ws = await asUser(db, erin, (tx) => one<{ ws: string }>(tx, `select public.accept_invite($1) as ws`, [inv.token]));
    expect(ws.ws).toBe(wsA);

    const frank = await createUser(db, 'frank@x.test');
    await expect(asUser(db, frank, (tx) => tx.query(`select public.accept_invite($1)`, [inv.token]))).rejects.toThrow(/already been used/);
  });

  it('email-locked invites reject other addresses', async () => {
    const inv = await asUser(db, alice, (tx) =>
      one<{ token: string }>(tx, `insert into public.workspace_invites (workspace_id, email, role, invited_by) values ($1, 'gina@x.test', 'viewer', $2) returning token`, [wsA, alice]),
    );
    const henry = await createUser(db, 'henry@x.test');
    await expect(asUser(db, henry, (tx) => tx.query(`select public.accept_invite($1)`, [inv.token]))).rejects.toThrow(/different email/);
  });

  it('members cannot create invites', async () => {
    await expect(asUser(db, carol, (tx) => tx.query(`insert into public.workspace_invites (workspace_id, role, invited_by) values ($1, 'admin', $2)`, [wsA, carol]))).rejects.toThrow();
  });
});

describe('leads & isolation', () => {
  let leadA1: string;

  it('new leads land in the "New" stage', async () => {
    const lead = await insertLead(alice, wsA, { business_name: 'Smile Dental', phone: '923001112233', city: 'Lahore', category: 'Dentists', tags: ['vip', ' vip ', 'dentist'], website: 'https://smile.pk' });
    leadA1 = lead.id;
    const stage = await one<{ name: string }>(db, `select name from public.pipeline_stages where id = $1`, [lead.stage_id]);
    expect(stage.name).toBe('New');
    const tags = await one<{ tags: string[]; has_website: boolean }>(db, `select tags, has_website from public.leads where id = $1`, [leadA1]);
    expect(tags.tags.sort()).toEqual(['dentist', 'vip']);
    expect(tags.has_website).toBe(true);
  });

  it('dedupes on phone within a workspace but not across workspaces', async () => {
    await expect(insertLead(carol, wsA, { business_name: 'Dup', phone: '923001112233' })).rejects.toThrow(/leads_ws_phone_key/);
    await insertLead(bob, wsB, { business_name: 'Same number, other agency', phone: '923001112233' });
  });

  it('other workspaces cannot read or write my leads', async () => {
    const seen = await asUser(db, bob, (tx) => rows(tx, `select id from public.leads where workspace_id = $1`, [wsA]));
    expect(seen).toHaveLength(0);
    await expect(insertLead(bob, wsA, { business_name: 'Injected' })).rejects.toThrow(/row-level security/);
    const upd = await asUser(db, bob, (tx) => tx.query(`update public.leads set business_name = 'x' where id = $1`, [leadA1]));
    expect(upd.affectedRows).toBe(0);
  });

  it('viewers read but cannot write', async () => {
    const seen = await asUser(db, victor, (tx) => rows(tx, `select id from public.leads where workspace_id = $1`, [wsA]));
    expect(seen.length).toBeGreaterThan(0);
    await expect(insertLead(victor, wsA, { business_name: 'Nope' })).rejects.toThrow(/row-level security/);
  });

  it('child rows cannot reference another workspace (composite FKs)', async () => {
    await expect(
      db.query(`insert into public.lead_notes (workspace_id, lead_id, author_id, body) values ($1, $2, $3, 'cross')`, [wsB, leadA1, bob]),
    ).rejects.toThrow(/foreign key/);
  });

  it('stage changes and assignment are logged, assignee gets notified', async () => {
    const replied = await one<{ id: string }>(db, `select id from public.pipeline_stages where workspace_id = $1 and name = 'Interested'`, [wsA]);
    await asUser(db, alice, (tx) => tx.query(`update public.leads set stage_id = $1, owner_id = $2 where id = $3`, [replied.id, carol, leadA1]));
    const acts = await rows<{ type: string }>(db, `select type from public.activities where lead_id = $1 order by created_at`, [leadA1]);
    expect(acts.map((a) => a.type).sort()).toEqual(['assigned', 'stage_changed']);
    const notes = await asUser(db, carol, (tx) => rows<{ type: string }>(tx, `select type from public.notifications`));
    expect(notes.map((n) => n.type)).toContain('lead_assigned');
    const notesAlice = await asUser(db, alice, (tx) => rows(tx, `select 1 from public.notifications`));
    expect(notesAlice).toHaveLength(0);
  });
});

describe('filtered_leads & bulk actions', () => {
  beforeAll(async () => {
    await insertLead(alice, wsA, { business_name: 'Gym One', phone: '923002223344', city: 'Karachi', category: 'Gyms', tags: ['fitness'] });
    await insertLead(alice, wsA, { business_name: 'Gym Two', phone: '923003334455', city: 'Karachi', category: 'Gyms', opted_out: true });
    await insertLead(alice, wsA, { business_name: 'No Phone Clinic', city: 'Lahore', category: 'Clinics' });
    await insertLead(alice, wsA, { business_name: 'Invalid WA', phone: '924235761234', phone_type: 'landline', wa_status: 'invalid', city: 'Lahore' });
  });

  const count = (filters: object) =>
    asUser(db, carol, (tx) => one<{ n: number }>(tx, `select count(*)::int n from public.filtered_leads($1, $2)`, [wsA, JSON.stringify(filters)])).then((r) => r.n);

  it('filters by text, phone digits, website, city, tags', async () => {
    expect(await count({})).toBe(5);
    expect(await count({ q: 'gym' })).toBe(2);
    expect(await count({ q: '+92 300 222' })).toBe(1);
    expect(await count({ has_website: true })).toBe(1);
    expect(await count({ has_website: false })).toBe(4);
    expect(await count({ cities: ['Karachi'] })).toBe(2);
    expect(await count({ tags: ['fitness', 'vip'] })).toBe(2);
    expect(await count({ sendable: true })).toBe(2);
    expect(await count({ opted_out: true })).toBe(1);
    expect(await count({ has_phone: false })).toBe(1);
    expect(await count({ unassigned: true })).toBe(4);
    expect(await count({ owner_ids: [carol] })).toBe(1);
    expect(await count({ contacted: 'never' })).toBe(5);
  });

  it('returns nothing for a workspace the caller is not in', async () => {
    const n = await asUser(db, bob, (tx) => one<{ n: number }>(tx, `select count(*)::int n from public.filtered_leads($1, '{}')`, [wsA]));
    expect(n.n).toBe(0);
  });

  it('bulk tags by filter and by ids', async () => {
    const n = await asUser(db, carol, (tx) => one<{ n: number }>(tx, `select public.leads_bulk_action($1, 'add_tags', null, $2, $3) n`, [wsA, JSON.stringify({ cities: ['Karachi'] }), JSON.stringify(['karachi-batch'])]));
    expect(n.n).toBe(2);
    expect(await count({ tags: ['karachi-batch'] })).toBe(2);
    await asUser(db, carol, (tx) => tx.query(`select public.leads_bulk_action($1, 'remove_tags', null, $2, $3)`, [wsA, JSON.stringify({ cities: ['Karachi'] }), JSON.stringify(['karachi-batch'])]));
    expect(await count({ tags: ['karachi-batch'] })).toBe(0);
  });

  it('viewers cannot run bulk actions', async () => {
    await expect(asUser(db, victor, (tx) => tx.query(`select public.leads_bulk_action($1, 'opt_out', null, '{}', null)`, [wsA]))).rejects.toThrow(/Not allowed/);
  });

  it('facets list cities, categories and tags with counts', async () => {
    const f = await asUser(db, carol, (tx) => one<{ f: { cities: { value: string; count: number }[] } }>(tx, `select public.lead_facets($1) f`, [wsA]));
    expect(f.f.cities).toEqual(expect.arrayContaining([{ value: 'Karachi', count: 2 }, { value: 'Lahore', count: 3 }]));
  });
});

describe('whatsapp accounts & messages', () => {
  let carolAcc: string;
  let aliceAccPrivate: string;
  let leadId: string;

  beforeAll(async () => {
    carolAcc = (await asUser(db, carol, (tx) => one<{ id: string }>(tx, `insert into public.whatsapp_accounts (workspace_id, owner_id, label) values ($1, $2, 'Carol phone') returning id`, [wsA, carol]))).id;
    aliceAccPrivate = (await asUser(db, alice, (tx) => one<{ id: string }>(tx, `insert into public.whatsapp_accounts (workspace_id, owner_id, label, shared) values ($1, $2, 'Alice private', false) returning id`, [wsA, alice]))).id;
    leadId = (await one<{ id: string }>(db, `select id from public.leads where workspace_id = $1 and business_name = 'Gym One'`, [wsA])).id;
  });

  it('owners can request a connection but not fake the status', async () => {
    await asUser(db, carol, (tx) => tx.query(`update public.whatsapp_accounts set desired_state = 'connected' where id = $1`, [carolAcc]));
    await expect(asUser(db, carol, (tx) => tx.query(`update public.whatsapp_accounts set status = 'connected' where id = $1`, [carolAcc]))).rejects.toThrow(/permission denied/);
  });

  it("teammates cannot change someone else's number", async () => {
    const res = await asUser(db, carol, (tx) => tx.query(`update public.whatsapp_accounts set label = 'mine now' where id = $1`, [aliceAccPrivate]));
    expect(res.affectedRows).toBe(0);
  });

  it('QR codes are visible to the account owner and admins only', async () => {
    await asService(db, (tx) => tx.query(`insert into public.whatsapp_link_codes (account_id, workspace_id, qr) values ($1, $2, 'QRDATA')`, [carolAcc, wsA]));
    expect(await asUser(db, carol, (tx) => rows(tx, `select qr from public.whatsapp_link_codes`))).toHaveLength(1);
    expect(await asUser(db, alice, (tx) => rows(tx, `select qr from public.whatsapp_link_codes`))).toHaveLength(1);
    expect(await asUser(db, victor, (tx) => rows(tx, `select qr from public.whatsapp_link_codes`))).toHaveLength(0);
  });

  it('session keys are never readable from the browser', async () => {
    await asService(db, (tx) => tx.query(`insert into public.wa_auth_keys (account_id, key, value) values ($1, 'creds', '{}')`, [carolAcc]));
    await expect(asUser(db, alice, (tx) => tx.query(`select * from public.wa_auth_keys`))).rejects.toThrow(/permission denied/);
  });

  it('members can queue messages from usable numbers only', async () => {
    const q = (user: string, acc: string, status = 'queued') =>
      asUser(db, user, (tx) => tx.query(
        `insert into public.messages (workspace_id, lead_id, account_id, direction, body, status, sent_by) values ($1, $2, $3, 'out', 'hi', $4, $5)`,
        [wsA, leadId, acc, status, user],
      ));
    await q(carol, carolAcc);
    await expect(q(carol, aliceAccPrivate)).rejects.toThrow(/row-level security/);
    await q(alice, carolAcc); // admins may use any number
    await expect(q(carol, carolAcc, 'sent')).rejects.toThrow(/row-level security/);
    await expect(q(victor, carolAcc)).rejects.toThrow(/row-level security/);
  });
});

describe('campaigns', () => {
  let campaignId: string;

  it('members create campaigns and add sendable recipients by filter', async () => {
    campaignId = (await asUser(db, carol, (tx) => one<{ id: string }>(tx, `insert into public.campaigns (workspace_id, name, created_by) values ($1, 'Gyms push', $2) returning id`, [wsA, carol]))).id;
    const n = await asUser(db, carol, (tx) => one<{ n: number }>(tx, `select public.campaign_add_recipients($1, $2) n`, [campaignId, JSON.stringify({ category: undefined, cities: ['Karachi'] })]));
    expect(n.n).toBe(1); // Gym Two is opted out
    const again = await asUser(db, carol, (tx) => one<{ n: number }>(tx, `select public.campaign_add_recipients($1, $2) n`, [campaignId, '{}']));
    expect(again.n).toBe(1); // Smile Dental added, Gym One already present, others not sendable
  });

  it("other members cannot edit someone else's campaign; admins can", async () => {
    const ivan = await createUser(db, 'ivan@a.test');
    await addMember(wsA, ivan, 'member');
    const res = await asUser(db, ivan, (tx) => tx.query(`update public.campaigns set status = 'running' where id = $1`, [campaignId]));
    expect(res.affectedRows).toBe(0);
    const res2 = await asUser(db, alice, (tx) => tx.query(`update public.campaigns set status = 'running' where id = $1`, [campaignId]));
    expect(res2.affectedRows).toBe(1);
  });

  it('stats view respects RLS and counts recipients', async () => {
    const s = await asUser(db, carol, (tx) => one<{ total: number; pending: number }>(tx, `select total, pending from public.campaign_stats where campaign_id = $1`, [campaignId]));
    expect(s).toEqual({ total: 2, pending: 2 });
    expect(await asUser(db, bob, (tx) => rows(tx, `select * from public.campaign_stats where campaign_id = $1`, [campaignId]))).toHaveLength(0);
  });

  it('only the engine can claim recipients, and each claim is exclusive', async () => {
    const acc = (await one<{ id: string }>(db, `select id from public.whatsapp_accounts where label = 'Carol phone'`)).id;
    await expect(asUser(db, carol, (tx) => tx.query(`select * from public.claim_next_recipient($1, $2)`, [campaignId, acc]))).rejects.toThrow(/permission denied/);
    const first = await asService(db, (tx) => rows<{ id: string; status: string; account_id: string }>(tx, `select * from public.claim_next_recipient($1, $2)`, [campaignId, acc]));
    const second = await asService(db, (tx) => rows<{ id: string }>(tx, `select * from public.claim_next_recipient($1, $2)`, [campaignId, acc]));
    const third = await asService(db, (tx) => rows(tx, `select * from public.claim_next_recipient($1, $2)`, [campaignId, acc]));
    expect(first[0]!.status).toBe('sending');
    expect(first[0]!.account_id).toBe(acc);
    expect(second[0]!.id).not.toBe(first[0]!.id);
    expect(third).toHaveLength(0);
  });
});

describe('analytics', () => {
  it('dashboard_overview returns a full payload for members only', async () => {
    const d = await asUser(db, carol, (tx) => one<{ d: Record<string, any> }>(tx, `select public.dashboard_overview($1, 7) d`, [wsA]));
    expect(d.d.leads.total).toBe(5);
    expect(d.d.series).toHaveLength(7);
    expect(d.d.stages).toHaveLength(8);
    expect(d.d.messages.sent).toBe(0);
    await expect(asUser(db, bob, (tx) => tx.query(`select public.dashboard_overview($1, 7)`, [wsA]))).rejects.toThrow(/Not a member/);
  });

  it('team_performance lists every member', async () => {
    const t = await asUser(db, alice, (tx) => rows<{ full_name: string; leads_owned: number }>(tx, `select * from public.team_performance($1, 30)`, [wsA]));
    expect(t.map((r) => r.full_name)).toEqual(expect.arrayContaining(['Alice', 'Carol', 'Victor']));
    expect(t.find((r) => r.full_name === 'Carol')!.leads_owned).toBe(1);
  });
});
