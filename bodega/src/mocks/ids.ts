// Sequential ids keep mock output readable and stable across runs.
const counters = new Map<string, number>();

export function nextId(prefix: string): string {
  const n = (counters.get(prefix) ?? 0) + 1;
  counters.set(prefix, n);
  return `${prefix}_${n}`;
}

export const nowIso = () => new Date().toISOString();
