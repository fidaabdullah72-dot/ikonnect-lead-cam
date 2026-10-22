import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { asService, asUser, createDb, createUser, one, rows, type Db } from './harness';

let db: Db;
let admin: string;
let ali: string;
let bina: string;
let viewer: string;
let outsider: string;
let ws: string;
let aliPhone: string;
let binaPhone: string;
const leads: Record<string, string> = {};

const members = async (conversation: string) =>
  one<{ member_ids: string[]; last_sender_id: string | null }>(db, `select member_ids, last_sender_id from public.conversations where id = $1`, [conversation]);

const conversation = (account: string, lead: string) =>
  asService(db, (tx) =>
    one<{ id: string }>(tx, `insert into public.conversations (workspace_id, account_id, lead_id, last_message_at) values ($1, $2, $3, now()) returning id`, [ws, account, lead]),
  ).then((r) => r.id);

const sent = (conv: string, lead: string, account: string, extra: { sent_by?: string; campaign_id?: string } = {}) =>
  asService(db, (tx) =>
    tx.query(
      `insert into public.messages (workspace_id, conversation_id, lead_id, account_id, direction, body, status, sent_by, campaign_id)
       values ($1, $2, $3, $4, 'out', 'Hello', 'sent', $5, $6)`,
      [ws, conv, lead, account, extra.sent_by ?? null, extra.campaign_id ?? null],
    ),
  );

beforeAll(async () => {
  db = await createDb();
  admin = await createUser(db, 'admin@agency.test', 'Ayesha Admin');
  ali = await createUser(db, 'ali@agency.test', 'Ali Agent');
  bina = await createUser(db, 'bina@agency.test', 'Bina Agent');
  viewer = await createUser(db, 'vic@agency.test', 'Vic Viewer');
  outsider = await createUser(db, 'x@other.test', 'Xavier');
  ws = (await asUser(db, admin, (tx) => one<{ id: string }>(tx, `select public.create_workspace('Agency') as id`))).id;
  await db.query(`insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'viewer')`, [
    ws,
    ali,
    bina,
    viewer,
  ]);
  aliPhone = (await asService(db, (tx) => one<{ id: string }>(tx, `insert into public.whatsapp_accounts (workspace_id, owner_id, label) values ($1, $2, 'Ali phone') returning id`, [ws, ali]))).id;
  binaPhone = (await asService(db, (tx) => one<{ id: string }>(tx, `insert into public.whatsapp_accounts (workspace_id, owner_id, label) values ($1, $2, 'Bina phone') returning id`, [ws, bina]))).id;
  for (const [name, phone] of [
    ['Smile Dental', '923001000001'],
    ['Pizza Point', '923001000002'],
    ['Gym One', '923001000003'],
  ] as const) {
    leads[name] = (await asUser(db, admin, (tx) => one<{ id: string }>(tx, `insert into public.leads (workspace_id, business_name, phone) values ($1, $2, $3) returning id`, [ws, name, phone]))).id;
  }
}, 60_000);

describe('lead finder access', () => {
  it('members and viewers neither see nor start lead searches by default', async () => {
    await asUser(db, admin, (tx) => tx.query(`insert into public.scrape_jobs (workspace_id, created_by, keywords, depth, area_limit) values ($1, $2, '{dentists}', 'deep', 25)`, [ws, admin]));
    expect(await asUser(db, admin, (tx) => rows(tx, `select id from public.scrape_jobs where workspace_id = $1`, [ws]))).toHaveLength(1);
    expect(await asUser(db, ali, (tx) => rows(tx, `select id from public.scrape_jobs where workspace_id = $1`, [ws]))).toHaveLength(0);
    expect(await asUser(db, viewer, (tx) => rows(tx, `select id from public.scrape_jobs where workspace_id = $1`, [ws]))).toHaveLength(0);
    await expect(
      asUser(db, ali, (tx) => tx.query(`insert into public.scrape_jobs (workspace_id, created_by, keywords) values ($1, $2, '{gyms}')`, [ws, ali])),
    ).rejects.toThrow(/row-level security/);
  });

  it('an admin can let a member use the lead finder', async () => {
    await asUser(db, admin, (tx) => tx.query(`update public.workspace_members set permissions = '{"scrape": true}' where workspace_id = $1 and user_id = $2`, [ws, ali]));
    await asUser(db, ali, (tx) => tx.query(`insert into public.scrape_jobs (workspace_id, created_by, keywords) values ($1, $2, '{gyms}')`, [ws, ali]));
    expect(await asUser(db, ali, (tx) => rows(tx, `select id from public.scrape_jobs where workspace_id = $1`, [ws]))).toHaveLength(2);
    expect(await asUser(db, bina, (tx) => rows(tx, `select id from public.scrape_jobs where workspace_id = $1`, [ws]))).toHaveLength(0);
  });

  it('new searches default to a standard search; deep options are stored', async () => {
    const r = await rows<{ depth: string; area_limit: number | null; recheck: boolean }>(db, `select depth, area_limit, recheck from public.scrape_jobs where workspace_id = $1 order by created_at`, [ws]);
    expect(r).toEqual([
      { depth: 'deep', area_limit: 25, recheck: false },
      { depth: 'standard', area_limit: null, recheck: false },
    ]);
  });

  it('the memory of searched map zones is engine-only', async () => {
    await asService(db, (tx) => tx.query(`insert into public.scrape_coverage (workspace_id, keyword, zone, area, found, fresh, dense) values ($1, 'dentists', '13/5767/3301', 'lahore', 120, 80, true)`, [ws]));
    await expect(asUser(db, admin, (tx) => tx.query(`select * from public.scrape_coverage`))).rejects.toThrow(/permission denied/);
    await expect(asUser(db, admin, (tx) => tx.query(`insert into public.scrape_coverage (workspace_id, keyword, zone) values ($1, 'x', 'y')`, [ws]))).rejects.toThrow(/permission denied/);
  });
});

describe('inbox folders', () => {
  let c1: string; // Smile Dental on Ali's number
  let c2: string; // Pizza Point on Bina's number
  let c3: string; // Gym One on Ali's number

  it("a new chat lands in the number owner's folder", async () => {
    c1 = await conversation(aliPhone, leads['Smile Dental']!);
    expect(await members(c1)).toEqual({ member_ids: [ali], last_sender_id: null });
  });

  it('whoever sends a message joins the chat', async () => {
    await sent(c1, leads['Smile Dental']!, aliPhone, { sent_by: admin });
    expect(await members(c1)).toEqual({ member_ids: [ali, admin], last_sender_id: admin });
    await sent(c1, leads['Smile Dental']!, aliPhone, { sent_by: ali });
    expect(await members(c1)).toEqual({ member_ids: [ali, admin], last_sender_id: ali });
  });

  it("campaign messages count for the campaign's creator, phone messages for the number's owner", async () => {
    c2 = await conversation(binaPhone, leads['Pizza Point']!);
    const camp = await asService(db, (tx) => one<{ id: string }>(tx, `insert into public.campaigns (workspace_id, name, created_by) values ($1, 'Promo', $2) returning id`, [ws, admin]));
    await sent(c2, leads['Pizza Point']!, binaPhone, { campaign_id: camp.id });
    expect(await members(c2)).toEqual({ member_ids: [bina, admin], last_sender_id: admin });
    await sent(c2, leads['Pizza Point']!, binaPhone);
    expect((await members(c2)).last_sender_id).toBe(bina);
  });

  it('a message queued in the dashboard joins once the engine has sent it', async () => {
    c3 = await conversation(aliPhone, leads['Gym One']!);
    const m = await asService(db, (tx) =>
      one<{ id: string }>(tx, `insert into public.messages (workspace_id, lead_id, account_id, direction, body, sent_by) values ($1, $2, $3, 'out', 'Hi', $4) returning id`, [
        ws,
        leads['Gym One']!,
        aliPhone,
        bina,
      ]),
    );
    expect((await members(c3)).member_ids).toEqual([ali]);
    await asService(db, (tx) => tx.query(`update public.messages set conversation_id = $1, status = 'sent' where id = $2`, [c3, m.id]));
    expect(await members(c3)).toEqual({ member_ids: [ali, bina], last_sender_id: bina });
  });

  it('counts chats and unread chats per teammate and per team', async () => {
    await asService(db, (tx) => tx.query(`update public.conversations set unread_count = 2 where id = $1`, [c2]));
    const team = await asUser(db, admin, (tx) => one<{ id: string }>(tx, `insert into public.teams (workspace_id, name) values ($1, 'Sales') returning id`, [ws]));
    await asUser(db, admin, (tx) => tx.query(`insert into public.team_members (team_id, workspace_id, user_id) values ($1, $2, $3), ($1, $2, $4)`, [team.id, ws, ali, bina]));
    const folders = await asUser(db, admin, (tx) =>
      rows<{ kind: string; id: string; conversations: number; unread: number }>(tx, `select * from public.inbox_folders($1) order by kind, conversations desc`, [ws]),
    );
    const byId = new Map(folders.map((f) => [`${f.kind}:${f.id}`, f]));
    expect(byId.get('all:null')).toMatchObject({ conversations: 3, unread: 1 });
    expect(byId.get(`member:${ali}`)).toMatchObject({ conversations: 2, unread: 0 });
    expect(byId.get(`member:${admin}`)).toMatchObject({ conversations: 2, unread: 1 });
    expect(byId.get(`member:${bina}`)).toMatchObject({ conversations: 2, unread: 1 });
    // Every chat has Ali or Bina in it; each is counted once for the team.
    expect(byId.get(`team:${team.id}`)).toMatchObject({ conversations: 3, unread: 1 });
  });

  it('archived chats leave the folder counts; outsiders see nothing', async () => {
    await asService(db, (tx) => tx.query(`update public.conversations set archived = true where id = $1`, [c3]));
    const folders = await asUser(db, admin, (tx) => rows<{ kind: string; id: string; conversations: number }>(tx, `select * from public.inbox_folders($1)`, [ws]));
    expect(folders.find((f) => f.kind === 'member' && f.id === ali)?.conversations).toBe(1);
    expect(await asUser(db, outsider, (tx) => rows(tx, `select * from public.inbox_folders($1) where conversations > 0`, [ws]))).toEqual([]);
  });

  it('members filter their own inbox by folder', async () => {
    const mine = await asUser(db, ali, (tx) => rows<{ id: string }>(tx, `select id from public.conversations where workspace_id = $1 and member_ids @> array[$2::uuid]`, [ws, bina]));
    expect(mine.map((r) => r.id)).toEqual([c3]);
  });
});

describe('private chats', () => {
  const chats = async (user: string) =>
    (await asUser(db, user, (tx) => rows<{ lead_id: string }>(tx, `select lead_id from public.conversations where workspace_id = $1`, [ws]))).map((r) => r.lead_id).sort();
  const messageCount = async (user: string, lead: string) =>
    (await asUser(db, user, (tx) => rows(tx, `select id from public.messages where lead_id = $1`, [lead]))).length;

  it('admins see every chat', async () => {
    expect(await chats(admin)).toEqual([leads['Smile Dental']!, leads['Pizza Point']!, leads['Gym One']!].sort());
  });

  it("members see only their own chats — not admins' or other members'", async () => {
    // Ali: his number's chats (Smile Dental, Gym One); not Pizza Point on Bina's number.
    expect(await chats(ali)).toEqual([leads['Smile Dental']!, leads['Gym One']!].sort());
    expect(await messageCount(ali, leads['Pizza Point']!)).toBe(0);
    expect(await messageCount(ali, leads['Smile Dental']!)).toBe(2);
    // Bina: her number's chat, plus Gym One where she sent a message.
    expect(await chats(bina)).toEqual([leads['Pizza Point']!, leads['Gym One']!].sort());
  });

  it('a chat with an admin-only number stays hidden from members', async () => {
    const adminPhone = (await asService(db, (tx) => one<{ id: string }>(tx, `insert into public.whatsapp_accounts (workspace_id, owner_id, label) values ($1, $2, 'Admin phone') returning id`, [ws, admin]))).id;
    const c = await conversation(adminPhone, leads['Smile Dental']!);
    await sent(c, leads['Smile Dental']!, adminPhone, { sent_by: admin });
    for (const user of [ali, bina]) {
      const seen = await asUser(db, user, (tx) => rows(tx, `select id from public.conversations where id = $1`, [c]));
      expect(seen).toHaveLength(0);
    }
    expect(await asUser(db, admin, (tx) => rows(tx, `select id from public.conversations where id = $1`, [c]))).toHaveLength(1);
  });

  it('viewers see no chats; members cannot change chats they cannot see', async () => {
    expect(await chats(viewer)).toEqual([]);
    const pizza = await one<{ id: string }>(db, `select id from public.conversations where lead_id = $1`, [leads['Pizza Point']!]);
    const r = await asUser(db, ali, (tx) => tx.query(`update public.conversations set archived = true where id = $1`, [pizza.id]));
    expect(r.affectedRows).toBe(0);
  });

  it('a message typed in the dashboard is visible to its sender before it is sent', async () => {
    const m = await asUser(db, ali, (tx) =>
      one<{ id: string }>(tx, `insert into public.messages (workspace_id, lead_id, account_id, direction, body, status, sent_by) values ($1, $2, $3, 'out', 'Hi', 'queued', $4) returning id`, [
        ws,
        leads['Pizza Point']!,
        aliPhone,
        ali,
      ]),
    );
    expect(await asUser(db, ali, (tx) => rows(tx, `select id from public.messages where id = $1`, [m.id]))).toHaveLength(1);
    expect(await asUser(db, bina, (tx) => rows(tx, `select id from public.messages where id = $1`, [m.id]))).toHaveLength(0);
  });
});

describe('duplicate sent messages', () => {
  it("WhatsApp's echo of a dashboard message is removed; a real phone message is kept", async () => {
    const lead = leads['Gym One']!;
    const conv = (await one<{ id: string }>(db, `select id from public.conversations where lead_id = $1 and account_id = $2`, [lead, aliPhone])).id;
    const ins = (body: string, sentBy: string | null, at: string) =>
      asService(db, (tx) =>
        one<{ id: string }>(
          tx,
          `insert into public.messages (workspace_id, conversation_id, lead_id, account_id, direction, body, status, sent_by, created_at) values ($1, $2, $3, $4, 'out', $5, 'sent', $6, $7) returning id`,
          [ws, conv, lead, aliPhone, body, sentBy, at],
        ),
      );
    const original = await ins('Price list attached', ali, '2026-10-20T10:00:00Z');
    const echo = await ins('Price list attached', null, '2026-10-20T10:00:02Z');
    const phone = await ins('Price list attached', null, '2026-10-20T15:00:00Z'); // hours later: typed on the phone
    await db.exec(readFileSync(join(import.meta.dirname, '..', 'migrations', '20261022000002_remove_echo_duplicates.sql'), 'utf8'));
    const left = (await rows<{ id: string }>(db, `select id from public.messages where id = any($1)`, [[original.id, echo.id, phone.id]])).map((r) => r.id);
    expect(left.sort()).toEqual([original.id, phone.id].sort());
  });
});
