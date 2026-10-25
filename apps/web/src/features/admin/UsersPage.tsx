import { HOME_SCREENS, createUserSchema, passwordSchema, roleSchema, updateUserSchema, type HomeScreen } from '@salon/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Lock, MoreHorizontal, Pencil, Plus, ShieldOff, Trash2, UserCheck, UserX } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { toastError } from '@/app/providers';
import { MultiSelectList } from '@/components/common/MultiSelectList';
import { Button, IconButton } from '@/components/ui/button';
import { Badge, Card, EmptyState, ErrorState, InlineNotice, PageHeader, Skeleton, TabPanel, Tabs } from '@/components/ui/display';
import { Checkbox, Field, FormError, Input, SearchInput, Select, Switch, Textarea } from '@/components/ui/form';
import { Drawer, Menu, Modal, useConfirm } from '@/components/ui/overlay';
import { DataTable, type Column } from '@/components/ui/table';
import { api, ApiError } from '@/lib/api';
import { useCan, useUser } from '@/lib/auth';
import { useBranch } from '@/lib/branch';
import { friendlyError } from '@/lib/errors';
import { fmtDateTime } from '@/lib/format';
import { useDebounced } from '@/lib/hooks';
import { qk, useStaffList } from '@/lib/queries';

interface UserRow { id: string; fullName: string; email: string | null; phone: string | null; status: string; allBranches: boolean; lastLoginAt: string | null; lockedUntil: string | null; twoFactorEnabled: boolean; roleId: string; roleName: string; roleKey: string; staffId: string | null; staffName: string | null; branches: Array<{ id: string; name: string }> }
interface RoleRow { id: string; key: string; name: string; description: string | null; homeScreen: HomeScreen; isSystem: boolean; isLocked: boolean; userCount: number; permissions: string[] }
interface PermissionGroup { module: string; permissions: Array<{ key: string; label: string }> }

const HOME_LABEL: Record<HomeScreen, string> = { owner_dashboard: 'Business dashboard', branch_dashboard: 'Today at the salon', front_desk: 'Front desk', my_day: 'My day (phone view)' };

export function Component() {
  const can = useCan();
  const [tab, setTab] = useState(can('users.manage') ? 'users' : 'roles');
  return (
    <div>
      <PageHeader title="Users and roles" description="Who can sign in, and what each person is allowed to do." />
      <Tabs value={tab} onValueChange={setTab} tabs={[...(can('users.manage') ? [{ value: 'users', label: 'Users' }] : []), { value: 'roles', label: 'Roles and permissions' }]}>
        <TabPanel value="users"><UsersPanel /></TabPanel>
        <TabPanel value="roles"><RolesPanel /></TabPanel>
      </Tabs>
    </div>
  );
}

function useRoles() {
  return useQuery({ queryKey: qk.roles, queryFn: () => api.get<RoleRow[]>('/roles') });
}

// ───────────── Users ─────────────
function UsersPanel() {
  const me = useUser();
  const confirm = useConfirm();
  const client = useQueryClient();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<UserRow | 'new' | null>(null);
  const [resetting, setResetting] = useState<UserRow | null>(null);
  const term = useDebounced(search);
  const q = useQuery({ queryKey: ['users', 'list', term, page], queryFn: () => api.list<UserRow>('/users', { search: term || undefined, page, pageSize: 25 }), placeholderData: (p) => p });
  const toggle = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'active' | 'disabled' }) => api.patch(`/users/${id}`, { status }),
    onSuccess: (_d, v) => { void client.invalidateQueries({ queryKey: ['users'] }); toast.success(v.status === 'disabled' ? 'Access switched off' : 'Access restored'); },
    onError: toastError,
  });
  const resetTwoFactor = useMutation({
    mutationFn: (id: string) => api.post(`/users/${id}/reset-two-factor`),
    onSuccess: () => { void client.invalidateQueries({ queryKey: ['users'] }); toast.success('Two-step sign-in switched off. They are signed out everywhere.'); },
    onError: toastError,
  });
  const columns: Array<Column<UserRow>> = [
    { key: 'name', header: 'Name', mobile: 'title', cell: (u) => <div><p className="font-medium">{u.fullName}{u.id === me.id && <span className="ml-2 text-xs text-muted">(you)</span>}</p><p className="text-xs text-muted">{u.email ?? u.phone}</p></div> },
    { key: 'role', header: 'Role', cell: (u) => <Badge tone={u.roleKey === 'owner' ? 'primary' : 'neutral'}>{u.roleName}</Badge> },
    { key: 'branches', header: 'Branches', hideBelow: 'md', cell: (u) => (u.allBranches ? 'All branches' : u.branches.map((b) => b.name).join(', ') || <span className="text-muted">None</span>) },
    { key: 'twoFactor', header: 'Two-step sign-in', hideBelow: 'md', cell: (u) => <Badge tone={u.twoFactorEnabled ? 'success' : 'neutral'}>{u.twoFactorEnabled ? 'On' : 'Off'}</Badge> },
    { key: 'last', header: 'Last signed in', hideBelow: 'lg', cell: (u) => (u.lastLoginAt ? fmtDateTime(u.lastLoginAt, me.organization?.timezone ?? 'Asia/Kolkata') : <span className="text-muted">Never</span>) },
    { key: 'status', header: 'Status', cell: (u) => (u.lockedUntil && new Date(u.lockedUntil) > new Date() ? <Badge tone="warning">Locked (too many attempts)</Badge> : <Badge tone={u.status === 'active' ? 'success' : 'neutral'}>{u.status === 'active' ? 'Active' : 'Switched off'}</Badge>) },
    {
      key: 'actions', header: 'Actions', srOnlyHeader: true, align: 'right', mobile: 'hide',
      cell: (u) => (
        <span onClick={(e) => e.stopPropagation()}>
          <Menu label={`Actions for ${u.fullName}`} trigger={<IconButton label={`Actions for ${u.fullName}`} size="sm"><MoreHorizontal className="size-5" /></IconButton>} items={[
            { label: 'Edit', icon: <Pencil className="size-4" />, onSelect: () => setEditing(u) },
            { label: 'Set a new password', icon: <KeyRound className="size-4" />, onSelect: () => setResetting(u) },
            { label: 'Reset two-step sign-in', icon: <ShieldOff className="size-4" />, hidden: !u.twoFactorEnabled || u.id === me.id, onSelect: async () => { if (await confirm({ title: `Reset ${u.fullName}’s two-step sign-in?`, body: 'Use this when they have lost their phone and their recovery codes. Their authenticator and recovery codes stop working, and they are signed out everywhere. If your salon requires two-step sign-in, they will set it up again the next time they sign in.', confirmLabel: 'Reset two-step sign-in', cancelLabel: 'Keep it on', tone: 'danger' })) resetTwoFactor.mutate(u.id); } },
            'separator',
            u.status === 'active'
              ? { label: 'Switch off access', icon: <UserX className="size-4" />, tone: 'danger', hidden: u.id === me.id, onSelect: async () => { if (await confirm({ title: `Switch off ${u.fullName}’s access?`, body: 'They are signed out immediately and cannot sign in until you switch access back on. Their history is kept.', confirmLabel: 'Switch off access', cancelLabel: 'Keep access', tone: 'danger' })) toggle.mutate({ id: u.id, status: 'disabled' }); } }
              : { label: 'Restore access', icon: <UserCheck className="size-4" />, onSelect: () => toggle.mutate({ id: u.id, status: 'active' }) },
          ]} />
        </span>
      ),
    },
  ];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3"><SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1); }} placeholder="Search by name, email or mobile" className="w-full sm:w-72" aria-label="Search users" /><Button icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>Add user</Button></div>
      <Card padded={false}>
        <DataTable columns={columns} rows={q.data?.rows} loading={q.isLoading} error={q.isError ? q.error : undefined} onRetry={() => void q.refetch()} rowKey={(u) => u.id} onRowClick={setEditing} pagination={{ page, pageSize: 25, total: q.data?.meta.total ?? 0, onPageChange: setPage }} empty={<EmptyState title="No users found" description="Add a user so someone can sign in." />} />
      </Card>
      {editing && <UserDrawer user={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {resetting && <ResetPassword user={resetting} onClose={() => setResetting(null)} />}
    </div>
  );
}

function UserDrawer({ user, onClose }: { user: UserRow | null; onClose: () => void }) {
  const client = useQueryClient();
  const me = useUser();
  const { branches } = useBranch();
  const roles = useRoles();
  const staff = useStaffList(undefined, { bookableOnly: false });
  const [v, setV] = useState({ fullName: user?.fullName ?? '', email: user?.email ?? '', phone: user?.phone ?? '', roleId: user?.roleId ?? '', allBranches: user?.allBranches ?? false, branchIds: user?.branches.map((b) => b.id) ?? (branches.length === 1 ? [branches[0]!.id] : []), staffId: user?.staffId ?? '', password: '' });
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const set = (p: Partial<typeof v>) => { setV((x) => ({ ...x, ...p })); setError(null); setFieldErrors({}); };
  const selfEdit = user?.id === me.id;
  const role = roles.data?.find((r) => r.id === v.roleId);
  const save = useMutation({
    mutationFn: () => {
      const schema = user ? updateUserSchema : createUserSchema;
      const payload = user ? { fullName: v.fullName, email: v.email, phone: v.phone, roleId: v.roleId, allBranches: v.allBranches, branchIds: v.branchIds, staffId: v.staffId } : v;
      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        const errs: Record<string, string> = {};
        for (const i of parsed.error.issues) errs[String(i.path[0])] ??= i.message;
        setFieldErrors(errs);
        throw new Error('Please fix the highlighted fields.');
      }
      return user ? api.patch(`/users/${user.id}`, parsed.data) : api.post('/users', parsed.data);
    },
    onSuccess: () => { void client.invalidateQueries({ queryKey: ['users'] }); void client.invalidateQueries({ queryKey: ['staff'] }); toast.success(user ? 'User updated' : 'User added. They will choose a new password when they first sign in.'); onClose(); },
    onError: (e) => {
      if (e instanceof ApiError) for (const [path, message] of Object.entries(e.fieldErrors)) setFieldErrors((x) => ({ ...x, [path]: message }));
      setError(e instanceof Error && !(e instanceof ApiError) ? e.message : friendlyError(e).message);
    },
  });
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} title={user ? `Edit ${user.fullName}` : 'Add user'} size="md" persistent footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button loading={save.isPending} onClick={() => save.mutate()}>{user ? 'Save changes' : 'Add user'}</Button></>}>
      <div className="space-y-4">
        <FormError message={error} />
        <Field label="Full name" required error={fieldErrors.fullName}><Input autoFocus value={v.fullName} onChange={(e) => set({ fullName: e.target.value })} /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Email" error={fieldErrors.email} hint="Email or mobile is needed to sign in."><Input type="email" value={v.email} onChange={(e) => set({ email: e.target.value })} /></Field>
          <Field label="Mobile" error={fieldErrors.phone}><Input type="tel" value={v.phone} onChange={(e) => set({ phone: e.target.value })} /></Field>
        </div>
        <Field label="Role" required error={fieldErrors.roleId} hint={role?.description ?? undefined}>
          <Select value={v.roleId} disabled={selfEdit} onChange={(e) => set({ roleId: e.target.value })}><option value="">Choose a role…</option>{(roles.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select>
        </Field>
        {selfEdit && <p className="-mt-2 text-xs text-muted">You cannot change your own role.</p>}
        <fieldset className="space-y-2">
          <legend className="text-sm font-semibold">Which branches can they use?</legend>
          {me.allBranches && <Switch checked={v.allBranches} onCheckedChange={(x) => set({ allBranches: x })} label="Every branch, including new ones" />}
          {!v.allBranches && <MultiSelectList items={branches.map((b) => ({ id: b.id, label: b.name }))} selected={v.branchIds} onChange={(ids) => set({ branchIds: ids })} />}
          <FormError message={fieldErrors.branchIds} />
        </fieldset>
        <Field label="Linked team member" optional hint="Link a login to a stylist so they see their own day.">
          <Select value={v.staffId} onChange={(e) => set({ staffId: e.target.value })}><option value="">Not linked</option>{(staff.data ?? []).filter((s) => !s.hasLogin || s.id === user?.staffId).map((s) => <option key={s.id} value={s.id}>{s.displayName} · {s.branchName}</option>)}</Select>
        </Field>
        {!user && <Field label="Temporary password" required error={fieldErrors.password} hint="At least 10 characters with a letter and a number. They will be asked to change it."><Input type="text" autoComplete="off" value={v.password} onChange={(e) => set({ password: e.target.value })} /></Field>}
      </div>
    </Drawer>
  );
}

function ResetPassword({ user, onClose }: { user: UserRow; onClose: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => { const parsed = passwordSchema.safeParse(password); if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Choose a stronger password.'); return api.post(`/users/${user.id}/reset-password`, { password }); },
    onSuccess: () => { toast.success(`New temporary password set for ${user.fullName}. They are signed out everywhere.`); onClose(); },
    onError: (e) => setError(e instanceof Error && !(e instanceof ApiError) ? e.message : friendlyError(e).message),
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={`New password for ${user.fullName}`} description="They will be signed out everywhere and must choose their own password the next time they sign in." size="sm" footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button loading={save.isPending} onClick={() => save.mutate()}>Set password</Button></>}>
      <div className="space-y-3"><FormError message={error} /><Field label="Temporary password" required hint="At least 10 characters with a letter and a number."><Input autoFocus autoComplete="off" value={password} onChange={(e) => { setPassword(e.target.value); setError(null); }} /></Field></div>
    </Modal>
  );
}

// ───────────── Roles ─────────────
function RolesPanel() {
  const can = useCan();
  const manage = can('roles.manage');
  const confirm = useConfirm();
  const client = useQueryClient();
  const roles = useRoles();
  const [editing, setEditing] = useState<RoleRow | 'new' | null>(null);
  const remove = useMutation({ mutationFn: (id: string) => api.delete(`/roles/${id}`), onSuccess: () => { void client.invalidateQueries({ queryKey: qk.roles }); toast.success('Role deleted'); }, onError: toastError });
  return (
    <div className="space-y-4">
      {manage && <div className="flex justify-end"><Button icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>Create role</Button></div>}
      {roles.isLoading && <Skeleton className="h-40" />}
      {roles.isError && <ErrorState error={roles.error} onRetry={() => void roles.refetch()} />}
      <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {roles.data?.map((r) => (
          <li key={r.id}>
            <Card className="h-full">
              <div className="flex items-start justify-between gap-2"><div><h2 className="flex items-center gap-2 font-semibold">{r.name}{r.isLocked && <Lock className="size-3.5 text-muted" aria-label="Locked" />}</h2><p className="text-sm text-muted">{r.description}</p></div><Badge>{r.userCount} {r.userCount === 1 ? 'user' : 'users'}</Badge></div>
              <p className="mt-3 text-sm text-muted">Starts on: {HOME_LABEL[r.homeScreen]}</p>
              <p className="text-sm text-muted">{r.isLocked ? 'Full access to everything' : `${r.permissions.length} permissions`}</p>
              <div className="mt-4 flex gap-2">
                <Button size="sm" variant="outline" onClick={() => setEditing(r)}>{manage && !r.isLocked ? 'Edit' : 'View'}</Button>
                {manage && !r.isSystem && <Button size="sm" variant="ghost" icon={<Trash2 className="size-4" />} onClick={async () => { if (await confirm({ title: `Delete the “${r.name}” role?`, body: r.userCount ? `${r.userCount} users still have this role. Move them to another role first.` : 'No one has this role, so nobody is affected.', confirmLabel: 'Delete role', cancelLabel: 'Keep role', tone: 'danger' })) remove.mutate(r.id); }}>Delete</Button>}
              </div>
            </Card>
          </li>
        ))}
      </ul>
      {editing && <RoleDrawer role={editing === 'new' ? null : editing} readOnly={!manage || (editing !== 'new' && editing.isLocked)} onClose={() => setEditing(null)} />}
    </div>
  );
}

function RoleDrawer({ role, readOnly, onClose }: { role: RoleRow | null; readOnly: boolean; onClose: () => void }) {
  const client = useQueryClient();
  const me = useUser();
  const groups = useQuery({ queryKey: ['permissions'], queryFn: () => api.get<PermissionGroup[]>('/roles/permissions'), staleTime: 10 * 60_000 });
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [homeScreen, setHomeScreen] = useState<HomeScreen>(role?.homeScreen ?? 'front_desk');
  const [perms, setPerms] = useState<Set<string>>(new Set(role?.permissions ?? []));
  const [error, setError] = useState<string | null>(null);
  const grantable = (key: string) => me.role?.key === 'owner' || me.permissions.includes(key as never);
  const toggle = (key: string, on: boolean) => { setPerms((s) => { const n = new Set(s); (on ? n.add(key) : n.delete(key)); return n; }); setError(null); };
  const toggleGroup = (g: PermissionGroup, on: boolean) => setPerms((s) => { const n = new Set(s); for (const p of g.permissions) if (grantable(p.key)) (on ? n.add(p.key) : n.delete(p.key)); return n; });
  const count = useMemo(() => perms.size, [perms]);
  const save = useMutation({
    mutationFn: () => {
      const parsed = roleSchema.safeParse({ name, description, homeScreen, permissions: [...perms] });
      if (!parsed.success) throw new Error(parsed.error.issues[0]?.path[0] === 'name' ? 'Give the role a name (at least 2 letters).' : 'Please check the role details.');
      return role ? api.put(`/roles/${role.id}`, parsed.data) : api.post('/roles', parsed.data);
    },
    onSuccess: () => { void client.invalidateQueries({ queryKey: qk.roles }); toast.success(role ? 'Role updated. It applies the next time people sign in or refresh.' : 'Role created'); onClose(); },
    onError: (e) => setError(e instanceof Error && !(e instanceof ApiError) ? e.message : friendlyError(e).message),
  });
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} title={readOnly ? role?.name ?? 'Role' : role ? `Edit ${role.name}` : 'Create role'} size="lg" persistent={!readOnly} footer={readOnly ? <Button onClick={onClose}>Close</Button> : <><Button variant="outline" onClick={onClose}>Cancel</Button><Button loading={save.isPending} onClick={() => save.mutate()}>{role ? 'Save role' : 'Create role'}</Button></>}>
      <div className="space-y-5">
        <FormError message={error} />
        {role?.isLocked && <InlineNotice tone="info">The Owner role always has full access and cannot be changed.</InlineNotice>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Role name" required><Input value={name} disabled={readOnly} onChange={(e) => { setName(e.target.value); setError(null); }} placeholder="e.g. Senior receptionist" /></Field>
          <Field label="Opens to"><Select value={homeScreen} disabled={readOnly} onChange={(e) => setHomeScreen(e.target.value as HomeScreen)}>{HOME_SCREENS.map((h) => <option key={h} value={h}>{HOME_LABEL[h]}</option>)}</Select></Field>
          <Field label="Description" optional className="sm:col-span-2"><Textarea rows={2} value={description ?? ''} disabled={readOnly} onChange={(e) => setDescription(e.target.value)} /></Field>
        </div>
        <div>
          <p className="mb-2 text-sm font-semibold">What this role can do <span className="font-normal text-muted">· {role?.isLocked ? 'everything' : `${count} selected`}</span></p>
          {groups.isLoading && <Skeleton className="h-40" />}
          <div className="space-y-4">
            {groups.data?.map((g) => {
              const keys = g.permissions.map((p) => p.key);
              const selected = keys.filter((k) => perms.has(k)).length;
              return (
                <fieldset key={g.module} className="rounded-xl border border-line">
                  <legend className="sr-only">{g.module}</legend>
                  <div className="flex items-center justify-between border-b border-line bg-surface-2 px-3 py-2"><h3 className="text-sm font-semibold">{g.module}</h3>{!readOnly && <Checkbox checked={selected === keys.length ? true : selected === 0 ? false : 'indeterminate'} onCheckedChange={(on) => toggleGroup(g, on)} label={<span className="text-xs text-muted">All</span>} />}</div>
                  <ul className="divide-y divide-line">
                    {g.permissions.map((p) => (
                      <li key={p.key} className="px-3 py-2"><Checkbox checked={role?.isLocked ? true : perms.has(p.key)} disabled={readOnly || !grantable(p.key)} onCheckedChange={(on) => toggle(p.key, on)} label={p.label} description={!readOnly && !grantable(p.key) ? 'You do not have this permission yourself' : undefined} /></li>
                    ))}
                  </ul>
                </fieldset>
              );
            })}
          </div>
        </div>
      </div>
    </Drawer>
  );
}
