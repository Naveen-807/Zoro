import fs from "fs";
import path from "path";
import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import type { AppConfig } from "../config.js";

const SCOPES = [
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/drive.readonly"
];

type InstalledCreds = {
  installed?: {
    client_id: string;
    client_secret: string;
    redirect_uris: string[];
  };
  web?: {
    client_id: string;
    client_secret: string;
    redirect_uris: string[];
  };
};

export async function getGoogleClient(config: AppConfig): Promise<OAuth2Client | null> {
  const oauthClientPath = config.GOOGLE_OAUTH_CLIENT_JSON;
  const tokenPath = config.GOOGLE_TOKEN_JSON;

  if (!config.GOOGLE_DOC_ID) {
    return null;
  }

  if (!oauthClientPath || !fs.existsSync(oauthClientPath)) {
    return null;
  }

  const raw = fs.readFileSync(oauthClientPath, "utf8");
  const credentials = JSON.parse(raw) as InstalledCreds;
  const seeded = credentials.installed ?? credentials.web;
  if (!seeded) {
    return null;
  }

  const redirectUri = seeded.redirect_uris[0] ?? "urn:ietf:wg:oauth:2.0:oob";
  const client = new google.auth.OAuth2(seeded.client_id, seeded.client_secret, redirectUri);

  if (tokenPath && fs.existsSync(tokenPath)) {
    const token = JSON.parse(fs.readFileSync(tokenPath, "utf8")) as Record<string, unknown>;
    client.setCredentials(token);
    return client;
  }

  throw new Error(
    `Missing Google token file at ${tokenPath ?? "<unset GOOGLE_TOKEN_JSON>"}. Run OAuth flow and write token JSON there.`
  );
}

export function ensureSecretDirs(config: AppConfig): void {
  if (config.GOOGLE_OAUTH_CLIENT_JSON) {
    fs.mkdirSync(path.dirname(config.GOOGLE_OAUTH_CLIENT_JSON), { recursive: true });
  }
  if (config.GOOGLE_TOKEN_JSON) {
    fs.mkdirSync(path.dirname(config.GOOGLE_TOKEN_JSON), { recursive: true });
  }
}

export function getGoogleAuthUrl(config: AppConfig): string | null {
  const oauthClientPath = config.GOOGLE_OAUTH_CLIENT_JSON;
  if (!oauthClientPath || !fs.existsSync(oauthClientPath)) {
    return null;
  }

  const raw = fs.readFileSync(oauthClientPath, "utf8");
  const credentials = JSON.parse(raw) as InstalledCreds;
  const seeded = credentials.installed ?? credentials.web;
  if (!seeded) {
    return null;
  }

  const redirectUri = seeded.redirect_uris[0] ?? "urn:ietf:wg:oauth:2.0:oob";
  const client = new google.auth.OAuth2(seeded.client_id, seeded.client_secret, redirectUri);
  return client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent"
  });
}
