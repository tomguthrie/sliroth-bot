import * as z from 'zod';

import type {
  CreateDiscordMessageRequestOptions,
  EditDiscordMessageRequestOptions,
} from './request';
import {
  createDiscordEditMessageRequest,
  createDiscordMessageRequest,
} from './request';
import { DiscordSnowflake } from './snowflake';

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

/** Validates a Discord message response and exposes its delivery receipt. */
export const DiscordMessageReceipt = z
  .object({
    id: DiscordSnowflake,
    channel_id: DiscordSnowflake,
  })
  .transform(({ id, channel_id: channelId }) => ({
    messageId: id,
    channelId,
  }));

export type DiscordMessageReceipt = z.infer<typeof DiscordMessageReceipt>;

/** Sends a message to Discord and returns its delivery receipt. */
export async function sendDiscordMessage(
  options: CreateDiscordMessageRequestOptions,
): Promise<DiscordMessageReceipt> {
  return executeDiscordMessageRequest(createDiscordMessageRequest(options));
}

/** Edits an existing Discord message and returns its delivery receipt. */
export async function editDiscordMessage(
  options: EditDiscordMessageRequestOptions,
): Promise<DiscordMessageReceipt> {
  return executeDiscordMessageRequest(createDiscordEditMessageRequest(options));
}

async function executeDiscordMessageRequest(
  request: Request,
): Promise<DiscordMessageReceipt> {
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

  return DiscordMessageReceipt.parse(await response.json());
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }

  const seconds = Number.parseFloat(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}
