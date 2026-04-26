/**
 * Next.js App Router GET handler for the `/api/metrics` route.
 *
 * Usage in a consumer's `app/api/metrics/route.ts`:
 *
 *   export { GET } from "@simsys/metrics/next/route";
 *   export const dynamic = "force-dynamic";
 *
 * `dynamic = "force-dynamic"` keeps Next from SSG-caching the metrics
 * payload at build time.
 */

import { registry } from "../registry.js";

export async function GET(): Promise<Response> {
  const body = await registry.metrics();
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": registry.contentType },
  });
}
