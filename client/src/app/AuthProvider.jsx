import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, setCsrfToken, setUnauthorizedHandler } from '../services/api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [state, setState] = useState({ status: 'loading', user: null, workspaces: [], error: null });

  const refresh = useCallback(async () => {
    try {
      const res = await api.get('/auth/me');
      setCsrfToken(res.data.csrfToken);
      setState({ status: 'authenticated', user: res.data.user, workspaces: res.data.workspaces, error: null });
    } catch (error) {
      setCsrfToken(null);
      setState({ status: error.status === 401 ? 'anonymous' : 'error', user: null, workspaces: [], error });
    }
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => setState({ status: 'anonymous', user: null, workspaces: [], error: null }));
    refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } finally {
      setCsrfToken(null);
      setState({ status: 'anonymous', user: null, workspaces: [], error: null });
    }
  }, []);

  const value = useMemo(() => ({ ...state, refresh, logout }), [state, refresh, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
