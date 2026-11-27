import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface S3StorageLike {
  createPresignedPutUrl(bucket: string, key: string, contentType: string, expiresIn?: number): Promise<string>;
  getObjectBuffer(bucket: string, key: string): Promise<Buffer>;
  putObjectBuffer(bucket: string, key: string, body: Buffer, contentType: string): Promise<void>;
}

let s3Client: S3Client | null = null;
let overrideStorage: S3StorageLike | null = null;

function getClient(): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({ region: process.env.AWS_REGION });
  }
  return s3Client;
}

/**
 * Override S3 operations for local testing without AWS.
 */
export function setS3StorageForTest(storage: S3StorageLike | null): void {
  overrideStorage = storage;
}

export async function createPresignedPutUrl(
  bucket: string,
  key: string,
  contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  expiresIn = 300,
): Promise<string> {
  if (overrideStorage) {
    return overrideStorage.createPresignedPutUrl(bucket, key, contentType, expiresIn);
  }
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType,
  });
  return getSignedUrl(getClient(), command, { expiresIn });
}

export async function getObjectBuffer(bucket: string, key: string): Promise<Buffer> {
  if (overrideStorage) {
    return overrideStorage.getObjectBuffer(bucket, key);
  }
  const res = await getClient().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!res.Body) {
    throw new Error(`Empty S3 object body for s3://${bucket}/${key}`);
  }
  const bytes = await res.Body.transformToByteArray();
  return Buffer.from(bytes);
}

export async function putObjectBuffer(
  bucket: string,
  key: string,
  body: Buffer,
  contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
): Promise<void> {
  if (overrideStorage) {
    return overrideStorage.putObjectBuffer(bucket, key, body, contentType);
  }
  await getClient().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}
