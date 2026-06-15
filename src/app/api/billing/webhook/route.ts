import { NextResponse, type NextRequest } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdmin } from "@/lib/firebase/admin";
import {
  eventIdFor,
  isHandledEvent,
  reduceSubscription,
  verifyLemonSqueezySignature,
  type LsWebhookPayload,
} from "@/lib/lemonsqueezy/webhook";
import { assertBillingEnv } from "@/lib/lemonsqueezy/env";
import { stripUndefined } from "@/lib/firebase/sanitize";
import { recordEvent } from "@/lib/analytics/recordEvent";
import { EVENTS } from "@/lib/analytics/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/billing/webhook  —  Lemon Squeezy webhook receiver.
 *
 * Contract:
 *   1. Read raw body via `await req.text()` BEFORE parsing JSON. The HMAC
 *      is computed against the exact bytes LS sent; re-stringified JSON
 *      will not verify.
 *   2. Verify the `X-Signature` header with the shared secret.
 *   3. Idempotency: write `processedEvents/{eventId}` AFTER the
 *      subscription write succeeds. If LS retries the same event, the
 *      second pass writes the same patch and then no-ops on the
 *      processedEvents create.
 *   4. Map `event.meta.custom_data.user_id` → Firebase uid. If it's
 *      missing (someone visited a checkout outside our /api/billing/checkout
 *      flow), 400 — the subscription orphans and we'd rather know than
 *      silently misattribute.
 *
 * IMPORTANT: this endpoint MUST be reachable from Lemon Squeezy's IPs.
 * In dev, expose it with ngrok. In prod, no auth header is expected.
 */
export async function POST(req: NextRequest) {
  // Surface env mis-configuration as a 500 with a clear message; LS will
  // retry, giving ops a chance to fix it.
  try {
    assertBillingEnv();
  } catch (err) {
    console.error("[billing/webhook]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Billing env not configured" },
      { status: 500 }
    );
  }

  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch (err) {
    console.error("[billing/webhook] failed to read body", err);
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  const signature = req.headers.get("x-signature");
  if (!verifyLemonSqueezySignature(rawBody, signature)) {
    console.warn("[billing/webhook] signature mismatch — rejecting");
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: LsWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as LsWebhookPayload;
  } catch (err) {
    console.error("[billing/webhook] body is not valid JSON", err);
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const eventName = payload.meta?.event_name;
  if (!eventName) {
    return NextResponse.json({ error: "Missing event name" }, { status: 400 });
  }

  // Events we don't handle are acknowledged so LS stops retrying.
  if (!isHandledEvent(eventName)) {
    console.log("[billing/webhook] ignoring unhandled event", eventName);
    return NextResponse.json({ ok: true, ignored: true });
  }

  const uid = payload.meta.custom_data?.user_id;
  if (!uid) {
    console.error(
      "[billing/webhook] missing custom_data.user_id — checkout was created outside /api/billing/checkout"
    );
    return NextResponse.json(
      { error: "Missing custom_data.user_id" },
      { status: 400 }
    );
  }

  const eventId = eventIdFor(payload);
  const { db } = getAdmin();
  const processedRef = db.doc(`processedEvents/${eventId}`);

  // Cheap pre-flight: if we've already processed this event, no-op.
  // (The post-write `.create()` below is the authoritative idempotency
  // guarantee — this check just saves us a Firestore round-trip in the
  // common retry case.)
  const processedSnap = await processedRef.get();
  if (processedSnap.exists) {
    return NextResponse.json({ ok: true, idempotent: true });
  }

  try {
    const now = Date.now();
    const subRef = db.doc(`subscriptions/${uid}`);
    const userRef = db.doc(`users/${uid}`);

    // `subscription_payment_success` carries a `subscription-invoice`
    // resource — NOT a subscription. Its attributes have no `variant_id`
    // and the `status` field is the invoice status ("paid"), not the
    // subscription status. Running it through `reduceSubscription` would
    // clobber the real state (set plan→"free", status→"past_due") because
    // the reducer defaults missing/unknown fields conservatively.
    //
    // The subscription_* state events (created/updated/cancelled/...) are
    // authoritative for status + plan. Payment-success only writes a
    // receipt timestamp, so it can't overwrite known-good state.
    if (eventName === "subscription_payment_success") {
      await subRef.set(
        { lastPaymentAt: now, updatedAt: now },
        { merge: true }
      );
      void recordEvent(EVENTS.PAYMENT_SUCCESS, { userId: uid });
    } else {
      const { patch, effectivePlan } = reduceSubscription(eventName, payload);

      // Order matters: write subscription + user-plan mirror FIRST so a
      // Firestore failure means LS will retry the whole event. Only after
      // both succeed do we record the idempotency marker.
      await db.runTransaction(async (tx) => {
        const subSnap = await tx.get(subRef);
        const existing = subSnap.exists ? subSnap.data() : null;
        const createdAt = (existing?.createdAt as number | undefined) ?? now;

        tx.set(
          subRef,
          stripUndefined({
            ...patch,
            userId: uid,
            createdAt,
            updatedAt: now,
          }),
          { merge: true }
        );
        tx.set(
          userRef,
          {
            plan: effectivePlan,
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      });

      // Surface the lifecycle transition to product analytics.
      const cancelled =
        eventName === "subscription_cancelled" ||
        eventName === "subscription_expired" ||
        effectivePlan === "free";
      void recordEvent(
        cancelled ? EVENTS.SUBSCRIPTION_CANCELLED : EVENTS.SUBSCRIPTION_CREATED,
        { userId: uid, plan: effectivePlan, metadata: { eventName } }
      );
    }

    // Idempotency marker — `create` throws if it already exists, which we
    // swallow (means a concurrent delivery beat us; the state is the same).
    try {
      await processedRef.create({
        eventName,
        uid,
        processedAt: FieldValue.serverTimestamp(),
      });
    } catch {
      /* concurrent delivery — already recorded */
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[billing/webhook] failed to apply event", eventName, err);
    // 500 → LS will retry, which is what we want.
    return NextResponse.json({ error: "Webhook handler failed" }, { status: 500 });
  }
}
