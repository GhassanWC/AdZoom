import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
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
    "google-gax",
    "@grpc/grpc-js",
    "@grpc/proto-loader",
  ],
};

export default nextConfig;
