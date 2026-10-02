/**
 * Provider identity constants. `HIGGSFIELD_PROVIDER_ID` is the value used on
 * every `MediaProvider.id`, job record and asset record, and by the ModelRegistry
 * to scope model ids.
 */
export const HIGGSFIELD_PROVIDER_ID = 'higgsfield';

/** Adapter implementation version. Bumped when submission semantics change. */
export const HIGGSFIELD_ADAPTER_VERSION = '0.1.0';

/**
 * Version of the bundled model catalog (`src/models/registry.json`). Bumped by
 * the catalog-refresh workflow, never by request handling.
 */
export const HIGGSFIELD_CATALOG_VERSION = '2026-10-02.1';
