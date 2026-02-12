import { getConfig } from "../src/config.js";
import { createDb, runMigrations } from "../src/db/db.js";

const config = getConfig();
const db = createDb(config);
runMigrations(db);
console.log(`Migrations applied to ${config.DB_PATH}`);
db.close();
