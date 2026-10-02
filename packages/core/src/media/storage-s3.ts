import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { ObjectStore } from '../contracts.js';
import { GatewayError } from '../errors.js';

export interface S3ObjectStoreOptions {
  endpoint?: string | undefined;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  prefix: string;
}

/** `health()` must answer within a readiness probe budget. */
const HEAD_BUCKET_TIMEOUT_MS = 5_000;

function storageFailure(action: string, error: unknown, details: Record<string, unknown>): GatewayError {
  const kind = error instanceof Error ? error.name : 'UnknownError';
  // Never surface credentials, endpoints, or signed URLs: the error travels
  // into MCP responses.
  return new GatewayError('MEDIA_UPLOAD_FAILED', `Managed storage ${action} failed (${kind}).`, { cause: error, details });
}

/**
 * S3-compatible object store (AWS S3, Cloudflare R2, MinIO). Keys are logical:
 * the configured `prefix` is prepended here so callers can use the
 * tenant-partitioned `${tenantId}/${assetId}` layout directly.
 */
export function createS3ObjectStore(options: S3ObjectStoreOptions): ObjectStore {
  const client = new S3Client({
    region: options.region,
    forcePathStyle: options.forcePathStyle,
    credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
    ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint })
  });
  const prefix = options.prefix.replace(/^\/+|\/+$/g, '');
  const physicalKey = (key: string): string => (prefix === '' ? key : `${prefix}/${key}`);

  return {
    put: async (key, body, contentType) => {
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: options.bucket,
            Key: physicalKey(key),
            Body: body,
            ContentType: contentType,
            ContentLength: body.byteLength
          })
        );
      } catch (error) {
        throw storageFailure('put', error, { key });
      }
    },

    get: async (key) => {
      try {
        const response = await client.send(new GetObjectCommand({ Bucket: options.bucket, Key: physicalKey(key) }));
        if (response.Body === undefined) {
          throw new GatewayError('MEDIA_UPLOAD_FAILED', 'Managed storage returned an empty object body.', { details: { key } });
        }
        return await response.Body.transformToByteArray();
      } catch (error) {
        if (error instanceof GatewayError) throw error;
        throw storageFailure('read', error, { key });
      }
    },

    delete: async (key) => {
      try {
        await client.send(new DeleteObjectCommand({ Bucket: options.bucket, Key: physicalKey(key) }));
      } catch (error) {
        throw storageFailure('delete', error, { key });
      }
    },

    signedGetUrl: async (key, expiresInSeconds) => {
      try {
        // Signing is local: no request is made, so a failure here is a
        // configuration or SDK problem rather than a storage outage.
        return await getSignedUrl(client, new GetObjectCommand({ Bucket: options.bucket, Key: physicalKey(key) }), {
          expiresIn: Math.max(1, Math.floor(expiresInSeconds))
        });
      } catch (error) {
        const kind = error instanceof Error ? error.name : 'UnknownError';
        throw new GatewayError('INTERNAL_ERROR', `Signing a managed storage URL failed (${kind}).`, { cause: error, details: { key } });
      }
    },

    health: async () => {
      try {
        await client.send(new HeadBucketCommand({ Bucket: options.bucket }), {
          abortSignal: AbortSignal.timeout(HEAD_BUCKET_TIMEOUT_MS)
        });
      } catch (error) {
        throw storageFailure('health check', error, {});
      }
    }
  };
}
