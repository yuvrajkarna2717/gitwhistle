import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../../services/api.js';
import { useAuth } from '../../app/AuthProvider.jsx';
import { Button, ErrorState, LoadingState } from '../../components/ui.jsx';

export default function InvitePage() {
  const { token } = useParams();
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    api.post('/invitations/preview', { token }).then((r) => setPreview(r.data), setError);
  }, [token]);

  const accept = async () => {
    setPending(true);
    try {
      const r = await api.post('/invitations/accept', { token });
      await refresh();
      navigate(`/w/${r.data.workspaceId}`);
    } catch (err) {
      setError(err);
      setPending(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-8">
        {error ? (
          <ErrorState error={error} />
        ) : !preview ? (
          <LoadingState />
        ) : (
          <>
            <h1 className="text-lg font-semibold text-slate-900">Join {preview.workspaceName}</h1>
            <p className="mt-2 text-sm text-slate-500">
              You have been invited as <strong className="capitalize">{preview.role}</strong>.
            </p>
            <Button className="mt-6 w-full" onClick={accept} pending={pending}>
              Accept invitation
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
