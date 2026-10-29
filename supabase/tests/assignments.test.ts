import { beforeAll, describe, expect, it } from 'vitest';
import { asUser, createDb, createUser, one, rows, type Db } from './harness';

let db: Db;
let owner: string;
let fizan: string; // member the campaign is assigned to
let sara: string; // member in the team
let other: string; // member with nothing assigned
let ws: string;
let campaign: string;
let team: string;

const notes = (uid: string) => rows<{ type: string; title: string; body: string; link: string }>(db, `select type, title, body, link from public.notifications where user_id = $1 and type = 'assigned'`, [uid]);

beforeAll(async () => {
  db = await createDb();
  owner = await createUser(db, 'owner@agency.test', 'Ayesha Owner');
  fizan = await createUser(db, 'fizan@agency.test', 'Fizan Agent');
  sara = await createUser(db, 'sara@agency.test', 'Sara Agent');
  other = await createUser(db, 'other@agency.test', 'Other Agent');
  ws = (await asUser(db, owner, (tx) => one<{ id: string }>(tx, `select public.create_workspace('Agency') as id`))).id;
  await db.query(`insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'member')`, [ws, fizan, sara, other]);
  await db.query(`update public.workspaces set settings = settings || '{"members_see_all_leads": false}' where id = $1`, [ws]);
  campaign = (await asUser(db, owner, (tx) => one<{ id: string }>(tx, `insert into public.campaigns (workspace_id, name, created_by, status) values ($1, 'Dentists Lahore', $2, 'running') returning id`, [ws, owner]))).id;
  team = (await asUser(db, owner, (tx) => one<{ id: string }>(tx, `insert into public.teams (workspace_id, name) values ($1, 'Sales') returning id`, [ws]))).id;
  await asUser(db, owner, (tx) => tx.query(`insert into public.team_members (team_id, workspace_id, user_id) values ($1, $2, $3), ($1, $2, $4)`, [team, ws, sara, owner]));
}, 60_000);

describe('assigning a campaign', () => {
  it('the assigned member sees the running campaign and gets a notification', async () => {
    expect(await asUser(db, fizan, (tx) => rows(tx, `select 1 from public.campaigns where id = $1`, [campaign]))).toHaveLength(0);
    await asUser(db, owner, (tx) =>
      tx.query(`insert into public.resource_access (workspace_id, resource_type, resource_id, user_id, access, granted_by) values ($1, 'campaign', $2, $3, 'manage', $4)`, [ws, campaign, fizan, owner]),
    );
    expect(await asUser(db, fizan, (tx) => rows(tx, `select 1 from public.campaigns where id = $1`, [campaign]))).toHaveLength(1);
    expect(await asUser(db, fizan, (tx) => rows(tx, `select 1 from public.campaign_stats where campaign_id = $1`, [campaign]))).toHaveLength(1);
    const [n] = await notes(fizan);
    expect(n).toEqual({
      type: 'assigned',
      title: 'Campaign assigned to you',
      body: 'Dentists Lahore · by Ayesha Owner · you can run and edit it',
      link: `/campaigns/${campaign}`,
    });
  });

  it('the member can read their own assignment; the owner sees who it is assigned to', async () => {
    expect(await asUser(db, fizan, (tx) => rows(tx, `select user_id from public.resource_access where resource_id = $1`, [campaign]))).toEqual([{ user_id: fizan }]);
    expect(await asUser(db, owner, (tx) => rows(tx, `select user_id from public.resource_access where resource_id = $1`, [campaign]))).toEqual([{ user_id: fizan }]);
  });

  it('assigning to a team notifies its members, but not the person who assigned it', async () => {
    await asUser(db, owner, (tx) =>
      tx.query(`insert into public.resource_access (workspace_id, resource_type, resource_id, team_id, access, granted_by) values ($1, 'campaign', $2, $3, 'view', $4)`, [ws, campaign, team, owner]),
    );
    expect((await notes(sara)).map((n) => n.body)).toEqual(['Dentists Lahore · by Ayesha Owner · you can follow its progress']);
    expect(await notes(owner)).toHaveLength(0);
    expect(await notes(other)).toHaveLength(0);
    expect(await asUser(db, other, (tx) => rows(tx, `select 1 from public.campaigns where id = $1`, [campaign]))).toHaveLength(0);
  });

  it('members cannot assign campaigns they did not create', async () => {
    await expect(
      asUser(db, fizan, (tx) =>
        tx.query(`insert into public.resource_access (workspace_id, resource_type, resource_id, user_id, access, granted_by) values ($1, 'campaign', $2, $3, 'view', $4)`, [ws, campaign, other, fizan]),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});
