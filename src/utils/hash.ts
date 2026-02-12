import { createHash } from "crypto";

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function shortId(prefix: string, input: string): string {
  return `${prefix}_${sha256Hex(input).slice(0, 16)}`;
}
