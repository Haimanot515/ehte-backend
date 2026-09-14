# Environment Variables

Ehte uses environment variables for application configuration, external services, authentication, security, and secrets.

For local development, create your environment file from the example:

```bash
cp .env.example .env
```

Never commit `.env` to Git.

## Core Application Configuration

```env
PORT=3000
NODE_ENV=development
APP_NAME=Ehte
CORS_CREDENTIALS=true
APP_DEBUG=false

APP_URL=http://localhost:3000
ADMIN_APP_URL=http://localhost:5173
```

`APP_URL` is the public URL of the backend.

`ADMIN_APP_URL` is the URL of the Ehte administration application.

## Database

Ehte uses PostgreSQL with Prisma.

```env
DATABASE_URL=postgresql://<username>:<password>@<host>:<port>/<database>
DIRECT_URL=postgresql://<username>:<password>@<host>:<port>/<database>
```

For Neon or another hosted PostgreSQL provider, use the connection strings provided by the database provider.

`DATABASE_URL` is used for the application database connection.

`DIRECT_URL` is used for direct database operations such as Prisma migrations where required.

Local Docker PostgreSQL configuration can also be provided through:

```env
POSTGRES_DB=ehte_db
POSTGRES_USER=ehte_user
POSTGRES_PASSWORD=<postgres-password>
```

## Authentication / JWT

Ehte uses JWT access tokens and refresh tokens.

```env
JWT_SECRET=<strong-jwt-secret>
JWT_EXPIRES_IN=24h

JWT_REFRESH_SECRET=<strong-refresh-secret>
JWT_REFRESH_EXPIRES_IN=7d
```

JWT secrets must be long, random, and unique.

Never reuse development JWT secrets in production.

## Swagger / OpenAPI

Swagger can be enabled for development and controlled environments.

```env
SWAGGER_ENABLED=true
SWAGGER_USER=<swagger-username>
SWAGGER_PASSWORD=<strong-swagger-password>
```

Swagger is available at:

```text
http://localhost:3000/docs
```

When Swagger authentication is enabled, `/docs` requires HTTP Basic Authentication.

After authentication, JWT-protected endpoints can be tested using the Swagger `Authorize` button:

```text
Bearer <access_token>
```

Never commit Swagger credentials to Git.

## OTP

OTP configuration is controlled through:

```env
OTP_EXPIRES_IN_MINUTES=2
OTP_RESEND_COOLDOWN_SECONDS=60
```

`OTP_EXPIRES_IN_MINUTES` controls how long an OTP remains valid.

`OTP_RESEND_COOLDOWN_SECONDS` controls the minimum time before another OTP can be requested.

## Security / Login Lockout

Failed login attempts are protected by account lockout settings:

```env
MAX_LOGIN_ATTEMPTS=5
LOCKOUT_DURATION_MINUTES=15
```

After the configured number of failed attempts, the account is temporarily locked.

## Encryption

Encryption configuration is provided through:

```env
ENCRYPTION_KEY=<64-character-hex-key>
ENCRYPTION_IV=<32-character-hex-iv>
```

These values must be generated securely and must not be committed to source control.

## CORS

Allowed frontend origins are configured with:

```env
CORS_ORIGIN=http://localhost:3000,http://localhost:5173
```

Multiple origins can be separated by commas.

For production, only trusted application origins should be configured.

## SMS / AfroMessage

Ehte uses AfroMessage for SMS delivery.

```env
AFROMESSAGE_URL=https://api.afromessage.com/api/send
AFROMESSAGE_TOKEN=<afromessage-token>
AFROMESSAGE_IDENTIFIER_ID=<identifier-id>
AFROMESSAGE_SENDER_NAME=<sender-name>
```

The AfroMessage token and identifier must be treated as secrets.

Do not commit them to Git.

## Email / SMTP

Email functionality uses SMTP configuration:

```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=<smtp-user>
SMTP_PASSWORD=<smtp-password>
SMTP_FROM=<sender-email>
SMTP_FROM_NAME=Ehte
```

For Gmail, `SMTP_PASSWORD` should normally be an appropriate SMTP credential such as an App Password rather than the user's normal account password.

## MinIO

Ehte uses MinIO for media storage.

```env
MINIO_ENDPOINT=localhost
MINIO_PORT=9010
MINIO_USE_SSL=false

MINIO_ACCESS_KEY=<minio-access-key>
MINIO_SECRET_KEY=<minio-secret-key>

MINIO_BUCKET_NAME=ehte-media
MINIO_PUBLIC_URL=http://localhost:9010

DURATION_OF_PRE_SIGNED_DOCUMENT=86400
```

For Docker Compose, the API container can connect to MinIO through the Docker service name:

```env
MINIO_ENDPOINT_DOCKER=minio
MINIO_PORT_DOCKER=9000
```

`DURATION_OF_PRE_SIGNED_DOCUMENT` specifies the lifetime of generated pre-signed document URLs in seconds.

## Administrator Seed Configuration

Initial administrator configuration can be provided through:

```env
ADMIN_EMAIL=admin@example.com
ADMIN_NAME=Ehte System Admin
ADMIN_PASSWORD=<strong-admin-password>
```

The administrator password must be strong and must never be committed to source control.

Production administrator credentials must be supplied through a secure secret-management mechanism.

## Rate Limiting

Application rate limiting is configured with:

```env
RATE_LIMIT_TTL=60
RATE_LIMIT_LIMIT=100

THROTTLE_TTL_SECONDS=60
THROTTLE_LIMIT=20
```

The throttler configuration controls request-rate protection for the API.

## Database Migrations

Database migrations can be enabled during deployment with:

```env
RUN_MIGRATIONS=true
```

For production deployments, migrations should be executed through the deployment process in a controlled manner.

## Media Uploads

Media upload restrictions can be configured with:

```env
MEDIA_MAX_FILE_SIZE=10485760

MEDIA_ALLOWED_MIME_TYPES=image/jpeg,image/png,image/webp,video/mp4,audio/mpeg,audio/wav
```

The default maximum file size is 10 MB.

## Feature Flags

Ehte feature flags include:

```env
SUPPORT_CURRENCY=ETB
SUPPORT_ENABLED=true
MISSING_PERSONS_ENABLED=true
VICTIM_SUPPORT_ENABLED=true
```

These values control optional application functionality.

## Production Secrets

Production secrets must never be committed to the repository.

Never commit:

```text
.env
production secrets
JWT secrets
JWT refresh secrets
database passwords
SMTP passwords
MinIO credentials
AfroMessage tokens
Swagger passwords
administrator passwords
encryption keys
private keys
```

The repository should contain:

```text
.env.example
```

but not:

```text
.env
```

For production deployments, provide secrets through the deployment platform's secure environment-variable or secret-management system.

If a secret is accidentally committed or exposed, assume it is compromised and rotate it immediately.
