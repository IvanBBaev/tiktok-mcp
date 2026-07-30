import * as vscode from "vscode";

/**
 * Registers the `tiktok-mcp-ai` MCP server with VS Code so it appears in
 * Copilot Chat (agent mode) the moment the extension is installed — no manual
 * `.vscode/mcp.json`. The server runs via `npx -y tiktok-mcp-ai`, so it always
 * resolves the published package; the TikTok app credentials are supplied
 * through the env file (`~/.config/tiktok-mcp-ai/.env`, with `TT_CLIENT_KEY`
 * and `TT_CLIENT_SECRET`), and a creator account is authorized at runtime via
 * `npx tiktok-mcp-ai login` (OAuth 2.0 + PKCE).
 */
export function activate(context: vscode.ExtensionContext): void {
  const didChange = new vscode.EventEmitter<void>();

  context.subscriptions.push(
    didChange,
    vscode.lm.registerMcpServerDefinitionProvider("tiktok-mcp-ai", {
      onDidChangeMcpServerDefinitions: didChange.event,
      provideMcpServerDefinitions: async () => [
        new vscode.McpStdioServerDefinition("TikTok", "npx", [
          "-y",
          "tiktok-mcp-ai",
        ]),
      ],
      resolveMcpServerDefinition: async (server) => server,
    }),
  );
}

export function deactivate(): void {
  // Registration is disposed via context.subscriptions; nothing else to clean up.
}
