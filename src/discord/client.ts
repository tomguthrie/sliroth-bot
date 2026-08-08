import type { CreateDiscordMessageRequestOptions } from './request';
import { createDiscordMessageRequest } from './request';

/** Describes a non-successful response returned by Discord's API. */
export class DiscordApiError extends Error {
  constructor(
    readonly status: number,
    detail: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(`Discord rejected the message with HTTP ${status}: ${detail}`);
  }
}

/**
 * Sends a message to Discord and discards the successful response body.
 *
 * Throws when Discord rejects the request and includes any response details.
 */
export async function sendDiscordMessage(
  options: CreateDiscordMessageRequestOptions,
): Promise<void> {
  const request = createDiscordMessageRequest(options);
  const response = await fetch(request);

  if (!response.ok) {
    const responseBody = await response.text();
    const detail =
      responseBody.trim() === '' ? 'no response body' : responseBody;

    throw new DiscordApiError(
      response.status,
      detail,
      parseRetryAfter(response.headers.get('retry-after')),
    );
  }

  if (response.body !== null) {
    await response.body.cancel();
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }

  const seconds = Number.parseFloat(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}
