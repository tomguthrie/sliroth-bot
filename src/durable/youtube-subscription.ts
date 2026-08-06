import { DurableObject } from "cloudflare:workers";

const SUBSCRIPTION_KEY = "subscription";

export interface SubscriptionState {
	schemaVersion: 1;
	phase: "uninitialized";
	channelId: string;
	createdAtMs: number;
}

export class YouTubeSubscription extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
	}

	ensureInitialized(channelId: string): SubscriptionState {
		if (channelId.trim() === "") {
			throw new Error("YouTube channel ID cannot be empty");
		}

		const existing = this.ctx.storage.kv.get<SubscriptionState>(SUBSCRIPTION_KEY);

		if (existing !== undefined) {
			if (existing.channelId !== channelId) {
				throw new Error("Subscription was initialized for a different YouTube channel");
			}

			return existing;
		}

		const created: SubscriptionState = {
			schemaVersion: 1,
			phase: "uninitialized",
			channelId,
			createdAtMs: Date.now(),
		};

		this.ctx.storage.kv.put(SUBSCRIPTION_KEY, created);
		return created;
	}
}
