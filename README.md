# GitWhistle

Engineering activity intelligence for GitHub organizations. GitWhistle receives GitHub App webhooks, normalizes them into provider-neutral events, tracks pull request and issue state, and routes notifications to Slack channels using configurable rules. It also sends review reminders and a daily engineering digest.

- **Backend**: Node.js 22+, Express 5, PostgreSQL (Knex), Redis (BullMQ), Octokit, Slack Web API. API and worker run as separate processes.
- **Frontend**: React 19, Vite, React Router, Tailwind CSS.

```bash
cd backend && npm ci && cp .env.example .env   # set DATABASE_URL, REDIS_URL, ENCRYPTION_KEY
npm run migrate && npm run dev                  # API :4000
npm run dev:worker                              # worker (second terminal)
cd ../client && npm ci && npm run dev           # web :5173
```

Tests: `cd backend && npm test` (no external services needed) and `cd client && npm test`.
Docker: `docker compose up --build` (web on :8080).

| Document | Contents |
|---|---|
| [SETUP.md](SETUP.md) | Local setup, GitHub App and Slack app creation, Docker, deployment, manual integration test |
| [ENVIRONMENT.md](ENVIRONMENT.md) | Every environment variable |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Modules, tenancy, event pipeline guarantees, rule engine, reminders, digests |
| [API_DOCUMENTATION.md](API_DOCUMENTATION.md) | REST API reference |
| [SECURITY.md](SECURITY.md) | Controls, assumptions, known risks, **required key rotation** |
| [DEVELOPMENT_PROGRESS.md](DEVELOPMENT_PROGRESS.md) | What is built and how it was verified |
