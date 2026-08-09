import type {
  CreateDiscordMessageRequestOptions,
  EditDiscordMessageRequestOptions,
} from './request';
import {
  createDiscordEditMessageRequest,
  createDiscordMessageRequest,
} from './request';

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

/** Identifies the Discord message created or edited by an API request. */
export interface DiscordMessageReceipt {
  messageId: string;
  channelId: string;
}

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

  const message = await response.json<{ id: string; channel_id: string }>();
  return { messageId: message.id, channelId: message.channel_id };
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }

  const seconds = Number.parseFloat(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}
