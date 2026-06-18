/**
 * Cloud-export kill switch. The server gate (`isCloudExportEnabled`) is
 * authoritative — `/api/export/cloud` refuses to create jobs unless
 * `CLOUD_EXPORT_ENABLED === "true"`. The client mirrors it via the public
 * `NEXT_PUBLIC_CLOUD_EXPORT_ENABLED` flag (UI visibility only). BOTH must be
 * "true" to fully turn the feature on; either left unset keeps it dark.
 *
 * This lets the Cloud Run worker be deployed to production with the feature
 * still OFF — flip the flags only once parity is verified.
 */
export function isCloudExportEnabled(): boolean {
  return process.env.CLOUD_EXPORT_ENABLED === "true";
}
