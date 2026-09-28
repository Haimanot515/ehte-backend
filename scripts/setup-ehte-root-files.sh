#!/usr/bin/env bash
# Ehte — root config file setup script
# Run this from the ROOT of your project (same level as package.json)
# Safe to re-run: any file that already exists is left untouched.
set -e

echo "Setting up Ehte root config files (existing files are never overwritten)..."
echo ""

CREATED=()
SKIPPED=()

create_if_missing() {
  local filename="$1"
  if [ -e "$filename" ]; then
    echo "  SKIP    $filename (already exists)"
    SKIPPED+=("$filename")
    return 1
  fi
  echo "  CREATE  $filename"
  CREATED+=("$filename")
  return 0
}

# .nvmrc
if create_if_missing ".nvmrc"; then
cat > .nvmrc << 'EOF'
20.11.0
EOF
fi

# .editorconfig
if create_if_missing ".editorconfig"; then
cat > .editorconfig << 'EOF'
root = true

[*]
indent_style = space
indent_size = 2
end_of_line = lf
charset = utf-8
trim_trailing_whitespace = true
insert_final_newline = true

[*.md]
trim_trailing_whitespace = false
EOF
fi

# .gitattributes
if create_if_missing ".gitattributes"; then
cat > .gitattributes << 'EOF'
* text=auto eol=lf
*.png binary
*.jpg binary
*.jpeg binary
*.pdf binary
EOF
fi

# LICENSE
if create_if_missing "LICENSE"; then
cat > LICENSE << 'EOF'
Proprietary License

Copyright (c) 2026 Pitron Technology Solutions. All Rights Reserved.

This software and associated documentation (the "Software") are the
confidential and proprietary property of Pitron Technology Solutions.

The Software was developed for the Ehte platform — a safe reporting, public
awareness, missing persons and victim support platform focused on the
protection of women and children in Ethiopia.

No part of this Software may be copied, modified, distributed, sublicensed,
or used in any form without prior written permission from Pitron Technology
Solutions.

Unauthorized use, reproduction, or distribution of this Software, or any
portion of it, may result in civil and criminal penalties, and will be
prosecuted to the maximum extent possible under applicable law.
EOF
fi

# SECURITY.md
if create_if_missing "SECURITY.md"; then
cat > SECURITY.md << 'EOF'
# Security Policy — Ehte

Ehte is a safe reporting, public awareness, missing persons and victim
support platform for women and children in Ethiopia, developed by Pitron
Technology Solutions. Given the nature of the data this platform handles,
security is treated as a first-class requirement, not an afterthought.

## Data Sensitivity

This system stores and processes highly sensitive information, including:

- Confidential incident reports (violence, abuse, exploitation)
- Reporter identity and contact information
- Missing person requests and information submissions
- Victim/Survivor profiles, including profiles involving children
- Evidence media (photos, video, audio)
- Payment and support-distribution records

Any vulnerability that could expose reporter identity, victim/survivor
information, or child-related data is treated as **critical severity** and
handled with the highest priority.

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Report vulnerabilities privately to: **security@pitrontechnology.com**
*(replace with the actual designated security contact before launch)*

Include where possible:
- A description of the vulnerability and its potential impact
- Steps to reproduce
- Any relevant logs or proof-of-concept (redact any real reporter, victim,
  or child data before sharing)

We aim to acknowledge reports within **24 hours** given the sensitivity of
the platform, and provide a resolution timeline within **5 business days**.

## Core Security Requirements (from the Ehte PRD)

- Discreet Mode (calculator-style appearance) must not leak Ehte data
- Password re-authentication is required for sensitive actions (creating/
  viewing reports, missing person requests, changing security settings)
- Application must lock on close/background and hide sensitive content from
  the recent-apps screen and lock-screen notifications
- Role-Based Access Control (RBAC) and least-access principle for all admin
  access to reporter/victim information
- Multi-Factor Authentication (MFA) is required for all Admin Portal users
- All sensitive admin actions must be captured in audit logs
- Additional protection is required for any content involving children —
  no home address, school, private phone numbers, family details, medical
  information, or identifying photos should be exposed publicly

## Incident Response

Any confirmed security incident follows: contain → investigate → identify
affected data → protect affected people → follow required notification
process → fix → prevent recurrence. See internal incident response runbook
(to be finalized before production launch).
EOF
fi

# CONTRIBUTING.md
if create_if_missing "CONTRIBUTING.md"; then
cat > CONTRIBUTING.md << 'EOF'
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
EOF
fi

# CHANGELOG.md
if create_if_missing "CHANGELOG.md"; then
cat > CHANGELOG.md << 'EOF'
# Changelog

All notable changes to the Ehte platform are documented in this file.

The format is based on Keep a Changelog.

## [Unreleased]
### Added
- Initial repository scaffolding (auth, billing, core reporting, media, misc modules)
- Prisma schema for agreements, disbursements, missing persons, victim profiles, reports, and audit logs
- Lockout and session revocation support
- Discreet-mode passcode and password-hash fields
- OTP channel selection and invite purposes
- Post review workflow and post hardening fields
- Victim profile and information-submission hardening fields
- Missing notification types

EOF
fi

# Makefile
if create_if_missing "Makefile"; then
cat > Makefile << 'EOF'
.PHONY: dev build start migrate seed test lint

dev:
npm run start:dev

build:
npm run build

start:
npm run start:prod

migrate:
npx prisma migrate dev

migrate-deploy:
npx prisma migrate deploy

seed:
npx ts-node src/common/seed/user.seeder.ts

test:
npm run test

test-e2e:
npm run test:e2e

lint:
npm run lint

lint-fix:
npm run lint -- --fix
EOF
fi

echo ""
echo "Summary:"
echo "  Created: ${#CREATED[@]} file(s)"
for f in "${CREATED[@]}"; do echo "    - $f"; done
echo "  Skipped (already existed): ${#SKIPPED[@]} file(s)"
for f in "${SKIPPED[@]}"; do echo "    - $f"; done
echo ""
if [ -e "tatusclear" ]; then
  echo "Note: a stray file named 'tatusclear' exists in this directory — remove it with: rm -f tatusclear"
fi
