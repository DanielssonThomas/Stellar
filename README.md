# Stellar

Stellar is an Nx and Angular monorepo for issue-driven application development. Applications compose shared libraries; UI components live in atomic-design libraries.

## Get started

Use Node.js 22.12 or newer in the 22.x line and Corepack:

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm nx serve stellar-web
```

Run checks with `corepack pnpm nx run-many -t lint test build`. Install Chromium once with `corepack pnpm exec playwright install chromium`, then run the browser workflow with `corepack pnpm nx e2e stellar-web-e2e`.

See [documentation index](docs/README.md) for architecture, issue conventions, and operating guidance.
