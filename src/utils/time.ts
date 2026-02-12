export function nowIso(): string {
  return new Date().toISOString();
}

export function startOfUtcDay(date = new Date()): string {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())).toISOString();
}
