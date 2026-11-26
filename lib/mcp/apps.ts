import {
  EXTENSION_ID as MCP_APPS_EXTENSION_ID,
  RESOURCE_MIME_TYPE,
  registerAppResource,
} from '@modelcontextprotocol/ext-apps/server';
import type { McpServer } from '@modelcontextprotocol/server';

export { MCP_APPS_EXTENSION_ID, RESOURCE_MIME_TYPE };

export const REVIEW_INSPECTOR_URI = 'ui://jean-ci/review-inspector.html';

/**
 * Self-contained MCP Apps (io.modelcontextprotocol/ui) HTML view for inspecting
 * PR reviews and individual check runs inline inside MCP hosts (Claude Desktop,
 * VS Code Copilot, Goose, MCPJam, etc.).
 *
 * Implements the MCP Apps postMessage JSON-RPC dialect directly with zero
 * external network dependencies so it works under strict sandbox CSP.
 */
export function buildReviewInspectorHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Jean CI PR Review Inspector</title>
<style>
  :root {
    --bg: #0f172a;
    --card: #1e293b;
    --card-2: #0b1220;
    --border: #334155;
    --text: #f1f5f9;
    --muted: #94a3b8;
    --accent: #38bdf8;
    --green: #22c55e;
    --red: #ef4444;
    --amber: #f59e0b;
    --purple: #a855f7;
    --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    --sans: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  @media (prefers-color-scheme: light) {
    :root:not([data-theme="dark"]) {
      --bg: #f8fafc;
      --card: #ffffff;
      --card-2: #f1f5f9;
      --border: #cbd5e1;
      --text: #0f172a;
      --muted: #475569;
      --accent: #0284c7;
      --green: #16a34a;
      --red: #dc2626;
      --amber: #d97706;
      --purple: #7e22ce;
    }
  }
  :root[data-theme="light"] {
    --bg: #f8fafc;
    --card: #ffffff;
    --card-2: #f1f5f9;
    --border: #cbd5e1;
    --text: #0f172a;
    --muted: #475569;
    --accent: #0284c7;
    --green: #16a34a;
    --red: #dc2626;
    --amber: #d97706;
    --purple: #7e22ce;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 12px;
    font-family: var(--sans);
    background: var(--bg);
    color: var(--text);
    line-height: 1.5;
    font-size: 14px;
  }
  .shell {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
  }
  .header {
    padding: 14px 16px;
    border-bottom: 1px solid var(--border);
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }
  .title-block h1 {
    margin: 0;
    font-size: 16px;
    font-weight: 700;
  }
  .meta {
    margin-top: 4px;
    font-size: 12px;
    color: var(--muted);
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .mono { font-family: var(--mono); }
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 9px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 600;
    border: 1px solid transparent;
  }
  .badge-pass { background: color-mix(in srgb, var(--green) 16%, transparent); color: var(--green); border-color: color-mix(in srgb, var(--green) 35%, transparent); }
  .badge-fail { background: color-mix(in srgb, var(--red) 16%, transparent); color: var(--red); border-color: color-mix(in srgb, var(--red) 35%, transparent); }
  .badge-running { background: color-mix(in srgb, var(--purple) 16%, transparent); color: var(--purple); border-color: color-mix(in srgb, var(--purple) 35%, transparent); }
  .badge-warn { background: color-mix(in srgb, var(--amber) 16%, transparent); color: var(--amber); border-color: color-mix(in srgb, var(--amber) 35%, transparent); }
  .badge-neutral { background: color-mix(in srgb, var(--muted) 16%, transparent); color: var(--muted); border-color: color-mix(in srgb, var(--muted) 35%, transparent); }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  button {
    cursor: pointer;
    font-family: inherit;
    font-size: 12px;
    font-weight: 600;
    padding: 6px 11px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--card-2);
    color: var(--text);
  }
  button:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
  button.primary { background: var(--accent); border-color: var(--accent); color: #082f49; }
  button.primary:hover:not(:disabled) { filter: brightness(1.08); color: #082f49; }
  button:disabled { opacity: 0.55; cursor: not-allowed; }
  .banner {
    margin: 12px 16px 0;
    padding: 10px 12px;
    border-radius: 8px;
    font-size: 13px;
    border: 1px solid var(--amber);
    background: color-mix(in srgb, var(--amber) 12%, transparent);
  }
  .banner.info {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 12%, transparent);
  }
  .tabs {
    display: flex;
    gap: 4px;
    padding: 10px 16px 0;
    border-bottom: 1px solid var(--border);
  }
  .tab {
    border: none;
    border-bottom: 2px solid transparent;
    border-radius: 0;
    background: transparent;
    padding: 7px 12px;
    color: var(--muted);
  }
  .tab.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
  }
  .body { padding: 14px 16px; }
  .check-list {
    display: grid;
    gap: 8px;
  }
  .check-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 10px 12px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--card-2);
  }
  .check-row:hover { border-color: var(--accent); }
  pre {
    margin: 0;
    padding: 12px;
    border-radius: 8px;
    background: var(--card-2);
    border: 1px solid var(--border);
    overflow-x: auto;
    font-family: var(--mono);
    font-size: 12px;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .diff-add { color: var(--green); }
  .diff-del { color: var(--red); }
  .diff-hunk { color: var(--accent); }
  .toast {
    margin: 10px 16px 0;
    padding: 8px 12px;
    border-radius: 8px;
    font-size: 12px;
    background: var(--card-2);
    border: 1px solid var(--border);
  }
  .empty { color: var(--muted); text-align: center; padding: 28px 12px; }
  a.link { color: var(--accent); text-decoration: none; cursor: pointer; }
  a.link:hover { text-decoration: underline; }
</style>
</head>
<body>
<div id="root" class="shell">
  <div class="empty">Waiting for Jean CI review data...</div>
</div>
<script>
(function () {
  var nextRpcId = 1;
  var pending = new Map();
  var state = { mode: 'empty', data: null, activeTab: 'summary', toast: null, busy: false };

  function post(msg) {
    window.parent.postMessage(msg, '*');
  }

  function rpcRequest(method, params) {
    var id = nextRpcId++;
    return new Promise(function (resolve, reject) {
      pending.set(id, { resolve: resolve, reject: reject });
      post({ jsonrpc: '2.0', id: id, method: method, params: params || {} });
    });
  }

  function notifySize() {
    requestAnimationFrame(function () {
      var h = document.documentElement.scrollHeight;
      var w = document.documentElement.scrollWidth;
      post({
        jsonrpc: '2.0',
        method: 'ui/notifications/size-changed',
        params: { width: w, height: h }
      });
    });
  }

  function esc(val) {
    return String(val == null ? '' : val)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function badgeFor(status, conclusion, overridden) {
    if (overridden) return '<span class="badge badge-warn">OVERRIDDEN</span>';
    if (status === 'completed') {
      if (conclusion === 'success') return '<span class="badge badge-pass">PASS</span>';
      if (conclusion === 'failure') return '<span class="badge badge-fail">FAIL</span>';
      return '<span class="badge badge-neutral">' + esc((conclusion || 'COMPLETED').toUpperCase()) + '</span>';
    }
    if (status === 'in_progress') return '<span class="badge badge-running">IN PROGRESS</span>';
    return '<span class="badge badge-warn">' + esc((status || 'QUEUED').toUpperCase()) + '</span>';
  }

  function renderDiff(diff) {
    if (!diff) return '<div class="empty">No diff preview stored for this check.</div>';
    var lines = String(diff).split('\\n').map(function (line) {
      var cls = '';
      if (line.startsWith('+') && !line.startsWith('+++')) cls = 'diff-add';
      else if (line.startsWith('-') && !line.startsWith('---')) cls = 'diff-del';
      else if (line.startsWith('@@')) cls = 'diff-hunk';
      return cls ? '<span class="' + cls + '">' + esc(line) + '</span>' : esc(line);
    });
    return '<pre>' + lines.join('\\n') + '</pre>';
  }

  function extractPayload(toolResult) {
    if (!toolResult) return null;
    if (toolResult.structuredContent && typeof toolResult.structuredContent === 'object') {
      return toolResult.structuredContent;
    }
    if (Array.isArray(toolResult.content)) {
      for (var i = 0; i < toolResult.content.length; i++) {
        var block = toolResult.content[i];
        if (block && block.type === 'text' && typeof block.text === 'string') {
          try { return JSON.parse(block.text); } catch (_) {}
        }
      }
    }
    return null;
  }

  function applyPayload(payload) {
    if (!payload || typeof payload !== 'object') return;
    if (payload.check && typeof payload.check === 'object') {
      state.mode = 'check';
      state.data = payload;
    } else if (Array.isArray(payload.latestChecks) || Array.isArray(payload.allChecks)) {
      state.mode = 'pr';
      state.data = payload;
    }
    render();
  }

  async function callTool(name, args) {
    state.busy = true;
    state.toast = 'Running ' + name + '...';
    render();
    try {
      var res = await rpcRequest('tools/call', { name: name, arguments: args });
      var payload = extractPayload(res);
      if (res && res.isError) {
        var errText = (res.content && res.content[0] && res.content[0].text) || 'Tool call failed';
        state.toast = 'Error: ' + errText;
      } else if (name === 'get_review_check' || name === 'get_pr_reviews') {
        state.toast = null;
        applyPayload(payload);
      } else {
        state.toast = (payload && payload.message) || ('Completed ' + name);
      }
    } catch (err) {
      state.toast = 'Request failed: ' + (err && err.message ? err.message : String(err));
    } finally {
      state.busy = false;
      render();
    }
  }

  function openExternal(url) {
    if (!url) return;
    rpcRequest('ui/open-link', { url: url }).catch(function () {});
  }

  function render() {
    var root = document.getElementById('root');
    if (state.mode === 'empty' || !state.data) {
      root.innerHTML = '<div class="empty">Waiting for Jean CI review data...</div>';
      notifySize();
      return;
    }

    var toastHtml = state.toast ? '<div class="toast">' + esc(state.toast) + '</div>' : '';

    if (state.mode === 'check') {
      var c = state.data.check;
      var approval = state.data.approvalStatus || {};
      var shaShort = c.headSha ? String(c.headSha).slice(0, 7) : 'n/a';
      var banners = '';
      if (approval.waitingForApproval) {
        banners += '<div class="banner"><strong>Tool approval required:</strong> This review is paused waiting for a GitHub administrator decision. ' +
          '<a class="link" data-open-url="' + esc(c.detailsUrl) + '">Open authenticated check page</a>.</div>';
      }
      if (c.manuallyOverridden) {
        banners += '<div class="banner info"><strong>Manual override recorded</strong> by ' + esc(c.overriddenBy || 'operator') +
          (c.overrideReason ? ' &mdash; ' + esc(c.overrideReason) : '') + '</div>';
      }
      var tabContent = '';
      if (state.activeTab === 'summary') {
        tabContent = '<pre>' + esc(c.summary || '(No review summary recorded yet.)') + '</pre>';
      } else if (state.activeTab === 'diff') {
        tabContent = renderDiff(c.diffPreview);
      } else if (state.activeTab === 'prompt') {
        tabContent = '<pre>' + esc(c.prompt || '(Prompt not included. Reload with includePrompt: true.)') + '</pre>';
      }

      root.innerHTML =
        '<div class="header">' +
          '<div class="title-block">' +
            '<h1>jean-ci / ' + esc(c.checkName) + ' ' + badgeFor(c.status, c.conclusion, c.manuallyOverridden) + '</h1>' +
            '<div class="meta">' +
              '<span>' + esc(c.repo) + '#' + esc(c.prNumber) + '</span>' +
              '<span class="mono">' + esc(shaShort) + '</span>' +
              '<span>check #' + esc(c.id) + '</span>' +
              (c.prTitle ? '<span>' + esc(c.prTitle) + '</span>' : '') +
            '</div>' +
          '</div>' +
          '<div class="actions">' +
            '<button id="btn-pr-overview"' + (state.busy ? ' disabled' : '') + '>All PR Checks</button>' +
            '<button id="btn-refresh"' + (state.busy ? ' disabled' : '') + '>Refresh</button>' +
            '<button id="btn-retrigger" class="primary"' + (state.busy ? ' disabled' : '') + '>Retrigger Check</button>' +
          '</div>' +
        '</div>' +
        toastHtml +
        banners +
        '<div class="tabs">' +
          '<button class="tab ' + (state.activeTab === 'summary' ? 'active' : '') + '" data-tab="summary">Summary</button>' +
          '<button class="tab ' + (state.activeTab === 'diff' ? 'active' : '') + '" data-tab="diff">Diff Preview</button>' +
          '<button class="tab ' + (state.activeTab === 'prompt' ? 'active' : '') + '" data-tab="prompt">Check Prompt</button>' +
        '</div>' +
        '<div class="body">' + tabContent + '</div>';

      root.querySelectorAll('[data-tab]').forEach(function (el) {
        el.addEventListener('click', function () {
          state.activeTab = el.getAttribute('data-tab');
          if (state.activeTab === 'diff' && !c.diffPreview) {
            callTool('get_review_check', { checkId: c.id, includeDiff: true, includePrompt: true });
          } else {
            render();
          }
        });
      });
      var btnRefresh = document.getElementById('btn-refresh');
      if (btnRefresh) btnRefresh.addEventListener('click', function () {
        callTool('get_review_check', { checkId: c.id, includeDiff: state.activeTab === 'diff', includePrompt: true });
      });
      var btnPr = document.getElementById('btn-pr-overview');
      if (btnPr) btnPr.addEventListener('click', function () {
        callTool('get_pr_reviews', { repo: c.repo, prNumber: c.prNumber });
      });
      var btnRetrigger = document.getElementById('btn-retrigger');
      if (btnRetrigger) btnRetrigger.addEventListener('click', function () {
        callTool('retrigger_pr_review', { repo: c.repo, prNumber: c.prNumber, checkNames: [c.checkName] });
      });
    } else if (state.mode === 'pr') {
      var pr = state.data;
      var checks = pr.latestChecks || [];
      var rows = checks.length === 0
        ? '<div class="empty">No review checks recorded for this PR yet.</div>'
        : '<div class="check-list">' + checks.map(function (chk) {
            return '<div class="check-row">' +
              '<div>' +
                '<strong>jean-ci / ' + esc(chk.checkName) + '</strong> ' + badgeFor(chk.status, chk.conclusion, chk.manuallyOverridden) +
                '<div class="meta">' +
                  '<span class="mono">' + esc((chk.headSha || '').slice(0, 7) || 'n/a') + '</span>' +
                  '<span>check #' + esc(chk.id) + '</span>' +
                  (chk.title ? '<span>' + esc(chk.title) + '</span>' : '') +
                '</div>' +
              '</div>' +
              '<div class="actions">' +
                '<button data-inspect-check="' + esc(chk.id) + '"' + (state.busy ? ' disabled' : '') + '>Inspect</button>' +
              '</div>' +
            '</div>';
          }).join('') + '</div>';

      root.innerHTML =
        '<div class="header">' +
          '<div class="title-block">' +
            '<h1>' + esc(pr.repo) + '#' + esc(pr.prNumber) + ' <span class="badge badge-neutral">' + esc(String(pr.overallStatus || 'unknown').toUpperCase()) + '</span></h1>' +
            '<div class="meta">' +
              (pr.reviewState && pr.reviewState.lastReviewedSha ? '<span>Last reviewed: <span class="mono">' + esc(String(pr.reviewState.lastReviewedSha).slice(0, 7)) + '</span></span>' : '') +
              '<span>' + esc(checks.length) + ' check(s)</span>' +
              (pr.prUrl ? '<a class="link" data-open-url="' + esc(pr.prUrl) + '">Open on GitHub</a>' : '') +
            '</div>' +
          '</div>' +
          '<div class="actions">' +
            '<button id="btn-pr-refresh"' + (state.busy ? ' disabled' : '') + '>Refresh</button>' +
            '<button id="btn-pr-retrigger" class="primary"' + (state.busy ? ' disabled' : '') + '>Retrigger All Checks</button>' +
          '</div>' +
        '</div>' +
        toastHtml +
        '<div class="body">' + rows + '</div>';

      root.querySelectorAll('[data-inspect-check]').forEach(function (el) {
        el.addEventListener('click', function () {
          var id = Number(el.getAttribute('data-inspect-check'));
          state.activeTab = 'summary';
          callTool('get_review_check', { checkId: id, includeDiff: false, includePrompt: true });
        });
      });
      var btnPrRefresh = document.getElementById('btn-pr-refresh');
      if (btnPrRefresh) btnPrRefresh.addEventListener('click', function () {
        callTool('get_pr_reviews', { repo: pr.repo, prNumber: pr.prNumber });
      });
      var btnPrRetrigger = document.getElementById('btn-pr-retrigger');
      if (btnPrRetrigger) btnPrRetrigger.addEventListener('click', function () {
        callTool('retrigger_pr_review', { repo: pr.repo, prNumber: pr.prNumber });
      });
    }

    root.querySelectorAll('[data-open-url]').forEach(function (el) {
      el.addEventListener('click', function (ev) {
        ev.preventDefault();
        openExternal(el.getAttribute('data-open-url'));
      });
    });

    notifySize();
  }

  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return;
    if (msg.id !== undefined && pending.has(msg.id)) {
      var entry = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(msg.error.message || 'RPC error'));
      else entry.resolve(msg.result);
      return;
    }
    if (msg.method === 'ui/notifications/tool-result' && msg.params) {
      applyPayload(extractPayload(msg.params));
    } else if (msg.method === 'ui/notifications/host-context-changed' && msg.params && msg.params.theme) {
      document.documentElement.setAttribute('data-theme', msg.params.theme);
    }
  });

  rpcRequest('ui/initialize', {
    appInfo: { name: 'jean-ci-review-inspector', version: '1.0.0' },
    appCapabilities: {},
    protocolVersion: '2026-01-26'
  }).then(function (initResult) {
    if (initResult && initResult.hostContext && initResult.hostContext.theme) {
      document.documentElement.setAttribute('data-theme', initResult.hostContext.theme);
    }
    post({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} });
    notifySize();
  }).catch(function () {});
})();
</script>
</body>
</html>`;
}

export function registerJeanCiAppResources(server: McpServer): void {
  server.server.registerCapabilities({
    extensions: {
      [MCP_APPS_EXTENSION_ID]: {
        mimeTypes: [RESOURCE_MIME_TYPE],
      },
    },
  });

  registerAppResource(
    server,
    'Jean CI PR Review Inspector',
    REVIEW_INSPECTOR_URI,
    {
      title: 'Jean CI PR Review Inspector',
      description: 'Interactive PR review and check run inspector with summary, diff preview, prompt viewer, and retrigger actions.',
      _meta: {
        ui: {
          csp: {},
        },
      },
    },
    async () => ({
      contents: [
        {
          uri: REVIEW_INSPECTOR_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: buildReviewInspectorHtml(),
          _meta: {
            ui: {
              csp: {},
            },
          },
        },
      ],
    }),
  );
}
