/**
 * Structured JSON logging for Workers Observability / `wrangler tail`.
 * Never pass secrets, payment payloads/signatures, or page contents to these helpers.
 */
export type LogFields = Record<string, string | number | boolean | null | undefined>;

export function logEvent(event: string, fields: LogFields = {}): void {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...fields }));
}

export function logError(event: string, fields: LogFields = {}): void {
  console.error(JSON.stringify({ event, ts: new Date().toISOString(), ...fields }));
}

/**
 * Short, non-reversible identifier for a payer wallet so repeat usage and unique
 * paying clients can be counted without logging raw addresses next to request URLs.
 */
export async function payerId(address: string | undefined): Promise<string | undefined> {
  if (!address) return undefined;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`agentread:${address.toLowerCase()}`));
  return Array.from(new Uint8Array(digest).slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}
