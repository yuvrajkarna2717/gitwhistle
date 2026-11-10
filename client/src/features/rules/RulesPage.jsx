import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useApi } from '../../hooks/useApi.js';
import { api } from '../../services/api.js';
import { AsyncContent, Badge, Button, Card, EmptyState, ErrorState, Flash, LoadingState, PageHeader, Toggle } from '../../components/ui.jsx';
import { useFlash } from '../../hooks/useFlash.js';
import RuleEditor from './RuleEditor.jsx';
import { emptyRule } from './ruleForm.js';
import { eventLabel } from '../../utils/format.js';

function describeCondition(c, meta) {
  const label = meta.fields[c.field]?.label?.split(' (')[0] || c.field;
  const value = Array.isArray(c.value) ? c.value.join(', ') : c.field === 'eventType' ? eventLabel(c.value) : String(c.value ?? '');
  return `${label} ${c.operator.replace(/_/g, ' ')} ${value}`.trim();
}

export default function RulesPage() {
  const { workspace, canAdmin } = useOutletContext();
  const base = `/workspaces/${workspace.id}/notification-rules`;
  const rules = useApi(base);
  const meta = useApi(`${base}/meta`);
  const channels = useApi(`/workspaces/${workspace.id}/channels`);
  const settings = useApi(`/workspaces/${workspace.id}`);
  const [editing, setEditing] = useState(null);
  const [flash, setFlash] = useFlash();

  if (meta.loading || channels.loading) return <LoadingState />;
  if (meta.error || channels.error) return <ErrorState error={meta.error || channels.error} onRetry={() => { meta.reload(); channels.reload(); }} />;
  const channelName = (id) => channels.data.find((c) => c.id === id)?.name || 'unknown';

  const save = async (data) => {
    if (editing.id) await api.patch(`${base}/${editing.id}`, data);
    else await api.post(base, data);
    setEditing(null);
    setFlash({ message: 'Rule saved' });
    rules.reload();
  };

  const toggle = async (rule) => {
    try {
      await api.patch(`${base}/${rule.id}`, { enabled: !rule.enabled });
      rules.reload();
    } catch (err) {
      setFlash({ tone: 'error', message: err.message });
    }
  };

  const remove = async (rule) => {
    if (!window.confirm(`Delete rule "${rule.name}"?`)) return;
    try {
      await api.delete(`${base}/${rule.id}`);
      setFlash({ message: 'Rule deleted' });
      rules.reload();
    } catch (err) {
      setFlash({ tone: 'error', message: err.message });
    }
  };

  const fallbackOn = settings.data?.fallbackRoutingEnabled;
  const defaultChannel = settings.data?.defaultChannelId && channelName(settings.data.defaultChannelId);

  return (
    <>
      <PageHeader
        title="Notification Rules"
        description="Rules decide which Slack channels receive which GitHub events. Rules run in priority order."
        actions={canAdmin && !editing && <Button onClick={() => setEditing(emptyRule())}>New rule</Button>}
      />
      <Flash flash={flash} onDismiss={() => setFlash(null)} />
      {settings.data && (
        <p className="mb-4 text-sm text-slate-500">
          {fallbackOn
            ? `When no rule matches, important events (new/merged PRs, approvals and change requests, new issues, failed workflows, releases) go to each repository's default channel or #${defaultChannel || '—'}.`
            : 'Fallback routing is off: events that match no rule are not sent anywhere.'}
        </p>
      )}

      {editing && (
        <Card title={editing.id ? `Edit "${editing.name}"` : 'New rule'} className="mb-6">
          <RuleEditor
            initial={editing}
            meta={meta.data}
            channels={channels.data.filter((c) => c.enabled)}
            onSave={save}
            onCancel={() => setEditing(null)}
            onPreview={async (rule) => (await api.post(`${base}/preview`, { rule })).data}
          />
        </Card>
      )}

      <Card padded={false}>
        <AsyncContent
          result={rules}
          empty={<EmptyState title="No rules yet" description="Without rules, fallback routing sends important events to the default channel." action={canAdmin && !editing && <Button onClick={() => setEditing(emptyRule())}>Create your first rule</Button>} />}
        >
          {(list) => (
            <ul className="divide-y divide-slate-100">
              {list.map((r) => (
                <li key={r.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
                  <div className="min-w-0 text-sm">
                    <p className="font-medium text-slate-900">
                      <span className="mr-2 text-xs text-slate-400">#{r.priority}</span>
                      {r.name} {!r.enabled && <Badge>disabled</Badge>} {r.actions.priority === 'high' && <Badge tone="red">high</Badge>}
                    </p>
                    <p className="mt-0.5 text-xs text-slate-500">
                      {r.conditions.length ? r.conditions.map((c) => describeCondition(c, meta.data)).join(r.matchMode === 'all' ? ' AND ' : ' OR ') : 'Every event'}
                    </p>
                    <p className="mt-0.5 text-xs text-slate-600">
                      → {r.actions.suppress ? 'mute (send nothing)' : r.actions.channelIds.map((id) => `#${channelName(id)}`).join(', ')}
                      {r.actions.stopProcessing && ' · stop'}
                    </p>
                  </div>
                  {canAdmin && (
                    <div className="flex items-center gap-2">
                      <Toggle label={`Enable ${r.name}`} checked={r.enabled} onChange={() => toggle(r)} />
                      <Button size="sm" variant="secondary" onClick={() => setEditing({ ...r, description: r.description || '' })}>
                        Edit
                      </Button>
                      <Button size="sm" variant="danger" onClick={() => remove(r)}>
                        Delete
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </AsyncContent>
      </Card>
    </>
  );
}
