import fs from "fs";
import path from "path";
import { getConfig } from "../src/config.js";
import { createDb, runMigrations } from "../src/db/db.js";
import { Repo } from "../src/db/repo.js";

async function main(): Promise<void> {
  const config = getConfig();
  const docId = process.argv[2] ?? config.GOOGLE_DOC_ID ?? "local-doc";

  const db = createDb(config);
  runMigrations(db);
  const repo = new Repo(db);

  const commands = repo.listCommands(docId).map((command) => ({
    ...command,
    trace: repo.getTrace(docId, command.cmdId),
    spend: repo.listSpendLedger(docId, command.cmdId)
  }));

  const output = {
    generatedAt: new Date().toISOString(),
    docId,
    commandCount: commands.length,
    commands
  };

  fs.mkdirSync("./data", { recursive: true });
  const filename = path.join("./data", `evidence-${docId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
  fs.writeFileSync(filename, `${JSON.stringify(output, null, 2)}\n`, "utf8");

  console.log(`Wrote ${filename}`);
  db.close();
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
