import { DurableObject } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';

import migrations from '../db/youtube-subscription/migrations/migrations.js';

export class YouTubeSubscription extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    const database = drizzle(this.ctx.storage);

    void this.ctx.blockConcurrencyWhile(() =>
      Promise.resolve(migrate(database, migrations)),
    );
  }
}
