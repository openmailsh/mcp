import { createApp } from "./index.js";

const PORT = parseInt(process.env.PORT || "3000", 10);
const app = createApp();
app.listen(PORT, "0.0.0.0", () => {
  console.log(`openmail mcp listening on :${PORT}`);
});
