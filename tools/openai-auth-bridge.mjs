
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";

// --- IMPORTS DESDE ENGINE ---
// Asumimos que Node puede encontrar hono y @openauthjs/openauth si el path está bien
// Pero para ser seguros, usaremos import dinámico o path absoluto si es necesario.
// En este caso, usaremos los paquetes instalados en engine/node_modules.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const USB_ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(USB_ROOT, "data");
const AUTH_FILE = path.join(DATA_DIR, "plus_auth.json");
const READY_FILE = path.join(DATA_DIR, "bridge_ready.tmp");

if (fs.existsSync(READY_FILE)) fs.unlinkSync(READY_FILE);
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

// --- CONFIGURACIÓN OPENAI CODEX ---
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const CODEX_BASE_URL = "https://chatgpt.com/backend-api";

// --- LOGGING ---
const LOG_FILE = path.join(DATA_DIR, "plus_bridge.log");
function log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    try { fs.appendFileSync(LOG_FILE, line); } catch {}
}

// --- PKCE HELPER ---
function generatePKCE() {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
}

// --- BROWSER OPENER ---
function openBrowser(url) {
    const opener = process.platform === "win32" ? "start" : (process.platform === "darwin" ? "open" : "xdg-open");
    spawn(opener, [url], { shell: process.platform === "win32", stdio: "ignore" }).on("error", () => {});
}

// --- TOKEN MANAGEMENT ---
let currentTokens = null;
if (fs.existsSync(AUTH_FILE)) {
    try { currentTokens = JSON.parse(fs.readFileSync(AUTH_FILE, "utf-8")); } catch {}
}

async function refreshTokens() {
    if (!currentTokens || !currentTokens.refresh) return null;
    log("Refreshing tokens...");
    const res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: CLIENT_ID,
            refresh_token: currentTokens.refresh
        })
    });
    if (!res.ok) {
        log(`Token refresh failed: ${res.status}`);
        return null;
    }
    const json = await res.json();
    currentTokens = {
        access: json.access_token,
        refresh: json.refresh_token,
        expires: Date.now() + (json.expires_in * 1000)
    };
    fs.writeFileSync(AUTH_FILE, JSON.stringify(currentTokens), "utf-8");
    log("Tokens refreshed and saved.");
    return currentTokens.access;
}

async function getValidToken() {
    if (!currentTokens) return null;
    if (Date.now() > currentTokens.expires - 60000) {
        return await refreshTokens();
    }
    return currentTokens.access;
}

// --- OAUTH FLOW ---
async function startLoginFlow() {
    const pkce = generatePKCE();
    const state = randomBytes(16).toString("hex");
    
    // URL EXACTA DE CODEX CLI (Con audience y parámetros de flujo simplificado)
    const authUrl = `${AUTHORIZE_URL}?client_id=${CLIENT_ID}&audience=https%3A%2F%2Fapi.openai.com%2Fv1&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=openid%20profile%20email%20offline_access&response_type=code&state=${state}&code_challenge=${pkce.challenge}&code_challenge_method=S256&id_token_add_organizations=true&codex_cli_simplified_flow=true&originator=codex_cli_rs`;

    return new Promise((resolve) => {
        const successHtml = fs.readFileSync(path.join(__dirname, "plus-auth-bridge", "oauth-success.html"), "utf-8");
        const server = http.createServer(async (req, res) => {
            const url = new URL(req.url, "http://localhost");
            if (url.pathname === "/auth/callback") {
                const code = url.searchParams.get("code");
                if (url.searchParams.get("state") !== state) {
                    log("State mismatch error.");
                    res.end("State mismatch error.");
                    return;
                }
                
                res.setHeader("Content-Type", "text/html");
                res.end(successHtml);
                
                log("Code received, exchanging for tokens...");
                try {
                    const tokenRes = await fetch(TOKEN_URL, {
                        method: "POST",
                        headers: { "Content-Type": "application/x-www-form-urlencoded" },
                        body: new URLSearchParams({
                            grant_type: "authorization_code",
                            client_id: CLIENT_ID,
                            code,
                            code_verifier: pkce.verifier,
                            redirect_uri: REDIRECT_URI
                        })
                    });
                    
                    if (tokenRes.ok) {
                        const json = await tokenRes.json();
                        currentTokens = {
                            access: json.access_token,
                            refresh: json.refresh_token,
                            expires: Date.now() + (json.expires_in * 1000)
                        };
                        fs.writeFileSync(AUTH_FILE, JSON.stringify(currentTokens), "utf-8");
                        log("Login successful, tokens saved.");
                        console.log("\n  \x1b[32m[OK]\x1b[0m Login successful!");
                        console.log("  You can close this window now.\n");
                        resolve(currentTokens.access);
                        // No cerramos el servidor inmediatamente para permitir que el bridge siga funcionando como proxy
                        fs.writeFileSync(READY_FILE, "READY", "utf-8");
                    } else {
                        log(`Token exchange failed: ${tokenRes.status}`);
                        console.log(`\n  \x1b[31m[ERROR]\x1b[0m Token exchange failed: ${tokenRes.status}`);
                        resolve(null);
                    }
                } catch (err) {
                    log(`Token exchange error: ${err.message}`);
                    resolve(null);
                }
            }
        });

        server.listen(1455, "127.0.0.1", () => {
            log("Auth callback server listening on 127.0.0.1:1455");
            console.log("\n  \x1b[33m[!]\x1b[0m \x1b[1mOpenAI Plus Auth Required\x1b[0m");
            console.log("  --------------------------------------------------");
            console.log("  Opening browser for login...");
            console.log("  If it doesn't open, copy and paste this URL:");
            console.log(`  \x1b[36m${authUrl}\x1b[0m`);
            console.log("  --------------------------------------------------\n");
            openBrowser(authUrl);
        });
    });
}

// --- PROXY SERVER ---
const server = http.createServer(async (req, res) => {
    if (req.url === "/v1/chat/completions" && req.method === "POST") {
        let body = [];
        req.on("data", chunk => body.push(chunk));
        req.on("end", async () => {
            const rawBody = Buffer.concat(body).toString();
            const json = JSON.parse(rawBody);
            
            const token = await getValidToken();
            if (!token) {
                res.writeHead(401);
                res.end(JSON.stringify({ error: "Auth required. Please login in the bridge window." }));
                return;
            }

            // Simplificación: Enviar a ChatGPT backend
            log(`Proxying request for model: ${json.model}`);

            const chatgptBody = {
                action: "next",
                messages: json.messages.map(m => ({
                    id: randomBytes(16).toString("hex"),
                    author: { role: m.role === "assistant" ? "assistant" : "user" },
                    content: { content_type: "text", parts: [typeof m.content === "string" ? m.content : ""] },
                    metadata: {}
                })),
                parent_message_id: randomBytes(16).toString("hex"),
                model: "gpt-4o",
                timezone_offset_min: -60,
                history_and_training_disabled: false,
                arkose_token: null
            };

            try {
                const response = await fetch(`${CODEX_BASE_URL}/conversation`, {
                    method: "POST",
                    headers: {
                        "Authorization": `Bearer ${token}`,
                        "Content-Type": "application/json",
                        "Accept": "text/event-stream",
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
                    },
                    body: JSON.stringify(chatgptBody)
                });

                if (!response.ok) {
                    log(`ChatGPT API error: ${response.status}`);
                    res.writeHead(response.status);
                    res.end(await response.text());
                    return;
                }

                // Stream back to OpenClaude
                res.writeHead(200, { "Content-Type": "text/event-stream" });
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    const chunk = decoder.decode(value);
                    
                    const lines = chunk.split("\n");
                    for (let line of lines) {
                        if (line.startsWith("data: ") && !line.includes("[DONE]")) {
                            try {
                                const data = JSON.parse(line.slice(6));
                                if (data.message && data.message.content && data.message.content.parts) {
                                    const text = data.message.content.parts[0];
                                    const openaiChunk = {
                                        choices: [{ delta: { content: text }, index: 0, finish_reason: null }]
                                    };
                                    res.write(`data: ${JSON.stringify(openaiChunk)}\n\n`);
                                }
                            } catch {}
                        }
                    }
                }
                res.write("data: [DONE]\n\n");
                res.end();
            } catch (err) {
                log(`Fetch error: ${err.message}`);
                res.writeHead(500);
                res.end(JSON.stringify({ error: err.message }));
            }
        });
    } else {
        res.writeHead(404);
        res.end();
    }
});

async function main() {
    log("Bridge starting...");
    const PORT = 11436;
    
    if (await getValidToken()) {
        server.listen(PORT, "127.0.0.1", () => {
            log(`Plus Bridge active on http://127.0.0.1:${PORT}`);
            fs.writeFileSync(READY_FILE, "READY", "utf-8");
            console.log(`  \x1b[32m[OK]\x1b[0m Plus Bridge active on port ${PORT}`);
        });
    } else {
        // Si no hay token, el flujo de login iniciará el servidor en 1455 y luego levantaremos el proxy en PORT
        await startLoginFlow();
        server.listen(PORT, "127.0.0.1", () => {
            log(`Plus Bridge active on http://127.0.0.1:${PORT}`);
            fs.writeFileSync(READY_FILE, "READY", "utf-8");
        });
    }
}

main();
