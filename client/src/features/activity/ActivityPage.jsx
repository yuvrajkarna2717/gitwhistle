import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useApi } from '../../hooks/useApi.js';
import { api } from '../../services/api.js';
import { AsyncContent, Badge, Card, EmptyState, ErrorState, LoadingState, PageHeader, Pagination, Select, StatusBadge, Button } from '../../components/ui.jsx';
import { eventLabel, eventSummary, eventTone, formatDateTime, timeAgo } from '../../utils/format.js';

const PERIODS = { '': 'Any time', 24: 'Last 24 hours', 168: 'Last 7 days', 720: 'Last 30 days' };
const CATEGORIES = { '': 'All events', pull_request: 'Pull requests', pull_request_review: 'Reviews', issues: 'Issues', issue_comment: 'Comments', push: 'Pushes', workflow_run: 'Workflow runs', release: 'Releases', deployment_status: 'Deployments' };

function EventDetail({ workspaceId, eventId, onClose }) {
  const detail = useApi(`/workspaces/${workspaceId}/events/${eventId}`);
  return (
    <Card title="Event details" actions={<Button variant="ghost" size="sm" onClick={onClose}>Close</Button>}>
      {detail.loading ? (
        <LoadingState />
      ) : detail.error ? (
        <ErrorState error={detail.error} onRetry={detail.reload} />
      ) : (
        <div className="space-y-3 text-sm">
          <p>
            <Badge tone={eventTone(detail.data)}>{detail.data.eventType}</Badge> <span className="text-slate-500">{formatDateTime(detail.data.occurredAt)}</span>
          </p>
          <p className="font-medium text-slate-900">{eventSummary(detail.data)}</p>
          <div>
            <p className="mb-1 text-xs font-semibold uppercase text-slate-500">Notifications</p>
            {detail.data.deliveries.length === 0 ? (
              <p className="text-slate-500">No notification rule matched this event.</p>
            ) : (
              <ul className="space-y-1">
                {detail.data.deliveries.map((d) => (
                  <li key={d.id} className="flex items-center gap-2">
                    #{d.channelName} <StatusBadge status={d.status} /> {d.lastError && <span className="text-xs text-red-600">{d.lastError}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <details>
            <summary className="cursor-pointer text-xs text-slate-500">Normalized metadata</summary>
            <pre className="mt-2 max-h-72 overflow-auto rounded bg-slate-50 p-3 text-xs">{JSON.stringify(detail.data.metadata, null, 2)}</pre>
          </details>
        </div>
      )}
    </Card>
  );
}

export default function ActivityPage() {
  const { workspace, canAdmin } = useOutletContext();
  const [filters, setFilters] = useState({ eventType: '', repositoryId: '', actor: '', period: '', from: undefined, page: 1 });
  const [selected, setSelected] = useState(null);
  const repos = useApi(`/workspaces/${workspace.id}/repositories`, { pageSize: 200 });
  const actors = useApi(`/workspaces/${workspace.id}/events/actors`);
  const events = useApi(`/workspaces/${workspace.id}/events`, {
    eventType: filters.eventType || undefined,
    repositoryId: filters.repositoryId || undefined,
    actor: filters.actor || undefined,
    from: filters.from,
    page: filters.page,
    pageSize: 25,
  });
  const set = (k) => (e) => setFilters((f) => ({ ...f, [k]: e.target.value, page: 1 }));
  // The window start is computed when the period is chosen (not during render) so results are stable.
  const setPeriod = (e) => {
    const period = e.target.value;
    setFilters((f) => ({ ...f, period, from: period ? new Date(Date.now() - Number(period) * 3600_000).toISOString() : undefined, page: 1 }));
  };

  return (
    <>
      <PageHeader title="Activity" description="Every GitHub event received for monitored repositories." />
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Select aria-label="Event type" value={filters.eventType} onChange={set('eventType')}>
          {Object.entries(CATEGORIES).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </Select>
        <Select aria-label="Repository" value={filters.repositoryId} onChange={set('repositoryId')}>
          <option value="">All repositories</option>
          {(repos.data || []).map((r) => (
            <option key={r.id} value={r.id}>
              {r.fullName}
            </option>
          ))}
        </Select>
        <Select aria-label="Actor" value={filters.actor} onChange={set('actor')}>
          <option value="">All people</option>
          {(actors.data || []).map((a) => (
            <option key={a}>{a}</option>
          ))}
        </Select>
        <Select aria-label="Time period" value={filters.period} onChange={setPeriod}>
          {Object.entries(PERIODS).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </Select>
      </div>

      <div className="grid gap-6 lg:grid-cols-5">
        <Card padded={false} className={selected ? 'lg:col-span-3' : 'lg:col-span-5'}>
          <AsyncContent result={events} empty={<EmptyState title="No events match these filters" description="Try widening the time period or clearing filters." />}>
            {(rows, meta) => (
              <>
                <ul className="divide-y divide-slate-100">
                  {rows.map((e) => (
                    <li key={e.id}>
                      <button type="button" onClick={() => setSelected(e.id)} className={`flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm hover:bg-slate-50 ${selected === e.id ? 'bg-indigo-50/50' : ''}`}>
                        <div className="min-w-0">
                          <Badge tone={eventTone(e)}>{eventLabel(e.eventType)}</Badge> <span className="text-slate-800">{eventSummary(e)}</span>
                          <div className="truncate text-xs text-slate-500">
                            {e.repository?.fullName} · {e.actor?.login}
                          </div>
                        </div>
                        <span className="shrink-0 text-xs text-slate-400">{timeAgo(e.occurredAt)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
                <Pagination meta={meta} onPage={(page) => setFilters((f) => ({ ...f, page }))} />
              </>
            )}
          </AsyncContent>
        </Card>
        {selected && (
          <div className="lg:col-span-2">
            <EventDetail workspaceId={workspace.id} eventId={selected} onClose={() => setSelected(null)} />
          </div>
        )}
      </div>
      {canAdmin && <DeliveryLog workspaceId={workspace.id} />}
    </>
  );
}

function DeliveryLog({ workspaceId }) {
  const [status, setStatus] = useState('failed');
  const rows = useApi(`/workspaces/${workspaceId}/webhook-deliveries`, { status: status || undefined, pageSize: 20 });
  const [busy, setBusy] = useState(null);
  const reprocess = async (id) => {
    setBusy(id);
    try {
      await api.post(`/workspaces/${workspaceId}/webhook-deliveries/${id}/reprocess`);
      rows.reload();
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card
      title="Webhook deliveries"
      className="mt-6"
      padded={false}
      actions={
        <Select aria-label="Delivery status" value={status} onChange={(e) => setStatus(e.target.value)} className="w-36">
          <option value="">All</option>
          {['failed', 'dead', 'ignored', 'pending', 'processed'].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </Select>
      }
    >
      <AsyncContent result={rows} empty={<EmptyState title={status ? `No ${status} deliveries` : 'No deliveries yet'} />}>
        {(list) => (
          <ul className="divide-y divide-slate-100">
            {list.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                <div className="min-w-0">
                  <span className="font-mono text-xs text-slate-700">{d.event}</span> <StatusBadge status={d.status} />{' '}
                  <span className="text-xs text-slate-500">
                    {d.attempts} attempt{d.attempts === 1 ? '' : 's'} · {timeAgo(d.receivedAt)}
                  </span>
                  {(d.lastError || d.ignoreReason) && <div className="truncate text-xs text-red-600">{d.lastError || d.ignoreReason}</div>}
                </div>
                {['failed', 'dead', 'ignored'].includes(d.status) && (
                  <Button size="sm" variant="secondary" pending={busy === d.id} onClick={() => reprocess(d.id)}>
                    Reprocess
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </AsyncContent>
    </Card>
  );
}
