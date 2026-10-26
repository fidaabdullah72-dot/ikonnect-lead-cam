import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { asService, asUser, createDb, createUser, one, rows, type Db } from './harness';

const MIGRATION = readFileSync(join(import.meta.dirname, '..', 'migrations', '20261026000001_reply_detection_and_lists.sql'), 'utf8');

let db: Db;
let admin: string;
let ws: string;
let acc: string;
let otherAcc: string;
let campaign: string;
const leads: Record<'auto' | 'real' | 'early' | 'elsewhere', string> = { auto: '', real: '', early: '', elsewhere: '' };
const recipients: Record<keyof typeof leads, string> = { auto: '', real: '', early: '', elsewhere: '' };
let list: string;

const T = Date.parse('2026-10-24T05:00:00Z');
const at = (ms: number) => new Date(T + ms).toISOString();

beforeAll(async () => {
  db = await createDb();
  admin = await createUser(db, 'admin@agency.test', 'Ayesha Admin');
  ws = (await asUser(db, admin, (tx) => one<{ id: string }>(tx, `select public.create_workspace('Agency') as id`))).id;
  acc = (await asService(db, (tx) => one<{ id: string }>(tx, `insert into public.whatsapp_accounts (workspace_id, owner_id, label) values ($1, $2, 'Main') returning id`, [ws, admin]))).id;
  otherAcc = (await asService(db, (tx) => one<{ id: string }>(tx, `insert into public.whatsapp_accounts (workspace_id, owner_id, label) values ($1, $2, 'Second') returning id`, [ws, admin]))).id;
  const replied = await one<{ id: string }>(db, `select id from public.pipeline_stages where workspace_id = $1 and kind = 'replied'`, [ws]);
  campaign = (
    await asService(db, (tx) =>
      one<{ id: string }>(tx, `insert into public.campaigns (workspace_id, name, created_by, status, audience) values ($1, 'Promo', $2, 'running', '{}') returning id`, [ws, admin]),
    )
  ).id;
  await db.query(
    `insert into public.campaign_steps (workspace_id, campaign_id, position, delay_hours, variants) values ($1, $2, 0, 0, '[{"body":"Hi"}]'), ($1, $2, 1, 24, '[{"body":"Follow-up"}]')`,
    [ws, campaign],
  );

  let n = 0;
  for (const key of Object.keys(leads) as Array<keyof typeof leads>) {
    n++;
    leads[key] = (
      await asService(db, (tx) =>
        one<{ id: string }>(tx, `insert into public.leads (workspace_id, business_name, phone, stage_id, last_contacted_at, last_replied_at) values ($1, $2, $3, $4, $5, $6) returning id`, [
          ws,
          `${key} clinic`,
          `92300100000${n}`,
          replied.id,
          at(0),
          at(4000),
        ]),
      )
    ).id;
    const sent = key !== 'early';
    recipients[key] = (
      await asService(db, (tx) =>
        one<{ id: string }>(
          tx,
          `insert into public.campaign_recipients (workspace_id, campaign_id, lead_id, account_id, status, steps_sent, last_sent_at, replied_at, next_send_at)
           values ($1, $2, $3, $4, 'replied', $5, $6, $7, $8) returning id`,
          [ws, campaign, leads[key], acc, sent ? 1 : 0, sent ? at(0) : null, at(4000), at(24 * 3600_000)],
        ),
      )
    ).id;
    if (sent) {
      await db.query(
        `insert into public.messages (workspace_id, lead_id, account_id, campaign_id, recipient_id, step, direction, body, status, created_at) values ($1, $2, $3, $4, $5, 0, 'out', 'Hi', 'delivered', $6)`,
        [ws, leads[key], acc, campaign, recipients[key], at(0)],
      );
    }
  }
  const inbound = (lead: string, account: string, ms: number, body: string) =>
    db.query(`insert into public.messages (workspace_id, lead_id, account_id, direction, body, status, created_at) values ($1, $2, $3, 'in', $4, 'received', $5)`, [ws, lead, account, body, at(ms)]);
  await inbound(leads.auto, acc, 4000, 'Thanks for contacting us! We will reply soon.');
  await inbound(leads.real, acc, 2 * 3600_000, 'Yes, how much does it cost?');
  await inbound(leads.early, acc, -3600_000, 'Hello, are you open?');
  await inbound(leads.elsewhere, otherAcc, 3600_000, 'Who is this?');

  list = (await asUser(db, admin, (tx) => one<{ id: string }>(tx, `insert into public.lead_lists (workspace_id, name, created_by) values ($1, 'Dentists', $2) returning id`, [ws, admin]))).id;
  await asUser(db, admin, (tx) => tx.query(`select public.lead_list_add($1, $2::uuid[])`, [list, [leads.auto, leads.real]]));
  await db.query(`update public.campaigns set audience = jsonb_build_object('mode', 'lists', 'list_ids', jsonb_build_array($2::text)) where id = $1`, [campaign, list]);

  // The correction runs on existing data when the update is applied.
  await db.exec(MIGRATION);
}, 60_000);

const recipient = (key: keyof typeof leads) => one<{ status: string; replied_at: string | null; error: string | null }>(db, `select status, replied_at, error from public.campaign_recipients where id = $1`, [recipients[key]]);
const lead = (key: keyof typeof leads) =>
  one<{ last_replied_at: string | null; kind: string }>(db, `select l.last_replied_at, s.kind from public.leads l join public.pipeline_stages s on s.id = l.stage_id where l.id = $1`, [leads[key]]);

describe('automatic replies', () => {
  it('an incoming message seconds after a campaign message is flagged as an automatic reply', async () => {
    const flagged = await rows<{ lead_id: string; auto_reply: boolean }>(db, `select lead_id, auto_reply from public.messages where direction = 'in'`);
    expect(flagged.find((m) => m.lead_id === leads.auto)?.auto_reply).toBe(true);
    expect(flagged.filter((m) => m.auto_reply)).toHaveLength(1);
  });

  it('a recipient who only sent an automatic reply is put back so follow-ups continue', async () => {
    expect(await recipient('auto')).toMatchObject({ status: 'waiting', replied_at: null });
    const l = await lead('auto');
    expect(l.last_replied_at).toBeNull();
    expect(l.kind).toBe('contacted');
  });

  it('a real reply after the campaign message still counts', async () => {
    expect((await recipient('real')).status).toBe('replied');
    expect((await lead('real')).kind).toBe('replied');
  });

  it('a message sent before the campaign reached the lead is not a reply to it', async () => {
    expect(await recipient('early')).toMatchObject({ status: 'skipped', replied_at: null });
  });

  it('a message to another number is not a reply to this campaign', async () => {
    expect((await recipient('elsewhere')).status).toBe('waiting');
  });

  it('the campaign activity log no longer lists the automatic reply as a reply', async () => {
    await db.query(`insert into public.campaign_events (workspace_id, campaign_id, lead_id, type, message) values ($1, $2, $3, 'replied', 'auto clinic: Thanks')`, [ws, campaign, leads.auto]);
    await db.query(`update public.campaign_recipients set status = 'replied' where id = $1`, [recipients.auto]);
    await db.exec(MIGRATION);
    const e = await one<{ type: string; message: string }>(db, `select type, message from public.campaign_events where lead_id = $1`, [leads.auto]);
    expect(e.type).toBe('info');
    expect(e.message).toMatch(/^Not counted as a reply/);
  });

  it('reports leave automatic replies out', async () => {
    const r = await asUser(db, admin, (tx) => one<{ v: { messages: { received: number } } }>(tx, `select public.dashboard_overview($1, 365) as v`, [ws]));
    const total = await one<{ n: number }>(db, `select count(*)::int as n from public.messages where direction = 'in' and created_at >= now() - interval '365 days'`);
    expect(r.v.messages.received).toBe(total.n - 1);
  });
});

describe('lead list stats', () => {
  it('tracks contacted, replied and the campaigns that used each list', async () => {
    const s = await asUser(db, admin, (tx) => one(tx, `select * from public.lead_list_stats($1) where list_id = $2`, [ws, list]));
    expect(s).toMatchObject({ total: 2, sendable: 2, contacted: 2, replied: 1, in_campaigns: 2, in_active_campaigns: 1, campaigns: 1 });
  });

  it('only shows lists the caller can see', async () => {
    const outsider = await createUser(db, 'outsider@other.test');
    const s = await asUser(db, outsider, (tx) => rows(tx, `select * from public.lead_list_stats($1)`, [ws]));
    expect(s).toHaveLength(0);
  });
});
