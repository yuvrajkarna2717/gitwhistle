import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useApi } from '../../hooks/useApi.js';
import { AsyncContent, Badge, Card, EmptyState, PageHeader, Pagination, Select, Table } from '../../components/ui.jsx';
import { formatHours, PR_STATUS_LABEL, PR_STATUS_TONE, timeAgo } from '../../utils/format.js';

const TABS = [
  ['open', 'All open'],
  ['waiting_for_review', 'Waiting for review'],
  ['waiting_for_author', 'Waiting for author'],
  ['stale', 'Stale'],
  ['approved', 'Approved'],
  ['draft', 'Drafts'],
  ['merged', 'Merged'],
];

export default function PullRequestsPage() {
  const { workspace } = useOutletContext();
  const [status, setStatus] = useState('open');
  const [repositoryId, setRepositoryId] = useState('');
  const [page, setPage] = useState(1);
  const summary = useApi(`/workspaces/${workspace.id}/pull-requests/summary`);
  const repos = useApi(`/workspaces/${workspace.id}/repositories`, { pageSize: 200 });
  const prs = useApi(`/workspaces/${workspace.id}/pull-requests`, { status, repositoryId: repositoryId || undefined, page, pageSize: 25 });

  const counts = summary.data
    ? { open: summary.data.open, waiting_for_review: summary.data.waitingForReview, waiting_for_author: summary.data.waitingForAuthor, stale: summary.data.stale, draft: summary.data.draft }
    : {};

  return (
    <>
      <PageHeader title="Pull Requests" description="Open pull requests across monitored repositories, with review status from GitHub." />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => { setStatus(key); setPage(1); }}
            className={`rounded-full px-3 py-1 text-sm ${status === key ? 'bg-indigo-600 text-white' : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50'}`}
            aria-pressed={status === key}
          >
            {label}
            {counts[key] !== undefined && <span className="ml-1 opacity-75">{counts[key]}</span>}
          </button>
        ))}
        <Select aria-label="Repository" value={repositoryId} onChange={(e) => { setRepositoryId(e.target.value); setPage(1); }} className="ml-auto w-56">
          <option value="">All repositories</option>
          {(repos.data || []).map((r) => (
            <option key={r.id} value={r.id}>
              {r.fullName}
            </option>
          ))}
        </Select>
      </div>
      <Card padded={false}>
        <AsyncContent result={prs} empty={<EmptyState title="No pull requests here" description="PRs appear once GitHub sends events or a repository sync completes." />}>
          {(rows, meta) => (
            <>
              <Table head={['Pull request', 'Author', 'Age', 'Review status', 'Reviewers', 'Last activity']}>
                {rows.map((p) => (
                  <tr key={p.id}>
                    <td className="max-w-md px-4 py-3">
                      <a href={p.htmlUrl} target="_blank" rel="noreferrer" className="font-medium text-slate-900 hover:underline">
                        #{p.number} {p.title}
                      </a>
                      <div className="text-xs text-slate-500">
                        {p.repository.fullName} · {p.headBranch} → {p.baseBranch}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-slate-700">{p.author}</td>
                    <td className="px-4 py-3 text-slate-700">{formatHours(p.ageHours)}</td>
                    <td className="px-4 py-3">
                      <Badge tone={PR_STATUS_TONE[p.status]}>{PR_STATUS_LABEL[p.status] || p.status}</Badge> {p.stale && <Badge tone="amber">stale</Badge>}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-600">{[...p.requestedReviewers, ...p.requestedTeams.map((t) => `@${t}`)].join(', ') || '—'}</td>
                    <td className="px-4 py-3 text-xs text-slate-500">{timeAgo(p.lastActivityAt)}</td>
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
