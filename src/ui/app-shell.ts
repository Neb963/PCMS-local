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
    <p>Core inventory uses stable PCMS identity. Display names and slugs are searchable metadata, not identity.</p>

    <section aria-labelledby="service-heading">
      <h2 id="service-heading">Service</h2>
      <dl id="status" aria-live="polite">
        <dt>Service</dt><dd>Loading…</dd>
      </dl>
    </section>

    <section aria-labelledby="attention-heading">
      <h2 id="attention-heading">Attention</h2>
      <p id="attention-state" aria-live="polite">Loading Attention…</p>
      <ul id="attention"></ul>
    </section>

    <section aria-labelledby="accounts-heading">
      <h2 id="accounts-heading">Accounts</h2>
      <p id="accounts-state" aria-live="polite">Loading Accounts…</p>
      <ul id="accounts"></ul>
    </section>

    <section id="persona-panel" aria-labelledby="persona-heading" hidden>
      <h2 id="persona-heading">Bound Persona</h2>
      <dl id="persona" aria-live="polite"></dl>
    </section>

    <section aria-labelledby="search-heading">
      <h2 id="search-heading">Inventory search</h2>
      <form id="search-form">
        <label for="search-query">Account, Persona or Generator metadata</label>
        <div class="row">
          <input id="search-query" name="q" type="search" maxlength="256" required>
          <button type="submit">Search</button>
        </div>
      </form>
      <p id="search-state" aria-live="polite"></p>
      <ul id="search-results"></ul>
    </section>
  </main>
  <script type="module" src="/app.js"></script>
</body>
</html>
`;
}

export const APP_JS = `const token = document.querySelector('meta[name="pcms-api-token"]')?.content;
const connection = document.querySelector("#connection");
const status = document.querySelector("#status");
const attentionState = document.querySelector("#attention-state");
const attentionList = document.querySelector("#attention");
const accountsState = document.querySelector("#accounts-state");
const accountsList = document.querySelector("#accounts");
const personaPanel = document.querySelector("#persona-panel");
const persona = document.querySelector("#persona");
const searchForm = document.querySelector("#search-form");
const searchQuery = document.querySelector("#search-query");
const searchState = document.querySelector("#search-state");
const searchResults = document.querySelector("#search-results");

if (!token) {
  connection.textContent = "Authentication bootstrap missing";
  throw new Error("PCMS API token bootstrap is missing");
}

async function api(path) {
  const response = await fetch(path, {
    headers: { authorization: \`Bearer \${token}\` },
    cache: "no-store"
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error?.message ?? "PCMS API request failed");
  }
  return payload;
}

function replaceDefinitionList(target, rows) {
  target.replaceChildren();
  for (const [label, value] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    target.append(dt, dd);
  }
}

async function openBoundPersona(accountId) {
  personaPanel.hidden = false;
  replaceDefinitionList(persona, [["Account", accountId], ["Persona", "Loading…"]]);
  try {
    const navigation = await api(
      \`/api/v1/accounts/\${encodeURIComponent(accountId)}/persona\`
    );
    if (navigation.persona === null) {
      replaceDefinitionList(persona, [
        ["Account", navigation.accountId],
        ["Persona", "unbound"]
      ]);
      return;
    }
    replaceDefinitionList(persona, [
      ["Account", navigation.accountId],
      ["Persona", navigation.persona.personaUid],
      ["Lifecycle", navigation.persona.lifecycleStatus],
      ["Profile", navigation.persona.profileState],
      ["Backend", navigation.persona.browserBackend]
    ]);
  } catch (error) {
    replaceDefinitionList(persona, [
      ["Account", accountId],
      ["Error", error instanceof Error ? error.message : "Persona lookup failed"]
    ]);
  }
}

async function loadStatus() {
  try {
    const payload = await api("/api/v1/status");
    connection.textContent = "Connected";
    replaceDefinitionList(status, [
      ["Service", payload.service],
      ["Version", payload.version],
      ["Status", payload.status],
      ["Schema", String(payload.database.schemaVersion)]
    ]);
  } catch (error) {
    connection.textContent = "Unavailable";
    status.textContent =
      error instanceof Error ? error.message : "Status request failed";
  }
}

async function loadAttention() {
  try {
    const payload = await api("/api/v1/attention");
    attentionList.replaceChildren();
    if (payload.attention.length === 0) {
      attentionState.textContent = "Nothing needs operator action.";
      return;
    }
    attentionState.textContent =
      `${payload.attention.length} blocking item(s)`;
    for (const task of payload.attention) {
      const item = document.createElement("li");
      const details = document.createElement("span");
      const context = [
        task.accountId ? `Account: ${task.accountId}` : null,
        task.personaUid ? `Persona: ${task.personaUid}` : null,
        task.operationId ? `Operation: ${task.operationId}` : null
      ].filter(Boolean);
      details.textContent =
        `${task.title} — ${task.explanation} — Action: ${task.requiredActionKind}${context.length === 0 ? "" : ` — ${context.join(" | ")}`}`;
      item.append(details);
      attentionList.append(item);
    }
  } catch (error) {
    attentionState.textContent =
      error instanceof Error ? error.message : "Attention query failed";
  }
}

async function loadAccounts() {
  try {
    const payload = await api("/api/v1/accounts");
    accountsList.replaceChildren();
    if (payload.accounts.length === 0) {
      accountsState.textContent = "No Accounts.";
      return;
    }
    accountsState.textContent = \`\${payload.accounts.length} Account(s)\`;
    for (const account of payload.accounts) {
      const item = document.createElement("li");
      const identity = document.createElement("span");
      identity.textContent =
        \`\${account.displayName} — \${account.accountId} — Persona: \${account.personaUid ?? "unbound"}\`;
      item.append(identity);

      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Open bound Persona";
      button.disabled = account.personaUid === null;
      button.addEventListener("click", () => {
        void openBoundPersona(account.accountId);
      });
      item.append(button);
      accountsList.append(item);
    }
  } catch (error) {
    accountsState.textContent =
      error instanceof Error ? error.message : "Account inventory failed";
  }
}

searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void (async () => {
    const query = searchQuery.value.trim();
    if (!query) return;
    searchState.textContent = "Searching…";
    searchResults.replaceChildren();
    try {
      const payload = await api(
        \`/api/v1/search?q=\${encodeURIComponent(query)}\`
      );
      searchState.textContent =
        payload.results.length === 0
          ? "No matches."
          : \`\${payload.results.length} match(es)\`;
      for (const result of payload.results) {
        const item = document.createElement("li");
        const identity = document.createElement("span");
        identity.textContent =
          \`\${result.entityType} \${result.entityId} — \${result.label} (matched \${result.matchedField})\`;
        item.append(identity);
        if (result.entityType === "ACCOUNT") {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = "Open bound Persona";
          button.disabled = result.personaUid === null;
          button.addEventListener("click", () => {
            void openBoundPersona(result.entityId);
          });
          item.append(button);
        }
        searchResults.append(item);
      }
    } catch (error) {
      searchState.textContent =
        error instanceof Error ? error.message : "Search failed";
    }
  })();
});

await Promise.all([loadStatus(), loadAttention(), loadAccounts()]);
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
section {
  margin-top: 1.5rem;
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
ul {
  display: grid;
  gap: 0.5rem;
  padding-left: 1.5rem;
}
li {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
}
.row {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.5rem;
}
input {
  flex: 1;
  min-width: 12rem;
}
button {
  white-space: nowrap;
}
`;
