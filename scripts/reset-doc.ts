// Quick script to reset doc tabs and force re-creation
import { google } from "googleapis";
import { GoogleAuth } from "google-auth-library";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

const SA_PATH = process.env.GOOGLE_SERVICE_ACCOUNT_JSON!;
const DOC_ID = process.env.GOOGLE_DOC_ID!;

async function main() {
    const raw = fs.existsSync(SA_PATH) ? JSON.parse(fs.readFileSync(SA_PATH, "utf8")) : JSON.parse(SA_PATH);
    const auth = new google.auth.JWT(
        raw.client_email,
        undefined,
        raw.private_key,
        ["https://www.googleapis.com/auth/documents", "https://www.googleapis.com/auth/drive"]
    );

    const docs = google.docs({ version: "v1", auth });
    const doc = await docs.documents.get({ documentId: DOC_ID, includeTabsContent: true });

    const tabs = doc.data.tabs ?? [];
    console.log(`Found ${tabs.length} tabs:`);
    for (const tab of tabs) {
        console.log(`  - "${tab.tabProperties?.title}" (${tab.tabProperties?.tabId})`);
    }

    // Delete all tabs except the first one
    if (tabs.length > 1) {
        const deleteReqs = tabs.slice(1).map((tab) => ({
            deleteTab: { tabId: tab.tabProperties!.tabId! }
        }));
        await docs.documents.batchUpdate({
            documentId: DOC_ID,
            requestBody: { requests: deleteReqs as any }
        });
        console.log(`Deleted ${deleteReqs.length} tabs`);
    }

    // Rename first tab back to something generic so ensureTemplate re-triggers
    const firstTabId = tabs[0]?.tabProperties?.tabId;
    if (firstTabId) {
        await docs.documents.batchUpdate({
            documentId: DOC_ID,
            requestBody: {
                requests: [{
                    updateDocumentTabProperties: {
                        tabProperties: { tabId: firstTabId, title: "Tab 1" },
                        fields: "title"
                    }
                } as any]
            }
        });
        console.log("Renamed first tab to 'Tab 1'");
    }

    // Clear the first tab content
    const freshDoc = await docs.documents.get({ documentId: DOC_ID, includeTabsContent: true });
    const freshTabs = freshDoc.data.tabs ?? [];
    const mainBody = freshTabs[0]?.documentTab?.body?.content ?? [];
    const endIndex = mainBody.at(-1)?.endIndex ?? 1;
    if (endIndex > 2) {
        await docs.documents.batchUpdate({
            documentId: DOC_ID,
            requestBody: {
                requests: [{
                    deleteContentRange: {
                        range: { startIndex: 1, endIndex: endIndex - 1, tabId: firstTabId }
                    }
                }]
            }
        });
        console.log("Cleared first tab content");
    }

    console.log("✓ Doc reset. Restart the server to regenerate template.");
}

main().catch(console.error);
