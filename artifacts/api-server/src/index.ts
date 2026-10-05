import app from "./app";
import { logger } from "./lib/logger";
import { runMigrations } from "stripe-replit-sync";
import { getStripeSync, getUncachableStripeClient } from "./lib/stripeClient";

async function initializeStripeSafely() {
  if (!process.env.DATABASE_URL) return;
  try {
    await runMigrations({ databaseUrl: process.env.DATABASE_URL });
    const sync = await getStripeSync();
    const domain = process.env.REPLIT_DOMAINS?.split(",")[0];
    if (domain) {
      const url = `https://${domain}/api/stripe/webhook`;
      // Create once with StripeSync's full supported event set. Its helper
      // deliberately reuses endpoints, so inspect then replace an older
      // endpoint when Connect/custom events are absent.
      let endpoint = await sync.findOrCreateManagedWebhook(url);
      const requiredEvents = ["account.updated", "transfer.reversed"];
      // Stripe's SDK response type omits `connect` although Stripe returns it
      // for Connect webhook endpoints.
      const connectEnabled = (endpoint as unknown as { connect?: boolean }).connect === true || endpoint.metadata?.connect_managed === "true";
      const missingConnectEvents = !connectEnabled || requiredEvents.some((event) => !endpoint.enabled_events.includes(event));
      if (missingConnectEvents) {
        await (await getUncachableStripeClient()).webhookEndpoints.del(endpoint.id);
        // findOrCreate observes the 404, cleans its _managed_webhooks record,
        // and creates the replacement with all prior sync-supported events.
        endpoint = await sync.findOrCreateManagedWebhook(url, {
          connect: true,
          enabled_events: [...new Set([...endpoint.enabled_events, ...requiredEvents])],
          metadata: { connect_managed: "true" },
        });
      }
    }
    await sync.syncBackfill();
  } catch (error) {
    // Connector availability can lag development startup; checkout reports a clear error until it recovers.
    logger.warn({ err: error }, "Stripe initialization deferred");
  }
}
void initializeStripeSafely();

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
