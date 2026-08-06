import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("YouTubeSubscription", () => {
  it("initializes and preserves subscription state", async () => {
    const subscription = env.YOUTUBE_SUBSCRIPTIONS.getByName(crypto.randomUUID());

    const first = await subscription.ensureInitialized("UC_TEST_CHANNEL_ID");
    const second = await subscription.ensureInitialized("UC_TEST_CHANNEL_ID");

    expect(second).toEqual(first);
  });
});
