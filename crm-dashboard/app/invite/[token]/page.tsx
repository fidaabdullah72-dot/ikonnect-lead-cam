import { ROLE_LABELS } from '@batsols/shared';
import { CenteredCard } from '@/components/centered-card';
import { createSupabaseServer } from '@/lib/supabase/server';
import { InviteActions } from './invite-actions';

export const dynamic = 'force-dynamic';

export default async function InvitePage({ params }: PageProps<'/invite/[token]'>) {
  const { token } = await params;
  const supabase = await createSupabaseServer();
  const [{ data: invites }, { data: claims }] = await Promise.all([
    supabase.rpc('get_invite', { p_token: token }),
    supabase.auth.getClaims(),
  ]);
  const invite = invites?.[0];
  const email = (claims?.claims?.email as string | undefined) ?? null;

  if (!invite || invite.expired || invite.accepted) {
    return (
      <CenteredCard>
        <h1 className="text-xl font-semibold tracking-[-0.02em]">This invite link can’t be used</h1>
        <p className="mt-2 text-[13.5px] text-muted">
          {!invite ? 'The link is invalid.' : invite.accepted ? 'It has already been used.' : 'It has expired.'} Ask your workspace admin for a new one.
        </p>
      </CenteredCard>
    );
  }

  return (
    <CenteredCard>
      <p className="text-[13px] font-medium text-primary">You’re invited</p>
      <h1 className="mt-1 text-xl font-semibold tracking-[-0.02em]">Join {invite.workspace_name} on CoreNexa</h1>
      <p className="mt-2 text-[13.5px] text-muted">
        {invite.invited_by_name ? `${invite.invited_by_name} invited you` : 'You were invited'} as{' '}
        <span className="font-medium text-foreground">{ROLE_LABELS[invite.role]}</span>.
      </p>
      <div className="mt-6">
        <InviteActions token={token} inviteEmail={invite.email} signedInEmail={email} />
      </div>
    </CenteredCard>
  );
}
