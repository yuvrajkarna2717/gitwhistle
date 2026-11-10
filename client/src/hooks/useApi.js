import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../services/api.js';

/**
 * Fetch data from a GET endpoint with loading / error / reload handling.
 * `path` may be null to skip the request.
 */
export function useApi(path, query) {
  const [state, setState] = useState({ data: undefined, meta: undefined, error: null, loading: Boolean(path) });
  const queryKey = JSON.stringify(query || {});
  const seq = useRef(0);

  const load = useCallback(async () => {
    if (!path) return;
    const id = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const res = await api.get(path, JSON.parse(queryKey));
      if (id === seq.current) setState({ data: res.data, meta: res.meta, error: null, loading: false });
    } catch (error) {
      if (id === seq.current) setState((s) => ({ ...s, error, loading: false }));
    }
  }, [path, queryKey]);

  useEffect(() => {
    load();
  }, [load]);

  return { ...state, reload: load, setData: (data) => setState((s) => ({ ...s, data })) };
}

/** Wrap a mutation with pending/error state. */
export function useMutation(fn) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);
  const run = useCallback(
    async (...args) => {
      setPending(true);
      setError(null);
      try {
        return await fn(...args);
      } catch (err) {
        setError(err);
        throw err;
      } finally {
        setPending(false);
      }
    },
    [fn],
  );
  return { run, pending, error, setError };
}
