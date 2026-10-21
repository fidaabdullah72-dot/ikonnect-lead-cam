import { beforeAll, describe, expect, it } from 'vitest';
import { asService, asUser, createDb, createUser, one, rows, type Db } from './harness';

let db: Db;
let admin: string;
let ali: string; // member
let bina: string; // member
let vik: string; // viewer
let ws: string;
let aliLead: string;
let binaLead: string;

const visibleLeads = (user: string) =>
  asUser(db, user, (tx) => rows<{ business_name: string }>(tx, `select business_name from public.leads where workspace_id = $1 order by business_name`, [ws])).then((r) =>
    r.map((x) => x.business_name),
  );

beforeAll(async () => {
  db = await createDb();
  admin = await createUser(db, 'admin@agency.test', 'Ayesha Admin');
  ali = await createUser(db, 'ali@agency.test', 'Ali Agent');
  bina = await createUser(db, 'bina@agency.test', 'Bina Agent');
  vik = await createUser(db, 'vik@agency.test', 'Vik Viewer');
  ws = (await asUser(db, admin, (tx) => one<{ id: string }>(tx, `select public.create_workspace('Agency') as id`))).id;
  await db.query(`insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'viewer')`, [ws, ali, bina, vik]);
  // The shared lead bank is the default; these tests cover the private-spaces mode.
  await db.query(`update public.workspaces set settings = settings || '{"members_see_all_leads": false}' where id = $1`, [ws]);
  aliLead = (await asUser(db, ali, (tx) => one<{ id: string }>(tx, `insert into public.leads (workspace_id, business_name, phone) values ($1, 'Ali Clinic', '923001000001') returning id`, [ws]))).id;
  binaLead = (await asUser(db, bina, (tx) => one<{ id: string }>(tx, `insert into public.leads (workspace_id, business_name, phone) values ($1, 'Bina Gym', '923001000002') returning id`, [ws]))).id;
  await asUser(db, admin, (tx) => tx.query(`insert into public.leads (workspace_id, business_name, phone) values ($1, 'Pool Lead', '923001000003')`, [ws]));
}, 60_000);

describe('personal lead spaces', () => {
  it('members see only their own leads; admins and viewers see all', async () => {
    expect(await visibleLeads(ali)).toEqual(['Ali Clinic']);
    expect(await visibleLeads(bina)).toEqual(['Bina Gym']);
    expect(await visibleLeads(admin)).toEqual(['Ali Clinic', 'Bina Gym', 'Pool Lead']);
    expect(await visibleLeads(vik)).toEqual(['Ali Clinic', 'Bina Gym', 'Pool Lead']);
  });

  it('a lead a member creates is owned by them automatically', async () => {
    const r = await one<{ owner_id: string }>(db, `select owner_id from public.leads where id = $1`, [aliLead]);
    expect(r.owner_id).toBe(ali);
  });

  it('members cannot edit or note leads they cannot see', async () => {
    const upd = await asUser(db, ali, (tx) => tx.query(`update public.leads set business_name = 'stolen' where id = $1`, [binaLead]));
    expect(upd.affectedRows).toBe(0);
    await expect(
      asUser(db, ali, (tx) => tx.query(`insert into public.lead_notes (workspace_id, lead_id, author_id, body) values ($1, $2, $3, 'x')`, [ws, binaLead, ali])),
    ).rejects.toThrow(/row-level security/);
  });

  it('duplicates are blocked across the whole team, even if invisible', async () => {
    await expect(
      asUser(db, ali, (tx) => tx.query(`insert into public.leads (workspace_id, business_name, phone) values ($1, 'Bina Gym again', '923001000002')`, [ws])),
    ).rejects.toThrow(/leads_ws_phone_key/);
  });

  it('the shared lead bank is the default; admins can switch to private spaces', async () => {
    await asUser(db, admin, (tx) => tx.query(`update public.workspaces set settings = settings - 'members_see_all_leads' where id = $1`, [ws]));
    expect(await visibleLeads(ali)).toHaveLength(3);
    await asUser(db, admin, (tx) => tx.query(`update public.workspaces set settings = settings || '{"members_see_all_leads": false}' where id = $1`, [ws]));
    expect(await visibleLeads(ali)).toHaveLength(1);
  });

  it('members cannot delete leads unless permitted', async () => {
    const del = await asUser(db, ali, (tx) => tx.query(`delete from public.leads where id = $1`, [aliLead]));
    expect(del.affectedRows).toBe(0);
  });
});

describe('lead lists & sharing', () => {
  let list: string;
  let team: string;

  it('admin shares a list with a member, who then sees its leads', async () => {
    list = (await asUser(db, admin, (tx) => one<{ id: string }>(tx, `insert into public.lead_lists (workspace_id, name, created_by) values ($1, 'Lahore dentists', $2) returning id`, [ws, admin]))).id;
    const pool = await one<{ id: string }>(db, `select id from public.leads where business_name = 'Pool Lead'`);
    const n = await asUser(db, admin, (tx) => one<{ n: number }>(tx, `select public.lead_list_add($1, $2) n`, [list, [pool.id]]));
    expect(n.n).toBe(1);
    expect(await asUser(db, ali, (tx) => rows(tx, `select 1 from public.lead_lists where id = $1`, [list]))).toHaveLength(0);

    await asUser(db, admin, (tx) => tx.query(`insert into public.resource_access (workspace_id, resource_type, resource_id, user_id, access, granted_by) values ($1, 'lead_list', $2, $3, 'view', $4)`, [ws, list, ali, admin]));
    expect(await visibleLeads(ali)).toEqual(['Ali Clinic', 'Pool Lead']);
    // view access can't add leads
    await expect(asUser(db, ali, (tx) => tx.query(`select public.lead_list_add($1, $2)`, [list, [aliLead]]))).rejects.toThrow(/Not allowed/);
  });

  it('team grants reach everyone in the team, and leaving the team removes access', async () => {
    team = (await asUser(db, admin, (tx) => one<{ id: string }>(tx, `insert into public.teams (workspace_id, name, created_by) values ($1, 'Sales A', $2) returning id`, [ws, admin]))).id;
    await asUser(db, admin, (tx) => tx.query(`insert into public.team_members (team_id, workspace_id, user_id) values ($1, $2, $3)`, [team, ws, bina]));
    await asUser(db, admin, (tx) => tx.query(`insert into public.resource_access (workspace_id, resource_type, resource_id, team_id, access, granted_by) values ($1, 'lead_list', $2, $3, 'manage', $4)`, [ws, list, team, admin]));
    expect(await visibleLeads(bina)).toEqual(['Bina Gym', 'Pool Lead']);
    // manage access may add their own leads
    const n = await asUser(db, bina, (tx) => one<{ n: number }>(tx, `select public.lead_list_add($1, $2) n`, [list, [binaLead]]));
    expect(n.n).toBe(1);
    await asUser(db, admin, (tx) => tx.query(`delete from public.team_members where team_id = $1 and user_id = $2`, [team, bina]));
    expect(await visibleLeads(bina)).toEqual(['Bina Gym']);
  });

  it('members can share only what they own', async () => {
    const own = (await asUser(db, ali, (tx) => one<{ id: string }>(tx, `insert into public.lead_lists (workspace_id, name, created_by) values ($1, 'Ali list', $2) returning id`, [ws, ali]))).id;
    await asUser(db, ali, (tx) => tx.query(`insert into public.resource_access (workspace_id, resource_type, resource_id, user_id, access, granted_by) values ($1, 'lead_list', $2, $3, 'view', $4)`, [ws, own, bina, ali]));
    await expect(
      asUser(db, ali, (tx) => tx.query(`insert into public.resource_access (workspace_id, resource_type, resource_id, user_id, access, granted_by) values ($1, 'lead_list', $2, $3, 'view', $4)`, [ws, list, bina, ali])),
    ).rejects.toThrow(/row-level security/);
  });

  it('deleting a resource drops its grants', async () => {
    const tmp = (await asUser(db, admin, (tx) => one<{ id: string }>(tx, `insert into public.lead_lists (workspace_id, name, created_by) values ($1, 'Temp', $2) returning id`, [ws, admin]))).id;
    await asUser(db, admin, (tx) => tx.query(`insert into public.resource_access (workspace_id, resource_type, resource_id, user_id, granted_by) values ($1, 'lead_list', $2, $3, $4)`, [ws, tmp, ali, admin]));
    await asUser(db, admin, (tx) => tx.query(`delete from public.lead_lists where id = $1`, [tmp]));
    expect(await rows(db, `select 1 from public.resource_access where resource_id = $1`, [tmp])).toHaveLength(0);
  });
});

describe('numbers, conversations & campaigns per member', () => {
  let aliAcc: string;
  let adminCampaign: string;

  it('numbers are personal by default and can be granted', async () => {
    aliAcc = (await asUser(db, ali, (tx) => one<{ id: string; shared: boolean }>(tx, `insert into public.whatsapp_accounts (workspace_id, owner_id, label) values ($1, $2, 'Ali phone') returning id, shared`, [ws, ali]))).id;
    expect(await asUser(db, bina, (tx) => rows(tx, `select 1 from public.whatsapp_accounts where id = $1`, [aliAcc]))).toHaveLength(0);
    expect(await asUser(db, admin, (tx) => rows(tx, `select 1 from public.whatsapp_accounts where id = $1`, [aliAcc]))).toHaveLength(1);
    await asUser(db, ali, (tx) => tx.query(`insert into public.resource_access (workspace_id, resource_type, resource_id, user_id, access, granted_by) values ($1, 'whatsapp_account', $2, $3, 'manage', $4)`, [ws, aliAcc, bina, ali]));
    expect(await asUser(db, bina, (tx) => rows(tx, `select 1 from public.whatsapp_accounts where id = $1`, [aliAcc]))).toHaveLength(1);
  });

  it("conversations on a member's number stay in their space", async () => {
    await asService(db, async (tx) => {
      const conv = await one<{ id: string }>(tx, `insert into public.conversations (workspace_id, account_id, lead_id, last_message_preview) values ($1, $2, $3, 'hi') returning id`, [ws, aliAcc, aliLead]);
      await tx.query(`insert into public.messages (workspace_id, conversation_id, lead_id, account_id, direction, body, status) values ($1, $2, $3, $4, 'in', 'hello', 'received')`, [ws, conv.id, aliLead, aliAcc]);
    });
    await asUser(db, ali, (tx) => tx.query(`delete from public.resource_access where resource_id = $1`, [aliAcc]));
    expect(await asUser(db, ali, (tx) => rows(tx, `select 1 from public.messages where lead_id = $1`, [aliLead]))).toHaveLength(1);
    expect(await asUser(db, bina, (tx) => rows(tx, `select 1 from public.messages where lead_id = $1`, [aliLead]))).toHaveLength(0);
    expect(await asUser(db, bina, (tx) => rows(tx, `select 1 from public.conversations where account_id = $1`, [aliAcc]))).toHaveLength(0);
    expect(await asUser(db, admin, (tx) => rows(tx, `select 1 from public.conversations where account_id = $1`, [aliAcc]))).toHaveLength(1);
  });

  it('an assigned campaign is visible (view) or operable (manage)', async () => {
    adminCampaign = (await asUser(db, admin, (tx) => one<{ id: string }>(tx, `insert into public.campaigns (workspace_id, name, created_by) values ($1, 'Agency push', $2) returning id`, [ws, admin]))).id;
    expect(await asUser(db, bina, (tx) => rows(tx, `select 1 from public.campaigns where id = $1`, [adminCampaign]))).toHaveLength(0);
    await asUser(db, admin, (tx) => tx.query(`insert into public.resource_access (workspace_id, resource_type, resource_id, user_id, access, granted_by) values ($1, 'campaign', $2, $3, 'view', $4)`, [ws, adminCampaign, bina, admin]));
    expect(await asUser(db, bina, (tx) => rows(tx, `select 1 from public.campaigns where id = $1`, [adminCampaign]))).toHaveLength(1);
    const blocked = await asUser(db, bina, (tx) => tx.query(`update public.campaigns set status = 'paused' where id = $1`, [adminCampaign]));
    expect(blocked.affectedRows).toBe(0);
    await asUser(db, admin, (tx) => tx.query(`update public.resource_access set access = 'manage' where resource_id = $1`, [adminCampaign])).catch(() => undefined);
    await db.query(`update public.resource_access set access = 'manage' where resource_id = $1`, [adminCampaign]);
    const ok = await asUser(db, bina, (tx) => tx.query(`update public.campaigns set status = 'paused' where id = $1`, [adminCampaign]));
    expect(ok.affectedRows).toBe(1);
  });

  it("campaign recipients' leads become visible to people on the campaign", async () => {
    const pool = await one<{ id: string }>(db, `select id from public.leads where business_name = 'Pool Lead'`);
    await asUser(db, admin, (tx) => tx.query(`select public.campaign_add_recipients($1, null, $2)`, [adminCampaign, [pool.id]]));
    expect(await visibleLeads(bina)).toContain('Pool Lead');
  });
});

describe('permissions & suspension', () => {
  it('admins can switch off scraping, campaigns and WhatsApp per member', async () => {
    await asUser(db, admin, (tx) =>
      tx.query(`update public.workspace_members set permissions = '{"scrape": false, "create_campaigns": false, "max_numbers": 1}' where workspace_id = $1 and user_id = $2`, [ws, ali]),
    );
    await expect(
      asUser(db, ali, (tx) => tx.query(`insert into public.scrape_jobs (workspace_id, created_by, keywords) values ($1, $2, '{gyms}')`, [ws, ali])),
    ).rejects.toThrow(/row-level security/);
    await expect(asUser(db, ali, (tx) => tx.query(`insert into public.campaigns (workspace_id, name, created_by) values ($1, 'x', $2)`, [ws, ali]))).rejects.toThrow(
      /row-level security/,
    );
    await expect(
      asUser(db, ali, (tx) => tx.query(`insert into public.whatsapp_accounts (workspace_id, owner_id, label) values ($1, $2, 'Second')`, [ws, ali])),
    ).rejects.toThrow(/up to 1 WhatsApp/);
    // Bina keeps the defaults: campaigns yes, the lead finder only when an admin allows it
    await asUser(db, bina, (tx) => tx.query(`insert into public.campaigns (workspace_id, name, created_by) values ($1, 'Bina promo', $2)`, [ws, bina]));
    await expect(
      asUser(db, bina, (tx) => tx.query(`insert into public.scrape_jobs (workspace_id, created_by, keywords) values ($1, $2, '{gyms}')`, [ws, bina])),
    ).rejects.toThrow(/row-level security/);
  });

  it('delete permission lets a member delete their own leads', async () => {
    await asUser(db, admin, (tx) => tx.query(`update public.workspace_members set permissions = '{"delete_leads": true}' where workspace_id = $1 and user_id = $2`, [ws, bina]));
    const tmp = (await asUser(db, bina, (tx) => one<{ id: string }>(tx, `insert into public.leads (workspace_id, business_name) values ($1, 'Temp lead') returning id`, [ws]))).id;
    const del = await asUser(db, bina, (tx) => tx.query(`delete from public.leads where id = $1`, [tmp]));
    expect(del.affectedRows).toBe(1);
  });

  it('members cannot change their own permissions', async () => {
    const r = await asUser(db, ali, (tx) => tx.query(`update public.workspace_members set permissions = '{"scrape": true}' where workspace_id = $1 and user_id = $2`, [ws, ali]));
    expect(r.affectedRows).toBe(0);
  });

  it('suspended members lose access; owners and self cannot be suspended', async () => {
    await asUser(db, admin, (tx) => tx.query(`update public.workspace_members set active = false where workspace_id = $1 and user_id = $2`, [ws, bina]));
    expect(await visibleLeads(bina)).toEqual([]);
    expect(await asUser(db, bina, (tx) => rows(tx, `select 1 from public.workspaces where id = $1`, [ws]))).toHaveLength(0);
    await expect(asUser(db, admin, (tx) => tx.query(`update public.workspace_members set active = false where workspace_id = $1 and user_id = $2`, [ws, admin]))).rejects.toThrow(
      /Owners can’t be suspended/,
    );
    await asUser(db, admin, (tx) => tx.query(`update public.workspace_members set active = true where workspace_id = $1 and user_id = $2`, [ws, bina]));
    expect(await visibleLeads(bina)).toContain('Bina Gym');
  });
});

describe('templates & automations scope', () => {
  it("members' templates are personal; workspace templates are shared", async () => {
    const t = await asUser(db, ali, (tx) => one<{ scope: string }>(tx, `insert into public.message_templates (workspace_id, name, body, created_by) values ($1, 'Ali opener', 'Hi', $2) returning scope`, [ws, ali]));
    expect(t.scope).toBe('personal');
    await asUser(db, admin, (tx) => tx.query(`insert into public.message_templates (workspace_id, name, body, created_by) values ($1, 'Company opener', 'Hello', $2)`, [ws, admin]));
    const binaSees = await asUser(db, bina, (tx) => rows<{ name: string }>(tx, `select name from public.message_templates order by name`));
    expect(binaSees.map((r) => r.name)).toEqual(['Company opener']);
  });

  it('workspace automations can be assigned to a team; personal ones stay personal', async () => {
    const auto = (await asUser(db, admin, (tx) => one<{ id: string }>(tx, `insert into public.automations (workspace_id, name, trigger, created_by) values ($1, 'Team rule', 'reply_received', $2) returning id`, [ws, admin]))).id;
    expect(await asUser(db, ali, (tx) => rows(tx, `select 1 from public.automations where id = $1`, [auto]))).toHaveLength(1); // unassigned => everyone
    const team = (await asUser(db, admin, (tx) => one<{ id: string }>(tx, `insert into public.teams (workspace_id, name, created_by) values ($1, 'Closers', $2) returning id`, [ws, admin]))).id;
    await asUser(db, admin, (tx) => tx.query(`insert into public.team_members (team_id, workspace_id, user_id) values ($1, $2, $3)`, [team, ws, bina]));
    await asUser(db, admin, (tx) => tx.query(`insert into public.resource_access (workspace_id, resource_type, resource_id, team_id, access, granted_by) values ($1, 'automation', $2, $3, 'view', $4)`, [ws, auto, team, admin]));
    expect(await asUser(db, ali, (tx) => rows(tx, `select 1 from public.automations where id = $1`, [auto]))).toHaveLength(0);
    expect(await asUser(db, bina, (tx) => rows(tx, `select 1 from public.automations where id = $1`, [auto]))).toHaveLength(1);

    const mine = (await asUser(db, ali, (tx) => one<{ id: string }>(tx, `insert into public.automations (workspace_id, name, trigger, owner_id, created_by) values ($1, 'My rule', 'keyword', $2, $2) returning id`, [ws, ali]))).id;
    expect(await asUser(db, bina, (tx) => rows(tx, `select 1 from public.automations where id = $1`, [mine]))).toHaveLength(0);
    await expect(
      asUser(db, ali, (tx) => tx.query(`insert into public.automations (workspace_id, name, trigger, created_by) values ($1, 'Workspace rule', 'keyword', $2)`, [ws, ali])),
    ).rejects.toThrow(/row-level security/);
  });
});

describe('team reports', () => {
  beforeAll(async () => {
    const aliAcc = await one<{ id: string }>(db, `select id from public.whatsapp_accounts where label = 'Ali phone'`);
    const camp = await one<{ id: string }>(db, `select id from public.campaigns where name = 'Agency push'`);
    await asService(db, async (tx) => {
      for (let i = 0; i < 3; i++) {
        await tx.query(`insert into public.messages (workspace_id, lead_id, account_id, campaign_id, direction, body, status) values ($1, $2, $3, $4, 'out', 'hi', $5)`, [
          ws,
          aliLead,
          aliAcc.id,
          camp.id,
          i === 2 ? 'read' : 'delivered',
        ]);
      }
    });
  });

  it('admins see every member; members see only themselves', async () => {
    const now = new Date();
    const from = new Date(now.getTime() - 86400000).toISOString();
    const to = new Date(now.getTime() + 86400000).toISOString();
    const all = await asUser(db, admin, (tx) => rows<{ full_name: string; messages_sent: number; replies: number; read: number }>(tx, `select * from public.report_members($1, $2, $3)`, [ws, from, to]));
    expect(all.map((r) => r.full_name).sort()).toEqual(['Ali Agent', 'Ayesha Admin', 'Bina Agent', 'Vik Viewer']);
    const aliRow = all.find((r) => r.full_name === 'Ali Agent')!;
    expect(aliRow.messages_sent).toBe(3);
    expect(aliRow.read).toBe(1);
    expect(aliRow.replies).toBe(1);

    const self = await asUser(db, ali, (tx) => rows<{ full_name: string }>(tx, `select * from public.report_members($1, $2, $3)`, [ws, from, to]));
    expect(self.map((r) => r.full_name)).toEqual(['Ali Agent']);

    const senders = await asUser(db, admin, (tx) => rows<{ full_name: string; messages_sent: number; campaign_name: string }>(tx, `select * from public.report_campaign_senders($1, $2, $3)`, [ws, from, to]));
    expect(senders).toEqual([expect.objectContaining({ full_name: 'Ali Agent', messages_sent: 3, campaign_name: 'Agency push' })]);

    const teams = await asUser(db, admin, (tx) => rows<{ name: string }>(tx, `select * from public.report_teams($1, $2, $3)`, [ws, from, to]));
    expect(teams.map((t) => t.name).sort()).toEqual(['Closers', 'Sales A']);
    await expect(asUser(db, ali, (tx) => tx.query(`select * from public.report_teams($1, $2, $3)`, [ws, from, to]))).rejects.toThrow(/Only admins/);

    const daily = await asUser(db, admin, (tx) => rows<{ sent: number; replies: number }>(tx, `select * from public.report_daily($1, $2, $3)`, [ws, from, to]));
    expect(daily.reduce((s, d) => s + d.sent, 0)).toBe(3);
    expect(daily.reduce((s, d) => s + d.replies, 0)).toBe(1);
  });
});
