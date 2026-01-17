import "dotenv/config";
import express from "express";
import cookieParser from "cookie-parser";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static("public"));

// ===== CONFIG (env vars) =====
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI;

const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID;
const ROLE_BASIC_ID = process.env.ROLE_BASIC_ID;
const ROLE_PRO_ID = process.env.ROLE_PRO_ID;
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

const SESSION_SECRET = process.env.SESSION_SECRET || "change_me";

// ===== minimal session store (OK for local testing) =====
const sessions = new Map(); // sid -> { discord_user_id, username }

function makeSid() {
  return crypto.randomBytes(24).toString("hex");
}

function sign(value) {
  const h = crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("hex");
  return `${value}.${h}`;
}

function verify(signed) {
  if (!signed || !signed.includes(".")) return null;
  const [value, h] = signed.split(".");
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("hex");
  if (h !== expected) return null;
  return value;
}

function requireAuth(req, res, next) {
  const sid = verify(req.cookies.sid);
  if (!sid || !sessions.has(sid)) return res.status(401).json({ error: "Not logged in" });
  req.sessionId = sid;
  req.session = sessions.get(sid);
  next();
}

function needEnv(name, value) {
  if (!value) {
    console.log(`❌ Missing env var: ${name}`);
    return false;
  }
  return true;
}

// ===== LOGIN ROUTE =====
app.get("/login", (req, res) => {
  if (!needEnv("DISCORD_CLIENT_ID", DISCORD_CLIENT_ID)) return res.status(500).send("Missing DISCORD_CLIENT_ID");
  if (!needEnv("DISCORD_REDIRECT_URI", DISCORD_REDIRECT_URI)) return res.status(500).send("Missing DISCORD_REDIRECT_URI");

  const state = crypto.randomBytes(16).toString("hex");
  res.cookie("oauth_state", state, { httpOnly: true, sameSite: "lax" });

  const url = new URL("https://discord.com/api/oauth2/authorize");
  url.searchParams.set("client_id", DISCORD_CLIENT_ID);
  url.searchParams.set("redirect_uri", DISCORD_REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "identify");
  url.searchParams.set("state", state);

  res.redirect(url.toString());
});

// ===== DISCORD OAUTH CALLBACK =====
app.get("/callback", async (req, res) => {
  const { code, state } = req.query;
  const expectedState = req.cookies.oauth_state;

  if (!code || !state || state !== expectedState) {
    return res.status(400).send("Invalid OAuth state.");
  }

  if (!needEnv("DISCORD_CLIENT_SECRET", DISCORD_CLIENT_SECRET)) return res.status(500).send("Missing DISCORD_CLIENT_SECRET");

  const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: DISCORD_CLIENT_ID,
      client_secret: DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code: String(code),
      redirect_uri: DISCORD_REDIRECT_URI,
    }),
  });

  if (!tokenRes.ok) {
    const txt = await tokenRes.text();
    return res.status(500).send("Token exchange failed: " + txt);
  }

  const tokenData = await tokenRes.json();
  const accessToken = tokenData.access_token;

  const meRes = await fetch("https://discord.com/api/users/@me", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!meRes.ok) {
    const txt = await meRes.text();
    return res.status(500).send("Failed to fetch user: " + txt);
  }

  const me = await meRes.json();

  const sid = makeSid();
  sessions.set(sid, {
    discord_user_id: me.id,
    username: me.username,
  });

  res.clearCookie("oauth_state");
  res.cookie("sid", sign(sid), { httpOnly: true, sameSite: "lax" });
  res.redirect("/");
});

// ===== ROLE CHECKS =====
async function fetchMemberRoles(userId) {
  if (!needEnv("DISCORD_GUILD_ID", DISCORD_GUILD_ID)) return [];
  if (!needEnv("DISCORD_BOT_TOKEN", DISCORD_BOT_TOKEN)) return [];
  if (!needEnv("ROLE_BASIC_ID", ROLE_BASIC_ID)) return [];
  if (!needEnv("ROLE_PRO_ID", ROLE_PRO_ID)) return [];

  const memberRes = await fetch(
    `https://discord.com/api/v10/guilds/${DISCORD_GUILD_ID}/members/${userId}`,
    { headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` } }
  );

  if (memberRes.status === 404) return []; // not in server
  if (!memberRes.ok) {
    const txt = await memberRes.text();
    throw new Error("Member fetch failed: " + txt);
  }

  const member = await memberRes.json();
  return Array.isArray(member.roles) ? member.roles : [];
}

async function getAccess(userId) {
  const roles = await fetchMemberRoles(userId);
  const has_pro = roles.includes(ROLE_PRO_ID);
  const has_basic = has_pro || roles.includes(ROLE_BASIC_ID); // pro includes basic
  return { has_basic, has_pro };
}

// used by the website
app.get("/api/me", requireAuth, async (req, res) => {
  try {
    const access = await getAccess(req.session.discord_user_id);
    res.json({
      discord_user_id: req.session.discord_user_id,
      username: req.session.username,
      ...access,
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ===== Protected downloads (2 tiers) =====
function sendZip(res, filename) {
  const filePath = path.join(__dirname, "premium_files", filename);
  res.sendFile(filePath, (err) => {
    if (err) res.status(404).send("File not found: " + filename);
  });
}

app.get("/premium/files/basic.zip", requireAuth, async (req, res) => {
  try {
    const { has_basic } = await getAccess(req.session.discord_user_id);
    if (!has_basic) return res.status(403).send("No Basic access.");
    return sendZip(res, "basic.zip");
  } catch (e) {
    return res.status(500).send("Role check error: " + String(e.message || e));
  }
});

app.get("/premium/files/pro.zip", requireAuth, async (req, res) => {
  try {
    const { has_pro } = await getAccess(req.session.discord_user_id);
    if (!has_pro) return res.status(403).send("No Pro access.");
    return sendZip(res, "pro.zip");
  } catch (e) {
    return res.status(500).send("Role check error: " + String(e.message || e));
  }
});

app.post("/logout", requireAuth, (req, res) => {
  sessions.delete(req.sessionId);
  res.clearCookie("sid");
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running: http://localhost:${PORT}`));
