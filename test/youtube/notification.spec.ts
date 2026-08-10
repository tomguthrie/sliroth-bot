import { describe, expect, it } from 'vitest';

import { parseYouTubeVideoNotifications } from '../../src/youtube/notification';

const CHANNEL_ID = 'UC_x5XG1OV2P6uZZ5FSM9Ttw';

describe('parseYouTubeVideoNotifications', () => {
  it('parses a YouTube Atom feed entry', () => {
    const xml = `
      <?xml version="1.0" encoding="UTF-8"?>
      <feed
        xmlns="http://www.w3.org/2005/Atom"
        xmlns:yt="http://www.youtube.com/xml/schemas/2015"
      >
        <entry>
          <yt:videoId>video-123</yt:videoId>
          <yt:channelId>${CHANNEL_ID}</yt:channelId>
          <title>Sliroth &amp; Friends</title>
          <published>2026-08-06T12:34:56+00:00</published>
        </entry>
      </feed>
    `;

    expect(parseYouTubeVideoNotifications(xml)).toEqual([
      {
        videoId: 'video-123',
        channelId: CHANNEL_ID,
        title: 'Sliroth & Friends',
        publishedAt: '2026-08-06T12:34:56+00:00',
      },
    ]);
  });

  it('parses multiple entries', () => {
    const xml = `
      <feed xmlns:yt="http://www.youtube.com/xml/schemas/2015">
        <entry>
          <yt:videoId>video-1</yt:videoId>
          <yt:channelId>${CHANNEL_ID}</yt:channelId>
          <title>First video</title>
          <published>2026-08-06T10:00:00+00:00</published>
        </entry>
        <entry>
          <yt:videoId>video-2</yt:videoId>
          <yt:channelId>${CHANNEL_ID}</yt:channelId>
          <title>Second video</title>
          <published>2026-08-06T11:00:00+00:00</published>
        </entry>
      </feed>
    `;

    expect(parseYouTubeVideoNotifications(xml)).toEqual([
      {
        videoId: 'video-1',
        channelId: CHANNEL_ID,
        title: 'First video',
        publishedAt: '2026-08-06T10:00:00+00:00',
      },
      {
        videoId: 'video-2',
        channelId: CHANNEL_ID,
        title: 'Second video',
        publishedAt: '2026-08-06T11:00:00+00:00',
      },
    ]);
  });

  it('returns no notifications for a feed without entries', () => {
    const xml = `
      <feed xmlns="http://www.w3.org/2005/Atom">
        <title>YouTube video feed</title>
        <updated>2026-08-06T12:34:56+00:00</updated>
      </feed>
    `;

    expect(parseYouTubeVideoNotifications(xml)).toEqual([]);
  });

  it('rejects feeds with missing required entry fields', () => {
    const xml = `
      <feed xmlns:yt="http://www.youtube.com/xml/schemas/2015">
        <entry>
          <yt:channelId>${CHANNEL_ID}</yt:channelId>
          <title>Missing video ID</title>
          <published>2026-08-06T12:34:56+00:00</published>
        </entry>
      </feed>
    `;

    expect(() => parseYouTubeVideoNotifications(xml)).toThrow();
  });

  it('rejects XML without an Atom feed', () => {
    expect(() => parseYouTubeVideoNotifications('<notification />')).toThrow(
      'YouTube notification must contain an Atom feed',
    );
  });
});
