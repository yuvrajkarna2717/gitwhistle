import { useSearchParams } from 'react-router-dom';
import { oauthUrls } from '../../services/api.js';
import { LinkButton, Notice } from '../../components/ui.jsx';

const ERRORS = {
  access_denied: 'GitHub sign-in was cancelled.',
  invalid_state: 'Your sign-in link expired or was already used. Please try again.',
  auth_failed: 'GitHub sign-in failed. Please try again.',
  oauth_error: 'GitHub returned an error. Please try again.',
  session_mismatch: 'Your session changed during sign-in. Please sign in again.',
  session_expired: 'Your session expired while connecting an integration. Sign in and try again.',
};

export default function LoginPage() {
  const [params] = useSearchParams();
  const error = params.get('error');
  const returnTo = params.get('returnTo') || '/';
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-sm rounded-lg border border-slate-200 bg-white p-8">
        <h1 className="text-xl font-semibold text-slate-900">Sign in to GitWhistle</h1>
        <p className="mt-2 text-sm text-slate-500">Engineering activity from GitHub, routed to the right Slack channels.</p>
        <div className="mt-6">
          {error && <Notice tone="error">{ERRORS[error] || 'Sign-in failed. Please try again.'}</Notice>}
          <LinkButton href={oauthUrls.login(returnTo)} className="w-full">
            Continue with GitHub
          </LinkButton>
        </div>
        <p className="mt-4 text-xs text-slate-400">GitWhistle reads your GitHub profile to sign you in. Repository access is granted separately when you install the GitHub App.</p>
      </div>
    </div>
  );
}
