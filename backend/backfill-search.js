// backend/backfill-search.js
require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") });
const { CosmosClient } = require("@azure/cosmos");
const { SearchClient, AzureKeyCredential } = require("@azure/search-documents");

async function main() {
  if (!process.env.COSMOS_DB_CONNECTION_STRING) {
    console.error("COSMOS_DB_CONNECTION_STRING not set");
    process.exit(1);
  }
  if (!process.env.AI_SEARCH_ENDPOINT || !process.env.AI_SEARCH_ADMIN_KEY) {
    console.error("AI_SEARCH_ENDPOINT or AI_SEARCH_ADMIN_KEY not set");
    process.exit(1);
  }

  const cosmos = new CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING);
  const dbId = process.env.COSMOS_DB_DATABASE || "yumi";
  const containerId = "sessions";
  const container = cosmos.database(dbId).container(containerId);

  const searchClient = new SearchClient(process.env.AI_SEARCH_ENDPOINT, "tasks-index", new AzureKeyCredential(process.env.AI_SEARCH_ADMIN_KEY));

  console.log("Querying Cosmos for sessions...");
  const { resources } = await container.items.query({ query: "SELECT * FROM c" }).fetchAll();

  if (!resources || resources.length === 0) {
    console.log("No sessions found.");
    return;
  }

  const docs = resources.map((s) => ({
    id: String(s.id),
    userId: String(s.userId || ""),
    task: String(s.task || s.label || "").slice(0, 400),
    label: String(s.label || s.task || "").slice(0, 400),
    timestamp: new Date(s.ts || Date.now()).toISOString(),
    ts: new Date(s.ts || Date.now()).toISOString(),
    url: String(s.url || "")
  }));

  console.log(`Uploading ${docs.length} documents to Azure AI Search in batches...`);
  const batchSize = 100;
  let attempted = 0;
  let indexed = 0;

  for (let i = 0; i < docs.length; i += batchSize) {
    const batch = docs.slice(i, i + batchSize);
    attempted += batch.length;
    try {
      const result = await searchClient.uploadDocuments(batch);
      const succeeded = Array.isArray(result?.results)
        ? result.results.filter((r) => r?.succeeded).length
        : batch.length;
      indexed += succeeded;
      console.log(`Batch ${Math.floor(i / batchSize) + 1}: ${succeeded}/${batch.length}`);
    } catch (err) {
      console.warn(`Batch ${Math.floor(i / batchSize) + 1} failed:`, err.message || err);
    }
  }

  console.log(`Done. Attempted: ${attempted}, Indexed: ${indexed}`);
}

main().catch((e) => {
  console.error("Backfill script failed:", e);
  process.exit(1);
});