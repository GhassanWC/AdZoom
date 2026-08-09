/**
 * The ordered migration list. Adding a generated `.sql` file means adding its
 * name HERE too — an explicit list (rather than a directory scan) keeps the
 * order deterministic and survives bundling, where the folder may not be
 * enumerable at runtime.
 */
export const MIGRATIONS = [
  "0000_initial.sql",
  "0001_cloud_link.sql",
  "0002_sync.sql",
  "0003_media_checksum.sql",
  "0004_media_downloads.sql",
] as const;
