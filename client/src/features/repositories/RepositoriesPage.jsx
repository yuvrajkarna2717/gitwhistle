import { useState } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import { useApi } from '../../hooks/useApi.js';
import { api } from '../../services/api.js';
import { AsyncContent, Badge, Button, Card, EmptyState, Flash, Input, PageHeader, Pagination, Select, Table, Toggle } from '../../components/ui.jsx';
import { useFlash } from '../../hooks/useFlash.js';
import { timeAgo } from '../../utils/format.js';

export default function RepositoriesPage() {
  const { workspace, canAdmin } = useOutletContext();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const repos = useApi(`/workspaces/${workspace.id}/repositories`, { search: search || undefined, page, pageSize: 50 });
  const channels = useApi(`/workspaces/${workspace.id}/channels`);
  const [flash, setFlash] = useFlash();
  const [busy, setBusy] = useState(null);

  const update = async (repo, patch) => {
    setBusy(repo.id);
    try {
      const res = await api.patch(`/workspaces/${workspace.id}/repositories/${repo.id}`, patch);
      repos.setData(repos.data.map((r) => (r.id === repo.id ? res.data : r)));
      setFlash({ message: `${repo.fullName} updated` });
    } catch (err) {
      setFlash({ tone: 'error', message: err.message });
    } finally {
      setBusy(null);
    }
  };

  const sync = async (repo) => {
    try {
      await api.post(`/workspaces/${workspace.id}/repositories/${repo.id}/sync`);
      setFlash({ message: `Sync queued for ${repo.fullName}. Open PRs and issues will refresh shortly.` });
    } catch (err) {
      setFlash({ tone: 'error', message: err.message });
    }
  };

  return (
    <>
      <PageHeader title="Repositories" description="Repositories the GitHub App can access. Only monitored repositories produce events and notifications." />
      <Flash flash={flash} onDismiss={() => setFlash(null)} />
      <div className="mb-4 max-w-sm">
        <Input aria-label="Search repositories" placeholder="Search repositories…" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
      </div>
      <Card padded={false}>
        <AsyncContent
          result={repos}
          empty={
            <EmptyState
              title={search ? 'No repositories match' : 'No repositories yet'}
              description={search ? undefined : 'Install the GitHub App on your organization to see repositories here.'}
              action={!search && <Link to="../integrations" className="text-sm font-medium text-indigo-600">Go to Integrations →</Link>}
            />
          }
        >
          {(rows, meta) => (
            <>
              <Table head={['Repository', 'Monitoring', 'Default channel', 'Last sync', '']}>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="px-4 py-3">
                      <a href={r.htmlUrl} target="_blank" rel="noreferrer" className="font-medium text-slate-900 hover:underline">
                        {r.fullName}
                      </a>
                      <div className="mt-0.5 flex gap-1">
                        {r.private && <Badge>private</Badge>}
                        {r.archived && <Badge tone="amber">archived</Badge>}
                        {r.integration.status !== 'active' && <Badge tone="red">installation {r.integration.status}</Badge>}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <Toggle label={`Monitor ${r.fullName}`} checked={r.monitoringEnabled} disabled={!canAdmin || busy === r.id} onChange={(v) => update(r, { monitoringEnabled: v })} />
                    </td>
                    <td className="px-4 py-3">
                      <Select aria-label={`Default channel for ${r.fullName}`} value={r.defaultChannelId || ''} disabled={!canAdmin || busy === r.id} onChange={(e) => update(r, { defaultChannelId: e.target.value || null })} className="w-44">
                        <option value="">Workspace default</option>
                        {(channels.data || []).map((c) => (
                          <option key={c.id} value={c.id}>
                            #{c.name}
                          </option>
                        ))}
                      </Select>
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500">{timeAgo(r.syncedAt)}</td>
                    <td className="px-4 py-3 text-right">
                      {canAdmin && (
                        <Button size="sm" variant="ghost" onClick={() => sync(r)}>
                          Sync
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </Table>
              <Pagination meta={meta} onPage={setPage} />
            </>
          )}
        </AsyncContent>
      </Card>
    </>
  );
}
