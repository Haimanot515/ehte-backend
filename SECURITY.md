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
