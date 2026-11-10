import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../app/AuthProvider.jsx';
import { AppRoutes } from '../app/App.jsx';
import { validateRule, emptyRule } from '../features/rules/ruleForm.js';
import { validateWorkspaceName } from '../utils/validation.js';

const WS = '0b6f3f7e-1111-4222-8333-444444444444';
const me = { user: { id: 'u1', login: 'alice', avatarUrl: null }, csrfToken: 'csrf-123', workspaces: [{ id: WS, name: 'Acme', slug: 'acme', role: 'owner' }] };
const overview = {
  github: [{ id: 'g', provider: 'github', status: 'active', displayName: 'acme' }],
  slack: [{ id: 's', provider: 'slack', status: 'active', displayName: 'Acme Slack' }],
  repositories: { total: 3, monitored: 2 },
  pullRequests: { open: 5, waitingForReview: 2, waitingForAuthor: 1, draft: 0, stale: 1, staleHours: 72 },
  issues: { open: 4, unassigned: 3 },
  failedWorkflows7d: 1,
  deliveries7d: { sent: 9, failed: 1, pending: 0 },
  recentEvents: [{ id: 'e1', eventType: 'pull_request.opened', metadata: { number: 42, title: 'Add authentication' }, repository: { fullName: 'acme/api' }, actor: { login: 'bob' }, resource: { url: 'https://github.com/acme/api/pull/42' }, occurredAt: new Date().toISOString() }],
  recentNotifications: [],
};

function jsonResponse(status, body) {
  return Promise.resolve(new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
}

function mockApi(routes) {
  const calls = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method || 'GET'} ${u.pathname}`;
    calls.push({ key, init, search: u.search });
    const handler = routes[key];
    if (!handler) return jsonResponse(404, { error: { code: 'not_found', message: `No mock for ${key}` } });
    const [status, body] = typeof handler === 'function' ? handler(init) : handler;
    return jsonResponse(status, body);
  });
  return calls;
}

const renderAt = (path) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </MemoryRouter>,
  );

describe('routing and authentication state', () => {
  it('sends anonymous users to the login page with GitHub sign-in', async () => {
    mockApi({ 'GET /api/v1/auth/me': [401, { error: { code: 'unauthorized', message: 'Authentication required' } }] });
    renderAt(`/w/${WS}/activity`);
    const link = await screen.findByRole('link', { name: /continue with github/i });
    expect(link.getAttribute('href')).toContain('/api/v1/auth/github/login?returnTo=');
    expect(link.getAttribute('href')).toContain(encodeURIComponent(`/w/${WS}/activity`));
  });

  it('shows the login error from a failed OAuth callback', async () => {
    mockApi({ 'GET /api/v1/auth/me': [401, { error: {} }] });
    renderAt('/login?error=access_denied');
    expect(await screen.findByText(/sign-in was cancelled/i)).toBeInTheDocument();
  });

  it('renders the overview from real API data for an authenticated user', async () => {
    mockApi({ 'GET /api/v1/auth/me': [200, { data: me }], [`GET /api/v1/workspaces/${WS}/overview`]: [200, { data: overview }] });
    renderAt('/');
    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeInTheDocument();
    // The heading renders before the data request resolves; wait for the data itself.
    expect((await screen.findByText('Open PRs')).nextSibling).toHaveTextContent('5');
    expect(screen.getByText('Pending review').nextSibling).toHaveTextContent('2');
    expect(screen.getByText(/#42 Add authentication/)).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Main' });
    for (const label of ['Overview', 'Activity', 'Repositories', 'Pull Requests', 'Issues', 'Notification Rules', 'Integrations', 'Settings']) {
      expect(within(nav).getByRole('link', { name: label })).toBeInTheDocument();
    }
  });

  it('sends new users without a workspace to workspace creation', async () => {
    mockApi({ 'GET /api/v1/auth/me': [200, { data: { ...me, workspaces: [] } }] });
    renderAt('/');
    expect(await screen.findByRole('heading', { name: 'Create a workspace' })).toBeInTheDocument();
  });

  it('shows an error state with retry when the API fails', async () => {
    let fail = true;
    mockApi({
      'GET /api/v1/auth/me': [200, { data: me }],
      [`GET /api/v1/workspaces/${WS}/overview`]: () => (fail ? [500, { error: { code: 'internal_error', message: 'An unexpected error occurred' } }] : [200, { data: overview }]),
    });
    renderAt(`/w/${WS}`);
    expect(await screen.findByRole('alert')).toHaveTextContent('An unexpected error occurred');
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('Open PRs')).toBeInTheDocument();
  });
});

describe('forms', () => {
  it('validates the workspace form and sends the CSRF token when creating', async () => {
    const calls = mockApi({
      'GET /api/v1/auth/me': [200, { data: { ...me, workspaces: [] } }],
      'POST /api/v1/workspaces': [201, { data: { id: WS, name: 'Platform', role: 'owner' } }],
    });
    renderAt('/workspaces');
    const submit = await screen.findByRole('button', { name: /create workspace/i });
    await userEvent.click(submit);
    expect(await screen.findByText(/at least 2 characters/i)).toBeInTheDocument();
    expect(calls.some((c) => c.key === 'POST /api/v1/workspaces')).toBe(false);

    await userEvent.type(screen.getByLabelText('Workspace name'), 'Platform');
    await userEvent.click(submit);
    await waitFor(() => expect(calls.some((c) => c.key === 'POST /api/v1/workspaces')).toBe(true));
    const post = calls.find((c) => c.key === 'POST /api/v1/workspaces');
    expect(post.init.headers['X-CSRF-Token']).toBe('csrf-123');
    expect(post.init.credentials).toBe('include');
    expect(JSON.parse(post.init.body)).toMatchObject({ name: 'Platform' });
  });

  it('validates notification rules before saving', () => {
    const meta = {
      fields: { eventType: { type: 'string' }, labels: { type: 'array' }, draft: { type: 'boolean' } },
      operators: { string: ['equals', 'in'], array: ['contains', 'is_empty'], boolean: ['equals'] },
      eventTypes: ['pull_request.opened'],
    };
    const rule = emptyRule();
    expect(validateRule(rule, meta)).toMatchObject({ name: expect.any(String), channels: expect.any(String) });
    expect(validateRule({ ...rule, name: 'ok', actions: { ...rule.actions, channelIds: ['c1'] } }, meta)).toEqual({});
    expect(validateRule({ ...rule, name: 'mute', actions: { ...rule.actions, suppress: true } }, meta)).toEqual({});
    const listWithoutValues = { ...rule, name: 'x', conditions: [{ field: 'eventType', operator: 'in', value: [] }], actions: { ...rule.actions, channelIds: ['c'] } };
    expect(validateRule(listWithoutValues, meta)).toHaveProperty('c0');
    expect(validateWorkspaceName(' a ')).toBeTruthy();
    expect(validateWorkspaceName('Acme')).toBeNull();
  });
});
