import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // Firebase App Hosting serves the standalone output (.next/standalone). Set it
  // explicitly so a local `next build` produces the SAME layout — lets us verify
  // the proto assets land in .next/standalone/node_modules (see tracing below).
  output: "standalone",
  turbopack: {
    root: path.resolve(__dirname),
  },
  // Cloud Tasks (used by /api/export/cloud → src/lib/export/enqueue.ts) pulls in
  // google-gax + gRPC, which do dynamic `require()`s for proto/native loading
  // that the production webpack bundle can't statically resolve — the failure
  // surfaces at runtime as "Cannot find module as expression is too dynamic".
  // Keeping these packages external makes Next `require()` them from
  // node_modules at runtime instead of bundling them. (firebase-admin is
  // already in Next's built-in default external list, which is why the
  // Firestore path works without being listed here.)
  serverExternalPackages: [
    "@google-cloud/tasks",
    "@google-cloud/batch",
    "google-gax",
    "@grpc/grpc-js",
    "@grpc/proto-loader",
  ],
  // This repo has a second lockfile (services/export-worker), which can make
  // Next infer the wrong workspace root for output-file tracing. Pin it to THIS
  // app's root so the standalone node_modules layout + the include globs below
  // resolve from the repo root (matches prod: /workspace/.next/standalone/...).
  outputFileTracingRoot: path.resolve(__dirname),
  // The externalized gRPC/google-gax packages load their protobuf descriptors
  // (.json/.proto) via dynamic paths that @vercel/nft can't follow, so Next's
  // standalone output drops them — at runtime the Cloud Tasks client throws:
  //   Cannot find module '.../@google-cloud/tasks/build/protos/protos.json'
  // Force the proto assets into the trace for the route that enqueues tasks.
  outputFileTracingIncludes: {
    // Both routes call createCloudExportJob → enqueueExportJob, which can dispatch
    // via Cloud Tasks AND/OR Cloud Batch depending on EXPORT_BACKEND. Trace both
    // clients' proto assets so whichever backend is configured resolves at runtime.
    "/api/export/cloud": [
      "./node_modules/@google-cloud/tasks/build/protos/**",
      "./node_modules/@google-cloud/batch/build/protos/**",
      "./node_modules/google-gax/build/protos/**",
    ],
    "/api/export/retry": [
      "./node_modules/@google-cloud/tasks/build/protos/**",
      "./node_modules/@google-cloud/batch/build/protos/**",
      "./node_modules/google-gax/build/protos/**",
    ],
    // Cancel stops the running Batch job (cancelBatchJob → @google-cloud/batch), so
    // its standalone bundle needs the Batch + gax proto assets traced in too.
    "/api/export/cancel": [
      "./node_modules/@google-cloud/batch/build/protos/**",
      "./node_modules/google-gax/build/protos/**",
    ],
    // The reconciler polls Batch job status (inspectBatchJob → @google-cloud/batch)
    // to detect jobs Google canceled before render (zone capacity) AND promotes the
    // deferred export queue (enqueueExportJob → Batch and/or Cloud Tasks), so it
    // needs the Batch + Tasks + gax proto assets traced in.
    "/api/cron/reconcile-exports": [
      "./node_modules/@google-cloud/tasks/build/protos/**",
      "./node_modules/@google-cloud/batch/build/protos/**",
      "./node_modules/google-gax/build/protos/**",
    ],
  },
};

export default nextConfig;
