import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asService, asUser, createDb, createUser, one, rows, type Db } from './harness';

let db: Db;
let owner: string;
let ws: string;
let acc: string;
let lead: string;

const kinds = async () => (await rows<{ kind: string }>(db, `select kind from public.engine_signals order by kind`)).map((r) => r.kind);

beforeAll(async () => {
  db = await createDb();
  owner = await createUser(db, 'owner@agency.test', 'Olivia Owner');
  ws = (await asUser(db, owner, (tx) => one<{ id: string }>(tx, `select public.create_workspace('Agency') as id`))).id;
  acc = (await asService(db, (tx) => one<{ id: string }>(tx, `insert into public.whatsapp_accounts (workspace_id, owner_id, label) values ($1, $2, 'Main') returning id`, [ws, owner]))).id;
  lead = (await asUser(db, owner, (tx) => one<{ id: string }>(tx, `insert into public.leads (workspace_id, business_name, phone) values ($1, 'Smile Dental', '923001000001') returning id`, [ws]))).id;
}, 60_000);

beforeEach(async () => {
  await db.query(`delete from public.engine_signals`);
});

describe('engine signals', () => {
  it('a message typed in the dashboard wakes the outbox; received messages do not', async () => {
    await asService(db, (tx) => tx.query(`insert into public.messages (workspace_id, lead_id, account_id, direction, body, status) values ($1, $2, $3, 'in', 'hi', 'received')`, [ws, lead, acc]));
    expect(await kinds()).toEqual([]);
    await asUser(db, owner, (tx) => tx.query(`insert into public.messages (workspace_id, lead_id, account_id, direction, body, status, sent_by) values ($1, $2, $3, 'out', 'hello', 'queued', $4)`, [ws, lead, acc, owner]));
    expect(await kinds()).toEqual(['outbox']);
  });

  it('connect / disconnect wakes the session manager; engine status updates do not', async () => {
    await asService(db, (tx) => tx.query(`update public.whatsapp_accounts set status = 'qr', last_error = null where id = $1`, [acc]));
    expect(await kinds()).toEqual([]);
    await asUser(db, owner, (tx) => tx.query(`update public.whatsapp_accounts set desired_state = 'connected' where id = $1`, [acc]));
    expect(await kinds()).toEqual(['accounts']);
  });

  it('a number coming online wakes waiting work', async () => {
    await asService(db, (tx) => tx.query(`update public.whatsapp_accounts set status = 'connected' where id = $1`, [acc]));
    expect(await kinds()).toEqual(['connected']);
    await db.query(`delete from public.engine_signals`);
    await asService(db, (tx) => tx.query(`update public.whatsapp_accounts set last_seen_at = now() where id = $1`, [acc]));
    expect(await kinds()).toEqual([]);
  });

  it('starting a campaign and adding leads wake the campaign runner; status notes do not', async () => {
    const c = await asUser(db, owner, (tx) => one<{ id: string }>(tx, `insert into public.campaigns (workspace_id, name, created_by) values ($1, 'Q4', $2) returning id`, [ws, owner]));
    expect(await kinds()).toEqual(['campaigns']);
    await db.query(`delete from public.engine_signals`);
    await asService(db, (tx) => tx.query(`update public.campaigns set paused_reason = 'Outside sending hours' where id = $1`, [c.id]));
    expect(await kinds()).toEqual([]);
    await asService(db, (tx) => tx.query(`update public.campaigns set status = 'running' where id = $1`, [c.id]));
    expect(await kinds()).toEqual(['campaigns']);
  });

  it('lead searches, background jobs and automation events wake their workers', async () => {
    await asUser(db, owner, (tx) => tx.query(`insert into public.scrape_jobs (workspace_id, created_by, name, keywords, locations, queries) values ($1, $2, 'x', '{a}', '{b}', '{a in b}')`, [ws, owner]));
    await asUser(db, owner, (tx) => tx.query(`insert into public.engine_jobs (workspace_id, type, created_by) values ($1, 'enrich_leads', $2)`, [ws, owner]));
    await asUser(db, owner, (tx) =>
      tx.query(`insert into public.automations (workspace_id, name, trigger, actions, created_by) values ($1, 'Won → notify', 'stage_changed', '[{"type":"notify","target":"owner"}]', $2)`, [ws, owner]),
    );
    await asUser(db, owner, (tx) => tx.query(`update public.leads set stage_id = (select id from public.pipeline_stages where workspace_id = $1 order by position desc limit 1) where id = $2`, [ws, lead]));
    expect(await kinds()).toEqual(['automation', 'jobs', 'scrape']);
  });

  it('nobody but the engine can read or write signals', async () => {
    await expect(asUser(db, owner, (tx) => tx.query(`select * from public.engine_signals`))).rejects.toThrow(/permission denied/);
  });
});
