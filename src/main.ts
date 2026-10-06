import { createApp } from "./index.js";
import { shutdownAnalytics } from "./analytics.js";

const PORT = parseInt(process.env.PORT || "3000", 10);
const app = createApp();
const httpServer = app.listen(PORT, "0.0.0.0", () => {
  console.log(`openmail mcp listening on :${PORT}`);
});

// posthog-node batches events; flush them before Railway stops the container.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    httpServer.close();
    void shutdownAnalytics().finally(() => process.exit(0));
  });
}
