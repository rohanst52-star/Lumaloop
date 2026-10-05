import Stripe from "stripe";
import { StripeSync } from "stripe-replit-sync";

async function credentials(): Promise<{ secretKey: string; webhookSecret?: string }> {
  const host = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const token = process.env.REPL_IDENTITY ? `repl ${process.env.REPL_IDENTITY}` :
    process.env.WEB_REPL_RENEWAL ? `depl ${process.env.WEB_REPL_RENEWAL}` : undefined;
  if (!host || !token) throw new Error("Stripe connector is not currently available.");
  const response = await fetch(`https://${host}/api/v2/connection?include_secrets=true&connector_names=stripe`, {
    headers: { Accept: "application/json", X_REPLIT_TOKEN: token },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Stripe connector request failed (${response.status}).`);
  const data = await response.json() as {
    items?: Array<{
      settings?: {
        secret?: string;
        secret_key?: string;
        webhook_secret?: string;
      };
    }>;
  };
  const settings = data.items?.[0]?.settings;
  const secretKey = settings?.secret ?? settings?.secret_key;
  if (!secretKey) throw new Error("Stripe integration is not connected.");
  return { secretKey, webhookSecret: settings?.webhook_secret };
}

export async function getUncachableStripeClient(): Promise<Stripe> {
  return new Stripe((await credentials()).secretKey);
}

export async function getStripeSync(): Promise<StripeSync> {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for Stripe sync.");
  const auth = await credentials();
  return new StripeSync({
    poolConfig: { connectionString: process.env.DATABASE_URL },
    stripeSecretKey: auth.secretKey,
    // Managed endpoints can be recreated to update Connect subscriptions,
    // which rotates their signing secret. Leaving this empty makes StripeSync
    // verify with the current secret persisted for its managed endpoint instead
    // of a potentially stale connector-level secret.
    stripeWebhookSecret: "",
  });
}