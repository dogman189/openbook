import fs from "fs";

const pre = fs.readFileSync("preload.js", "utf8");
if (!pre.includes("http://127.0.0.1:5678")) throw new Error("backendUrl 5678 missing");
if (!pre.includes("SETUP")) throw new Error("preload missing SETUP bridge");
const main = fs.readFileSync("main.js", "utf8");
for (const ch of ["openbook:deps-status", "openbook:install-deps", "openbook:start-backend"]) {
  if (!main.includes(ch)) throw new Error(`setup channel ${ch} missing in main.js`);
}
if (!main.includes("setupMode")) throw new Error("main missing setupMode gate");
if (!main.includes("bundledUv")) throw new Error("main missing bundledUv resolver");
if (!main.includes("vc_redist")) throw new Error("in-app installer missing VC++ redistributable fallback");
if (!main.includes("'pip', 'install', '--python'")) throw new Error("in-app installer missing uv pip branch");
if (!main.includes("/api/config")) throw new Error("readiness probe missing");
if (!main.includes("process.resourcesPath")) throw new Error("packaged exe lookup missing");

console.log("check: PASS — backend URL wiring OK");

// --- Task 4: monet-shell study frontend asserts ---
const html = fs.readFileSync("index.html", "utf8");
for (const id of ["notebooks", "sources-slot", "center-slot", "studio-slot", "status-pill", "theme-toggle", "banner-slot", "model-picker"]) {
  if (!html.includes(`id="${id}"`)) throw new Error(`slot #${id} missing in index.html`);
}
if (!html.includes('id="boot"')) throw new Error("boot overlay missing in index.html");
if (!html.includes('id="setup"')) throw new Error("setup overlay missing in index.html");
if (!html.includes('id="setup-install"')) throw new Error("setup install button missing in index.html");
if (!html.includes('id="engine-slot"')) throw new Error("engine slot missing in index.html");
if (!html.includes("http://127.0.0.1:5678")) throw new Error("CSP/backend URL 5678 missing in index.html");
if (!html.includes("renderer.js")) throw new Error("classic renderer.js script missing in index.html");
if (/type\s*=\s*["']module["']/.test(html)) throw new Error("type=module forbidden (file:// CORS)");

const css = fs.readFileSync("app.css", "utf8");
if (!css.includes("--cyan")) throw new Error("app.css missing --cyan token");
if (!css.includes(".panel")) throw new Error("app.css missing .panel");

const mac = fs.readFileSync("macos.css", "utf8");
if (!mac.includes("is-mac")) throw new Error("macos.css missing is-mac offsets");

const rend = fs.readFileSync("renderer.js", "utf8");
if (!rend.includes("APP_CONFIG")) throw new Error("renderer missing APP_CONFIG");
if (!rend.includes("/api/notebooks")) throw new Error("renderer missing /api/notebooks");
if (!rend.includes("EventSource")) throw new Error("renderer missing EventSource log stream");
if (!rend.includes("/api/logs")) throw new Error("renderer missing /api/logs");
if (!rend.includes("line.message")) throw new Error("renderer appendLog missing object-payload support");
if (!rend.includes("window.SETUP")) throw new Error("renderer missing window.SETUP setup flow");
if (!rend.includes("renderSetup")) throw new Error("renderer missing renderSetup");
if (!rend.includes("renderEngine")) throw new Error("renderer missing renderEngine");
if (!rend.includes("/api/engine")) throw new Error("renderer missing /api/engine");
if (!rend.includes("Custom…")) throw new Error("renderer missing custom OpenRouter model option");
if (!rend.includes("__test_hook")) throw new Error("renderer missing OB.__test_hook");
if (rend.includes("localhost:8000")) throw new Error("renderer still points at localhost:8000");
if (/price-chart|getCurrency|currency\.js|nav\.js/.test(html + rend))
  throw new Error("trading code leaked into study frontend");

console.log("check: PASS — monet-shell study frontend OK");
