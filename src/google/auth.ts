import fs from "fs";
import path from "path";
import { google } from "googleapis";
import type { JWT } from "google-auth-library";
import type { AppConfig } from "../config.js";

const SCOPES = [
    "https://www.googleapis.com/auth/documents",
    "https://www.googleapis.com/auth/drive"
];

/**
 * Loads a Google Service Account JWT client from either:
 *  1. A JSON file path (GOOGLE_SERVICE_ACCOUNT_JSON pointing to a .json file)
 *  2. Inline JSON string (GOOGLE_SERVICE_ACCOUNT_JSON containing raw JSON)
 *
 * Returns null if no credentials are configured.
 */
export async function getGoogleAuth(config: AppConfig): Promise<JWT | null> {
    const jsonSource = config.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!jsonSource) {
        return null;
    }

    let credentials: { client_email: string; private_key: string; project_id?: string };

    // Determine if jsonSource is a file path or inline JSON
    if (jsonSource.trim().startsWith("{")) {
        credentials = JSON.parse(jsonSource);
    } else {
        const resolved = path.resolve(jsonSource);
        if (!fs.existsSync(resolved)) {
            throw new Error(`Service account JSON not found at: ${resolved}`);
        }
        credentials = JSON.parse(fs.readFileSync(resolved, "utf8"));
    }

    if (!credentials.client_email || !credentials.private_key) {
        throw new Error("Service account JSON missing client_email or private_key");
    }

    const auth = new google.auth.JWT({
        email: credentials.client_email,
        key: credentials.private_key,
        scopes: SCOPES
    });

    // Validate credentials by requesting a token
    await auth.authorize();

    console.log(`✓ Google Service Account: ${credentials.client_email}`);
    return auth;
}

export function ensureSecretDirs(_config: AppConfig): void {
    // No secret dirs needed for service account flow.
    // Kept for backward compatibility with main.ts.
}
