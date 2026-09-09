import { createRedactor, collectKnownSecrets } from "@celestea/core";
import { readFileSync } from "node:fs";
const prov = JSON.parse(readFileSync("/src/celestea_studio/providers.json", "utf8")) as unknown;
const npmrc = readFileSync((process.env["HOME"] ?? "") + "/.npmrc", "utf8");
const r = createRedactor(collectKnownSecrets({ providersJson: prov, npmrc, env: process.env }));
const res = await fetch("http://127.0.0.1:3777/api/sessions/" + encodeURIComponent("server-center/center-架构师-1788940601.93642104") + "/messages");
const j = (await res.json()) as { messages: unknown[] };
const text = JSON.stringify({ messages: j.messages }, null, 2) + "\n";
const out = r.redact(text);
try {
  JSON.parse(out);
  console.log("parse OK");
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  console.log("ERR", msg);
  const m = /position (\d+)/.exec(msg);
  if (m?.[1]) {
    const p = Number(m[1]);
    console.log("CTX:", JSON.stringify(out.slice(Math.max(0, p - 200), p + 100)));
  }
}
