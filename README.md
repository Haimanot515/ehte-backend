## Environment Variables

Ehte uses environment variables for configuration and secrets.

Create a local environment file:

```bash
cp .env.example .env
```

### Core Configuration

```env
PORT=3000
NODE_ENV=development
BASE_URL=http://localhost:3000
```

### Database

```env
DATABASE_URL=postgresql://<username>:<password>@<host>:<port>/<database>
```

### Authentication

```env
JWT_SECRET=<strong-secret>
JWT_EXPIRES_IN=24

JWT_REFRESH_SECRET=<strong-refresh-secret>
JWT_REFRESH_EXPIRES_IN=48
```

### Swagger

Swagger can be enabled for development or controlled environments.

```env
SWAGGER_ENABLED=true
SWAGGER_USER=<swagger-username>
SWAGGER_PASSWORD=<strong-swagger-password>
```

Swagger is available at:

```text
http://localhost:3000/docs
```

When Swagger authentication is enabled, the `/docs` endpoint requires HTTP Basic Authentication.

**Never commit Swagger credentials to Git.**

### OTP

```env
OTP_EXPIRES_IN_MINUTES=2
```

### MinIO

```env
MINIO_ENDPOINT=localhost
MINIO_PORT=9010
MINIO_USE_SSL=false
MINIO_ACCESS_KEY=<access-key>
MINIO_SECRET_KEY=<secret-key>
MINIO_BUCKET_NAME=ehte-media
MINIO_BUCKET=ehte-files
MINIO_PUBLIC_URL=http://localhost:9010
DURATION_OF_PRE_SIGNED_DOCUMENT=86400
```

### CORS

```env
CORS_ORIGIN=http://localhost:3000
```

### SMS / AfroMessage

```env
AFROMESSAGE_URL=https://api.afromessage.com/api/send
AFROMESSAGE_TOKEN=<afromessage-token>
AFROMESSAGE_IDENTIFIER_ID=<identifier-id>
AFROMESSAGE_SENDER_NAME=<sender-name>
```

### Administrator Configuration

```env
ADMIN_PHONE=<admin-phone>
ADMIN_NAME=<admin-name>
ADMIN_PASSWORD=<strong-admin-password>
```

Production credentials must be supplied through a secure secret-management mechanism rather than committed configuration files.

---

# API Versioning

Ehte uses URI-based API versioning.

The current API version is:

```text
/v1
```

Example:

```text
POST /v1/reports
GET  /v1/reports
GET  /v1/reports/me
```

Future breaking API changes should use a new API version rather than silently changing the behavior of an existing version.

---

# Swagger / OpenAPI

Ehte provides interactive API documentation through Swagger UI.

When enabled:

```text
http://localhost:3000/docs
```

Swagger documents:

* API endpoints
* Request bodies
* DTO validation
* Response structures
* Authentication requirements
* API tags
* JWT authorization

### Swagger Authentication

Swagger can be protected with HTTP Basic Authentication.

Configure:

```env
SWAGGER_ENABLED=true
SWAGGER_USER=<username>
SWAGGER_PASSWORD=<password>
```

Then open:

```text
http://localhost:3000/docs
```

Enter the configured Swagger username and password.

After accessing Swagger, JWT-protected endpoints can be tested using the **Authorize** button.

Use:

```text
Bearer <access_token>
```

Do not commit Swagger credentials to source control.

---

# Authentication Flow

The authentication system is based on JWT access tokens and refresh sessions.

A typical authentication flow is:

```text
User
  │
  ├── Login / OTP
  │
  ▼
Authentication Service
  │
  ├── Access Token
  │
  └── Refresh Session
  │
  ▼
Protected API
  │
  ▼
JWT Guard
  │
  ▼
Roles / Permissions
  │
  ▼
Controller
```

Access tokens are used to authenticate protected API requests.

Example:

```http
Authorization: Bearer <access_token>
```

Administrative endpoints additionally require the appropriate role and permissions.

---

# Authorization Model

Ehte uses Role-Based Access Control (RBAC).

Authorization is evaluated using:

```text
User
  ↓
Role
  ↓
Permissions
  ↓
Protected Resource
```

Roles and permissions are intentionally separated from authentication so that administrative responsibilities can be changed without changing the authentication mechanism.

Sensitive administrative operations should require the minimum permissions necessary.

---

# Application Architecture

The backend follows a modular NestJS architecture.

```text
Client Applications
       │
       ▼
   Ehte API
       │
       ├── Auth
       │
       ├── Reports
       │
       ├── Posts
       │
       ├── Missing Persons
       │
       ├── Information Submissions
       │
       ├── Victim Profiles
       │
       ├── Support
       │
       ├── Notifications
       │
       ├── Users / Roles
       │
       └── Audit Logs
       │
       ├───────────────┐
       ▼               ▼
 PostgreSQL          MinIO
   Prisma          Media Storage
```

The API is responsible for authentication, authorization, validation, business logic, database access, file-management operations, notifications, and audit logging.

---

# Health and Troubleshooting

## Check Docker Services

```bash
docker compose ps
```

Expected services include:

```text
ehte-api
ehte-postgres
ehte-minio
```

## Check API Logs

```bash
docker compose logs -f api
```

## Check PostgreSQL Logs

```bash
docker compose logs -f postgres
```

## Check MinIO Logs

```bash
docker compose logs -f minio
```

## Test the API

```bash
curl http://localhost:3000
```

## Test Swagger

If Swagger authentication is enabled:

```bash
curl -I -u '<swagger-user>:<swagger-password>' \
  http://localhost:3000/docs
```

A successful response should return:

```text
HTTP/1.1 200 OK
```

---

# Database Migration Workflow

Database schema changes should be handled through Prisma migrations.

During development:

```bash
npx prisma migrate dev
```

Validate the schema:

```bash
npx prisma validate
```

Generate the Prisma client:

```bash
npx prisma generate
```

For deployed environments:

```bash
npx prisma migrate deploy
```

Do not manually modify production database structures without an appropriate migration.

---

# Security and Secrets Management

Ehte handles highly sensitive information. Security-sensitive configuration must never be committed to source control.

Never commit:

```text
.env
production secrets
JWT secrets
JWT refresh secrets
database passwords
MinIO credentials
AfroMessage tokens
Swagger passwords
administrator passwords
private keys
encryption keys
real user information
```

The repository should contain:

```text
.env.example
```

but not:

```text
.env
```

A production deployment should provide secrets through a secure environment or secret-management system.

If a credential is accidentally committed, assume that credential is compromised and rotate it immediately.

---

# Development Workflow

Create a feature branch before making changes:

```bash
git checkout -b feature/my-feature
```

Make the required changes and run:

```bash
npm run format
npm run lint
npm run test
npm run test:e2e
npm run build
```

For Prisma changes:

```bash
npx prisma validate
npx prisma generate
npx prisma migrate dev
```

Review the security impact of changes involving:

* Authentication
* Authorization
* Reports
* Evidence
* Missing persons
* Victim/Survivor Profiles
* Payments
* Notifications
* Personal information
* Audit logs

Then create a pull request.

---

# Current Implementation Status

Ehte is under active development.

Implemented or actively developed areas include:

* Authentication and authorization
* JWT authentication
* OTP workflows
* Refresh sessions
* Role-Based Access Control
* Permission management
* Confidential reporting
* Report administration
* Posts
* Missing-person management
* Information submissions
* Victim/Survivor Profiles
* Support management
* Notifications
* Audit logging
* Prisma/PostgreSQL integration
* MinIO media storage
* Docker deployment
* Swagger/OpenAPI documentation

Some product capabilities remain subject to additional development, security review, legal review, operational requirements, and institutional agreements.

Features described under **Future Features** should not be considered production-ready unless explicitly marked as implemented.

---

# Production Readiness

The development Docker configuration is intended primarily for local development and controlled testing.

Before production deployment, review at minimum:

* Secret management
* HTTPS/TLS
* Database security
* PostgreSQL backups
* MinIO security
* Network isolation
* CORS configuration
* JWT secret rotation
* Admin MFA
* Rate limiting
* Logging
* Audit-log protection
* Monitoring
* Alerting
* Data retention
* Evidence access controls
* Privacy requirements
* Child-safety requirements
* Legal and institutional requirements

Development credentials must never be reused in production.

Swagger should also be carefully controlled in production and should not be publicly exposed without appropriate protection.

---

# Responsible Security Reporting

If a security vulnerability is discovered, do not publicly disclose sensitive details before the issue has been reviewed and addressed.

Security reports should be provided privately to the project maintainers through the organization's designated security contact.

Do not include real victim, survivor, reporter, child, evidence, or other sensitive information in public GitHub issues.

---

# Disclaimer

Ehte is a software platform intended to support safe reporting, awareness, missing-person workflows, and victim/survivor support.

The software does not replace emergency services, law enforcement, medical services, social workers, legal professionals, or other qualified support organizations.

Operational deployment must comply with applicable Ethiopian laws, regulations, privacy requirements, child-protection requirements, institutional agreements, and security standards.
