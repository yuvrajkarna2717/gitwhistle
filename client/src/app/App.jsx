import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './AuthProvider.jsx';
import { ErrorState, LoadingState } from '../components/ui.jsx';
import AppLayout from '../layouts/AppLayout.jsx';
import LoginPage from '../features/auth/LoginPage.jsx';
import WorkspacesPage from '../features/workspaces/WorkspacesPage.jsx';
import OverviewPage from '../features/dashboard/OverviewPage.jsx';

// Less-visited pages are code-split.
const InvitePage = lazy(() => import('../features/auth/InvitePage.jsx'));
const ActivityPage = lazy(() => import('../features/activity/ActivityPage.jsx'));
const RepositoriesPage = lazy(() => import('../features/repositories/RepositoriesPage.jsx'));
const PullRequestsPage = lazy(() => import('../features/pull-requests/PullRequestsPage.jsx'));
const IssuesPage = lazy(() => import('../features/issues/IssuesPage.jsx'));
const RulesPage = lazy(() => import('../features/rules/RulesPage.jsx'));
const IntegrationsPage = lazy(() => import('../features/integrations/IntegrationsPage.jsx'));
const SettingsPage = lazy(() => import('../features/settings/SettingsPage.jsx'));

function RequireAuth({ children }) {
  const { status, error, refresh } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <LoadingState label="Loading GitWhistle…" />;
  if (status === 'error')
    return (
      <div className="mx-auto max-w-md p-8">
        <ErrorState error={error} onRetry={refresh} />
      </div>
    );
  if (status === 'anonymous') return <Navigate to={`/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  return children;
}

function Home() {
  const { workspaces } = useAuth();
  return <Navigate to={workspaces.length ? `/w/${workspaces[0].id}` : '/workspaces'} replace />;
}

function LoginRoute() {
  const { status } = useAuth();
  if (status === 'authenticated') return <Navigate to="/" replace />;
  return <LoginPage />;
}

export function AppRoutes() {
  return (
    <Suspense fallback={<LoadingState />}>
    <Routes>
      <Route path="/login" element={<LoginRoute />} />
      <Route path="/invite/:token" element={<RequireAuth><InvitePage /></RequireAuth>} />
      <Route path="/workspaces" element={<RequireAuth><WorkspacesPage /></RequireAuth>} />
      <Route path="/w/:workspaceId" element={<RequireAuth><AppLayout /></RequireAuth>}>
        <Route index element={<OverviewPage />} />
        <Route path="activity" element={<ActivityPage />} />
        <Route path="repositories" element={<RepositoriesPage />} />
        <Route path="pull-requests" element={<PullRequestsPage />} />
        <Route path="issues" element={<IssuesPage />} />
        <Route path="rules" element={<RulesPage />} />
        <Route path="integrations" element={<IntegrationsPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
      <Route path="/" element={<RequireAuth><Home /></RequireAuth>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </Suspense>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  );
}
