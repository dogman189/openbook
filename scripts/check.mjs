import fs from "fs";

const pre = fs.readFileSync("preload.js", "utf8");
if (!pre.includes("http://127.0.0.1:5678")) throw new Error("backendUrl 5678 missing");
const main = fs.readFileSync("main.js", "utf8");
if (!main.includes("/api/config")) throw new Error("readiness probe missing");
if (!main.includes("process.resourcesPath")) throw new Error("packaged exe lookup missing");

console.log("check: PASS — backend URL wiring OK");
