// TEST-ONLY composition. This file is not a deployed entry point or RPC.
export const bootstrapSource = `
import worker, { CoachRealProviderCoordinator as ProductionCoordinator } from './prelive/worker.js';
import { provisionCoordinator, INITIAL_PROVISIONING } from './prelive/provision.js';
export default worker;
export class CoachRealProviderCoordinator extends ProductionCoordinator {
  constructor(ctx, env) {
    if (!ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1").toArray().length)
      provisionCoordinator(ctx.storage, INITIAL_PROVISIONING);
    super(ctx, env);
  }
}`;
