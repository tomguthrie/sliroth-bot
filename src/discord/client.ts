import type { CreateDiscordMessageRequestOptions } from './request';
import { createDiscordMessageRequest } from './request';

export async function sendDiscordMessage(
  options: CreateDiscordMessageRequestOptions,
): Promise<void> {
  const request = createDiscordMessageRequest(options);
  const response = await fetch(request);

  if (!response.ok) {
    const responseBody = await response.text();
    const detail =
      responseBody.trim() === '' ? 'no response body' : responseBody;

    throw new Error(
      `Discord rejected the message with HTTP ${response.status}: ${detail}`,
    );
  }

  if (response.body !== null) {
    await response.body.cancel();
  }
}
