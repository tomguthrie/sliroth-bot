import { describe, expect, it } from 'vitest';

import { toLoggableError } from '../src/log';

describe('toLoggableError', () => {
  it('makes Error details and its cause enumerable', () => {
    const cause = Object.assign(new Error('Twitch returned HTTP 401'), {
      status: 401,
    });
    const error = new Error('Twitch channel could not be loaded', { cause });

    expect(JSON.parse(JSON.stringify(toLoggableError(error)))).toMatchObject({
      name: 'Error',
      message: 'Twitch channel could not be loaded',
      cause: {
        name: 'Error',
        message: 'Twitch returned HTTP 401',
        status: 401,
      },
    });
  });

  it('preserves a non-Error caught value', () => {
    const value = { reason: 'unavailable' };

    expect(toLoggableError(value)).toBe(value);
  });
});
