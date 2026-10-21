import { beforeAll, describe, expect, it } from 'vitest';
import { asService, asUser, createDb, createUser, one, rows, type Db } from './harness';

let db: Db;
let admin: string;
let ali: string; // member who owns the number
let bina: string; // member without access to it
let ws: string;
let msg: string;
let queued: string;

beforeAll(async () => {
  db = await createDb();
  admin = await createUser(db, 'admin@agency.test', 'Ayesha Admin');
  ali = await createUser(db, 'ali@agency.test', 'Ali Agent');
  bina = await createUser(db, 'bina@agency.test', 'Bina Agent');
  ws = (await asUser(db, admin, (tx) => one<{ id: string }>(tx, `select public.create_workspace('Agency') as id`))).id;
  await db.query(`insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member'), ($1, $3, 'member')`, [ws, ali, bina]);
  const acc = await asService(db, (tx) => one<{ id: string }>(tx, `insert into public.whatsapp_accounts (workspace_id, owner_id, label) values ($1, $2, 'Ali phone') returning id`, [ws, ali]));
  const lead = await asUser(db, ali, (tx) => one<{ id: string }>(tx, `insert into public.leads (workspace_id, business_name, phone) values ($1, 'Ali Clinic', '923001000001') returning id`, [ws]));
  msg = (
    await asService(db, (tx) =>
      one<{ id: string }>(
        tx,
        `insert into public.messages (workspace_id, lead_id, account_id, direction, body, wa_message_id, status) values ($1, $2, $3, 'in', 'Interested!', 'WA1', 'received') returning id`,
        [ws, lead.id, acc.id],
      ),
    )
  ).id;
  queued = (
    await asService(db, (tx) =>
      one<{ id: string }>(tx, `insert into public.messages (workspace_id, lead_id, account_id, direction, body) values ($1, $2, $3, 'out', 'Hi') returning id`, [ws, lead.id, acc.id]),
    )
  ).id;
}, 60_000);

describe('WhatsApp reactions', () => {
  it('the number owner can react; the engine picks it up', async () => {
    await asUser(db, ali, (tx) => tx.query(`select public.message_react($1, '👍')`, [msg]));
    const m = await one<{ reaction_out: string; reaction_out_pending: boolean }>(db, `select reaction_out, reaction_out_pending from public.messages where id = $1`, [msg]);
    expect(m).toEqual({ reaction_out: '👍', reaction_out_pending: true });
  });

  it('an empty emoji removes the reaction', async () => {
    await asUser(db, ali, (tx) => tx.query(`select public.message_react($1, '')`, [msg]));
    const m = await one<{ reaction_out: string | null }>(db, `select reaction_out from public.messages where id = $1`, [msg]);
    expect(m.reaction_out).toBeNull();
  });

  it('admins can react from any number; others cannot', async () => {
    await asUser(db, admin, (tx) => tx.query(`select public.message_react($1, '❤️')`, [msg]));
    await expect(asUser(db, bina, (tx) => tx.query(`select public.message_react($1, '😂')`, [msg]))).rejects.toThrow(/can't send from this WhatsApp number/);
    const m = await one<{ reaction_out: string }>(db, `select reaction_out from public.messages where id = $1`, [msg]);
    expect(m.reaction_out).toBe('❤️');
  });

  it('messages that were not sent yet cannot be reacted to', async () => {
    await expect(asUser(db, ali, (tx) => tx.query(`select public.message_react($1, '👍')`, [queued]))).rejects.toThrow(/can't be reacted to yet/);
  });

  it('people cannot set reaction columns directly', async () => {
    await expect(asUser(db, ali, (tx) => tx.query(`update public.messages set reaction_in = '👎' where id = $1`, [msg]))).rejects.toThrow(/permission denied/);
  });
});

describe('team chat reactions', () => {
  it('adding and removing a reaction touches the message so other people update live', async () => {
    const general = await one<{ id: string }>(db, `select id from public.chat_channels where workspace_id = $1 and name = 'general'`, [ws]);
    const m = await asUser(db, ali, (tx) =>
      one<{ id: string }>(tx, `insert into public.chat_messages (workspace_id, channel_id, author_id, body) values ($1, $2, $3, 'deal closed') returning id`, [ws, general.id, ali]),
    );
    const at = async () => (await one<{ reacted_at: string | null }>(db, `select reacted_at from public.chat_messages where id = $1`, [m.id])).reacted_at;
    expect(await at()).toBeNull();

    await asUser(db, bina, (tx) => tx.query(`insert into public.chat_reactions (message_id, workspace_id, user_id, emoji) values ($1, $2, $3, '🎉')`, [m.id, ws, bina]));
    const first = await at();
    expect(first).not.toBeNull();

    await db.query(`update public.chat_messages set reacted_at = '2000-01-01' where id = $1`, [m.id]);
    await asUser(db, bina, (tx) => tx.query(`delete from public.chat_reactions where message_id = $1 and user_id = $2`, [m.id, bina]));
    expect(new Date((await at())!).getFullYear()).toBeGreaterThan(2000);

    // Reacting twice is harmless.
    const twice = `insert into public.chat_reactions (message_id, workspace_id, user_id, emoji) values ($1, $2, $3, '👍') on conflict do nothing`;
    await asUser(db, ali, (tx) => tx.query(twice, [m.id, ws, ali]));
    await asUser(db, ali, (tx) => tx.query(twice, [m.id, ws, ali]));
    expect(await rows(db, `select 1 from public.chat_reactions where message_id = $1`, [m.id])).toHaveLength(1);
  });
});
