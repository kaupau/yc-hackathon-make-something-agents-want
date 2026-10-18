import { createHash } from 'node:crypto';
/** One mailbox namespace per trusted customer wallet, shared by its trials and purchases. */
export function primitiveInboxFor(owner: string, configuredInbox?: string): string | undefined {
  if (!configuredInbox) return undefined;
  const domain = configuredInbox.split('@')[1]?.toLowerCase();
  if (!domain || !/^[a-z0-9-]+\.primitive\.email$/.test(domain)) throw new Error('A managed Primitive inbox is required');
  return `bodega-${createHash('sha256').update(owner).digest('hex').slice(0,24)}@${domain}`;
}
