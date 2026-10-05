import { getStripeSync } from "./stripeClient";
import { projectStripeEvent } from "./stripeEventProjector";

export class WebhookHandlers {
  static async processWebhook(payload: Buffer, signature: string): Promise<void> {
    if (!Buffer.isBuffer(payload)) throw new Error("Stripe webhook payload must be raw bytes.");
    await (await getStripeSync()).processWebhook(payload, signature);
    // StripeSync verification is deliberately first; only verified events reach our projector.
    await projectStripeEvent(JSON.parse(payload.toString("utf8")) as { id: string; type: string; data?: { object?: { id?: string } } });
  }
}