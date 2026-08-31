# Ehte — Backend API

Ehte is a secure backend API for the **Ehte Safe Reporting, Public Awareness, Missing Persons and Victim Support Platform**.

Ehte provides a secure digital platform for protecting women and children by allowing users to confidentially report incidents, submit awareness and incident posts for review, report missing women and children, provide information about missing persons, and access approved Victim/Survivor support profiles.

The backend also provides a **Secure Admin Portal API** for authorized administrators to manage reports, posts, missing-person cases, victim/survivor profiles, users, permissions, notifications, evidence, and audit logs.

## Product

**Product Name:** Ehte
**Product Type:** Mobile Application + Secure Admin Portal
**Version:** 1.0
**Languages:** Amharic and English
**Country Focus:** Ethiopia
**Developed By:** Pitron Technology Solutions

### Main Product Areas

* Confidential incident reporting
* My Reports and report status tracking
* Incident Posts
* Awareness Posts
* Missing women and children
* Confidential information about missing persons
* Victim/Survivor Profiles
* Support management
* User authentication and authorization
* Discreet Mode support
* Notifications
* Audit logging
* Secure media storage
* Role-Based Access Control

---

# Tech Stack

* **Framework:** NestJS
* **Runtime:** Node.js
* **Language:** TypeScript
* **Database:** PostgreSQL
* **ORM:** Prisma
* **Authentication:** JWT + Passport
* **Validation:** class-validator / class-transformer
* **Logging:** nestjs-pino
* **API Documentation:** Swagger / OpenAPI
* **File and Media Storage:** MinIO
* **Containerization:** Docker + Docker Compose
* **Testing:** Jest / Supertest
* **Code Quality:** ESLint + Prettier

---

# Project Structure

```text
Ehte/
│
├── prisma/
│   ├── schema/
│   │   ├── schema.prisma
│   │   ├── user.prisma
│   │   ├── user-otp.prisma
│   │   ├── session.prisma
│   │   ├── role.prisma
│   │   ├── user-role.prisma
│   │   ├── permission.prisma
│   │   ├── role-permission.prisma
│   │   ├── audit-log.prisma
│   │   ├── notification.prisma
│   │   ├── report.prisma
│   │   ├── post.prisma
│   │   ├── missing-person.prisma
│   │   ├── information-submission.prisma
│   │   ├── victim-profile.prisma
│   │   └── support.prisma
│   └── migrations/
│
├── src/
│   ├── common/
│   ├── config/
│   ├── modules/
│   │   ├── auth/
│   │   ├── core/
│   │   └── misc/
│   ├── prisma/
│   ├── app.module.ts
│   └── main.ts
│
├── test/
│
├── Dockerfile
├── docker-compose.yml
├── eslint.config.mjs
├── .eslintrc.js
├── .prettierrc
├── nest-cli.json
├── prisma.config.ts
├── update-schema.sh
├── .env.example
├── package.json
└── README.md
```

---

# Getting Started

## 1. Prerequisites

Make sure the following are installed:

* Node.js
* npm
* PostgreSQL
* Docker
* Docker Compose

Check your installations:

```bash
node --version
npm --version
docker --version
docker compose version
```

---

## 2. Clone the Project

```bash
git clone <repository-url>
cd Ehte
```

---

## 3. Install Dependencies

```bash
npm install
```

---

## 4. Configure Environment Variables

Create a local `.env` file from the example:

```bash
cp .env.example .env
```

Example development configuration:

```env
PORT=3000
NODE_ENV=development
BASE_URL=http://localhost:3000

DATABASE_URL=postgresql://ehte_user:ehte_pass@localhost:5432/ehte_db

JWT_SECRET='ehte-development-jwt-secret-change-this'
JWT_EXPIRES_IN='24'
JWT_REFRESH_SECRET='ehte-development-refresh-secret-change-this'
JWT_REFRESH_EXPIRES_IN='48'

OTP_EXPIRES_IN_MINUTES=2

MINIO_ENDPOINT=localhost
MINIO_PORT=9010
MINIO_USE_SSL=false
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin123
MINIO_BUCKET_NAME=ehte-media
MINIO_PUBLIC_URL=http://localhost:9010
DURATION_OF_PRE_SIGNED_DOCUMENT=86400
CORS_ORIGIN=http://localhost:3000
MINIO_BUCKET=ehte-files
```

> Do not commit `.env` or production secrets to Git.

---

# Database

Ehte uses PostgreSQL through Prisma ORM.

The development database is configured as:

```text
Database: ehte_db
User:     ehte_user
Host:     localhost
Port:     5432
```

## Run Database with Docker

```bash
docker compose up -d
```

Check running containers:

```bash
docker compose ps
```

---

# Prisma

## Generate Prisma Client

```bash
npx prisma generate
```

## Apply Existing Migrations

```bash
npx prisma migrate deploy
```

## Create a Development Migration

When the Prisma schema changes:

```bash
npx prisma migrate dev
```

## Check Prisma Schema

```bash
npx prisma validate
```

---

# MinIO

Ehte uses MinIO for storing uploaded media and documents.

The development configuration uses:

```text
Endpoint: localhost
Port: 9010
Bucket: ehte-media
```

MinIO is used for files such as:

* Photos
* Videos
* Audio
* PDF files
* Documents
* Other supporting media

Sensitive evidence must not automatically become public.

---

# Running the Application

## Development

Run the application in watch mode:

```bash
npm run start:dev
```

A successful startup should look similar to:

```text
Found 0 errors. Watching for file changes.

Ehte running on port 3000
Nest application successfully started
```

The API will be available at:

```text
http://localhost:3000
```

---

## Production Build

Build the application:

```bash
npm run build
```

Run the compiled application:

```bash
npm run start:prod
```

---

# API Documentation

When Swagger is enabled, API documentation is available at:

```text
http://localhost:3000/docs
```

Swagger provides documentation for the available API endpoints, request DTOs, authentication requirements, and responses.

---

# Main API Modules

## Authentication

The authentication module handles:

* Login
* Password authentication
* OTP
* Password reset
* Password change
* Refresh sessions
* Logout
* Discreet Mode settings
* Role management
* Permission management

## Reports

The Reports module handles confidential incident reports concerning women and children.

Reports can contain:

* Category
* Description
* Date and time
* Location
* Photos
* Videos
* Audio
* PDF files
* Documents
* Other supporting information

Reports remain private and are intended for authorized administrators.

## Posts

The Post module supports:

* Incident Posts
* Awareness Posts
* Drafts
* Admin review
* Approval
* Rejection
* Change requests
* Publication
* Unpublication

User-created posts must be reviewed before becoming public.

## Missing Persons

The Missing Person module supports:

* Missing women
* Missing children
* Missing-person requests
* Review and approval
* Public approved information
* Information submissions

## Information Submissions

Users can confidentially provide information about an approved missing-person case.

Information may contain:

* Written information
* Location
* Photo
* Video
* Audio
* Documents
* Other supporting information

## Victim/Survivor Profiles

Victim/Survivor Profiles require additional protection and an approval workflow.

The system tracks:

1. Verification
2. Safety review
3. Consent/authorization
4. Privacy review
5. Admin approval
6. Publication

Profiles involving children receive additional protection.

## Support

The Support module handles approved support for Victim/Survivor Profiles.

Support can contain:

* Support type
* Amount
* Agreement type
* Recipient amount
* Organization amount
* Platform amount
* Support status
* Support message

The payment distribution must be transparent to the supporter before confirmation.

---

# Security

Because Ehte handles highly sensitive information, security is a core part of the backend.

The system includes:

* JWT authentication
* Password hashing
* OTP handling
* Refresh sessions
* Role-Based Access Control
* Permissions
* Password re-authentication
* Discreet Mode state
* Admin access control
* Admin MFA support
* Secure media storage
* Audit logs
* Security monitoring
* Secure database access
* Controlled access to sensitive information

The backend follows the principle of:

> **Least Access — users and administrators should only access the information required for their role.**

---

# Audit Logging

Important administrative actions should be recorded.

Examples include:

* Admin login
* Failed login
* Report opened
* Reporter information accessed
* Evidence accessed
* Report status changed
* Post approved
* Post rejected
* Missing-person request approved
* Victim/Survivor Profile approved
* Permission changed

Audit logs provide accountability for sensitive operations.

---

# Testing

Run unit tests:

```bash
npm run test
```

Run end-to-end tests:

```bash
npm run test:e2e
```

Run tests with coverage:

```bash
npm run test:cov
```

---

# Code Quality

Run ESLint:

```bash
npm run lint
```

Format the project:

```bash
npm run format
```

The project uses:

* ESLint
* TypeScript ESLint
* Prettier

Before creating a pull request, make sure linting and tests pass.

---

# Docker

Build the Docker image:

```bash
docker build -t ehte-backend .
```

Start the development infrastructure:

```bash
docker compose up -d
```

Stop the infrastructure:

```bash
docker compose down
```

---

# Important Privacy Rules

Ehte handles sensitive information involving women and children.

Therefore:

* Reports are private.
* Reporter information must not be publicly exposed.
* Evidence must not automatically become public.
* Missing-person information must be reviewed before publication.
* Victim/Survivor Profiles require verification and approval.
* Information involving children requires additional protection.
* Administrative access must follow role and permission rules.
* Sensitive administrative actions must be logged.
* Secrets must never be committed to source control.

---

# Product Principles

### Safety First

Protect users from unnecessary harm.

### Privacy First

Sensitive information is private by default.

### Discreet When Needed

Discreet Mode provides an additional privacy layer for users who need it.

### Secure

Security must be considered throughout the application.

### Human Review

Sensitive decisions and public content require appropriate human review.

### Least Access

Users and administrators should only access information required for their responsibilities.

### Transparency

Users should understand how their information is handled.

---

# Future Features

The architecture is designed to support future capabilities such as:

* USSD access
* SMS support
* Fingerprint authentication
* Face authentication
* Offline encrypted drafts
* Additional Ethiopian languages
* Speech-to-text
* Secure messaging
* Advanced fraud detection
* Payment integrations
* Missing-person reward payments
* Institutional integrations
* Advanced analytics
* AI-assisted features

Future features must be implemented only after the required technical, security, legal, financial, and institutional requirements are satisfied.

---

# Contributing

Contributions should follow the project's development and security requirements.

Before submitting changes:

1. Create a feature branch.
2. Make the required changes.
3. Run formatting.
4. Run ESLint.
5. Run tests.
6. Verify Prisma migrations.
7. Review security implications.
8. Submit a pull request.

Example:

```bash
git checkout -b feature/my-feature

npm run format
npm run lint
npm run test
npm run build
```

Do not commit:

* `.env`
* Passwords
* JWT secrets
* Database credentials
* MinIO credentials
* Private keys
* Sensitive user information

---

# License

UNLICENSED — Private and Proprietary.

© Pitron Technology Solutions
