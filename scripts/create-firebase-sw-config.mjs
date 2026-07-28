import { readFile, writeFile } from "node:fs/promises";

const source = await readFile(new URL("../public/firebase-config.js", import.meta.url), "utf8");
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const { firebaseConfig } = await import(moduleUrl);

if (!firebaseConfig?.projectId || !firebaseConfig?.messagingSenderId || !firebaseConfig?.appId) {
  throw new Error("Firebase Messaging에 필요한 웹 설정값이 없습니다.");
}

await writeFile(
  new URL("../public/firebase-sw-config.js", import.meta.url),
  `self.FIREBASE_CONFIG = ${JSON.stringify(firebaseConfig)};\n`,
  "utf8",
);
