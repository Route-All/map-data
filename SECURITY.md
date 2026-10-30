# Security

## Reporting a problem

Please use GitHub's private vulnerability reporting: the **Security** tab of this repository,
then **Report a vulnerability**. Do not open a public issue for anything that could expose a
credential or let someone change published data.

## Credential model

- **One R2 S3 API token for the data jobs**, held as encrypted Actions secrets and passed only as
  environment variables to the single step that publishes:
  - `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` — roads, places, road work and fuel
  - `R2_S3_ENDPOINT` — the account's R2 S3 endpoint (a secret because it names the account)
- The token is an R2 API token with **Object Read & Write on the public tiles bucket only**.
  Cloudflare offers no write-only object permission, and the publishers need to read the live
  pointer and list objects for clean-up, so Read & Write on that one bucket is the narrowest scope.
  R2 cannot scope a token to a key prefix, so separate tokens per job would each have the same
  power; one token keeps rotation to one place.
- The token cannot reach any other bucket (including private route storage), Workers
  deploys, DNS, zone settings or any database. Worker deploys, private storage and everything
  else stay in the private application repository with their own credentials.
- Optional read-only feed keys: `WZDX_KEYS` (road-work step only) and `EIA_API_KEY` (fuel fetch
  step only).
- `freshness.yml` holds no secrets at all: it reads the public files and fails (emailing the
  owner) when data is stale.
- Workflows declare `permissions: {}` at the top and grant `contents: read` per job. The keepalive
  job has only `actions: write` (it re-enables the schedules) and holds no bucket token. Checkouts use
  `persist-credentials: false`. Triggers are `schedule` and `workflow_dispatch` only; never
  `pull_request_target`, so a fork's pull request never runs with secrets.
- Every action is pinned to a full commit SHA, with its version in a comment; Dependabot proposes
  updates as reviewed pull requests.
- One writer per dataset: each publisher takes a lease object in the bucket before writing, so a
  manual run and a scheduled run (or another repository) can never publish the same dataset at
  once.

## Repository settings to enable (owner checklist)

- [ ] **Secret scanning** and **push protection** (Settings → Code security).
- [ ] **Private vulnerability reporting** (Settings → Code security).
- [ ] **Dependabot alerts** and **security updates**.
- [ ] **Branch protection / ruleset on `main`**: pull request required, at least one approving
      review, review from Code Owners, dismiss stale approvals, no force pushes, no deletion.
- [ ] **Actions → General**: allow only actions created by GitHub, restricted to
      `actions/checkout` and `actions/setup-node`; require SHA pinning if offered.
- [ ] **Actions → General → Fork pull request workflows**: require approval for all outside
      contributors; do not send secrets or write tokens to fork pull requests.
- [ ] **Actions → General → Workflow permissions**: default `GITHUB_TOKEN` to read-only, and do
      not allow Actions to create or approve pull requests.
- [ ] **Secrets**: only the names listed above, as repository (not organisation-wide) Actions
      secrets. No personal access tokens or admin tokens at repository level.
- [ ] **Freshness emails**: the owner is the last person to edit `freshness.yml`'s `cron` line
      (GitHub sends scheduled-run failures to that person) and has Actions failure notifications
      on (Settings → Notifications → Actions → "Send notifications for failed workflows only").
- [ ] **Collaborators**: maintainers only; no outside collaborators with write access.
