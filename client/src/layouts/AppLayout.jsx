import { useState } from 'react';
import { NavLink, Outlet, useNavigate, useParams, Navigate } from 'react-router-dom';
import { useAuth } from '../app/AuthProvider.jsx';
import { Select } from '../components/ui.jsx';

const NAV = [
  { to: '', label: 'Overview', end: true },
  { to: 'activity', label: 'Activity' },
  { to: 'repositories', label: 'Repositories' },
  { to: 'pull-requests', label: 'Pull Requests' },
  { to: 'issues', label: 'Issues' },
  { to: 'rules', label: 'Notification Rules' },
  { to: 'integrations', label: 'Integrations' },
  { to: 'settings', label: 'Settings' },
];

export default function AppLayout() {
  const { workspaceId } = useParams();
  const { user, workspaces, logout } = useAuth();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const current = workspaces.find((w) => w.id === workspaceId);
  if (!current) return <Navigate to="/workspaces" replace />;

  return (
    <div className="min-h-screen bg-slate-50 lg:flex">
      <aside className={`${menuOpen ? 'block' : 'hidden'} border-b border-slate-200 bg-white lg:block lg:min-h-screen lg:w-60 lg:shrink-0 lg:border-b-0 lg:border-r`}>
        <div className="hidden px-4 py-4 lg:block">
          <span className="text-base font-semibold text-slate-900">GitWhistle</span>
        </div>
        <div className="px-3 pb-3">
          <label htmlFor="workspace-switcher" className="sr-only">
            Workspace
          </label>
          <Select
            id="workspace-switcher"
            value={workspaceId}
            onChange={(e) => (e.target.value === '__new' ? navigate('/workspaces') : navigate(`/w/${e.target.value}`))}
          >
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
            <option value="__new">+ Create or switch workspace…</option>
          </Select>
        </div>
        <nav className="space-y-0.5 px-2 pb-4" aria-label="Main">
          {NAV.map((item) => (
            <NavLink
              key={item.label}
              to={item.to}
              end={item.end}
              onClick={() => setMenuOpen(false)}
              className={({ isActive }) =>
                `block rounded-md px-3 py-2 text-sm font-medium ${isActive ? 'bg-indigo-50 text-indigo-700' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'}`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="min-w-0 flex-1">
        <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3 lg:px-8">
          <button type="button" className="text-sm font-semibold text-slate-900 lg:hidden" onClick={() => setMenuOpen((o) => !o)} aria-expanded={menuOpen}>
            ☰ GitWhistle
          </button>
          <span className="hidden text-sm text-slate-500 lg:block">
            {current.name} · <span className="capitalize">{current.role}</span>
          </span>
          <div className="flex items-center gap-3">
            {user.avatarUrl && <img src={user.avatarUrl} alt="" className="h-7 w-7 rounded-full" />}
            <span className="text-sm text-slate-700">{user.login}</span>
            <button type="button" onClick={logout} className="text-sm text-slate-500 hover:text-slate-900">
              Sign out
            </button>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-6 lg:px-8">
          <Outlet context={{ workspace: current, canAdmin: current.role !== 'member', isOwner: current.role === 'owner' }} />
        </main>
      </div>
    </div>
  );
}
