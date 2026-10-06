import type { Pool } from 'pg';
import { AgentsRepository } from '../agents/agents.repository';
import { AgentRegistrySync } from '../agents/agent-registry-sync';
import { EditorChannelsRepository } from '../repo/editor-channels.repository';

/**
 * Test helper for the pg suites of spec 031: give the test's own cards their
 * orchestrators right away (a sync scoped to those cards), so a global
 * registry sync running in a parallel suite finds nothing to create for them.
 */
export async function syncAgentsFor(pool: Pool, keys: string[]): Promise<void> {
  const channels = new EditorChannelsRepository(pool);
  const cards = (await Promise.all(keys.map((k) => channels.get(k)))).filter((c): c is NonNullable<typeof c> => !!c);
  try {
    await new AgentRegistrySync({ agents: new AgentsRepository(pool), channels: { list: async () => cards } }).run();
  } catch { /* a parallel global sync created them first */ }
}
