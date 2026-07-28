// Vibe Kanban bridge: long-polls the vibe-kanban backend for editor
// commands (open file, close sidebar). Seeded by OpenVscodeService — do not
// edit in place, it is overwritten on every editor-server start.
const vscode = require('vscode');
const http = require('http');

function activate(context) {
  const base = process.env.VK_BRIDGE_BASE;
  if (!base) {
    return;
  }

  // The vibe-kanban shell owns the explorer; keep the workbench editor-only.
  vscode.commands.executeCommand('workbench.action.closeSidebar');

  let stopped = false;

  async function handleCommand(cmd) {
    if (!cmd || typeof cmd !== 'object') return;
    if (cmd.type === 'open_file' && typeof cmd.path === 'string') {
      try {
        const doc = await vscode.workspace.openTextDocument(
          vscode.Uri.file(cmd.path)
        );
        const editor = await vscode.window.showTextDocument(doc, {
          preview: false,
        });
        if (typeof cmd.line === 'number' && cmd.line > 0) {
          const pos = new vscode.Position(cmd.line - 1, 0);
          editor.selection = new vscode.Selection(pos, pos);
          editor.revealRange(
            new vscode.Range(pos, pos),
            vscode.TextEditorRevealType.InCenter
          );
        }
      } catch (e) {
        console.error('vibe-kanban-bridge: open_file failed', e);
      }
    } else if (cmd.type === 'close_sidebar') {
      vscode.commands.executeCommand('workbench.action.closeSidebar');
    }
  }

  function poll() {
    if (stopped) return;
    const req = http.get(
      base + '/api/editor-server/bridge/poll',
      { timeout: 45000 },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const body = JSON.parse(data);
            const cmds = (body && body.data) || [];
            for (const cmd of cmds) void handleCommand(cmd);
          } catch {
            // Non-JSON response (server restarting) — just poll again.
          }
          setTimeout(poll, 50);
        });
      }
    );
    req.on('error', () => setTimeout(poll, 2000));
    req.on('timeout', () => req.destroy());
  }

  poll();
  context.subscriptions.push({
    dispose: () => {
      stopped = true;
    },
  });
}

function deactivate() {}

module.exports = { activate, deactivate };
