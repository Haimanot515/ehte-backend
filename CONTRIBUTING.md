# Contributing to Ehte

Thank you for contributing to Ehte. Because this platform handles sensitive
data related to abuse reports, missing children, and victim/survivor
identities, please read this document carefully before opening a PR.

## Getting Started
1. Use the Node version pinned in `.nvmrc` (`nvm use`)
2. Copy `.env.example` to `.env` and fill in values (never use real
   production credentials locally)
3. Install dependencies: `npm install`
4. Run migrations: `npx prisma migrate dev`
5. Seed reference data: `make seed`
6. Start dev server: `make dev`

## Handling Sensitive Data — Required Rules

- **Never** commit real reporter, victim, survivor, or missing-person data —
  including in seed scripts, test fixtures, screenshots, or issue/PR
  descriptions. Use clearly fake/synthetic data only.
- **Never** log full report contents, evidence file contents, or personal
  identifying information. Redact or reference by ID in logs.
- Any change touching `victim-profile`, `information-submission`,
  `missing-person`, `report`, or `audit-log` modules should be flagged for
  extra review — these carry the platform's highest-sensitivity data.
- Do not weaken re-authentication, RBAC, or audit-logging behavior without
  explicit sign-off — these are core safety requirements from the PRD.

## Branch Naming
- `feature/short-description`
- `fix/short-description`
- `chore/short-description`

## Commit Messages
Follow Conventional Commits:
feat: add discreet-mode notification masking
fix: correct missing-person review status transition
chore: update dependencies

## Pull Requests
- Keep PRs focused and small where possible
- Link related issues
- Ensure npm run lint and npm run test pass before requesting review
- PRs touching sensitive modules (see above) require review from at least
  one security-aware reviewer, in addition to standard code review
- Never include real user data in PR descriptions, screenshots, or test logs

## Code Style
- Formatting is enforced via Prettier and ESLint — run npm run lint:fix
- Follow existing module structure (controller / service / dto)
- Keep audit-logging calls in sync with any new sensitive action per
  Section 35 of the Ehte PRD
