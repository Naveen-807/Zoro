import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { Orchestrator } from "../engine/orchestrator.js";
import type { WalletConnectService } from "../wc/walletconnect.js";
import type { AppConfig } from "../config.js";

export type HttpServerDeps = {
  orchestrator: Orchestrator;
  walletConnect: WalletConnectService;
  config: AppConfig;
};

// ─── Shared CSS ──────────────────────────────────────────────────────
const CSS = `
  :root {
    --bg: #0a0a0f;
    --card: #12121a;
    --card-hover: #1a1a28;
    --border: #1e1e2e;
    --accent: #6c63ff;
    --accent-glow: rgba(108,99,255,0.25);
    --green: #00d68f;
    --yellow: #ffc107;
    --red: #ff4757;
    --orange: #ff8c42;
    --blue: #4fc3f7;
    --text: #e8e8ef;
    --muted: #6b6b80;
    --mono: 'SF Mono', 'Cascadia Code', 'Fira Code', 'JetBrains Mono', Consolas, monospace;
    --sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  }
  * { margin:0; padding:0; box-sizing:border-box; }
  body {
    font-family: var(--sans);
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
  }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .container { max-width: 1100px; margin: 0 auto; padding: 32px 24px; }
  .header {
    display: flex;
    align-items: center;
    gap: 16px;
    margin-bottom: 32px;
    padding-bottom: 24px;
    border-bottom: 1px solid var(--border);
  }
  .header h1 {
    font-size: 28px;
    font-weight: 700;
    background: linear-gradient(135deg, var(--accent), #a78bfa, #f472b6);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    letter-spacing: -0.5px;
  }
  .header .logo {
    font-size: 32px;
    width: 48px;
    height: 48px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: linear-gradient(135deg, var(--accent), #a78bfa);
    border-radius: 12px;
    font-weight: 800;
    -webkit-text-fill-color: white;
  }
  .track-badges {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin: 12px 0 24px;
  }
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 10px;
    border-radius: 20px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.5px;
    text-transform: uppercase;
  }
  .badge-x402  { background: rgba(79,195,247,0.15); color: var(--blue); border: 1px solid rgba(79,195,247,0.3); }
  .badge-ap2   { background: rgba(108,99,255,0.15); color: var(--accent); border: 1px solid rgba(108,99,255,0.3); }
  .badge-defi  { background: rgba(0,214,143,0.15); color: var(--green); border: 1px solid rgba(0,214,143,0.3); }
  .badge-bite  { background: rgba(255,140,66,0.15); color: var(--orange); border: 1px solid rgba(255,140,66,0.3); }
  .badge-overall { background: rgba(244,114,182,0.15); color: #f472b6; border: 1px solid rgba(244,114,182,0.3); }
  .status {
    display: inline-block;
    padding: 3px 10px;
    border-radius: 6px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.5px;
    text-transform: uppercase;
    font-family: var(--mono);
  }
  .status-NEW             { background: rgba(108,99,255,0.15); color: var(--accent); }
  .status-INTENT_CREATED  { background: rgba(79,195,247,0.15); color: var(--blue); }
  .status-AWAITING_APPROVAL { background: rgba(255,193,7,0.15); color: var(--yellow); }
  .status-APPROVED        { background: rgba(0,214,143,0.15); color: var(--green); }
  .status-EXECUTING       { background: rgba(79,195,247,0.25); color: var(--blue); animation: pulse 1.5s infinite; }
  .status-DONE            { background: rgba(0,214,143,0.25); color: var(--green); }
  .status-ABORTED         { background: rgba(255,71,87,0.15); color: var(--red); }
  .status-FAILED          { background: rgba(255,71,87,0.25); color: var(--red); }
  @keyframes pulse { 0%,100% { opacity:1 } 50% { opacity:0.6 } }
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 20px;
    margin-bottom: 16px;
    transition: border-color 0.2s, background 0.2s;
  }
  .card:hover {
    background: var(--card-hover);
    border-color: rgba(108,99,255,0.3);
  }
  .card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 10px;
  }
  .cmd-id {
    font-family: var(--mono);
    font-size: 14px;
    font-weight: 600;
    color: var(--accent);
  }
  .cmd-raw {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--muted);
    background: rgba(0,0,0,0.3);
    padding: 8px 12px;
    border-radius: 8px;
    margin-top: 8px;
    word-break: break-all;
  }
  .section-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 1px;
    margin: 28px 0 12px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .section-title .count {
    background: var(--accent);
    color: white;
    padding: 2px 8px;
    border-radius: 10px;
    font-size: 12px;
  }
  pre.json {
    background: #080810;
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 16px;
    overflow-x: auto;
    font-family: var(--mono);
    font-size: 12px;
    line-height: 1.6;
    color: #b8b8d0;
    max-height: 400px;
    overflow-y: auto;
  }
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 10px 20px;
    border: none;
    border-radius: 8px;
    font-family: var(--sans);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
  }
  .btn-primary {
    background: linear-gradient(135deg, var(--accent), #a78bfa);
    color: white;
    box-shadow: 0 4px 16px var(--accent-glow);
  }
  .btn-primary:hover { transform: translateY(-1px); box-shadow: 0 6px 24px var(--accent-glow); }
  .btn-danger {
    background: rgba(255,71,87,0.15);
    color: var(--red);
    border: 1px solid rgba(255,71,87,0.3);
  }
  .btn-danger:hover { background: rgba(255,71,87,0.25); }
  .btn-outline {
    background: transparent;
    color: var(--muted);
    border: 1px solid var(--border);
  }
  .btn-outline:hover { color: var(--text); border-color: var(--accent); }
  .actions { display: flex; gap: 10px; margin: 20px 0; flex-wrap: wrap; }
  .meta-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 12px;
    margin: 16px 0;
  }
  .meta-item {
    background: rgba(0,0,0,0.2);
    padding: 12px;
    border-radius: 8px;
    border: 1px solid var(--border);
  }
  .meta-label {
    font-size: 11px;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 4px;
  }
  .meta-value {
    font-family: var(--mono);
    font-size: 13px;
    color: var(--text);
    word-break: break-all;
  }
  .nav {
    display: flex;
    gap: 12px;
    margin-top: 20px;
  }
  .empty {
    color: var(--muted);
    font-style: italic;
    padding: 16px 0;
  }
  .mode-banner {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 12px;
    border-radius: 6px;
    font-size: 11px;
    font-weight: 600;
    font-family: var(--mono);
    margin-left: auto;
  }
  .mode-dev { background: rgba(255,193,7,0.15); color: var(--yellow); }
  .mode-live { background: rgba(0,214,143,0.15); color: var(--green); }
`;

function layout(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>${CSS}</style>
</head>
<body><div class="container">${body}</div></body>
</html>`;
}

function statusBadge(status: string): string {
  return `<span class="status status-${escapeHtml(status)}">${escapeHtml(status)}</span>`;
}

function trackBadgesForKind(kind: string): string {
  const badges: string[] = [];
  badges.push('<span class="badge badge-overall">Overall</span>');
  badges.push('<span class="badge badge-ap2">AP2</span>');
  if (kind === "PAY_VENDOR") {
    badges.push('<span class="badge badge-x402">x402</span>');
  } else if (kind === "TREASURY_SWAP") {
    badges.push('<span class="badge badge-defi">DeFi</span>');
  } else if (kind === "PRIVATE_PAYOUT") {
    badges.push('<span class="badge badge-bite">BITE Encrypted</span>');
  }
  return badges.join("");
}

function headerHtml(config: AppConfig): string {
  const mode = config.STRICT_LIVE_MODE === 1
    ? '<span class="mode-banner mode-live">● LIVE</span>'
    : '<span class="mode-banner mode-dev">● DEV (Simulated)</span>';
  return `
    <div class="header">
      <div class="logo">Z</div>
      <div>
        <h1>Zoro</h1>
        <div style="color:var(--muted);font-size:13px;margin-top:2px;">Doc-driven agentic commerce engine</div>
      </div>
      ${mode}
    </div>`;
}

// ─── Server ──────────────────────────────────────────────────────────
export function startHttpServer({ orchestrator, walletConnect, config }: HttpServerDeps): { close: () => Promise<void> } {
  const app = new Hono();

  // ─── Landing page ────────────────────────────────────────────────
  app.get("/", (c) => {
    const docId = config.GOOGLE_DOC_ID ?? "local-doc";
    return c.html(layout("Zoro", `
      ${headerHtml(config)}
      <div class="track-badges">
        <span class="badge badge-overall">Overall Track</span>
        <span class="badge badge-x402">x402 Payments</span>
        <span class="badge badge-ap2">AP2 Authorization</span>
        <span class="badge badge-defi">DeFi Trading</span>
        <span class="badge badge-bite">BITE Encrypted</span>
      </div>
      <div class="meta-grid">
        <div class="meta-item">
          <div class="meta-label">Document ID</div>
          <div class="meta-value">${escapeHtml(docId)}</div>
        </div>
        <div class="meta-item">
          <div class="meta-label">API Server</div>
          <div class="meta-value">:${config.PORT}</div>
        </div>
        <div class="meta-item">
          <div class="meta-label">Tools Server</div>
          <div class="meta-value">:${config.TOOLS_PORT}</div>
        </div>
        <div class="meta-item">
          <div class="meta-label">Poll Interval</div>
          <div class="meta-value">${config.POLL_INTERVAL_MS}ms</div>
        </div>
      </div>
      <div class="actions">
        <a class="btn btn-primary" href="/dashboard/${encodeURIComponent(docId)}">⚡ Dashboard</a>
        <a class="btn btn-outline" href="/sessions/${encodeURIComponent(docId)}">🔗 WalletConnect</a>
        <a class="btn btn-outline" href="/demo/${encodeURIComponent(docId)}" style="border-color:var(--green);color:var(--green)">🎬 Demo Walkthrough</a>
      </div>
      <div style="margin-top:28px;">
        <div class="section-title">API Endpoints</div>
        <pre class="json">POST /api/tick/${escapeHtml(docId)}           → Process commands
POST /api/ap2/cmd/:docId/:cmdId/request-approval → Approve command
POST /api/ap2/cmd/:docId/:cmdId/simulate-failure → Simulate failure
GET  /api/ap2/cmd/:docId/:cmdId               → Command summary
GET  /api/commands/:docId/:cmdId/trace         → Full trace JSON
GET  /api/receipt/:docId/:cmdId               → Structured AP2 receipt
GET  /.well-known/tools (port ${config.TOOLS_PORT})           → Paid tools catalog</pre>
      </div>
    `));
  });

  // ─── Dashboard ───────────────────────────────────────────────────
  app.get("/dashboard/:docId", (c) => {
    const docId = c.req.param("docId");
    const awaiting = orchestrator.listAwaitingApproval(docId);
    const approved = orchestrator.listApproved(docId);
    const executing = orchestrator.listExecuting(docId);

    return c.html(layout("Zoro Dashboard", `
      ${headerHtml(config)}
      <div style="color:var(--muted);font-size:13px;margin-bottom:24px;">
        Doc ID: <span style="font-family:var(--mono);color:var(--text)">${escapeHtml(docId)}</span>
      </div>

      <div class="section-title">Awaiting Approval <span class="count">${awaiting.length}</span></div>
      ${renderCommandCards(docId, awaiting)}

      <div class="section-title">Approved <span class="count">${approved.length}</span></div>
      ${renderCommandCards(docId, approved)}

      <div class="section-title">Executing <span class="count">${executing.length}</span></div>
      ${renderCommandCards(docId, executing)}

      <div class="actions" style="margin-top:32px;">
        <a class="btn btn-outline" href="/">← Home</a>
        <a class="btn btn-primary" href="/builder/${encodeURIComponent(docId)}">🛠️ Command Builder</a>
        <form method="post" action="/api/tick/${encodeURIComponent(docId)}" style="display:inline">
          <button type="submit" class="btn btn-primary">⚡ Trigger Tick</button>
        </form>
      </div>
    `));
  });

  // ─── Command Builder ─────────────────────────────────────────────
  app.get("/builder/:docId", (c) => {
    const docId = c.req.param("docId");

    const builderCSS = `
      .builder-wrap {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 24px;
        margin-top: 16px;
      }
      @media (max-width: 768px) { .builder-wrap { grid-template-columns: 1fr; } }
      .form-group { margin-bottom: 16px; }
      .form-label {
        display: block;
        font-size: 12px;
        font-weight: 600;
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 0.5px;
        margin-bottom: 6px;
      }
      .form-input, .form-select {
        width: 100%;
        padding: 10px 14px;
        background: rgba(0,0,0,0.3);
        border: 1px solid var(--border);
        border-radius: 8px;
        color: var(--text);
        font-family: var(--mono);
        font-size: 13px;
        outline: none;
        transition: border-color 0.2s;
      }
      .form-input:focus, .form-select:focus { border-color: var(--accent); }
      .form-select option { background: var(--card); }
      .preview-box {
        background: #080810;
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 16px;
        font-family: var(--mono);
        font-size: 13px;
        line-height: 1.8;
        color: var(--green);
        min-height: 60px;
        word-break: break-all;
        position: relative;
      }
      .preview-box .copy-overlay {
        position: absolute;
        top: 8px;
        right: 8px;
        padding: 4px 10px;
        background: rgba(108,99,255,0.3);
        border: 1px solid var(--accent);
        border-radius: 6px;
        color: var(--accent);
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
        font-family: var(--sans);
        transition: all 0.2s;
      }
      .preview-box .copy-overlay:hover { background: var(--accent); color: white; }
      .suggestions {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        margin-top: 16px;
      }
      .suggestion-chip {
        padding: 6px 14px;
        background: rgba(108,99,255,0.1);
        border: 1px solid rgba(108,99,255,0.25);
        border-radius: 20px;
        color: var(--accent);
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.2s;
        font-family: var(--sans);
      }
      .suggestion-chip:hover { background: rgba(108,99,255,0.2); border-color: var(--accent); }
      .field-hint {
        font-size: 11px;
        color: var(--muted);
        margin-top: 4px;
        font-style: italic;
      }
    `;

    const builderJS = `
      const FIELDS = {
        PAY_VENDOR: ['vendor','amount','to','dataBudget','maxTotal'],
        TREASURY_SWAP: ['amount','toToken','slippage','maxSpend'],
        PRIVATE_PAYOUT: ['amount','to','unlockAt']
      };
      const SUGGESTIONS = [
        { label: 'Pay ACME 200 USDC', type: 'PAY_VENDOR', values: { vendor:'ACME', amount:'200', to:'0x1111111111111111111111111111111111111111', dataBudget:'1', maxTotal:'2' } },
        { label: 'Swap 25 USDC → WETH', type: 'TREASURY_SWAP', values: { amount:'25', toToken:'WETH', slippage:'50', maxSpend:'30' } },
        { label: 'Private 50 USDC', type: 'PRIVATE_PAYOUT', values: { amount:'50', to:'0x2222222222222222222222222222222222222222', unlockAt: new Date(Date.now()+3*86400000).toISOString().replace(/\\.\\d+Z/,'Z') } },
        { label: 'Pay Vendor 500', type: 'PAY_VENDOR', values: { vendor:'GLOBEX', amount:'500', to:'0x3333333333333333333333333333333333333333', dataBudget:'2', maxTotal:'5' } },
        { label: 'Swap 100 USDC', type: 'TREASURY_SWAP', values: { amount:'100', toToken:'WETH', slippage:'30', maxSpend:'110' } },
      ];

      function el(id) { return document.getElementById(id); }

      function updateForm() {
        const type = el('cmdType').value;
        const fields = FIELDS[type] || [];
        document.querySelectorAll('.dynamic-field').forEach(f => {
          f.style.display = fields.includes(f.dataset.field) ? 'block' : 'none';
        });
        updatePreview();
      }

      function updatePreview() {
        const type = el('cmdType').value;
        let cmd = 'DW ' + type;
        if (type === 'PAY_VENDOR') {
          const v = el('f_vendor').value || '<vendor>';
          const a = el('f_amount').value || '<amount>';
          const t = el('f_to').value || '<address>';
          const db = el('f_dataBudget').value || '1';
          const mt = el('f_maxTotal').value || '2';
          cmd += ' ' + v + ' ' + a + ' USDC TO ' + t + ' DATA_BUDGET ' + db + ' MAX_TOTAL ' + mt;
        } else if (type === 'TREASURY_SWAP') {
          const a = el('f_amount').value || '<amount>';
          const tk = el('f_toToken').value || 'WETH';
          const sl = el('f_slippage').value || '50';
          const ms = el('f_maxSpend').value || '<max>';
          cmd += ' ' + a + ' USDC TO ' + tk + ' SLIPPAGE ' + sl + ' MAX_SPEND ' + ms;
        } else if (type === 'PRIVATE_PAYOUT') {
          const a = el('f_amount').value || '<amount>';
          const t = el('f_to').value || '<address>';
          const u = el('f_unlockAt').value || '<ISO-date>';
          cmd += ' ' + a + ' USDC TO ' + t + ' AT ' + u;
        }
        el('preview').textContent = cmd;
      }

      function applySuggestion(idx) {
        const s = SUGGESTIONS[idx];
        el('cmdType').value = s.type;
        updateForm();
        Object.entries(s.values).forEach(([k, v]) => {
          const input = el('f_' + k);
          if (input) input.value = v;
        });
        updatePreview();
      }

      function copyCmd() {
        const text = el('preview').textContent;
        navigator.clipboard.writeText(text).then(() => {
          const btn = document.querySelector('.copy-overlay');
          btn.textContent = '✓ Copied!';
          setTimeout(() => { btn.textContent = '📋 Copy'; }, 1500);
        });
      }

      document.addEventListener('DOMContentLoaded', () => {
        el('cmdType').addEventListener('change', updateForm);
        document.querySelectorAll('.form-input, .form-select').forEach(input => {
          input.addEventListener('input', updatePreview);
        });
        updateForm();
      });
    `;

    return c.html(layout("Zoro — Command Builder", `
      ${headerHtml(config)}
      <style>${builderCSS}</style>

      <a href="/dashboard/${encodeURIComponent(docId)}" style="color:var(--muted);font-size:12px;">&larr; Dashboard</a>
      <h2 style="font-size:20px;margin-top:8px;margin-bottom:4px;">🛠️ Command Builder</h2>
      <p style="color:var(--muted);font-size:13px;margin-bottom:8px;">
        Build DW commands with auto-suggestions. Click a suggestion or fill in the form, then copy the generated command.
      </p>

      <div class="section-title">Quick Suggestions</div>
      <div class="suggestions">
        ${[
        { label: "💰 Pay ACME 200", idx: 0 },
        { label: "🔄 Swap 25 → WETH", idx: 1 },
        { label: "🔒 Private 50 USDC", idx: 2 },
        { label: "💰 Pay GLOBEX 500", idx: 3 },
        { label: "🔄 Swap 100 USDC", idx: 4 }
      ].map(s => `<button class="suggestion-chip" onclick="applySuggestion(${s.idx})">${s.label}</button>`).join("")}
      </div>

      <div class="builder-wrap">
        <div>
          <div class="section-title">Configure</div>
          <div class="card" style="padding:24px;">
            <div class="form-group">
              <label class="form-label">Command Type</label>
              <select id="cmdType" class="form-select">
                <option value="PAY_VENDOR">PAY_VENDOR — Pay a vendor with x402 tool checks</option>
                <option value="TREASURY_SWAP">TREASURY_SWAP — DeFi swap via Uniswap</option>
                <option value="PRIVATE_PAYOUT">PRIVATE_PAYOUT — BITE encrypted time-locked payout</option>
              </select>
            </div>

            <div class="dynamic-field" data-field="vendor">
              <div class="form-group">
                <label class="form-label">Vendor Name</label>
                <input id="f_vendor" class="form-input" placeholder="e.g. ACME" value="ACME">
                <div class="field-hint">Name of the vendor to pay</div>
              </div>
            </div>

            <div class="dynamic-field" data-field="amount">
              <div class="form-group">
                <label class="form-label">Amount (USDC)</label>
                <input id="f_amount" class="form-input" type="number" placeholder="e.g. 200" value="200">
              </div>
            </div>

            <div class="dynamic-field" data-field="to">
              <div class="form-group">
                <label class="form-label">Recipient Address</label>
                <input id="f_to" class="form-input" placeholder="0x..." value="0x1111111111111111111111111111111111111111">
                <div class="field-hint">Ethereum address (0x + 40 hex chars)</div>
              </div>
            </div>

            <div class="dynamic-field" data-field="dataBudget">
              <div class="form-group">
                <label class="form-label">Data Budget (USDC)</label>
                <input id="f_dataBudget" class="form-input" type="number" step="0.1" placeholder="e.g. 1" value="1">
                <div class="field-hint">Max spend on x402 paid tool calls</div>
              </div>
            </div>

            <div class="dynamic-field" data-field="maxTotal">
              <div class="form-group">
                <label class="form-label">Max Total (USDC)</label>
                <input id="f_maxTotal" class="form-input" type="number" step="0.1" placeholder="e.g. 2" value="2">
                <div class="field-hint">Overall spend cap for this command</div>
              </div>
            </div>

            <div class="dynamic-field" data-field="toToken">
              <div class="form-group">
                <label class="form-label">Target Token</label>
                <select id="f_toToken" class="form-select">
                  <option value="WETH">WETH</option>
                </select>
              </div>
            </div>

            <div class="dynamic-field" data-field="slippage">
              <div class="form-group">
                <label class="form-label">Slippage (basis points)</label>
                <input id="f_slippage" class="form-input" type="number" placeholder="e.g. 50" value="50">
                <div class="field-hint">50 bps = 0.5%. Max 200 bps enforced by policy</div>
              </div>
            </div>

            <div class="dynamic-field" data-field="maxSpend">
              <div class="form-group">
                <label class="form-label">Max Spend (USDC)</label>
                <input id="f_maxSpend" class="form-input" type="number" placeholder="e.g. 30" value="30">
              </div>
            </div>

            <div class="dynamic-field" data-field="unlockAt">
              <div class="form-group">
                <label class="form-label">Unlock At (ISO 8601)</label>
                <input id="f_unlockAt" class="form-input" placeholder="e.g. 2026-02-13T12:00:00Z">
                <div class="field-hint">BITE decryption time — must be in the future</div>
              </div>
            </div>
          </div>
        </div>

        <div>
          <div class="section-title">Generated Command</div>
          <div class="preview-box">
            <button class="copy-overlay" onclick="copyCmd()">📋 Copy</button>
            <span id="preview">DW PAY_VENDOR ACME 200 USDC TO 0x1111111111111111111111111111111111111111 DATA_BUDGET 1 MAX_TOTAL 2</span>
          </div>

          <div style="margin-top:16px;">
            <div class="section-title">Track Coverage</div>
            <div id="trackInfo" class="track-badges">
              <span class="badge badge-overall">Overall</span>
              <span class="badge badge-ap2">AP2</span>
              <span class="badge badge-x402">x402</span>
            </div>
          </div>

          <div style="margin-top:20px;">
            <div class="section-title">How It Works</div>
            <div class="card" style="padding:16px;">
              <ol style="padding-left:20px;color:var(--muted);font-size:13px;line-height:2;">
                <li>Copy the generated command</li>
                <li>Paste it into the Google Doc (or <code>data/local-doc.txt</code>)</li>
                <li>The engine polls the doc → ingests the command</li>
                <li>Approve via WalletConnect (AP2 signature)</li>
                <li>Engine executes: x402 tools → settlement → receipt</li>
              </ol>
            </div>
          </div>
        </div>
      </div>

      <div class="nav" style="margin-top:24px;">
        <a class="btn btn-outline" href="/dashboard/${encodeURIComponent(docId)}">← Dashboard</a>
      </div>

      <script>${builderJS}</script>
    `));
  });

  // ─── Command detail ──────────────────────────────────────────────
  app.get("/cmd/:docId/:cmdId", (c) => {
    const docId = c.req.param("docId");
    const cmdId = c.req.param("cmdId");
    const summary = orchestrator.buildApprovalSummary(docId, cmdId);
    const spend = orchestrator.buildSpendSummary(docId, cmdId);
    const trace = orchestrator.getTrace(docId, cmdId);
    const kind = summary.command?.parsed?.kind ?? "UNKNOWN";

    return c.html(layout(`Zoro — ${cmdId}`, `
      ${headerHtml(config)}

      <div class="card-header" style="margin-bottom:20px;">
        <div>
          <a href="/dashboard/${encodeURIComponent(docId)}" style="color:var(--muted);font-size:12px;">&larr; Dashboard</a>
          <h2 style="font-size:20px;margin-top:4px;">
            <span style="font-family:var(--mono)">${escapeHtml(cmdId)}</span>
          </h2>
        </div>
        <div>${statusBadge(summary.command?.status ?? "UNKNOWN")}</div>
      </div>

      <div class="track-badges">${trackBadgesForKind(kind)}</div>

      ${summary.command ? `<div class="cmd-raw">${escapeHtml(summary.command.rawCmd)}</div>` : ""}

      <div class="meta-grid" style="margin-top:16px">
        <div class="meta-item">
          <div class="meta-label">Command Type</div>
          <div class="meta-value">${escapeHtml(kind)}</div>
        </div>
        <div class="meta-item">
          <div class="meta-label">Total Spend</div>
          <div class="meta-value">${spend.totalUsdc.toFixed(4)} USDC</div>
        </div>
        <div class="meta-item">
          <div class="meta-label">Tool Receipts</div>
          <div class="meta-value">${spend.toolReceipts.length}</div>
        </div>
        <div class="meta-item">
          <div class="meta-label">Created</div>
          <div class="meta-value">${escapeHtml(summary.command?.createdAt ?? "—")}</div>
        </div>
      </div>

      <div class="actions">
        <form method="post" action="/api/ap2/cmd/${encodeURIComponent(docId)}/${encodeURIComponent(cmdId)}/request-approval">
          <button type="submit" class="btn btn-primary">🔐 Approve via WalletConnect</button>
        </form>
        <form method="post" action="/api/ap2/cmd/${encodeURIComponent(docId)}/${encodeURIComponent(cmdId)}/simulate-failure">
          <button type="submit" class="btn btn-danger">💥 Simulate Failure</button>
        </form>
        <a class="btn btn-outline" href="/api/commands/${encodeURIComponent(docId)}/${encodeURIComponent(cmdId)}/trace" target="_blank">📄 Raw Trace JSON</a>
      </div>

      <div class="section-title">AP2 Intent</div>
      <pre class="json">${escapeHtml(JSON.stringify(summary.intent, null, 2))}</pre>

      <div class="section-title">AP2 Cart (Authorization Signature)</div>
      <pre class="json">${escapeHtml(JSON.stringify(summary.cart, null, 2))}</pre>

      <div class="section-title">Spend Summary</div>
      <pre class="json">${escapeHtml(JSON.stringify(spend, null, 2))}</pre>

      <div class="section-title">Full Trace</div>
      <pre class="json">${escapeHtml(JSON.stringify(trace, null, 2))}</pre>

      <div class="nav">
        <a class="btn btn-outline" href="/sessions/${encodeURIComponent(docId)}">🔗 WalletConnect Session</a>
        <a class="btn btn-outline" href="/dashboard/${encodeURIComponent(docId)}">← Dashboard</a>
      </div>
    `));
  });

  // ─── WalletConnect session ───────────────────────────────────────
  app.get("/sessions/:docId", async (c) => {
    const docId = c.req.param("docId");
    const session = await walletConnect.ensureSession(docId);

    return c.html(layout("WalletConnect Session", `
      ${headerHtml(config)}
      <h2 style="font-size:20px;margin-bottom:20px;">🔗 WalletConnect Session</h2>

      <div class="meta-grid">
        <div class="meta-item">
          <div class="meta-label">Doc ID</div>
          <div class="meta-value">${escapeHtml(docId)}</div>
        </div>
        <div class="meta-item">
          <div class="meta-label">Signer Address</div>
          <div class="meta-value">${escapeHtml(session.address || "PENDING_WALLET_APPROVAL")}</div>
        </div>
        <div class="meta-item">
          <div class="meta-label">Status</div>
          <div class="meta-value">${session.pending ? "⏳ Pending" : "✅ Connected"}</div>
        </div>
      </div>

      <div class="section-title">Pairing URI</div>
      <pre class="json">${escapeHtml(session.uri)}</pre>
      <p style="color:var(--muted);font-size:13px;margin-top:12px;">
        Use this URI in a wallet that supports WalletConnect v2, then approve the AP2 typed-data request.
      </p>

      <div class="nav">
        <a class="btn btn-outline" href="/dashboard/${encodeURIComponent(docId)}">← Dashboard</a>
      </div>
    `));
  });

  // ─── Demo Walkthrough ───────────────────────────────────────────
  app.get("/demo/:docId", (c) => {
    const docId = c.req.param("docId");
    const allCommands = orchestrator.listAllCommands(docId);
    const doneCount = allCommands.filter(cmd => cmd.status === "DONE").length;
    const totalCount = allCommands.length;

    const commandRows = allCommands.map((cmd) => {
      const kind = cmd.parsed?.kind ?? "UNKNOWN";
      const kindBadge = kind === "PAY_VENDOR" ? '<span class="badge badge-x402">x402</span><span class="badge badge-ap2">AP2</span>'
        : kind === "TREASURY_SWAP" ? '<span class="badge badge-defi">DeFi</span><span class="badge badge-x402">x402</span>'
          : kind === "PRIVATE_PAYOUT" ? '<span class="badge badge-bite">BITE</span>'
            : '<span class="badge badge-overall">Overall</span>';
      return `<tr>
        <td><a href="/cmd/${encodeURIComponent(docId)}/${encodeURIComponent(cmd.cmdId)}" style="color:var(--accent);font-family:var(--mono);font-size:12px">${escapeHtml(cmd.cmdId.slice(0, 16))}…</a></td>
        <td>${kindBadge}</td>
        <td>${statusBadge(cmd.status)}</td>
        <td style="font-family:var(--mono);font-size:11px;color:var(--muted);max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(cmd.rawCmd.slice(0, 80))}</td>
        <td>
          <a class="btn btn-outline" style="padding:4px 10px;font-size:11px" href="/receipt/${encodeURIComponent(docId)}/${encodeURIComponent(cmd.cmdId)}">📄 Receipt</a>
        </td>
      </tr>`;
    }).join("");

    return c.html(layout("Zoro — Demo Walkthrough", `
      ${headerHtml(config)}
      <h2 style="font-size:22px;margin-bottom:6px;">🎬 Demo Walkthrough</h2>
      <p style="color:var(--muted);font-size:14px;margin-bottom:24px;">
        <strong>Zoro</strong> is a doc-driven agentic commerce engine. Users type commands in a <strong>Google Doc</strong>, 
        and Zoro autonomously discovers tools, reasons about costs, authorizes via AP2, executes x402 payments, 
        and settles on-chain — all with a full audit trail.
      </p>

      <div class="track-badges" style="margin-bottom:24px;">
        <span class="badge badge-overall">🏆 Overall Track</span>
        <span class="badge badge-x402">💳 x402 Tool Usage</span>
        <span class="badge badge-ap2">🔐 AP2 Authorization</span>
        <span class="badge badge-defi">📈 DeFi Trading</span>
        <span class="badge badge-bite">🔒 Encrypted Agents</span>
      </div>

      <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-bottom:28px;">
        <div class="meta-item" style="text-align:center">
          <div class="meta-label">Commands</div>
          <div class="meta-value" style="font-size:24px;font-weight:700;color:var(--accent)">${totalCount}</div>
        </div>
        <div class="meta-item" style="text-align:center">
          <div class="meta-label">Completed</div>
          <div class="meta-value" style="font-size:24px;font-weight:700;color:var(--green)">${doneCount}</div>
        </div>
        <div class="meta-item" style="text-align:center">
          <div class="meta-label">x402 Tools</div>
          <div class="meta-value" style="font-size:24px;font-weight:700;color:var(--blue)">3</div>
        </div>
        <div class="meta-item" style="text-align:center">
          <div class="meta-label">Chains</div>
          <div class="meta-value" style="font-size:24px;font-weight:700;color:var(--orange)">2</div>
        </div>
        <div class="meta-item" style="text-align:center">
          <div class="meta-label">Mode</div>
          <div class="meta-value" style="font-size:14px;font-weight:700;color:${config.STRICT_LIVE_MODE === 1 ? 'var(--green)' : 'var(--yellow)'}">${config.STRICT_LIVE_MODE === 1 ? 'LIVE' : 'DEV'}</div>
        </div>
      </div>

      <div class="section-title">How Zoro Works</div>
      <div class="card" style="padding:20px;">
        <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:8px;text-align:center;">
          ${[
        { icon: "📝", label: "Doc Input", detail: "User types in Google Doc" },
        { icon: "🧠", label: "LLM Parse", detail: "Gemini understands intent" },
        { icon: "🔐", label: "AP2 Auth", detail: "WalletConnect signature" },
        { icon: "⚡", label: "x402 Tools", detail: "Paid tool calls (402→pay→200)" },
        { icon: "✅", label: "Settlement", detail: "On-chain payout + receipt" }
      ].map(step => `
            <div>
              <div style="font-size:28px;margin-bottom:6px;">${step.icon}</div>
              <div style="font-size:12px;font-weight:700;color:var(--text);margin-bottom:2px;">${step.label}</div>
              <div style="font-size:10px;color:var(--muted);">${step.detail}</div>
            </div>
          `).join('<div style="display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:20px;">→</div>')}
        </div>
      </div>

      <div class="section-title">Command Types & Track Coverage</div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:20px;">
        <div class="card" style="border-left:3px solid var(--blue)">
          <div style="font-weight:700;font-size:14px;margin-bottom:8px;">💰 PAY_VENDOR</div>
          <div style="font-size:12px;color:var(--muted);line-height:1.6;">
            Chains <strong>vendor-risk</strong> ($0.25) + <strong>compliance-check</strong> ($0.50) via x402,
            then settles payout on-chain. Full AP2 intent→auth→settle flow.
          </div>
          <div class="track-badges" style="margin-top:8px;">
            <span class="badge badge-x402">x402</span>
            <span class="badge badge-ap2">AP2</span>
            <span class="badge badge-overall">Overall</span>
          </div>
        </div>
        <div class="card" style="border-left:3px solid var(--green)">
          <div style="font-weight:700;font-size:14px;margin-bottom:8px;">🔄 TREASURY_SWAP</div>
          <div style="font-size:12px;color:var(--muted);line-height:1.6;">
            Calls <strong>price-check</strong> ($0.10) for research, analyzes market conditions,
            then executes DeFi swap with slippage guards and spend caps.
          </div>
          <div class="track-badges" style="margin-top:8px;">
            <span class="badge badge-defi">DeFi</span>
            <span class="badge badge-x402">x402</span>
            <span class="badge badge-overall">Overall</span>
          </div>
        </div>
        <div class="card" style="border-left:3px solid var(--orange)">
          <div style="font-weight:700;font-size:14px;margin-bottom:8px;">🔒 PRIVATE_PAYOUT</div>
          <div style="font-size:12px;color:var(--muted);line-height:1.6;">
            Encrypts payout via <strong>BITE v2</strong>. Amount and recipient are hidden until
            a time-based condition is met. Conditional decryption + execution.
          </div>
          <div class="track-badges" style="margin-top:8px;">
            <span class="badge badge-bite">BITE</span>
            <span class="badge badge-overall">Overall</span>
          </div>
        </div>
      </div>

      <div class="section-title">All Commands <span class="count">${totalCount}</span></div>
      ${totalCount > 0 ? `
      <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead>
            <tr style="border-bottom:1px solid var(--border);">
              <th style="text-align:left;padding:10px 8px;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">ID</th>
              <th style="text-align:left;padding:10px 8px;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">Tracks</th>
              <th style="text-align:left;padding:10px 8px;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">Status</th>
              <th style="text-align:left;padding:10px 8px;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">Command</th>
              <th style="text-align:left;padding:10px 8px;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">Receipt</th>
            </tr>
          </thead>
          <tbody>
            ${commandRows}
          </tbody>
        </table>
      </div>
      ` : '<p class="empty">No commands yet. Type a command in the Google Doc (e.g. "Pay ACME 10 USDC to 0x1234...") and click Trigger Tick.</p>'}

      <div class="section-title">Safety & Trust</div>
      <div class="meta-grid">
        <div class="meta-item">
          <div class="meta-label">Per-Cmd Limit</div>
          <div class="meta-value">$${config.X402_MAX_PER_CMD_USDC} USDC</div>
        </div>
        <div class="meta-item">
          <div class="meta-label">Daily Limit</div>
          <div class="meta-value">$${config.X402_DAILY_LIMIT_USDC} USDC</div>
        </div>
        <div class="meta-item">
          <div class="meta-label">Auto-Approve Under</div>
          <div class="meta-value">$${config.AUTO_RUN_UNDER_USDC} USDC</div>
        </div>
        <div class="meta-item">
          <div class="meta-label">Tool Allowlist</div>
          <div class="meta-value">${[...config.x402ToolAllowlist].join(", ")}</div>
        </div>
      </div>

      <div class="actions" style="margin-top:24px;">
        <a class="btn btn-primary" href="/dashboard/${encodeURIComponent(docId)}">⚡ Dashboard</a>
        <a class="btn btn-outline" href="/builder/${encodeURIComponent(docId)}">🛠️ Command Builder</a>
        <a class="btn btn-outline" href="/">← Home</a>
      </div>
    `));
  });

  // ─── Structured Receipt Page ────────────────────────────────────
  app.get("/receipt/:docId/:cmdId", (c) => {
    const docId = c.req.param("docId");
    const cmdId = c.req.param("cmdId");
    const summary = orchestrator.buildApprovalSummary(docId, cmdId);
    const spend = orchestrator.buildSpendSummary(docId, cmdId);
    const trace = orchestrator.getTrace(docId, cmdId);
    const kind = summary.command?.parsed?.kind ?? "UNKNOWN";
    const cmd = summary.command;

    const ap2Receipts = trace?.ap2Receipts ?? [];
    const toolReceipts = ap2Receipts.filter(r => r.kind === "TOOL");
    const settlementReceipts = ap2Receipts.filter(r => r.kind === "SETTLEMENT");
    const abortReceipts = ap2Receipts.filter(r => r.kind === "ABORT");
    const encryptedReceipts = ap2Receipts.filter(r => r.kind === "ENCRYPTED");

    const timelineHtml = ap2Receipts.map((receipt, idx) => {
      const payload = receipt.payload as Record<string, any>;
      const color = receipt.kind === "SETTLEMENT" ? "var(--green)"
        : receipt.kind === "TOOL" ? "var(--blue)"
          : receipt.kind === "ABORT" ? "var(--red)"
            : receipt.kind === "ENCRYPTED" ? "var(--orange)"
              : "var(--muted)";
      const reasoning = payload?.agentReasoning ? `<div style="font-size:11px;color:var(--accent);margin-top:4px;font-style:italic;">🧠 ${escapeHtml(String(payload.agentReasoning))}</div>` : "";
      return `
        <div style="display:flex;gap:12px;margin-bottom:16px;">
          <div style="display:flex;flex-direction:column;align-items:center;min-width:24px;">
            <div style="width:10px;height:10px;border-radius:50%;background:${color};margin-top:6px;"></div>
            ${idx < ap2Receipts.length - 1 ? '<div style="width:1px;flex:1;background:var(--border);margin-top:4px;"></div>' : ''}
          </div>
          <div class="card" style="flex:1;margin-bottom:0;">
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <span style="font-weight:600;font-size:13px;color:${color};">${escapeHtml(receipt.kind)}${payload?.tool ? ` — ${escapeHtml(String(payload.tool))}` : ''}</span>
              <span style="font-size:11px;color:var(--muted);">${escapeHtml(receipt.createdAt)}</span>
            </div>
            ${payload?.costUsdc !== undefined ? `<div style="font-size:12px;color:var(--muted);margin-top:4px;">Cost: <strong style="color:var(--text)">$${Number(payload.costUsdc).toFixed(4)}</strong></div>` : ''}
            ${payload?.txHash ? `<div style="font-size:11px;color:var(--muted);margin-top:4px;">TX: <span style="font-family:var(--mono);color:var(--text)">${escapeHtml(String(payload.txHash).slice(0, 20))}…</span></div>` : ''}
            ${payload?.event ? `<div style="font-size:12px;color:var(--muted);margin-top:4px;">Event: <span style="color:var(--text)">${escapeHtml(String(payload.event))}</span></div>` : ''}
            ${reasoning}
          </div>
        </div>`;
    }).join("");

    return c.html(layout(`Receipt — ${cmdId}`, `
      ${headerHtml(config)}
      <a href="/demo/${encodeURIComponent(docId)}" style="color:var(--muted);font-size:12px;">&larr; Demo</a>
      <h2 style="font-size:20px;margin-top:8px;margin-bottom:4px;">📄 Structured Receipt</h2>
      <div class="track-badges" style="margin-bottom:16px;">${trackBadgesForKind(kind)}</div>

      ${cmd ? `<div class="cmd-raw">${escapeHtml(cmd.rawCmd)}</div>` : ""}

      <div class="meta-grid" style="margin-top:16px">
        <div class="meta-item">
          <div class="meta-label">Command ID</div>
          <div class="meta-value">${escapeHtml(cmdId)}</div>
        </div>
        <div class="meta-item">
          <div class="meta-label">Status</div>
          <div class="meta-value">${statusBadge(cmd?.status ?? "UNKNOWN")}</div>
        </div>
        <div class="meta-item">
          <div class="meta-label">Total Spend</div>
          <div class="meta-value" style="color:var(--green)">$${spend.totalUsdc.toFixed(4)} USDC</div>
        </div>
        <div class="meta-item">
          <div class="meta-label">Tool Calls</div>
          <div class="meta-value">${toolReceipts.length} calls</div>
        </div>
      </div>

      <div class="section-title" style="margin-top:20px;">AP2 Authorization</div>
      <div class="meta-grid">
        <div class="meta-item">
          <div class="meta-label">Who Authorized</div>
          <div class="meta-value">${escapeHtml((summary.cart as any)?.signerAddress ?? "Auto-approved")}</div>
        </div>
        <div class="meta-item">
          <div class="meta-label">Intent ID</div>
          <div class="meta-value">${escapeHtml(summary.intent?.id ?? "—")}</div>
        </div>
        <div class="meta-item">
          <div class="meta-label">Max Authorized</div>
          <div class="meta-value">$${(summary.intent?.maxTotalUsdc ?? 0).toFixed(2)} USDC</div>
        </div>
      </div>

      <div class="section-title" style="margin-top:24px;">Receipt Timeline <span class="count">${ap2Receipts.length}</span></div>
      ${timelineHtml || '<p class="empty">No receipts yet.</p>'}

      <div class="section-title">Full Trace (JSON)</div>
      <pre class="json">${escapeHtml(JSON.stringify(trace, null, 2))}</pre>

      <div class="actions">
        <a class="btn btn-outline" href="/cmd/${encodeURIComponent(docId)}/${encodeURIComponent(cmdId)}">🔍 Detail View</a>
        <a class="btn btn-outline" href="/api/receipt/${encodeURIComponent(docId)}/${encodeURIComponent(cmdId)}" target="_blank">📦 Export JSON</a>
        <a class="btn btn-outline" href="/demo/${encodeURIComponent(docId)}">← Demo</a>
      </div>
    `));
  });

  // ─── Encrypted Job Lifecycle Page ───────────────────────────────
  app.get("/encrypted/:docId/:cmdId", (c) => {
    const docId = c.req.param("docId");
    const cmdId = c.req.param("cmdId");
    const job = orchestrator.getEncryptedJob(docId, cmdId) as any;
    const cmd = orchestrator.buildApprovalSummary(docId, cmdId).command;
    const trace = orchestrator.getTrace(docId, cmdId);
    const encryptedReceipts = (trace?.ap2Receipts ?? []).filter((r: any) => r.kind === "ENCRYPTED");

    const condition = job ? JSON.parse(job.conditionJson) : null;
    const encryptedTx = job ? JSON.parse(job.encryptedTxJson) : null;
    const decrypted = job?.decryptedJson ? JSON.parse(job.decryptedJson) : null;

    const conditionMet = condition?.unlockAt ? Date.now() >= Date.parse(condition.unlockAt) : false;

    const phases = [
      {
        icon: "🔒",
        label: "Encrypted",
        detail: "Transaction data encrypted via BITE v2. Amount and recipient hidden.",
        active: job?.status === "PENDING",
        done: job && ["SUBMITTED", "DECRYPTED"].includes(job.status),
        color: "var(--orange)"
      },
      {
        icon: "⏳",
        label: "Condition Check",
        detail: condition?.unlockAt ? `Unlocks at: ${condition.unlockAt}` : "No condition",
        active: job?.status === "PENDING" && !conditionMet,
        done: conditionMet,
        color: "var(--yellow)"
      },
      {
        icon: "📤",
        label: "Submitted",
        detail: job?.txHash ? `TX: ${job.txHash.slice(0, 20)}…` : "Awaiting submission",
        active: job?.status === "SUBMITTED",
        done: job?.status === "DECRYPTED",
        color: "var(--blue)"
      },
      {
        icon: "🔓",
        label: "Decrypted & Executed",
        detail: decrypted ? "Transaction data revealed after finality" : "Pending decryption",
        active: false,
        done: job?.status === "DECRYPTED",
        color: "var(--green)"
      }
    ];

    const phasesHtml = phases.map((phase, idx) => {
      const bg = phase.done ? `rgba(0,214,143,0.1)` : phase.active ? `rgba(255,193,7,0.1)` : `rgba(0,0,0,0.2)`;
      const border = phase.done ? `var(--green)` : phase.active ? `var(--yellow)` : `var(--border)`;
      return `
        <div style="display:flex;gap:12px;margin-bottom:12px;">
          <div style="display:flex;flex-direction:column;align-items:center;min-width:24px;">
            <div style="width:14px;height:14px;border-radius:50%;background:${phase.done ? 'var(--green)' : phase.active ? 'var(--yellow)' : 'var(--border)'};margin-top:4px;display:flex;align-items:center;justify-content:center;font-size:8px;color:white;">${phase.done ? '✓' : ''}</div>
            ${idx < phases.length - 1 ? '<div style="width:1px;flex:1;background:var(--border);margin-top:4px;"></div>' : ''}
          </div>
          <div class="card" style="flex:1;margin-bottom:0;background:${bg};border-color:${border};">
            <div style="font-size:20px;margin-bottom:4px;">${phase.icon}</div>
            <div style="font-weight:600;font-size:14px;">${phase.label}</div>
            <div style="font-size:12px;color:var(--muted);margin-top:4px;">${phase.detail}</div>
          </div>
        </div>`;
    }).join("");

    return c.html(layout(`BITE Lifecycle — ${cmdId}`, `
      ${headerHtml(config)}
      <a href="/receipt/${encodeURIComponent(docId)}/${encodeURIComponent(cmdId)}" style="color:var(--muted);font-size:12px;">&larr; Receipt</a>
      <h2 style="font-size:20px;margin-top:8px;margin-bottom:4px;">🔒 BITE v2 — Encrypted Transaction Lifecycle</h2>
      <div class="track-badges"><span class="badge badge-bite">BITE Encrypted</span><span class="badge badge-overall">Overall</span></div>

      ${cmd ? `<div class="cmd-raw" style="margin-top:12px">${escapeHtml(cmd.rawCmd)}</div>` : ""}

      <div class="section-title" style="margin-top:20px;">Lifecycle Phases</div>
      ${phasesHtml}

      <div class="section-title">🔐 What Stays Encrypted</div>
      <div class="card" style="border-left:3px solid var(--orange);">
        <div class="meta-grid" style="margin:0;">
          <div class="meta-item">
            <div class="meta-label">Recipient</div>
            <div class="meta-value">${job ? '••••••••' + (cmd?.parsed?.kind === 'PRIVATE_PAYOUT' ? (cmd.parsed as any).to?.slice(-6) ?? '' : '') : '—'}</div>
          </div>
          <div class="meta-item">
            <div class="meta-label">Amount</div>
            <div class="meta-value">•••• USDC</div>
          </div>
          <div class="meta-item">
            <div class="meta-label">Condition</div>
            <div class="meta-value">${condition?.type ?? "TIME"}-based unlock</div>
          </div>
          <div class="meta-item">
            <div class="meta-label">Unlock At</div>
            <div class="meta-value">${escapeHtml(condition?.unlockAt ?? "—")}</div>
          </div>
        </div>
      </div>

      ${conditionMet ? `
        <div class="section-title">🔓 Decrypted Result</div>
        <pre class="json">${decrypted ? escapeHtml(JSON.stringify(decrypted, null, 2)) : '{ "status": "awaiting_next_tick" }'}</pre>
      ` : `
        <div class="section-title">⏳ Condition Not Yet Met</div>
        <div class="card" style="border-left:3px solid var(--yellow);">
          <div style="font-size:13px;color:var(--muted);">
            The transaction data will remain encrypted until <strong style="color:var(--text)">${escapeHtml(condition?.unlockAt ?? "the specified time")}</strong>.
            The agent checks each tick cycle and will auto-submit + decrypt when the condition is met.
            If the condition fails, the job stays PENDING and no funds are released.
          </div>
        </div>
      `}

      ${encryptedReceipts.length > 0 ? `
        <div class="section-title">Encrypted Event Log <span class="count">${encryptedReceipts.length}</span></div>
        <pre class="json">${escapeHtml(JSON.stringify(encryptedReceipts, null, 2))}</pre>
      ` : ''}

      ${encryptedTx ? `
        <div class="section-title">Encrypted Payload</div>
        <pre class="json">${escapeHtml(JSON.stringify(encryptedTx, null, 2))}</pre>
      ` : ''}

      <div class="actions">
        <a class="btn btn-outline" href="/receipt/${encodeURIComponent(docId)}/${encodeURIComponent(cmdId)}">📄 Full Receipt</a>
        <a class="btn btn-outline" href="/demo/${encodeURIComponent(docId)}">← Demo</a>
      </div>
    `));
  });

  // ─── API routes ──────────────────────────────────────────────────
  app.post("/api/tick/:docId", async (c) => {
    const docId = c.req.param("docId");
    await orchestrator.tick(docId);

    const accept = c.req.header("accept") ?? "";
    if (accept.includes("text/html")) {
      return c.redirect(`/dashboard/${encodeURIComponent(docId)}`);
    }
    return c.json({ ok: true, docId, tickedAt: new Date().toISOString() });
  });

  app.post("/api/ap2/cmd/:docId/:cmdId/request-approval", async (c) => {
    const docId = c.req.param("docId");
    const cmdId = c.req.param("cmdId");
    const result = await orchestrator.requestApproval(docId, cmdId);

    const accept = c.req.header("accept") ?? "";
    if (accept.includes("text/html")) {
      return c.redirect(`/cmd/${encodeURIComponent(docId)}/${encodeURIComponent(cmdId)}`);
    }
    return c.json(result, result.approved ? 200 : 400);
  });

  app.post("/api/ap2/cmd/:docId/:cmdId/simulate-failure", async (c) => {
    const docId = c.req.param("docId");
    const cmdId = c.req.param("cmdId");
    await orchestrator.simulateAbort(docId, cmdId);

    const accept = c.req.header("accept") ?? "";
    if (accept.includes("text/html")) {
      return c.redirect(`/cmd/${encodeURIComponent(docId)}/${encodeURIComponent(cmdId)}`);
    }
    return c.json({ ok: true, cmdId, docId });
  });

  app.get("/api/ap2/cmd/:docId/:cmdId", (c) => {
    const docId = c.req.param("docId");
    const cmdId = c.req.param("cmdId");
    return c.json(orchestrator.buildApprovalSummary(docId, cmdId));
  });

  app.get("/api/commands/:docId/:cmdId/trace", (c) => {
    const docId = c.req.param("docId");
    const cmdId = c.req.param("cmdId");
    return c.json(orchestrator.getTrace(docId, cmdId));
  });

  // Structured receipt — combines AP2 mandates + x402 spend + settlement
  app.get("/api/receipt/:docId/:cmdId", (c) => {
    const docId = c.req.param("docId");
    const cmdId = c.req.param("cmdId");
    const approval = orchestrator.buildApprovalSummary(docId, cmdId);
    const spend = orchestrator.buildSpendSummary(docId, cmdId);
    const trace = orchestrator.getTrace(docId, cmdId);
    return c.json({
      ok: true,
      receipt: {
        docId,
        cmdId,
        command: approval.command,
        ap2: {
          intent: approval.intent,
          cart: approval.cart
        },
        x402: {
          totalToolCostUsdc: spend.totalUsdc,
          toolReceipts: spend.toolReceipts
        },
        trace,
        exportedAt: new Date().toISOString()
      }
    });
  });

  // Spend summary — per-tool x402 cost breakdown
  app.get("/api/spend-summary/:docId/:cmdId", (c) => {
    const docId = c.req.param("docId");
    const cmdId = c.req.param("cmdId");
    const spend = orchestrator.buildSpendSummary(docId, cmdId);
    return c.json({
      ok: true,
      docId,
      cmdId,
      totalToolCostUsdc: spend.totalUsdc,
      toolReceipts: spend.toolReceipts.map((r: any) => ({
        tool: r.toolName,
        cost: r.costUsdc,
        status: r.retryStatus,
        paidVia: r.paymentAttempted ? "x402" : "free",
        at: r.createdAt
      }))
    });
  });

  const server = serve({
    fetch: app.fetch,
    port: config.PORT
  });

  return {
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error: Error | undefined) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────
function renderCommandCards(docId: string, commands: Array<{ cmdId: string; rawCmd: string; status: string; parsed?: any }>): string {
  if (commands.length === 0) {
    return '<p class="empty">None</p>';
  }
  return commands.map((cmd) => {
    const kind = cmd.parsed?.kind ?? "UNKNOWN";
    return `
    <a href="/cmd/${encodeURIComponent(docId)}/${encodeURIComponent(cmd.cmdId)}" style="text-decoration:none;color:inherit;">
      <div class="card">
        <div class="card-header">
          <span class="cmd-id">${escapeHtml(cmd.cmdId)}</span>
          ${statusBadge(cmd.status)}
        </div>
        <div class="track-badges" style="margin:8px 0 4px">${trackBadgesForKind(kind)}</div>
        <div class="cmd-raw">${escapeHtml(cmd.rawCmd)}</div>
      </div>
    </a>`;
  }).join("");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
