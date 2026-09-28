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
