/**
 * Lazy entry point for the Editframe beta engine. The provider `import()`s THIS
 * module on export start, so mediabunny + the render loop are code-split out of
 * the main bundle and never touch the Cloud export path.
 */
export { buildEditframeComposition } from "./build-composition";
export {
  runEditframeExport,
  type EditframeRenderResult,
  type RunEditframeExportOptions,
} from "./render";
export { detectEditframeSupport, type EditframeSupport } from "./capabilities";
export type {
  EditframePlan,
  EditframeProgress,
  EditframeProjectInput,
  EditframeResolution,
  EditframeTimelineInput,
} from "./types";
