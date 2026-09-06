import { DurableObject } from 'cloudflare:workers';
import { createCoordinator } from './coordinator.js';
export { default } from './outer.js';

export class CoachRealProviderCoordinator extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.coordinator = createCoordinator(ctx.storage, env, {
        // Workers does not implement redirect:error. Manual returns the 3xx to
        // C1A's non-200 rejection/body-cancellation path without following it.
        fetch: (url, options) => fetch(url, { ...options, redirect: 'manual' }),
      });
      await ctx.storage.sync();
    });
  }

  async execute(input) {
    // Pending provider I/O is owned here. No lease is returned to the outer Worker.
    // RPC object results carry disposal metadata. A bounded flat JSON string keeps
    // that transport metadata out of the exact-key framing contract.
    return JSON.stringify(await this.coordinator.execute(input));
  }
}
