import { registerAs } from '@nestjs/config';

export default registerAs('minio', () => ({
  publicUrl: process.env.MINIO_PUBLIC_URL ?? 'http://localhost:9010',

  endpoint: process.env.MINIO_ENDPOINT ?? 'localhost',

  port: parseInt(process.env.MINIO_PORT ?? '9010', 10),

  useSSL: process.env.MINIO_USE_SSL === 'true',

  accessKey: process.env.MINIO_ACCESS_KEY ?? 'minioadmin',

  secretKey: process.env.MINIO_SECRET_KEY ?? 'minioadmin123',

  bucketName: process.env.MINIO_BUCKET_NAME ?? 'ehte-media',

  presignedDuration: parseInt(
    process.env.DURATION_OF_PRE_SIGNED_DOCUMENT ?? '86400',
    10,
  ),
}));