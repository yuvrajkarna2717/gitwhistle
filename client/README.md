# GitWhistle web app

React 19 + Vite + React Router + Tailwind CSS.

```bash
npm ci
npm run dev     # http://localhost:5173, proxies /api to http://localhost:4000 (override with VITE_API_PROXY)
npm test        # vitest + Testing Library (jsdom)
npm run lint
npm run build   # dist/
```

- `src/services/api.js` is the only place that calls the API. It sends cookies (`credentials: 'include'`) and the CSRF token on mutations.
- `src/app/AuthProvider.jsx` holds the signed-in user, CSRF token and workspace list from `GET /api/v1/auth/me`.
- Pages live in `src/features/<area>`. Shared UI primitives live in `src/components/ui.jsx`.
- The app expects to be served on the **same origin** as the API (Vite proxy in development, `nginx.conf` in Docker).

See the repository root for setup and architecture docs.
