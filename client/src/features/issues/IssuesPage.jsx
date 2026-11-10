import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useApi } from '../../hooks/useApi.js';
import { AsyncContent, Badge, Card, EmptyState, Input, PageHeader, Pagination, Select, Table } from '../../components/ui.jsx';
import { timeAgo } from '../../utils/format.js';

export default function IssuesPage() {
  const { workspace } = useOutletContext();
  const [filters, setFilters] = useState({ state: 'open', unassigned: '', label: '', repositoryId: '', page: 1 });
  const repos = useApi(`/workspaces/${workspace.id}/repositories`, { pageSize: 200 });
  const issues = useApi(`/workspaces/${workspace.id}/issues`, { ...filters, unassigned: filters.unassigned || undefined, label: filters.label || undefined, repositoryId: filters.repositoryId || undefined, pageSize: 25 });
  const set = (k) => (e) => setFilters((f) => ({ ...f, [k]: e.target.value, page: 1 }));

  return (
    <>
      <PageHeader title="Issues" description="GitHub issues in monitored repositories." />
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Select aria-label="State" value={filters.state} onChange={set('state')}>
          <option value="open">Open</option>
          <option value="closed">Closed</option>
          <option value="all">All</option>
        </Select>
        <Select aria-label="Assignment" value={filters.unassigned} onChange={set('unassigned')}>
          <option value="">Assigned or not</option>
          <option value="true">Unassigned only</option>
          <option value="false">Assigned only</option>
        </Select>
        <Input aria-label="Label" placeholder="Label (exact)" value={filters.label} onChange={set('label')} />
        <Select aria-label="Repository" value={filters.repositoryId} onChange={set('repositoryId')}>
          <option value="">All repositories</option>
          {(repos.data || []).map((r) => (
            <option key={r.id} value={r.id}>
              {r.fullName}
            </option>
          ))}
        </Select>
      </div>
      <Card padded={false}>
        <AsyncContent result={issues} empty={<EmptyState title="No issues match" />}>
          {(rows, meta) => (
            <>
              <Table head={['Issue', 'Assignees', 'Labels', 'State', 'Last activity']}>
                {rows.map((i) => (
                  <tr key={i.id}>
                    <td className="max-w-md px-4 py-3">
                      <a href={i.htmlUrl} target="_blank" rel="noreferrer" className="font-medium text-slate-900 hover:underline">
                        #{i.number} {i.title}
                      </a>
                      <div className="text-xs text-slate-500">
                        {i.repository.fullName} · opened by {i.author}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs">{i.assignees.length ? i.assignees.join(', ') : <Badge tone="amber">unassigned</Badge>}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {i.labels.map((l) => (
                          <Badge key={l} tone={/critical|p0|sev/i.test(l) ? 'red' : 'slate'}>
                            {l}
                          </Badge>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={i.state === 'open' ? 'green' : 'violet'}>{i.state}</Badge>
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500">{timeAgo(i.lastActivityAt)}</td>
                  </tr>
                ))}
              </Table>
              <Pagination meta={meta} onPage={(page) => setFilters((f) => ({ ...f, page }))} />
            </>
          )}
        </AsyncContent>
      </Card>
    </>
  );
}
