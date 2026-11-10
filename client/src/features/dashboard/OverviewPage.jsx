import { Link, useOutletContext } from 'react-router-dom';
import { useApi } from '../../hooks/useApi.js';
import { AsyncContent, Badge, Card, EmptyState, PageHeader, Stat, StatusBadge } from '../../components/ui.jsx';
import { eventLabel, eventSummary, eventTone, timeAgo } from '../../utils/format.js';

function ConnectionRow({ name, items, to }) {
  const active = items.find((i) => i.status === 'active');
  const current = active || items[0];
  return (
    <div className="flex items-center justify-between py-2 text-sm">
      <span className="font-medium text-slate-700">{name}</span>
      {current ? (
        <span className="flex items-center gap-2">
          <span className="text-slate-500">{current.displayName}</span>
          <StatusBadge status={current.status} />
        </span>
      ) : (
        <Link to={to} className="text-indigo-600 hover:text-indigo-700">
          Connect →
        </Link>
      )}
    </div>
  );
}

export default function OverviewPage() {
  const { workspace } = useOutletContext();
  const overview = useApi(`/workspaces/${workspace.id}/overview`);

  return (
    <>
      <PageHeader title="Overview" description="Live state of your monitored repositories." />
      <AsyncContent result={overview}>
        {(d) => {
          const notConnected = !d.github.some((g) => g.status === 'active') || !d.slack.some((s) => s.status === 'active');
          return (
            <div className="space-y-6">
              {notConnected && (
                <Card>
                  <p className="text-sm text-slate-700">
                    Finish setup: connect GitHub and Slack on the{' '}
                    <Link to="integrations" className="font-medium text-indigo-600">
                      Integrations
                    </Link>{' '}
                    page, then pick channels and create notification rules.
                  </p>
                </Card>
              )}
              <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
                <Stat label="Repositories" value={d.repositories.monitored} hint={`${d.repositories.total} connected`} />
                <Stat label="Open PRs" value={d.pullRequests.open} />
                <Stat label="Pending review" value={d.pullRequests.waitingForReview} tone={d.pullRequests.waitingForReview ? 'amber' : undefined} />
                <Stat label="Stale PRs" value={d.pullRequests.stale} hint={`> ${d.pullRequests.staleHours}h idle`} tone={d.pullRequests.stale ? 'amber' : undefined} />
                <Stat label="Open issues" value={d.issues.open} hint={`${d.issues.unassigned} unassigned`} />
                <Stat label="Failed workflows" value={d.failedWorkflows7d} hint="last 7 days" tone={d.failedWorkflows7d ? 'red' : undefined} />
              </div>

              <div className="grid gap-6 lg:grid-cols-3">
                <Card title="Connections">
                  <ConnectionRow name="GitHub" items={d.github} to="integrations" />
                  <ConnectionRow name="Slack" items={d.slack} to="integrations" />
                  <div className="mt-3 border-t border-slate-100 pt-3 text-xs text-slate-500">
                    Notifications (7d): {d.deliveries7d.sent} sent · {d.deliveries7d.failed} failed · {d.deliveries7d.pending} pending
                  </div>
                </Card>

                <Card title="Recent activity" className="lg:col-span-2" padded={false} actions={<Link to="activity" className="text-xs text-indigo-600">View all</Link>}>
                  {d.recentEvents.length === 0 ? (
                    <EmptyState title="No activity yet" description="Events appear here as soon as GitHub sends webhooks for monitored repositories." />
                  ) : (
                    <ul className="divide-y divide-slate-100">
                      {d.recentEvents.map((e) => (
                        <li key={e.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                          <div className="min-w-0">
                            <Badge tone={eventTone(e)}>{eventLabel(e.eventType)}</Badge>{' '}
                            <a href={e.resource?.url} target="_blank" rel="noreferrer" className="text-slate-800 hover:underline">
                              {eventSummary(e)}
                            </a>
                            <div className="truncate text-xs text-slate-500">
                              {e.repository?.fullName} · {e.actor?.login}
                            </div>
                          </div>
                          <span className="shrink-0 text-xs text-slate-400">{timeAgo(e.occurredAt)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              </div>

              <Card title="Recent notifications" padded={false}>
                {d.recentNotifications.length === 0 ? (
                  <EmptyState title="No notifications sent yet" />
                ) : (
                  <ul className="divide-y divide-slate-100">
                    {d.recentNotifications.map((n) => (
                      <li key={n.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                        <div className="min-w-0">
                          <span className="text-slate-800">{n.summary}</span>
                          <div className="text-xs text-slate-500">
                            #{n.channelName} · {n.kind}
                            {n.lastError ? ` · ${n.lastError}` : ''}
                          </div>
                        </div>
                        <span className="flex shrink-0 items-center gap-2">
                          <StatusBadge status={n.status} />
                          <span className="text-xs text-slate-400">{timeAgo(n.createdAt)}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
          );
        }}
      </AsyncContent>
    </>
  );
}
