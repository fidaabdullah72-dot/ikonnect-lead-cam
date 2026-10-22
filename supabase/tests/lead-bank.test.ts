import { beforeAll, describe, expect, it } from 'vitest';
import { asUser, createDb, createUser, one, rows, type Db } from './harness';

let db: Db;
let owner: string;
let ali: string;
let outsider: string;
let ws: string;
const ids: Record<string, string> = {};

const names = async (user: string, filters: object) =>
  (await asUser(db, user, (tx) => rows<{ business_name: string }>(tx, `select business_name from public.filtered_leads($1, $2) order by business_name`, [ws, filters]))).map(
    (r) => r.business_name,
  );

beforeAll(async () => {
  db = await createDb();
  owner = await createUser(db, 'owner@agency.test', 'Olivia Owner');
  ali = await createUser(db, 'ali@agency.test', 'Ali Agent');
  outsider = await createUser(db, 'x@other.test', 'Xavier');
  ws = (await asUser(db, owner, (tx) => one<{ id: string }>(tx, `select public.create_workspace('Agency') as id`))).id;
  await db.query(`insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')`, [ws, ali]);
  const add = async (user: string, name: string, phone: string, website: string | null, country: string | null) =>
    (ids[name] = (
      await asUser(db, user, (tx) =>
        one<{ id: string }>(tx, `insert into public.leads (workspace_id, business_name, phone, website, country, created_by) values ($1, $2, $3, $4, $5, $6) returning id`, [
          ws,
          name,
          phone,
          website,
          country,
          user,
        ]),
      )
    ).id);
  await add(owner, 'Smile Dental', '923001000001', 'https://www.SmileDental.pk/contact', 'PK');
  await add(owner, 'Pizza Hut Gulberg', '923001000002', null, 'PK');
  await add(ali, 'Burger Lab', '923001000003', 'facebook.com/burgerlab', 'PK');
  await add(ali, 'Austin Dentist', '15125550100', 'austin dentist', 'US');
}, 60_000);

describe('shared lead bank', () => {
  it('members see every lead by default; lead searches only with the lead finder permission', async () => {
    expect(await names(ali, {})).toHaveLength(4);
    await asUser(db, owner, (tx) => tx.query(`insert into public.scrape_jobs (workspace_id, created_by, keywords, country) values ($1, $2, '{dentists}', 'US')`, [ws, owner]));
    const jobs = () => asUser(db, ali, (tx) => rows(tx, `select id from public.scrape_jobs where workspace_id = $1`, [ws]));
    expect(await jobs()).toHaveLength(0);
    await asUser(db, owner, (tx) => tx.query(`update public.workspace_members set permissions = '{"scrape": true}' where workspace_id = $1 and user_id = $2`, [ws, ali]));
    expect(await jobs()).toHaveLength(1);
  });

  it('stopping a queued search finishes it at once', async () => {
    const j = await asUser(db, ali, (tx) => one<{ id: string }>(tx, `insert into public.scrape_jobs (workspace_id, created_by, keywords) values ($1, $2, '{gyms}') returning id`, [ws, ali]));
    await asUser(db, ali, (tx) => tx.query(`update public.scrape_jobs set cancel_requested = true where id = $1`, [j.id]));
    const r = await one<{ status: string; finished_at: string | null }>(db, `select status, finished_at from public.scrape_jobs where id = $1`, [j.id]);
    expect(r.status).toBe('cancelled');
    expect(r.finished_at).not.toBeNull();
  });

  it('the same business can only be saved once, whoever scrapes it', async () => {
    await expect(
      asUser(db, ali, (tx) => tx.query(`insert into public.leads (workspace_id, business_name, phone) values ($1, 'Smile Dental (again)', '923001000001')`, [ws])),
    ).rejects.toThrow(/leads_ws_phone_key/);
  });

  it('outsiders see nothing', async () => {
    expect(await asUser(db, outsider, (tx) => rows(tx, `select id from public.filtered_leads($1, '{}')`, [ws]))).toHaveLength(0);
    await expect(asUser(db, outsider, (tx) => tx.query(`select public.lead_inventory($1)`, [ws]))).rejects.toThrow(/Not a member/);
  });
});

describe('lead filters', () => {
  it('finds numbers by country code, international or local format', async () => {
    expect(await names(owner, { q: '+92' })).toEqual(['Burger Lab', 'Pizza Hut Gulberg', 'Smile Dental']);
    expect(await names(owner, { q: '+1' })).toEqual(['Austin Dentist']);
    expect(await names(owner, { q: '0300 1000002' })).toEqual(['Pizza Hut Gulberg']);
    expect(await names(owner, { q: '512 555' })).toEqual(['Austin Dentist']);
  });

  it('filters by phone country code', async () => {
    expect(await names(owner, { phone_codes: ['1'] })).toEqual(['Austin Dentist']);
    expect(await names(owner, { phone_codes: ['92', '1'] })).toHaveLength(4);
    expect(await names(owner, { phone_codes: ['44'] })).toEqual([]);
  });

  it('filters by category and city together, for members too', async () => {
    await db.query(`update public.leads set category = 'Dentist', city = 'Lahore' where workspace_id = $1 and business_name in ('Smile Dental', 'Austin Dentist')`, [ws]);
    await db.query(`update public.leads set city = 'Austin' where workspace_id = $1 and business_name = 'Austin Dentist'`, [ws]);
    expect(await names(ali, { categories: ['Dentist'] })).toEqual(['Austin Dentist', 'Smile Dental']);
    expect(await names(ali, { categories: ['Dentist'], cities: ['Lahore'] })).toEqual(['Smile Dental']);
  });

  it('extracts the website domain and grades the website', async () => {
    const r = await rows<{ business_name: string; website_domain: string | null; kind: string }>(
      db,
      `select business_name, website_domain, public.website_kind(website_domain) as kind from public.leads where workspace_id = $1 order by business_name`,
      [ws],
    );
    expect(r).toEqual([
      { business_name: 'Austin Dentist', website_domain: 'austin dentist', kind: 'invalid' },
      { business_name: 'Burger Lab', website_domain: 'facebook.com', kind: 'social' },
      { business_name: 'Pizza Hut Gulberg', website_domain: null, kind: 'none' },
      { business_name: 'Smile Dental', website_domain: 'smiledental.pk', kind: 'site' },
    ]);
  });

  it('filters by website quality', async () => {
    expect(await names(ali, { website: 'site' })).toEqual(['Smile Dental']);
    expect(await names(ali, { website: 'none' })).toEqual(['Pizza Hut Gulberg']);
    expect(await names(ali, { website: 'no_site' })).toEqual(['Austin Dentist', 'Burger Lab', 'Pizza Hut Gulberg']);
  });

  it('filters by country, name, domain and who added the lead', async () => {
    expect(await names(ali, { countries: ['US'] })).toEqual(['Austin Dentist']);
    expect(await names(ali, { name: 'dent' })).toEqual(['Austin Dentist', 'Smile Dental']);
    expect(await names(ali, { domain: 'smiledental' })).toEqual(['Smile Dental']);
    expect(await names(ali, { created_by_ids: [ali] })).toEqual(['Austin Dentist', 'Burger Lab']);
    expect(await names(ali, { countries: ['PK'], website: 'no_site', created_by_ids: [owner] })).toEqual(['Pizza Hut Gulberg']);
  });

  it('filters by campaign membership across the team', async () => {
    const c = (await asUser(db, owner, (tx) => one<{ id: string }>(tx, `insert into public.campaigns (workspace_id, name, created_by) values ($1, 'Owner only', $2) returning id`, [ws, owner]))).id;
    await asUser(db, owner, (tx) => tx.query(`select public.campaign_add_recipients($1, null, $2)`, [c, [ids['Smile Dental']]]));
    // Ali can't open Olivia's private campaign, but still sees the lead is taken.
    expect(await names(ali, { campaign: 'any' })).toEqual(['Smile Dental']);
    expect(await names(ali, { campaign: 'never' })).toEqual(['Austin Dentist', 'Burger Lab', 'Pizza Hut Gulberg']);
    expect(await names(owner, { campaign_ids: [c] })).toEqual(['Smile Dental']);
    expect(await names(owner, { exclude_campaign_ids: [c], countries: ['PK'] })).toEqual(['Burger Lab', 'Pizza Hut Gulberg']);
  });
});

describe('lead inventory', () => {
  it('reports the team-wide lead bank to every member', async () => {
    const inv = await asUser(db, ali, (tx) => one<{ v: { totals: Record<string, number>; by_member: Array<{ user_id: string; count: number }>; recent_jobs: unknown[] } }>(tx, `select public.lead_inventory($1) as v`, [ws]));
    expect(inv.v.totals).toMatchObject({ total: 4, new_7d: 4, in_campaigns: 1, available: 3, with_site: 1, without_site: 3, countries: 2 });
    expect(inv.v.by_member).toEqual(
      expect.arrayContaining([expect.objectContaining({ user_id: owner, count: 2 }), expect.objectContaining({ user_id: ali, count: 2 })]),
    );
    expect(inv.v.recent_jobs).toHaveLength(2);
  });
});
