import * as z from 'zod';

import type { TwitchApiClient, TwitchUser } from './client';
import { TwitchBroadcasterId, TwitchLogin } from './data';

const TwitchChannelUrl = z
  .url({
    protocol: /^https$/,
    hostname: /^(?:www\.|m\.)?twitch\.tv$/i,
  })
  .transform((value) => new URL(value).pathname)
  .pipe(z.string().regex(/^\/[^/]+(?:\/|$)/))
  .transform((pathname) => pathname.replace(/^\/([^/]+).*$/, '$1'))
  .pipe(TwitchLogin);

const TwitchChannelReference = z
  .string()
  .trim()
  .min(1)
  .pipe(
    z.union([
      TwitchBroadcasterId.transform(
        (value): { type: 'id'; value: TwitchBroadcasterId } => ({
          type: 'id',
          value,
        }),
      ),
      TwitchChannelUrl.transform(
        (value): { type: 'login'; value: TwitchLogin } => ({
          type: 'login',
          value,
        }),
      ),
      TwitchLogin.transform((value): { type: 'login'; value: TwitchLogin } => ({
        type: 'login',
        value,
      })),
    ]),
  );

export class TwitchChannelResolutionError extends Error {}

/** Resolves a Twitch login, numeric broadcaster ID, or channel URL. */
export async function resolveTwitchChannel(
  input: string,
  client: Pick<TwitchApiClient, 'getUserById' | 'getUserByLogin'>,
): Promise<TwitchUser> {
  const reference = TwitchChannelReference.safeParse(input);
  if (!reference.success) {
    throw new TwitchChannelResolutionError('Invalid Twitch channel', {
      cause: reference.error,
    });
  }
  let user: TwitchUser | undefined;
  try {
    user =
      reference.data.type === 'id'
        ? await client.getUserById(reference.data.value)
        : await client.getUserByLogin(reference.data.value);
  } catch (error) {
    throw new TwitchChannelResolutionError(
      'Twitch channel could not be loaded',
      {
        cause: error,
      },
    );
  }
  if (user === undefined) {
    throw new TwitchChannelResolutionError('Twitch channel was not found');
  }
  return user;
}
