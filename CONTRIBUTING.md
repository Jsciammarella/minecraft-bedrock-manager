# Contributing

## Local setup

Use Node.js 20 or newer. Install the backend and frontend dependencies, build the frontend, and run the smoke test:

```bash
npm ci
npm --prefix frontend ci
npm run build
npm test
```

For development, run `npm run dev` for the API and `npm --prefix frontend run dev` for the Vite UI. The development Docker Compose file is also available.

## Changes

- Keep runtime data, server binaries, worlds, add-on packages, logs, and `.env` files out of commits.
- Keep API and UI changes compatible with per-server isolation.
- Add or update a focused test when behavior changes.
- Confirm both `npm run build` and `npm test` pass before opening a merge request.
- Describe data migrations, restart requirements, and manual verification in the merge request.

## Commit and merge request guidance

Use a short imperative commit subject. Keep unrelated changes separate, and include screenshots for visible UI changes when practical.
