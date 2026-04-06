import { google } from "googleapis";
import pg from "pg";

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const { rows } = await client.query("SELECT access_token, refresh_token, token_expiry, scope FROM google_auth WHERE user_name = 'David' LIMIT 1");
await client.end();

if (!rows.length) { console.log("NO ROW FOUND"); process.exit(1); }

const row = rows[0];
console.log("=== SCOPE IN DB ===");
const scopeList = (row.scope ?? "").split(" ").filter(Boolean);
scopeList.forEach(s => console.log(" •", s));
console.log("\nhas contacts.readonly:", scopeList.includes("https://www.googleapis.com/auth/contacts.readonly"));
console.log("has calendar (write):", scopeList.includes("https://www.googleapis.com/auth/calendar"));
console.log("token_expiry:", row.token_expiry);
console.log("has_refresh_token:", !!row.refresh_token);

// Build OAuth client and try to refresh
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  "https://placeholder.invalid/callback"  // redirect not needed for refresh
);
oauth2Client.setCredentials({
  access_token: row.access_token,
  refresh_token: row.refresh_token ?? undefined,
  expiry_date: row.token_expiry ? new Date(row.token_expiry).getTime() : undefined,
});

// Refresh the token
console.log("\n=== REFRESHING TOKEN ===");
let freshToken;
try {
  const { credentials } = await oauth2Client.refreshAccessToken();
  freshToken = credentials.access_token;
  console.log("Token refreshed successfully. New expiry:", new Date(credentials.expiry_date ?? 0).toISOString());
} catch (err) {
  console.error("Token refresh FAILED:", err.message);
  process.exit(1);
}

// Test 1: calendar.events.list (read) — should work with 'calendar' scope
console.log("\n=== TEST: Google Calendar (events.list) ===");
const calendar = google.calendar({ version: "v3", auth: oauth2Client });
try {
  const calRes = await calendar.events.list({ calendarId: "primary", maxResults: 1 });
  console.log("Calendar API: OK — HTTP 200. Events found:", calRes.data.items?.length ?? 0);
} catch (err) {
  console.error("Calendar API ERROR:", err.message, "| code:", err.code);
}

// Test 2: People API connections (requires contacts.readonly scope)
console.log("\n=== TEST: Google People API (connections list) ===");
try {
  const resp = await fetch(
    "https://people.googleapis.com/v1/people/me/connections?personFields=names,emailAddresses,phoneNumbers&pageSize=3",
    { headers: { Authorization: `Bearer ${freshToken}` } }
  );
  console.log("People API HTTP status:", resp.status);
  const body = await resp.json();
  if (resp.ok) {
    console.log("People API: OK — connections returned:", (body.connections ?? []).length);
    console.log("Response keys:", Object.keys(body));
  } else {
    console.log("People API ERROR body:", JSON.stringify(body, null, 2));
  }
} catch (err) {
  console.error("People API fetch FAILED:", err.message);
}

// Test 3: People searchContacts (different endpoint)
console.log("\n=== TEST: Google People API (searchContacts endpoint) ===");
try {
  const resp2 = await fetch(
    "https://people.googleapis.com/v1/people:searchContacts?query=test&readMask=names,emailAddresses,phoneNumbers&pageSize=1",
    { headers: { Authorization: `Bearer ${freshToken}` } }
  );
  console.log("searchContacts HTTP status:", resp2.status);
  const body2 = await resp2.json();
  if (!resp2.ok) {
    console.log("searchContacts ERROR body:", JSON.stringify(body2, null, 2));
  } else {
    console.log("searchContacts: OK — results:", (body2.results ?? []).length);
  }
} catch (err) {
  console.error("searchContacts fetch FAILED:", err.message);
}

