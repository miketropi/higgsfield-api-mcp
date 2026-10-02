/**
 * Media surface: the only component allowed to read local files, download
 * caller or provider URLs, and copy bytes into managed object storage.
 */
export { createMediaService, managedObjectKey } from './service.js';
export type { MediaServiceConfig, MediaServiceOptions } from './service.js';

export { createProviderAssetMaterializer } from './materialize.js';
export type { ProviderAssetMaterializer, ProviderAssetMaterializerOptions } from './materialize.js';

export { createS3ObjectStore } from './storage-s3.js';
export type { S3ObjectStoreOptions } from './storage-s3.js';
