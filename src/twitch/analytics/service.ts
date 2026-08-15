import { and, eq, lt } from 'drizzle-orm';
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import {
  analyticsAuthorization,
  analyticsOauthStates,
  analyticsPendingFinalizers,
  analyticsRuntime,
  eventSubSubscriptions,
} from '../../db/twitch-subscription/schema';
import { toLoggableError } from '../../log';
import { isTwitchApiErrorStatus, TwitchApiClient } from '../client';
import type { EventSubNotification } from '../eventsub';
import {
  TWITCH_EVENT_CHANNEL_CHAT_MESSAGE,
  TWITCH_EVENT_CHANNEL_UPDATE,
  TWITCH_EVENT_STREAM_OFFLINE,
  TWITCH_EVENT_STREAM_ONLINE,
} from '../eventsub';
import type { TwitchEventSubDelivery } from '../subscription/queue';
import {
  TWITCH_ANALYTICS_EVENTSUB_SUBSCRIPTIONS,
  TWITCH_ANALYTICS_SCOPES,
} from './eventsub';
import {
  createOAuthState,
  exchangeAuthorizationCode,
  hashOAuthState,
  refreshUserToken,
  type ValidatedTwitchToken,
  validateUserToken,
} from './oauth';
import { TwitchAnalyticsRepository } from './repository';

const OAUTH_STATE_LIFETIME_MS = 10 * 60 * 1000;
const VIEWER_SAMPLE_INTERVAL_MS = 60 * 1000;
const AUDIENCE_SAMPLE_INTERVAL_MS = 5 * 60 * 1000;
const TOKEN_VALIDATION_INTERVAL_MS = 24 * 60 * 60 * 1000;
const EVENTSUB_AUDIT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const TOKEN_REFRESH_LEEWAY_MS = 5 * 60 * 1000;
const STREAM_FINALIZATION_DELAY_MS = 2 * 60 * 1000;
const ACTIVE_EVENTSUB_STATUSES = new Set([
  'enabled',
  'webhook_callback_verification_pending',
]);

interface AuthorizationResult {
  readonly login: string;
}

/** Coordinates broadcaster-scoped analytics state and shared D1 capture. */
export class TwitchAnalyticsService {
  private readonly repository: TwitchAnalyticsRepository;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
    private readonly localDb: DrizzleSqliteDODatabase,
  ) {
    this.repository = new TwitchAnalyticsRepository(env);
  }

  async beginAuthorization(redirectUri: string): Promise<string> {
    const state = createOAuthState();
    const stateHash = await hashOAuthState(state);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + OAUTH_STATE_LIFETIME_MS);

    await this.localDb
      .delete(analyticsOauthStates)
      .where(lt(analyticsOauthStates.expiresAt, now));
    await this.localDb.insert(analyticsOauthStates).values({
      stateHash,
      createdAt: now,
      expiresAt,
    });

    const url = new URL('https://id.twitch.tv/oauth2/authorize');
    url.searchParams.set('client_id', this.env.TWITCH_CLIENT_ID);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', TWITCH_ANALYTICS_SCOPES.join(' '));
    url.searchParams.set('state', state);
    url.searchParams.set('force_verify', 'true');
    return url.toString();
  }

  async completeAuthorization(
    code: string,
    state: string,
    redirectUri: string,
  ): Promise<AuthorizationResult> {
    const stateHash = await hashOAuthState(state);
    const now = new Date();
    const [storedState] = await this.localDb
      .select()
      .from(analyticsOauthStates)
      .where(eq(analyticsOauthStates.stateHash, stateHash))
      .limit(1);
    if (storedState === undefined || storedState.expiresAt <= now) {
      throw new Error('Invalid or expired Twitch analytics OAuth state');
    }
    await this.localDb
      .delete(analyticsOauthStates)
      .where(eq(analyticsOauthStates.stateHash, stateHash));

    const token = await exchangeAuthorizationCode(this.env, code, redirectUri);
    const validated = await validateUserToken(token.access_token);
    this.assertConfiguredAuthorization(validated);

    const grantedScopes = new Set(validated.scopes);
    const missingScopes = TWITCH_ANALYTICS_SCOPES.filter(
      (scope) => !grantedScopes.has(scope),
    );
    if (missingScopes.length > 0) {
      throw new Error(
        `Twitch authorization is missing scopes: ${missingScopes.join(', ')}`,
      );
    }

    const expiresAt = new Date(now.getTime() + validated.expires_in * 1000);
    await this.localDb
      .insert(analyticsAuthorization)
      .values({
        singleton: 1,
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        scopesJson: JSON.stringify(validated.scopes),
        authorizedAt: now,
        validatedAt: now,
        expiresAt,
      })
      .onConflictDoUpdate({
        target: analyticsAuthorization.singleton,
        set: {
          accessToken: token.access_token,
          refreshToken: token.refresh_token,
          scopesJson: JSON.stringify(validated.scopes),
          authorizedAt: now,
          validatedAt: now,
          expiresAt,
        },
      });
    await this.localDb
      .insert(analyticsRuntime)
      .values({
        singleton: 1,
        status: 'active',
        enabledAt: now,
        nextViewerSampleAt: null,
        nextAudienceSampleAt: null,
        nextTokenValidationAt: new Date(
          now.getTime() + TOKEN_VALIDATION_INTERVAL_MS,
        ),
        nextEventSubAuditAt: now,
      })
      .onConflictDoUpdate({
        target: analyticsRuntime.singleton,
        set: {
          status: 'active',
          enabledAt: now,
          nextViewerSampleAt: null,
          nextAudienceSampleAt: null,
          nextTokenValidationAt: new Date(
            now.getTime() + TOKEN_VALIDATION_INTERVAL_MS,
          ),
          nextEventSubAuditAt: now,
        },
      });

    const user = await new TwitchApiClient(this.env).getUserById(
      validated.user_id,
    );
    if (user === undefined) throw new Error('Authorized Twitch user not found');
    await this.repository.initializeChannel(user, now);
    await this.repository.recordGrantedCapabilities(validated.scopes, now);
    await this.reconcileEventSub(now);
    return { login: validated.login };
  }

  async processEventSub(delivery: TwitchEventSubDelivery): Promise<void> {
    if (
      delivery.message.messageType !== 'notification' ||
      delivery.message.subscription.broadcasterId !==
        this.env.TWITCH_ANALYTICS_CHANNEL_ID
    ) {
      return;
    }
    const runtime = await this.getActiveRuntime();
    if (runtime === undefined) return;

    const occurredAt = new Date(delivery.timestamp);
    const message = delivery.message;
    switch (message.eventType) {
      case TWITCH_EVENT_STREAM_ONLINE:
        await this.recordStreamOnline(message, occurredAt);
        await this.sampleBoundary(
          message.event.streamId,
          occurredAt,
          'stream_start',
        );
        break;
      case TWITCH_EVENT_STREAM_OFFLINE:
        await this.sampleBoundary(
          message.event.streamId,
          occurredAt,
          'stream_end',
        );
        await this.recordStreamOffline(message.event.streamId, occurredAt);
        break;
      case TWITCH_EVENT_CHANNEL_UPDATE:
        await this.repository.recordMetadataChange(
          delivery.messageId,
          runtime.activeStreamId,
          occurredAt,
          message.event,
        );
        break;
      case TWITCH_EVENT_CHANNEL_CHAT_MESSAGE:
        await this.repository.recordChatMessage(
          delivery.messageId,
          runtime.activeStreamId,
          occurredAt,
          message,
        );
        break;
      default:
        await this.repository.recordActivityEvent(
          delivery.messageId,
          runtime.activeStreamId,
          occurredAt,
          message,
        );
    }
  }

  async eventSubRevoked(): Promise<void> {
    await this.reconcileEventSub(new Date());
  }

  async alarm(): Promise<void> {
    try {
      await this.runAlarm();
    } catch (error) {
      console.error({
        event: 'twitch_analytics_alarm_failed',
        error: toLoggableError(error),
      });
      const runtime = await this.getActiveRuntime();
      if (runtime?.activeStreamId === null || runtime === undefined) {
        await this.ctx.storage.deleteAlarm();
      } else {
        await this.ctx.storage.setAlarm(Date.now() + VIEWER_SAMPLE_INTERVAL_MS);
      }
    }
  }

  private async runAlarm(): Promise<void> {
    const now = new Date();
    await this.localDb
      .delete(analyticsOauthStates)
      .where(lt(analyticsOauthStates.expiresAt, now));
    let runtime = await this.getActiveRuntime();
    if (runtime === undefined) return;

    let authorization = await this.getAuthorization();
    if (authorization === undefined) {
      await this.requireReauthorization();
      return;
    }
    if (
      authorization.expiresAt.getTime() <=
      now.getTime() + TOKEN_REFRESH_LEEWAY_MS
    ) {
      authorization = await this.refreshAuthorization(authorization, now);
    }
    if (
      runtime.nextTokenValidationAt === null ||
      runtime.nextTokenValidationAt <= now
    ) {
      let validated;
      try {
        validated = await validateUserToken(authorization.accessToken);
      } catch (error) {
        await this.requireReauthorization();
        throw error;
      }
      this.assertConfiguredAuthorization(validated);
      await this.localDb
        .update(analyticsAuthorization)
        .set({
          scopesJson: JSON.stringify(validated.scopes),
          validatedAt: now,
          expiresAt: new Date(now.getTime() + validated.expires_in * 1000),
        })
        .where(eq(analyticsAuthorization.singleton, 1));
      await this.localDb
        .update(analyticsRuntime)
        .set({
          nextTokenValidationAt: new Date(
            now.getTime() + TOKEN_VALIDATION_INTERVAL_MS,
          ),
        })
        .where(eq(analyticsRuntime.singleton, 1));
    }
    if (
      runtime.nextEventSubAuditAt === null ||
      runtime.nextEventSubAuditAt <= now
    ) {
      await this.reconcileEventSub(now);
    }

    const viewerDue =
      runtime.activeStreamId !== null &&
      (runtime.nextViewerSampleAt === null ||
        runtime.nextViewerSampleAt <= now);
    const audienceDue =
      runtime.activeStreamId !== null &&
      (runtime.nextAudienceSampleAt === null ||
        runtime.nextAudienceSampleAt <= now);
    if (viewerDue || audienceDue) {
      await this.sample(now, authorization.accessToken, viewerDue, audienceDue);
    }

    runtime = await this.getActiveRuntime();
    if (runtime !== undefined) {
      await this.scheduleNextAlarm(runtime, now);
    }
  }

  private async sample(
    now: Date,
    accessToken: string,
    viewerDue: boolean,
    audienceDue: boolean,
  ): Promise<void> {
    const runtime = await this.getActiveRuntime();
    if (runtime === undefined) return;
    const appClient = new TwitchApiClient(this.env);
    const stream = viewerDue
      ? await appClient.getStream(this.env.TWITCH_ANALYTICS_CHANNEL_ID)
      : undefined;
    let activeStreamId = runtime.activeStreamId;
    let viewerCount: number | undefined;

    if (viewerDue) {
      if (stream !== undefined) {
        activeStreamId = stream.id;
        viewerCount = stream.viewerCount;
        await this.repository.upsertLiveStream(stream, now);
        await this.repository.recordMetadataIfChanged(stream, now);
      } else if (activeStreamId !== null) {
        await this.recordStreamOffline(activeStreamId, now);
        activeStreamId = null;
      }
    }

    let followerCount: number | undefined;
    let subscriberCount: number | undefined;
    if (audienceDue) {
      [followerCount, subscriberCount] = await this.getAudienceCounts(
        accessToken,
        now,
      );
    }

    if (
      viewerCount !== undefined ||
      followerCount !== undefined ||
      subscriberCount !== undefined
    ) {
      await this.repository.recordAudienceSample({
        streamId: activeStreamId,
        sampledAt: now,
        ...(viewerCount === undefined ? {} : { viewerCount }),
        ...(followerCount === undefined ? {} : { followerCount }),
        ...(subscriberCount === undefined ? {} : { subscriberCount }),
        source: 'alarm',
      });
    }

    await this.localDb
      .update(analyticsRuntime)
      .set({
        activeStreamId,
        ...(viewerDue
          ? {
              nextViewerSampleAt: new Date(
                now.getTime() + VIEWER_SAMPLE_INTERVAL_MS,
              ),
            }
          : {}),
        ...(audienceDue
          ? {
              nextAudienceSampleAt: new Date(
                now.getTime() + AUDIENCE_SAMPLE_INTERVAL_MS,
              ),
            }
          : {}),
      })
      .where(eq(analyticsRuntime.singleton, 1));
  }

  private async recordStreamOnline(
    message: Extract<
      EventSubNotification,
      { eventType: typeof TWITCH_EVENT_STREAM_ONLINE }
    >,
    recordedAt: Date,
  ): Promise<void> {
    await this.repository.recordStreamOnline(
      message.event.streamId,
      new Date(message.event.startedAt),
      recordedAt,
    );
    await this.localDb
      .update(analyticsRuntime)
      .set({
        activeStreamId: message.event.streamId,
        nextViewerSampleAt: recordedAt,
        nextAudienceSampleAt: recordedAt,
      })
      .where(eq(analyticsRuntime.singleton, 1));
    await this.ctx.storage.setAlarm(Date.now());
  }

  private async sampleBoundary(
    streamId: string,
    sampledAt: Date,
    source: 'stream_start' | 'stream_end',
  ): Promise<void> {
    const authorization = await this.getAuthorization();
    if (authorization === undefined) return;
    const stream =
      source === 'stream_start'
        ? await new TwitchApiClient(this.env).getStream(
            this.env.TWITCH_ANALYTICS_CHANNEL_ID,
          )
        : undefined;
    const [followerCount, subscriberCount] = await this.getAudienceCounts(
      authorization.accessToken,
      sampledAt,
    );
    if (stream !== undefined) {
      await this.repository.upsertLiveStream(stream, sampledAt);
      await this.repository.recordMetadataIfChanged(stream, sampledAt);
    }
    await this.repository.recordAudienceSample({
      streamId,
      sampledAt,
      ...(stream === undefined ? {} : { viewerCount: stream.viewerCount }),
      followerCount,
      subscriberCount,
      source,
    });
  }

  private async recordStreamOffline(
    streamId: string,
    recordedAt: Date,
  ): Promise<void> {
    await this.repository.finishStream(streamId, recordedAt);
    await this.localDb
      .insert(analyticsPendingFinalizers)
      .values({
        streamId,
        finalizeAfter: new Date(
          recordedAt.getTime() + STREAM_FINALIZATION_DELAY_MS,
        ),
      })
      .onConflictDoUpdate({
        target: analyticsPendingFinalizers.streamId,
        set: {
          finalizeAfter: new Date(
            recordedAt.getTime() + STREAM_FINALIZATION_DELAY_MS,
          ),
        },
      });
    await this.localDb
      .update(analyticsRuntime)
      .set({
        activeStreamId: null,
        nextViewerSampleAt: null,
        nextAudienceSampleAt: null,
      })
      .where(eq(analyticsRuntime.singleton, 1));
    await this.ctx.storage.deleteAlarm();
  }

  private async getAudienceCounts(
    accessToken: string,
    now: Date,
  ): Promise<readonly [number, number]> {
    try {
      return await fetchAudienceCounts(this.env, accessToken);
    } catch (error) {
      if (!isTwitchApiErrorStatus(error, 401)) throw error;
      const authorization = await this.getAuthorization();
      if (authorization === undefined) throw error;
      const refreshed = await this.refreshAuthorization(authorization, now);
      return fetchAudienceCounts(this.env, refreshed.accessToken);
    }
  }

  private async reconcileEventSub(now: Date): Promise<void> {
    const client = new TwitchApiClient(this.env);
    const callback = new URL(
      `/twitch/eventsub/${this.env.TWITCH_ANALYTICS_CHANNEL_ID}`,
      this.env.PUBLIC_BASE_URL,
    ).toString();
    const rows = await this.localDb.select().from(eventSubSubscriptions);

    for (const desired of TWITCH_ANALYTICS_EVENTSUB_SUBSCRIPTIONS) {
      const condition = desired.condition(this.env.TWITCH_ANALYTICS_CHANNEL_ID);
      const row = rows.find(
        (candidate) => candidate.subscriptionKey === desired.key,
      );
      if (row !== undefined) {
        const remote = await client.getEventSubSubscription(row.subscriptionId);
        if (
          remote !== undefined &&
          ACTIVE_EVENTSUB_STATUSES.has(remote.status) &&
          remote.type === desired.type &&
          remote.version === desired.version &&
          remote.transport.callback === callback &&
          sameRecord(remote.condition, condition)
        ) {
          continue;
        }
        if (remote !== undefined) {
          await client.deleteEventSubSubscription(remote.id);
        }
        await this.localDb
          .delete(eventSubSubscriptions)
          .where(eq(eventSubSubscriptions.subscriptionKey, desired.key));
      }

      try {
        const created = await client.createEventSubSubscription({
          type: desired.type,
          version: desired.version,
          condition,
          transport: {
            method: 'webhook',
            callback,
            secret: this.env.TWITCH_EVENTSUB_SECRET,
          },
        });
        await this.localDb.insert(eventSubSubscriptions).values({
          subscriptionKey: desired.key,
          type: desired.type,
          version: desired.version,
          conditionJson: JSON.stringify(condition),
          subscriptionId: created.id,
        });
        await this.repository.recordCapability(
          `eventsub:${desired.key}`,
          'active',
          null,
          now,
        );
      } catch (error) {
        await this.repository.recordCapability(
          `eventsub:${desired.key}`,
          'error',
          error instanceof Error ? error.message : 'Unknown EventSub error',
          now,
        );
        console.error({
          event: 'twitch_analytics_eventsub_reconcile_failed',
          subscriptionKey: desired.key,
          error: toLoggableError(error),
        });
      }
    }

    await this.localDb
      .update(analyticsRuntime)
      .set({
        nextEventSubAuditAt: new Date(
          now.getTime() + EVENTSUB_AUDIT_INTERVAL_MS,
        ),
      })
      .where(eq(analyticsRuntime.singleton, 1));
  }

  private async refreshAuthorization(
    authorization: typeof analyticsAuthorization.$inferSelect,
    now: Date,
  ): Promise<typeof analyticsAuthorization.$inferSelect> {
    try {
      const token = await refreshUserToken(
        this.env,
        authorization.refreshToken,
      );
      const validated = await validateUserToken(token.access_token);
      this.assertConfiguredAuthorization(validated);
      const updated = {
        ...authorization,
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        scopesJson: JSON.stringify(validated.scopes),
        validatedAt: now,
        expiresAt: new Date(now.getTime() + validated.expires_in * 1000),
      };
      await this.localDb
        .update(analyticsAuthorization)
        .set(updated)
        .where(eq(analyticsAuthorization.singleton, 1));
      return updated;
    } catch (error) {
      await this.requireReauthorization();
      throw error;
    }
  }

  private assertConfiguredAuthorization(validated: ValidatedTwitchToken): void {
    if (validated.client_id !== this.env.TWITCH_CLIENT_ID) {
      throw new Error('Twitch authorization belongs to another client');
    }
    if (validated.user_id !== this.env.TWITCH_ANALYTICS_CHANNEL_ID) {
      throw new Error('Twitch authorization belongs to another channel');
    }
  }

  private async requireReauthorization(): Promise<void> {
    await this.localDb
      .update(analyticsRuntime)
      .set({ status: 'reauthorization_required' })
      .where(eq(analyticsRuntime.singleton, 1));
  }

  private async getAuthorization() {
    const [authorization] = await this.localDb
      .select()
      .from(analyticsAuthorization)
      .where(eq(analyticsAuthorization.singleton, 1))
      .limit(1);
    return authorization;
  }

  private async getActiveRuntime() {
    const [runtime] = await this.localDb
      .select()
      .from(analyticsRuntime)
      .where(
        and(
          eq(analyticsRuntime.singleton, 1),
          eq(analyticsRuntime.status, 'active'),
        ),
      )
      .limit(1);
    return runtime;
  }

  private async scheduleNextAlarm(
    runtime: typeof analyticsRuntime.$inferSelect,
    now: Date,
  ): Promise<void> {
    if (runtime.activeStreamId === null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const candidates = [
      runtime.nextViewerSampleAt,
      runtime.nextAudienceSampleAt,
      runtime.nextTokenValidationAt,
      runtime.nextEventSubAuditAt,
    ].filter((candidate): candidate is Date => candidate !== null);
    const next = Math.max(
      now.getTime() + 1000,
      Math.min(...candidates.map((candidate) => candidate.getTime())),
    );
    await this.ctx.storage.setAlarm(next);
  }
}

function sameRecord(
  left: Record<string, string>,
  right: Record<string, string>,
): boolean {
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => left[key] === right[key])
  );
}

async function fetchAudienceCounts(
  env: Env,
  accessToken: string,
): Promise<readonly [number, number]> {
  const client = new TwitchApiClient(env, accessToken);
  return Promise.all([
    client.getFollowerCount(env.TWITCH_ANALYTICS_CHANNEL_ID),
    client.getSubscriberCount(env.TWITCH_ANALYTICS_CHANNEL_ID),
  ]);
}
