import { describe, expect, it } from 'vitest';

import { parseYouTubeVideoNotifications } from '../../src/youtube/notification';

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
          <yt:channelId>channel-456</yt:channelId>
          <title>Sliroth &amp; Friends</title>
          <published>2026-08-06T12:34:56+00:00</published>
        </entry>
      </feed>
    `;

    expect(parseYouTubeVideoNotifications(xml)).toEqual([
      {
        videoId: 'video-123',
        channelId: 'channel-456',
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
          <yt:channelId>channel-1</yt:channelId>
          <title>First video</title>
          <published>2026-08-06T10:00:00+00:00</published>
        </entry>
        <entry>
          <yt:videoId>video-2</yt:videoId>
          <yt:channelId>channel-1</yt:channelId>
          <title>Second video</title>
          <published>2026-08-06T11:00:00+00:00</published>
        </entry>
      </feed>
    `;

    expect(parseYouTubeVideoNotifications(xml)).toEqual([
      {
        videoId: 'video-1',
        channelId: 'channel-1',
        title: 'First video',
        publishedAt: '2026-08-06T10:00:00+00:00',
      },
      {
        videoId: 'video-2',
        channelId: 'channel-1',
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
          <yt:channelId>channel-456</yt:channelId>
          <title>Missing video ID</title>
          <published>2026-08-06T12:34:56+00:00</published>
        </entry>
      </feed>
    `;

    expect(() => parseYouTubeVideoNotifications(xml)).toThrow(
      'YouTube notification entry requires a non-empty videoId',
    );
  });

  it('rejects XML without an Atom feed', () => {
    expect(() => parseYouTubeVideoNotifications('<notification />')).toThrow(
      'YouTube notification must contain an Atom feed',
    );
  });
});
