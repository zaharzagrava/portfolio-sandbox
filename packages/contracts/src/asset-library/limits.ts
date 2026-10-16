/** S31 limits shared by the schemas, the server and the sync client (specs/domains/S31-assets-digital-delivery). */
export const ASSET_CHUNK_MAX_BYTES = 16 * 1024 * 1024;
export const ASSET_PREPARE_MAX_CHUNKS = 5000;
export const ASSET_COMMIT_MAX_CHUNKS = 15000;
export const ASSET_FILE_MAX_BYTES = 50 * 1024 * 1024 * 1024;
export const ASSET_PATH_MAX_LENGTH = 1000;
export const ASSET_SEGMENT_MAX_LENGTH = 255;
export const ASSET_HASH_PATTERN = /^[0-9a-f]{64}$/;
export const ASSET_DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{4,64}$/;
