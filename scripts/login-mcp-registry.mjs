import { spawnSync } from "node:child_process";
import { createPrivateKey } from "node:crypto";
import { join } from "node:path";

const secret = process.env.MCP_PRIVATE_KEY?.trim();
if (!secret) {
  console.error("Set the MCP_PRIVATE_KEY repository or mcp-registry environment secret.");
  process.exit(1);
}

let hexKey = secret;
if (!/^[0-9a-f]{64}$/i.test(secret)) {
  try {
    const key = createPrivateKey({ key: secret, format: "pem", passphrase: "" });
    if (key.asymmetricKeyType !== "ed25519") throw new Error();
    hexKey = Buffer.from(key.export({ format: "jwk" }).d, "base64url").toString("hex");
  } catch {
    console.error("MCP_PRIVATE_KEY must be a 64-character hex Ed25519 seed or its unencrypted private PEM.");
    process.exit(1);
  }
}

const login = spawnSync(join(process.env.RUNNER_TEMP, "mcp-publisher"), ["login", "dns", "--domain", "openmail.sh"], {
  env: { ...process.env, MCP_PRIVATE_KEY: hexKey },
  stdio: "inherit",
});
if (login.error) console.error("Unable to start mcp-publisher.");
process.exitCode = login.status ?? 1;
