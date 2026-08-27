# deploy/

Platform-specific deployment assets.

- `cloudflare/`: Pages/Workers build script (`build.sh`) and config used by `npm run site:build` and `npm run deploy:cloudflare`.
- `gcp/`: Cloud Run and Cloud Build definitions for the API.

Root-level configs for Railway, Fly, Render, Docker, and Nixpacks still live at the repo root. Runbook: [docs/deployment.md](../docs/deployment.md).

    npm run deploy:cloudflare
    npm run deploy:fly
