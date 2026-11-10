import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../services/api.js';
import { useAuth } from '../../app/AuthProvider.jsx';
import { Button, Card, Field, Input, Notice, Select } from '../../components/ui.jsx';
import { validateWorkspaceName } from '../../utils/validation.js';

const ZONES = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : ['UTC'];

export default function WorkspacesPage() {
  const { workspaces, user, refresh, logout } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(false);
  const nameError = touched ? validateWorkspaceName(name) : null;

  const submit = async (e) => {
    e.preventDefault();
    setTouched(true);
    if (validateWorkspaceName(name)) return;
    setPending(true);
    setError(null);
    try {
      const res = await api.post('/workspaces', { name: name.trim(), timezone });
      await refresh();
      navigate(`/w/${res.data.id}/integrations`);
    } catch (err) {
      setError(err);
      setPending(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-12">
      <div className="mx-auto max-w-xl space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold text-slate-900">Workspaces</h1>
          <span className="text-sm text-slate-500">
            {user.login} ·{' '}
            <button type="button" className="hover:text-slate-900" onClick={logout}>
              Sign out
            </button>
          </span>
        </div>

        {workspaces.length > 0 && (
          <Card title="Your workspaces" padded={false}>
            <ul className="divide-y divide-slate-100">
              {workspaces.map((w) => (
                <li key={w.id}>
                  <Link to={`/w/${w.id}`} className="flex items-center justify-between px-4 py-3 text-sm hover:bg-slate-50">
                    <span className="font-medium text-slate-900">{w.name}</span>
                    <span className="capitalize text-slate-500">{w.role}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        )}

        <Card title="Create a workspace">
          <form onSubmit={submit} className="space-y-4" noValidate>
            {error && <Notice tone="error">{error.message}</Notice>}
            <p className="text-sm text-slate-500">A workspace connects one GitHub organization to your Slack workspace. Teammates can join with an invitation link.</p>
            <Field label="Workspace name" htmlFor="ws-name" error={nameError}>
              <Input id="ws-name" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => setTouched(true)} placeholder="Acme Engineering" maxLength={100} />
            </Field>
            <Field label="Timezone" htmlFor="ws-tz" hint="Used for the daily digest schedule.">
              <Select id="ws-tz" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
                {ZONES.map((z) => (
                  <option key={z}>{z}</option>
                ))}
              </Select>
            </Field>
            <Button type="submit" pending={pending}>
              Create workspace
            </Button>
          </form>
        </Card>
      </div>
    </div>
  );
}
