import { useState } from 'react';
import { useOutletContext, useSearchParams } from 'react-router-dom';
import { useApi } from '../../hooks/useApi.js';
import { api, oauthUrls } from '../../services/api.js';
import { AsyncContent, Badge, Button, Card, EmptyState, ErrorState, Flash, LinkButton, LoadingState, Notice, PageHeader, StatusBadge, Toggle } from '../../components/ui.jsx';
import { useFlash } from '../../hooks/useFlash.js';
import { formatDateTime } from '../../utils/format.js';

const CALLBACK_MESSAGES = {
  'github=connected': ['success', 'GitHub connected. Repositories are being synchronised.'],
  'github=requested': ['info', 'Installation requested. An organization owner must approve it on GitHub.'],
  'slack=connected': ['success', 'Slack connected. Now choose which channels GitWhistle may post to.'],
  'error=forbidden': ['error', 'Your GitHub account does not have access to that installation, or you are not a workspace admin.'],
  'error=installation_claimed': ['error', 'That GitHub installation is already connected to another GitWhistle workspace.'],
  'error=slack_workspace_claimed': ['error', 'That Slack workspace is already connected to another GitWhistle workspace.'],
  'error=github_account_mismatch': ['error', 'You authorised GitHub with a different account than the one you are signed in with.'],
  'error=invalid_state': ['error', 'The connection link expired or was already used. Please try again.'],
  'error=slack_access_denied': ['warn', 'Slack installation was cancelled.'],
  'error=slack_oauth_failed': ['error', 'Slack installation failed. Please try again.'],
};

function IntegrationCard({ integration, onDisconnect, onSync, canAdmin, children }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="text-sm">
          <p className="font-medium text-slate-900">
            {integration.displayName} <StatusBadge status={integration.status} />
          </p>
          <p className="text-xs text-slate-500">
            {integration.accountType} · connected {formatDateTime(integration.connectedAt)}
          </p>
          {integration.lastError && <p className="mt-1 text-xs text-red-600">{integration.lastError}</p>}
        </div>
        {canAdmin && integration.status !== 'disconnected' && (
          <div className="flex gap-2">
            {onSync && integration.status === 'active' && (
              <Button size="sm" variant="secondary" onClick={onSync}>
                Sync repositories
              </Button>
            )}
            <Button size="sm" variant="danger" onClick={onDisconnect}>
              Disconnect
            </Button>
          </div>
        )}
      </div>
      {children}
    </div>
  );
}

function SlackChannels({ workspaceId, canAdmin, setFlash }) {
  const configured = useApi(`/workspaces/${workspaceId}/channels`);
  const [available, setAvailable] = useState(null);
  const [loadingAvail, setLoadingAvail] = useState(false);
  const [availError, setAvailError] = useState(null);
  const [selected, setSelected] = useState([]);
  const [busy, setBusy] = useState(null);

  const discover = async () => {
    setLoadingAvail(true);
    setAvailError(null);
    try {
      setAvailable((await api.get(`/workspaces/${workspaceId}/integrations/slack/channels`)).data);
    } catch (err) {
      setAvailError(err);
    } finally {
      setLoadingAvail(false);
    }
  };

  const add = async () => {
    try {
      await api.post(`/workspaces/${workspaceId}/channels`, { externalIds: selected });
      setSelected([]);
      setAvailable(null);
      configured.reload();
      setFlash({ message: 'Channels added' });
    } catch (err) {
      setFlash({ tone: 'error', message: err.message });
    }
  };

  const act = async (id, fn, okMsg) => {
    setBusy(id);
    try {
      const res = await fn();
      configured.reload();
      setFlash(okMsg(res));
    } catch (err) {
      setFlash({ tone: 'error', message: err.message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="border-t border-slate-100 pt-3">
      <p className="mb-2 text-xs font-semibold uppercase text-slate-500">Notification channels</p>
      <AsyncContent result={configured} empty={<p className="text-sm text-slate-500">No channels selected yet.</p>}>
        {(list) => (
          <ul className="divide-y divide-slate-100 rounded-md ring-1 ring-slate-200">
            {list.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                <span>
                  #{c.name} {c.isPrivate && <Badge>private</Badge>}
                </span>
                {canAdmin && (
                  <span className="flex items-center gap-2">
                    <Toggle label={`Enable #${c.name}`} checked={c.enabled} disabled={busy === c.id} onChange={(v) => act(c.id, () => api.patch(`/workspaces/${workspaceId}/channels/${c.id}`, { enabled: v }), () => ({ message: `#${c.name} ${v ? 'enabled' : 'disabled'}` }))} />
                    <Button
                      size="sm"
                      variant="ghost"
                      pending={busy === c.id}
                      onClick={() => act(c.id, () => api.post(`/workspaces/${workspaceId}/channels/${c.id}/test`), (r) => (r.data.outcome === 'sent' ? { message: `Test message sent to #${c.name}` } : { tone: 'error', message: `Test failed: ${r.data.error || r.data.outcome}` }))}
                    >
                      Send test
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => window.confirm(`Remove #${c.name}? Rules using it will stop sending there.`) && act(c.id, () => api.delete(`/workspaces/${workspaceId}/channels/${c.id}`), () => ({ message: 'Channel removed' }))}>
                      Remove
                    </Button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </AsyncContent>
      {canAdmin && (
        <div className="mt-3">
          {!available ? (
            <Button size="sm" variant="secondary" pending={loadingAvail} onClick={discover}>
              Add channels…
            </Button>
          ) : (
            <div className="space-y-2">
              <p className="text-xs text-slate-500">Public channels work without inviting the bot. For private channels, invite @GitWhistle first.</p>
              <div className="flex max-h-56 flex-wrap gap-2 overflow-y-auto">
                {available
                  .filter((c) => !c.channelId)
                  .map((c) => (
                    <label key={c.externalId} className={`flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1 text-sm ring-1 ${selected.includes(c.externalId) ? 'bg-indigo-50 text-indigo-700 ring-indigo-200' : 'ring-slate-200'}`}>
                      <input type="checkbox" className="sr-only" checked={selected.includes(c.externalId)} onChange={() => setSelected((s) => (s.includes(c.externalId) ? s.filter((x) => x !== c.externalId) : [...s, c.externalId]))} />#{c.name}
                    </label>
                  ))}
              </div>
              <div className="flex gap-2">
                <Button size="sm" disabled={!selected.length} onClick={add}>
                  Add {selected.length || ''} channel{selected.length === 1 ? '' : 's'}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setAvailable(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
          {availError && <ErrorState error={availError} onRetry={discover} />}
        </div>
      )}
    </div>
  );
}

export default function IntegrationsPage() {
  const { workspace, canAdmin } = useOutletContext();
  const [params, setParams] = useSearchParams();
  const data = useApi(`/workspaces/${workspace.id}/integrations`);
  const [flash, setFlash] = useFlash(6000);
  const callbackKey = [...params.entries()].map(([k, v]) => `${k}=${v}`).find((k) => CALLBACK_MESSAGES[k]);
  const callback = callbackKey ? CALLBACK_MESSAGES[callbackKey] : params.get('error') ? ['error', `Connection failed (${params.get('error')}).`] : null;

  const disconnect = async (integration) => {
    const note = integration.provider === 'github' ? ' The GitHub App stays installed on GitHub until you uninstall it there.' : '';
    if (!window.confirm(`Disconnect ${integration.displayName}?${note}`)) return;
    try {
      await api.delete(`/workspaces/${workspace.id}/integrations/${integration.id}`);
      data.reload();
      setFlash({ message: `${integration.displayName} disconnected` });
    } catch (err) {
      setFlash({ tone: 'error', message: err.message });
    }
  };
  const sync = async (integration) => {
    try {
      await api.post(`/workspaces/${workspace.id}/integrations/${integration.id}/sync`);
      setFlash({ message: 'Repository sync queued' });
    } catch (err) {
      setFlash({ tone: 'error', message: err.message });
    }
  };

  if (data.loading && !data.data) return <LoadingState />;
  if (data.error) return <ErrorState error={data.error} onRetry={data.reload} />;
  const { integrations, available, requirements } = data.data;
  const github = integrations.filter((i) => i.provider === 'github');
  const slack = integrations.filter((i) => i.provider === 'slack');
  const activeSlack = slack.find((s) => s.status === 'active');

  return (
    <>
      <PageHeader title="Integrations" description="Connect your GitHub organization (event source) and Slack workspace (destination)." />
      {callback && (
        <Notice tone={callback[0]} onDismiss={() => setParams({})}>
          {callback[1]}
        </Notice>
      )}
      <Flash flash={flash} onDismiss={() => setFlash(null)} />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="GitHub" actions={canAdmin && available.github && <LinkButton href={oauthUrls.installGitHub(workspace.id)} variant={github.some((g) => g.status === 'active') ? 'secondary' : 'primary'}>Install GitHub App</LinkButton>}>
          {!available.github && <Notice tone="warn">The GitHub App is not configured on this server (see ENVIRONMENT.md).</Notice>}
          {github.length === 0 ? (
            <EmptyState title="GitHub not connected" description="Install the GitWhistle GitHub App on your organization and choose which repositories it can read." />
          ) : (
            <div className="space-y-6">
              {github.map((g) => (
                <IntegrationCard key={g.id} integration={g} canAdmin={canAdmin} onDisconnect={() => disconnect(g)} onSync={() => sync(g)}>
                  {(g.details.missingPermissions.length > 0 || g.details.missingEvents.length > 0) && (
                    <Notice tone="warn">
                      The installation is missing {g.details.missingPermissions.length ? `permissions (${g.details.missingPermissions.join(', ')})` : ''}
                      {g.details.missingPermissions.length && g.details.missingEvents.length ? ' and ' : ''}
                      {g.details.missingEvents.length ? `event subscriptions (${g.details.missingEvents.join(', ')})` : ''}. Some notifications will not work until the app is updated on GitHub.
                    </Notice>
                  )}
                  <p className="text-xs text-slate-500">Repository access: {g.details.repositorySelection === 'all' ? 'all repositories' : 'selected repositories'}</p>
                </IntegrationCard>
              ))}
            </div>
          )}
          <details className="mt-4 text-xs text-slate-500">
            <summary className="cursor-pointer">Required permissions</summary>
            <p className="mt-2">Read-only: {Object.keys(requirements.github.permissions).join(', ')}.</p>
            <p>Events: {requirements.github.events.join(', ')}.</p>
          </details>
        </Card>

        <Card title="Slack" actions={canAdmin && available.slack && !activeSlack && <LinkButton href={oauthUrls.connectSlack(workspace.id)}>Add to Slack</LinkButton>}>
          {!available.slack && <Notice tone="warn">Slack is not configured on this server (see ENVIRONMENT.md).</Notice>}
          {slack.length === 0 ? (
            <EmptyState title="Slack not connected" description="Install the GitWhistle bot into your Slack workspace, then pick the channels it may post to." />
          ) : (
            <div className="space-y-6">
              {slack.map((s) => (
                <IntegrationCard key={s.id} integration={s} canAdmin={canAdmin} onDisconnect={() => disconnect(s)}>
                  {s.status === 'revoked' && canAdmin && (
                    <Notice tone="error">
                      Slack access was revoked. <a className="underline" href={oauthUrls.connectSlack(workspace.id)}>Reconnect Slack</a>.
                    </Notice>
                  )}
                  {s.status === 'active' && <SlackChannels workspaceId={workspace.id} canAdmin={canAdmin} setFlash={setFlash} />}
                </IntegrationCard>
              ))}
            </div>
          )}
          <details className="mt-4 text-xs text-slate-500">
            <summary className="cursor-pointer">Requested bot scopes</summary>
            <p className="mt-2">{requirements.slack.scopes.join(', ')}</p>
          </details>
        </Card>
      </div>
    </>
  );
}
