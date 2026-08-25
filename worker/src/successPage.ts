// ── Hosted Checkout success page ──
//
// Plain HTML + inline JS, served by the Worker itself (no build step, no
// external assets — this loads in whatever system browser Electron's
// shell.openExternal opened). Polls for the credential, then tries the
// bethaniel:// deep link automatically while always showing a manual
// copy-paste fallback code, since the protocol handler isn't guaranteed to
// be registered on every machine.

export function renderSuccessPage(sessionId: string): string {
  const escapedSessionId = sessionId.replace(/[^a-zA-Z0-9_.-]/g, "");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Betty in the Cloud — payment received</title>
<style>
  :root { color-scheme: light; }
  body {
    font-family: Georgia, "Times New Roman", serif;
    background: #faf8f4;
    color: #2a2318;
    max-width: 560px;
    margin: 4rem auto;
    padding: 0 1.5rem;
    text-align: center;
  }
  h1 { font-size: 1.4rem; margin-bottom: 0.5rem; }
  p { color: #5a4d3a; line-height: 1.5; }
  .spinner {
    width: 32px; height: 32px; margin: 2rem auto;
    border: 3px solid #d9c9a8; border-top-color: #8b7355;
    border-radius: 50%; animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .code-box {
    display: none;
    margin-top: 1.5rem;
    padding: 1rem;
    background: #fff;
    border: 1.5px solid #d9c9a8;
    border-radius: 10px;
  }
  .code {
    font-family: "Courier New", monospace;
    font-size: 1.1rem;
    letter-spacing: 0.05em;
    word-break: break-all;
    color: #1a140a;
  }
  button {
    margin-top: 0.75rem;
    font-family: inherit;
    font-size: 0.9rem;
    padding: 0.5rem 1rem;
    border-radius: 8px;
    border: 1.5px solid #8b7355;
    background: #1a140a;
    color: #f7f1e3;
    cursor: pointer;
  }
  .error { color: #a33; display: none; }
</style>
</head>
<body>
  <h1>Payment received</h1>
  <p id="status-text">Activating your cloud credit — this only takes a moment…</p>
  <div class="spinner" id="spinner"></div>

  <div class="code-box" id="code-box">
    <p>Betty didn't open automatically? Copy this code and paste it into Bethaniel's "Betty in the Cloud" panel:</p>
    <div class="code" id="code"></div>
    <button id="copy-btn" type="button">Copy code</button>
  </div>

  <p class="error" id="error-text">
    Something went wrong activating your credit. If you were charged, contact
    support with this reference: <code>${escapedSessionId}</code>
  </p>

<script>
(function () {
  var sessionId = ${JSON.stringify(escapedSessionId)};
  var attempts = 0;
  var maxAttempts = 20; // ~30s at 1.5s intervals
  var claimed = false;

  function showCode(token) {
    document.getElementById("spinner").style.display = "none";
    document.getElementById("status-text").textContent =
      "Your cloud credit is ready.";
    var box = document.getElementById("code-box");
    box.style.display = "block";
    document.getElementById("code").textContent = token;
    document.getElementById("copy-btn").onclick = function () {
      navigator.clipboard.writeText(token).then(function () {
        var btn = document.getElementById("copy-btn");
        btn.textContent = "Copied!";
        setTimeout(function () { btn.textContent = "Copy code"; }, 1500);
      });
    };
  }

  function showError() {
    document.getElementById("spinner").style.display = "none";
    document.getElementById("status-text").style.display = "none";
    document.getElementById("error-text").style.display = "block";
  }

  function poll() {
    attempts++;
    fetch("/v1/credential?session_id=" + encodeURIComponent(sessionId))
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data.status === "issued" && data.token) {
          claimed = true;
          showCode(data.token);
          // Best-effort auto-open — silently does nothing if no handler is
          // registered for the scheme, which is why the code above is always
          // shown regardless of whether this works.
          window.location.href =
            "bethaniel://claim?token=" + encodeURIComponent(data.token) +
            "&model=" + encodeURIComponent(data.model || "");
          return;
        }
        if (attempts < maxAttempts) {
          setTimeout(poll, 1500);
        } else {
          showError();
        }
      })
      .catch(function () {
        if (attempts < maxAttempts) setTimeout(poll, 1500);
        else showError();
      });
  }

  poll();
})();
</script>
</body>
</html>`;
}

export function renderCancelledPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Checkout cancelled</title>
<style>
  body { font-family: Georgia, serif; background: #faf8f4; color: #2a2318;
         max-width: 480px; margin: 4rem auto; padding: 0 1.5rem; text-align: center; }
</style>
</head>
<body>
  <h1>Checkout cancelled</h1>
  <p>No charge was made. You can close this tab and try again from Bethaniel whenever you're ready.</p>
</body>
</html>`;
}
