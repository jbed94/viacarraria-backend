import { createHmac, randomUUID } from 'crypto';

export type WebhookEventType =
  | 'subscription_created'
  | 'subscription_updated'
  | 'subscription_cancelled'
  | 'subscription_resumed'
  | 'subscription_expired'
  | 'order_created';

export interface WebhookSimulationOptions {
  userId: string;
  eventType: WebhookEventType;
  externalEventId?: string;
  planId?: string;
  variantId?: string;
}

export interface LemonSqueezyWebhookPayload {
  meta: {
    event_name: WebhookEventType;
    custom_data: {
      user_id: string;
      [key: string]: unknown;
    };
  };
  data: {
    id: string;
    type: string;
    attributes: {
      status: string;
      order_id?: number;
      created_at: string;
      updated_at: string;
      user_email?: string;
      variant_id?: string;
      [key: string]: unknown;
    };
  };
}

export function generateWebhookPayload(
  options: WebhookSimulationOptions,
): LemonSqueezyWebhookPayload {
  const { userId, eventType, externalEventId, variantId } = options;
  const eventId =
    externalEventId ?? `ls_evt_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const now = new Date().toISOString();

  let status = 'active';
  if (eventType === 'subscription_cancelled') {
    status = 'cancelled';
  } else if (eventType === 'subscription_expired') {
    status = 'expired';
  } else if (eventType === 'order_created') {
    status = 'paid';
  }

  return {
    meta: {
      event_name: eventType,
      custom_data: {
        user_id: userId,
      },
    },
    data: {
      id: eventId,
      type: eventType.startsWith('order') ? 'orders' : 'subscriptions',
      attributes: {
        status,
        created_at: now,
        updated_at: now,
        variant_id: variantId ?? 'variant_default_pro',
      },
    },
  };
}

export function signWebhookPayload(
  payload: unknown,
  secret: string,
): { rawBody: string; signature: string } {
  const rawBody = JSON.stringify(payload);
  const signature = createHmac('sha256', secret).update(rawBody).digest('hex');
  return { rawBody, signature };
}

export async function sendWebhook(
  targetUrl: string,
  secret: string,
  payload: unknown,
): Promise<{ status: number; body: unknown }> {
  const { rawBody, signature } = signWebhookPayload(payload, secret);

  const response = await fetch(targetUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Signature': signature,
    },
    body: rawBody,
  });

  let responseBody: unknown;
  const text = await response.text();
  try {
    responseBody = JSON.parse(text);
  } catch {
    responseBody = text;
  }

  return {
    status: response.status,
    body: responseBody,
  };
}

export function parseArgs(argv: string[]): {
  event: WebhookEventType;
  userId: string;
  url: string;
  secret: string;
  dryRun: boolean;
} {
  let event: WebhookEventType = 'subscription_created';
  let userId = 'user-dev-demo';
  let url = 'http://localhost:3000/api/billing/webhook';
  let secret = process.env.LEMON_SQUEEZY_WEBHOOK_SECRET || 'dev-webhook-secret';
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--event' && argv[i + 1]) {
      event = (argv[++i] as WebhookEventType) || event;
    } else if (arg === '--user' && argv[i + 1]) {
      userId = argv[++i] ?? userId;
    } else if (arg === '--url' && argv[i + 1]) {
      url = argv[++i] ?? url;
    } else if (arg === '--secret' && argv[i + 1]) {
      secret = argv[++i] ?? secret;
    } else if (arg === '--dry-run') {
      dryRun = true;
    }
  }

  return { event, userId, url, secret, dryRun };
}

async function runCli() {
  const options = parseArgs(process.argv.slice(2));
  console.log(
    `[Webhook Simulator] Generating event: ${options.event} for user: ${options.userId}`,
  );

  const payload = generateWebhookPayload({
    userId: options.userId,
    eventType: options.event,
  });

  const { signature, rawBody } = signWebhookPayload(payload, options.secret);
  console.log(`[Webhook Simulator] HMAC-SHA256 Signature: ${signature}`);
  console.log(
    `[Webhook Simulator] Payload:\n${JSON.stringify(payload, null, 2)}`,
  );

  if (options.dryRun) {
    console.log(
      '[Webhook Simulator] Dry-run enabled. Skipping network dispatch.',
    );
    return;
  }

  console.log(`[Webhook Simulator] Dispatching POST -> ${options.url}`);
  try {
    const result = await sendWebhook(options.url, options.secret, payload);
    console.log(`[Webhook Simulator] Response Status: ${result.status}`);
    console.log(`[Webhook Simulator] Response Body:`, result.body);
  } catch (error) {
    console.error(`[Webhook Simulator] Network dispatch failed:`, error);
    process.exit(1);
  }
}

// Check if run directly from command line
if (process.argv[1]?.includes('simulate-webhook')) {
  runCli().catch((err) => {
    console.error('[Webhook Simulator] Unexpected error:', err);
    process.exit(1);
  });
}
