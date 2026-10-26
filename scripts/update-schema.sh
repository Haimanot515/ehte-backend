
#!/bin/bash

# Ehte — Update Payment Schema
# Adds optional sessionId and reservationId fields
# and updates the corresponding Prisma relations.

set -e

SCHEMA="prisma/schema/payment.prisma"

echo "Updating $SCHEMA..."

# Make sessionId optional
sed -i 's/sessionId   String/sessionId   String?/g' "$SCHEMA"

# Add reservationId after sessionId
sed -i '/sessionId   String?/a\
  reservationId String?
' "$SCHEMA"

# Replace the existing Session relation
sed -i '/session Session @relation/c\
  session Session? @relation(fields: [sessionId], references: [id])\
\
  reservation Reservation? @relation(fields: [reservationId], references: [id])
' "$SCHEMA"

echo "Payment schema updated successfully."

# Format Prisma schema
npx prisma format --schema=./prisma/schema

echo "Prisma schema formatted successfully."
