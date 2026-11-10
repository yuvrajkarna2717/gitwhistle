import { useEffect, useState } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import { useApi } from '../../hooks/useApi.js';
import { api } from '../../services/api.js';
import { useAuth } from '../../app/AuthProvider.jsx';
import { AsyncContent, Badge, Button, Card, EmptyState, ErrorState, Field, Flash, Input, LoadingState, PageHeader, Select, Toggle } from '../../components/ui.jsx';
import { useFlash } from '../../hooks/useFlash.js';
import { formatDateTime, timeAgo } from '../../utils/format.js';

const ZONES = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : ['UTC'];
const REMINDER_INFO = {
  review_pending: ['Review pending', 'Open, non-draft PRs that have not been approved or had changes requested.'],
  changes_requested: ['Changes requested', 'PRs where a reviewer requested changes and the author has not pushed since.'],
  stale_pr: ['Stale pull requests', 'Open PRs with no activity (commits, reviews, comments).'],
};

function ChannelSelect({ channels, value, onChange, id, emptyLabel = 'None', disabled }) {
  return (
    <Select id={id} value={value || ''} onChange={(e) => onChange(e.target.value || null)} disabled={disabled}>
      <option value="">{emptyLabel}</option>
      {channels.map((c) => (
        <option key={c.id} value={c.id}>
          #{c.name}
        </option>
      ))}
    </Select>
  );
}

function GeneralSettings({ ws, channels, canAdmin, onSaved, setFlash }) {
  const [form, setForm] = useState(ws);
  const [pending, setPending] = useState(false);
  useEffect(() => setForm(ws), [ws]);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const nameError = form.name.trim().length < 2 ? 'Name must be at least 2 characters' : null;

  const save = async (e) => {
    e.preventDefault();
    if (nameError) return;
    setPending(true);
    try {
      const res = await api.patch(`/workspaces/${ws.id}`, {
        name: form.name.trim(),
        timezone: form.timezone,
        fallbackRoutingEnabled: form.fallbackRoutingEnabled,
        defaultChannelId: form.defaultChannelId,
        digestEnabled: form.digestEnabled,
        digestHour: Number(form.digestHour),
        digestChannelId: form.digestChannelId,
      });
      onSaved(res.data);
      setFlash({ message: 'Settings saved' });
    } catch (err) {
      setFlash({ tone: 'error', message: err.message });
    } finally {
      setPending(false);
    }
  };

  const sendTestDigest = async () => {
    try {
      const r = await api.post(`/workspaces/${ws.id}/digests/test`);
      setFlash(r.data.outcome === 'sent' ? { message: 'Test digest sent' } : { tone: 'error', message: `Digest failed: ${r.data.error || r.data.outcome}` });
    } catch (err) {
      setFlash({ tone: 'error', message: err.message });
    }
  };

  return (
    <form onSubmit={save} className="space-y-6" noValidate>
      <Card title="General">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Workspace name" htmlFor="s-name" error={nameError}>
            <Input id="s-name" value={form.name} onChange={(e) => set({ name: e.target.value })} disabled={!canAdmin} />
          </Field>
          <Field label="Timezone" htmlFor="s-tz">
            <Select id="s-tz" value={form.timezone} onChange={(e) => set({ timezone: e.target.value })} disabled={!canAdmin}>
              {ZONES.map((z) => (
                <option key={z}>{z}</option>
              ))}
            </Select>
          </Field>
          <Field label="Default channel" htmlFor="s-default" hint="Used by fallback routing and reminders when nothing more specific is set.">
            <ChannelSelect id="s-default" channels={channels} value={form.defaultChannelId} onChange={(v) => set({ defaultChannelId: v })} disabled={!canAdmin} />
          </Field>
          <div className="flex items-center gap-3 pt-6 text-sm">
            <Toggle label="Fallback routing" checked={form.fallbackRoutingEnabled} onChange={(v) => set({ fallbackRoutingEnabled: v })} disabled={!canAdmin} />
            Send important events to the default channel when no rule matches
          </div>
        </div>
      </Card>

      <Card title="Daily engineering digest" actions={canAdmin && <Button size="sm" variant="secondary" onClick={sendTestDigest}>Send test digest</Button>}>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="flex items-center gap-3 text-sm">
            <Toggle label="Digest enabled" checked={form.digestEnabled} onChange={(v) => set({ digestEnabled: v })} disabled={!canAdmin} /> Enabled
          </div>
          <Field label="Delivery time" htmlFor="s-hour" hint={`Local time in ${form.timezone}`}>
            <Select id="s-hour" value={form.digestHour} onChange={(e) => set({ digestHour: e.target.value })} disabled={!canAdmin}>
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  {String(h).padStart(2, '0')}:00
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Digest channel" htmlFor="s-digest">
            <ChannelSelect id="s-digest" channels={channels} value={form.digestChannelId} onChange={(v) => set({ digestChannelId: v })} emptyLabel="Default channel" disabled={!canAdmin} />
          </Field>
        </div>
      </Card>
      {canAdmin && (
        <Button type="submit" pending={pending}>
          Save settings
        </Button>
      )}
    </form>
  );
}

function ReminderPolicies({ workspaceId, channels, canAdmin, setFlash }) {
  const policies = useApi(`/workspaces/${workspaceId}/reminder-policies`);
  const [drafts, setDrafts] = useState({});
  const save = async (p) => {
    const d = { ...p, ...drafts[p.type] };
    if (!(d.thresholdHours >= 1 && d.thresholdHours <= 2160) || (d.repeatHours != null && !(d.repeatHours >= 1 && d.repeatHours <= 2160))) {
      setFlash({ tone: 'error', message: 'Hours must be between 1 and 2160' });
      return;
    }
    try {
      await api.put(`/workspaces/${workspaceId}/reminder-policies/${p.type}`, { enabled: d.enabled, thresholdHours: Number(d.thresholdHours), repeatHours: d.repeatHours ? Number(d.repeatHours) : null, channelId: d.channelId || null });
      setDrafts((x) => ({ ...x, [p.type]: undefined }));
      policies.reload();
      setFlash({ message: `${REMINDER_INFO[p.type][0]} reminders saved` });
    } catch (err) {
      setFlash({ tone: 'error', message: err.message });
    }
  };
  return (
    <Card title="Review reminders" padded={false}>
      <AsyncContent result={policies}>
        {(list) => (
          <ul className="divide-y divide-slate-100">
            {list.map((p) => {
              const d = { ...p, ...drafts[p.type] };
              const set = (patch) => setDrafts((x) => ({ ...x, [p.type]: { ...x[p.type], ...patch } }));
              return (
                <li key={p.type} className="grid gap-3 px-4 py-4 text-sm lg:grid-cols-[1.5fr_auto_auto_1fr_auto] lg:items-end">
                  <div>
                    <p className="font-medium text-slate-900">{REMINDER_INFO[p.type][0]}</p>
                    <p className="text-xs text-slate-500">{REMINDER_INFO[p.type][1]}</p>
                  </div>
                  <Field label="After (hours)">
                    <Input type="number" min={1} max={2160} value={d.thresholdHours} onChange={(e) => set({ thresholdHours: Number(e.target.value) })} disabled={!canAdmin} className="w-24" />
                  </Field>
                  <Field label="Repeat every (h)">
                    <Input type="number" min={1} max={2160} placeholder="never" value={d.repeatHours ?? ''} onChange={(e) => set({ repeatHours: e.target.value ? Number(e.target.value) : null })} disabled={!canAdmin} />
                  </Field>
                  <Field label="Channel">
                    <ChannelSelect channels={channels} value={d.channelId} onChange={(v) => set({ channelId: v })} emptyLabel="Repo / workspace default" disabled={!canAdmin} />
                  </Field>
                  <div className="flex items-center gap-3">
                    <Toggle label={`Enable ${REMINDER_INFO[p.type][0]}`} checked={d.enabled} onChange={(v) => set({ enabled: v })} disabled={!canAdmin} />
                    {canAdmin && (
                      <Button size="sm" variant="secondary" onClick={() => save(p)}>
                        Save
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </AsyncContent>
    </Card>
  );
}

function Members({ workspaceId, isOwner, canAdmin, setFlash }) {
  const { user, refresh } = useAuth();
  const navigate = useNavigate();
  const members = useApi(`/workspaces/${workspaceId}/members`);
  const invitations = useApi(canAdmin ? `/workspaces/${workspaceId}/invitations` : null);
  const [invite, setInvite] = useState({ role: 'member', githubLogin: '' });
  const [inviteUrl, setInviteUrl] = useState(null);
  const loginError = invite.githubLogin && !/^[A-Za-z0-9-]{1,39}$/.test(invite.githubLogin) ? 'Not a valid GitHub username' : null;

  const run = async (fn, msg) => {
    try {
      await fn();
      members.reload();
      invitations.reload();
      if (msg) setFlash({ message: msg });
    } catch (err) {
      setFlash({ tone: 'error', message: err.message });
    }
  };

  const createInvite = async (e) => {
    e.preventDefault();
    if (loginError) return;
    try {
      const res = await api.post(`/workspaces/${workspaceId}/invitations`, { role: invite.role, ...(invite.githubLogin ? { githubLogin: invite.githubLogin } : {}) });
      setInviteUrl(res.data.url);
      invitations.reload();
    } catch (err) {
      setFlash({ tone: 'error', message: err.message });
    }
  };

  const leave = async () => {
    if (!window.confirm('Leave this workspace?')) return;
    await run(() => api.delete(`/workspaces/${workspaceId}/members/${user.id}`));
    await refresh();
    navigate('/workspaces');
  };

  return (
    <Card title="Members" padded={false} actions={<Button size="sm" variant="ghost" onClick={leave}>Leave workspace</Button>}>
      <AsyncContent result={members}>
        {(list) => (
          <ul className="divide-y divide-slate-100">
            {list.map((m) => (
              <li key={m.userId} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                <span className="flex items-center gap-2">
                  {m.avatarUrl && <img src={m.avatarUrl} alt="" className="h-6 w-6 rounded-full" />}
                  <span className="font-medium text-slate-900">{m.login}</span>
                  {m.userId === user.id && <Badge>you</Badge>}
                </span>
                <span className="flex items-center gap-2">
                  {isOwner ? (
                    <Select aria-label={`Role for ${m.login}`} value={m.role} onChange={(e) => run(() => api.patch(`/workspaces/${workspaceId}/members/${m.userId}`, { role: e.target.value }), 'Role updated')} className="w-28">
                      <option value="owner">owner</option>
                      <option value="admin">admin</option>
                      <option value="member">member</option>
                    </Select>
                  ) : (
                    <Badge>{m.role}</Badge>
                  )}
                  {canAdmin && m.userId !== user.id && (
                    <Button size="sm" variant="ghost" onClick={() => window.confirm(`Remove ${m.login}?`) && run(() => api.delete(`/workspaces/${workspaceId}/members/${m.userId}`), 'Member removed')}>
                      Remove
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </AsyncContent>
      {canAdmin && (
        <div className="space-y-3 border-t border-slate-200 p-4">
          <form onSubmit={createInvite} className="flex flex-wrap items-end gap-3" noValidate>
            <Field label="Invite role">
              <Select value={invite.role} onChange={(e) => setInvite((i) => ({ ...i, role: e.target.value }))}>
                <option value="member">member</option>
                <option value="admin">admin</option>
              </Select>
            </Field>
            <Field label="Restrict to GitHub user (optional)" error={loginError}>
              <Input value={invite.githubLogin} onChange={(e) => setInvite((i) => ({ ...i, githubLogin: e.target.value.trim() }))} placeholder="octocat" />
            </Field>
            <Button type="submit">Create invite link</Button>
          </form>
          {inviteUrl && (
            <div className="rounded-md bg-slate-50 p-3 text-xs">
              <p className="mb-1 text-slate-600">Share this single-use link (valid 7 days). It is shown only once:</p>
              <code className="break-all text-slate-900">{inviteUrl}</code>
            </div>
          )}
          {invitations.data?.length > 0 && (
            <ul className="text-xs text-slate-600">
              {invitations.data.map((i) => (
                <li key={i.id} className="flex items-center justify-between py-1">
                  <span>
                    {i.role} invite{i.githubLogin ? ` for ${i.githubLogin}` : ''} · expires {formatDateTime(i.expiresAt)}
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => run(() => api.delete(`/workspaces/${workspaceId}/invitations/${i.id}`), 'Invitation revoked')}>
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}

function AuditLog({ workspaceId }) {
  const [page, setPage] = useState(1);
  const log = useApi(`/workspaces/${workspaceId}/audit-logs`, { page, pageSize: 15 });
  return (
    <Card title="Audit log" padded={false}>
      <AsyncContent result={log} empty={<EmptyState title="No administrative actions recorded yet" />}>
        {(rows, meta) => (
          <>
            <ul className="divide-y divide-slate-100 text-sm">
              {rows.map((r) => (
                <li key={r.id} className="flex justify-between gap-3 px-4 py-2">
                  <span>
                    <span className="font-mono text-xs">{r.action}</span> <span className="text-slate-500">by {r.actor || 'system'}</span>
                  </span>
                  <span className="text-xs text-slate-400">{timeAgo(r.createdAt)}</span>
                </li>
              ))}
            </ul>
            {meta.totalPages > 1 && (
              <div className="flex justify-end gap-2 px-4 py-2">
                <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                  Previous
                </Button>
                <Button size="sm" variant="secondary" disabled={page >= meta.totalPages} onClick={() => setPage(page + 1)}>
                  Next
                </Button>
              </div>
            )}
          </>
        )}
      </AsyncContent>
    </Card>
  );
}

export default function SettingsPage() {
  const { workspace, canAdmin, isOwner } = useOutletContext();
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const ws = useApi(`/workspaces/${workspace.id}`);
  const channels = useApi(`/workspaces/${workspace.id}/channels`);
  const [flash, setFlash] = useFlash();

  if (ws.loading && !ws.data) return <LoadingState />;
  if (ws.error) return <ErrorState error={ws.error} onRetry={ws.reload} />;
  const enabledChannels = (channels.data || []).filter((c) => c.enabled);

  const deleteWorkspace = async () => {
    if (window.prompt(`Type the workspace name to delete it permanently:`) !== ws.data.name) return;
    try {
      await api.delete(`/workspaces/${workspace.id}`);
      await refresh();
      navigate('/workspaces');
    } catch (err) {
      setFlash({ tone: 'error', message: err.message });
    }
  };

  return (
    <>
      <PageHeader title="Settings" description={canAdmin ? undefined : 'Only admins can change these settings.'} />
      <Flash flash={flash} onDismiss={() => setFlash(null)} />
      <div className="space-y-6">
        <GeneralSettings ws={ws.data} channels={enabledChannels} canAdmin={canAdmin} setFlash={setFlash} onSaved={(d) => { ws.setData(d); refresh(); }} />
        <ReminderPolicies workspaceId={workspace.id} channels={enabledChannels} canAdmin={canAdmin} setFlash={setFlash} />
        <Members workspaceId={workspace.id} isOwner={isOwner} canAdmin={canAdmin} setFlash={setFlash} />
        {canAdmin && <AuditLog workspaceId={workspace.id} />}
        {isOwner && (
          <Card title="Danger zone">
            <Button variant="danger" onClick={deleteWorkspace}>
              Delete workspace
            </Button>
            <p className="mt-2 text-xs text-slate-500">Deletes all rules, channels, events and history for this workspace. GitHub and Slack apps must be uninstalled separately.</p>
          </Card>
        )}
      </div>
    </>
  );
}
