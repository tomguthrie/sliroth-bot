import { describe, expect, it } from 'vitest';

import {
  createYouTubeWebSubRequest,
  YOUTUBE_WEBSUB_HUB_URL,
} from '../../src/youtube/websub';

describe('createYouTubeWebSubRequest', () => {
  it('creates a form-encoded YouTube subscription requset', async () => {
    const request = createYouTubeWebSubRequest({
      mode: 'subscribe',
      channelId: 'UC_TEST_CHANNEL_ID',
      publicBaseUrl: 'https://bot.example.com',
      callbackToken: 'test-callback-token',
      secret: 'test-websub-secret',
    });

    expect(request.url).toBe(YOUTUBE_WEBSUB_HUB_URL);
    expect(request.method).toBe('POST');
    expect(request.headers.get('content-type')).toBe(
      'application/x-www-form-urlencoded;charset=UTF-8',
    );

    const body = await request.formData();

    expect(Object.fromEntries(body)).toEqual({
      'hub.mode': 'subscribe',
      'hub.topic':
        'https://www.youtube.com/feeds/videos.xml?channel_id=UC_TEST_CHANNEL_ID',
      'hub.callback':
        'https://bot.example.com/youtube/websub/test-callback-token',
      'hub.secret': 'test-websub-secret',
    });
  });
});
