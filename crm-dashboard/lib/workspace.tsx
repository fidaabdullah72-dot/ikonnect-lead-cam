'use client';

import * as React from 'react';
import { canWrite, isAdminRole, type MemberPermissions, type Profile, type Role, type Workspace } from '@batsols/shared';

export interface WorkspaceSummary {
  id: string;
  name: string;
  role: Role;
}

export interface SessionData {
  userId: string;
  email: string;
  profile: Profile;
  workspace: Workspace;
  role: Role;
  /** This member's permissions in the workspace (see member_can in the database). */
  permissions: MemberPermissions;
  workspaces: WorkspaceSummary[];
}

interface WorkspaceContextValue extends SessionData {
  /** scrape: may use the lead finder — admins, and members an admin allowed. */
  can: { write: boolean; admin: boolean; owner: boolean; scrape: boolean };
  setWorkspace: (w: Workspace) => void;
  setProfile: (p: Profile) => void;
}

const Ctx = React.createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({ initial, children }: { initial: SessionData; children: React.ReactNode }) {
  const [workspace, setWorkspace] = React.useState(initial.workspace);
  const [profile, setProfile] = React.useState(initial.profile);

  // A server navigation (workspace switch) delivers new initial data.
  React.useEffect(() => setWorkspace(initial.workspace), [initial.workspace]);
  React.useEffect(() => setProfile(initial.profile), [initial.profile]);

  const value = React.useMemo<WorkspaceContextValue>(
    () => ({
      ...initial,
      workspace,
      profile,
      can: {
        write: canWrite(initial.role),
        admin: isAdminRole(initial.role),
        owner: initial.role === 'owner',
        scrape: isAdminRole(initial.role) || (initial.role === 'member' && initial.permissions.scrape === true),
      },
      setWorkspace,
      setProfile,
    }),
    [initial, workspace, profile],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWorkspace() {
  const ctx = React.useContext(Ctx);
  if (!ctx) throw new Error('useWorkspace must be used inside WorkspaceProvider');
  return ctx;
}
