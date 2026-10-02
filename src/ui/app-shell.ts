function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function renderAppShell(apiToken: string): string {
  const token = escapeHtmlAttribute(apiToken);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="pcms-api-token" content="${token}">
  <title>PCMS Local</title>
  <link rel="stylesheet" href="/app.css">
</head>
<body>
  <header>
    <strong>PCMS Local</strong>
    <span id="connection">Connecting…</span>
  </header>
  <main>
    <h1>Local control plane</h1>
    <p>This foundation shell exposes daemon and database status only.</p>
    <dl id="status" aria-live="polite">
      <dt>Service</dt><dd>Loading…</dd>
    </dl>
  </main>
  <script type="module" src="/app.js"></script>
</body>
</html>
`;
}

export const APP_JS = `const token = document.querySelector('meta[name="pcms-api-token"]')?.content;
const connection = document.querySelector("#connection");
const status = document.querySelector("#status");

if (!token) {
  connection.textContent = "Authentication bootstrap missing";
  throw new Error("PCMS API token bootstrap is missing");
}

try {
  const response = await fetch("/api/v1/status", {
    headers: { authorization: \`Bearer \${token}\` },
    cache: "no-store"
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message ?? "Status request failed");

  connection.textContent = "Connected";
  status.replaceChildren();

  const rows = [
    ["Service", payload.service],
    ["Version", payload.version],
    ["Status", payload.status],
    ["Schema", String(payload.database.schemaVersion)]
  ];
  for (const [label, value] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    status.append(dt, dd);
  }
} catch (error) {
  connection.textContent = "Unavailable";
  status.textContent = error instanceof Error ? error.message : "Status request failed";
}
`;

export const APP_CSS = `:root {
  color-scheme: light dark;
  font-family: system-ui, sans-serif;
}
body {
  margin: 0;
  max-width: 64rem;
  padding: 1.5rem;
}
header {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  border-bottom: 1px solid currentColor;
  padding-bottom: 0.75rem;
}
main {
  padding-top: 1rem;
}
dl {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.5rem 1rem;
}
dt {
  font-weight: 600;
}
dd {
  margin: 0;
}
`;
