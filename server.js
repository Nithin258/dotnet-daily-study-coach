require("dotenv").config();

const express = require("express");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const app = express();
const port = Number(process.env.PORT) || 3000;
const dataDirectory = path.join(__dirname, "data");
const remindersFile = path.join(dataDirectory, "reminders.json");
const tokenFile = path.join(dataDirectory, "google-token.json");
const settingsFile = path.join(dataDirectory, "settings.json");
const gmailScope = "https://www.googleapis.com/auth/gmail.send";
const sentReminderIds = new Set();
const oauthStates = new Map();
let digestSending = false;

app.use(express.json({ limit: "128kb" }));
app.use(express.static(path.join(__dirname, "public")));

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(file, value) {
  await fs.mkdir(dataDirectory, { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2), "utf8");
}

function googleConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

async function getSettings() {
  const saved = await readJson(settingsFile, {});
  return {
    digestEmail: typeof saved.digestEmail === "string" ? saved.digestEmail : "",
    digestTime: typeof saved.digestTime === "string" && /^\d{2}:\d{2}$/.test(saved.digestTime)
      ? saved.digestTime
      : "08:00",
    lastDigestDate: typeof saved.lastDigestDate === "string" ? saved.lastDigestDate : "",
  };
}

app.get("/api/status", async (_request, response, next) => {
  try {
    const token = await readJson(tokenFile, null);
    response.json({
      llmConfigured: Boolean(process.env.LLM_API_KEY),
      gmailConfigured: googleConfigured(),
      gmailConnected: Boolean(token && token.refresh_token),
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/settings", async (_request, response, next) => {
  try {
    const { digestEmail, digestTime } = await getSettings();
    response.json({ digestEmail, digestTime });
  } catch (error) {
    next(error);
  }
});

app.put("/api/settings", async (request, response, next) => {
  try {
    const { digestEmail, digestTime } = request.body || {};
    const normalizedEmail = typeof digestEmail === "string" ? digestEmail.trim() : null;
    if (normalizedEmail === null || normalizedEmail.length > 254 ||
        (normalizedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail))) {
      return response.status(400).json({ error: "Enter a valid email address for your daily plan." });
    }
    if (typeof digestTime !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(digestTime)) {
      return response.status(400).json({ error: "Choose a valid daily email time." });
    }

    const settings = await getSettings();
    settings.digestEmail = normalizedEmail;
    settings.digestTime = digestTime;
    await writeJson(settingsFile, settings);
    response.json({ digestEmail: settings.digestEmail, digestTime: settings.digestTime });
  } catch (error) {
    next(error);
  }
});

app.get("/api/reminders", async (_request, response, next) => {
  try {
    response.json(await readJson(remindersFile, []));
  } catch (error) {
    next(error);
  }
});

app.post("/api/reminders", async (request, response, next) => {
  try {
    const { title, dueAt, email } = request.body || {};
    if (typeof title !== "string" || !title.trim() || title.length > 120) {
      return response.status(400).json({ error: "Enter a task title up to 120 characters." });
    }
    const dueDate = new Date(dueAt);
    if (!dueAt || Number.isNaN(dueDate.getTime())) {
      return response.status(400).json({ error: "Choose a valid reminder date and time." });
    }
    if (email && (typeof email !== "string" || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
      return response.status(400).json({ error: "Enter a valid email address." });
    }

    const reminders = await readJson(remindersFile, []);
    const reminder = {
      id: crypto.randomUUID(),
      title: title.trim(),
      dueAt: dueDate.toISOString(),
      email: email ? email.trim() : "",
      done: false,
      emailSent: false,
      createdAt: new Date().toISOString(),
    };
    reminders.push(reminder);
    await writeJson(remindersFile, reminders);
    response.status(201).json(reminder);
  } catch (error) {
    next(error);
  }
});

app.patch("/api/reminders/:id", async (request, response, next) => {
  try {
    const reminders = await readJson(remindersFile, []);
    const reminder = reminders.find((item) => item.id === request.params.id);
    if (!reminder) return response.status(404).json({ error: "Study task not found." });
    if (typeof request.body.done !== "boolean") {
      return response.status(400).json({ error: "A done status is required." });
    }
    reminder.done = request.body.done;
    await writeJson(remindersFile, reminders);
    response.json(reminder);
  } catch (error) {
    next(error);
  }
});

app.delete("/api/reminders/:id", async (request, response, next) => {
  try {
    const reminders = await readJson(remindersFile, []);
    const updated = reminders.filter((item) => item.id !== request.params.id);
    if (updated.length === reminders.length) {
      return response.status(404).json({ error: "Study task not found." });
    }
    await writeJson(remindersFile, updated);
    sentReminderIds.delete(request.params.id);
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.post("/api/chat", async (request, response) => {
  const { messages } = request.body || {};
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 30) {
    return response.status(400).json({ error: "Send between 1 and 30 chat messages." });
  }
  const validMessages = messages.every((message) =>
    message &&
    ["user", "assistant"].includes(message.role) &&
    typeof message.content === "string" &&
    message.content.length <= 4000
  );
  if (!validMessages) return response.status(400).json({ error: "One or more chat messages are invalid." });

  if (!process.env.LLM_API_KEY) {
    const latestQuestion = [...messages].reverse().find((message) => message.role === "user")?.content || "";
    return response.json({ reply: offlineTutorReply(latestQuestion) });
  }

  try {
    const baseUrl = (process.env.LLM_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
    const upstream = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.LLM_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.LLM_MODEL || "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: "You are SharpStudy, a patient C# exam-prep tutor. Explain concepts clearly, use short C# examples, ask a quick check-for-understanding question, and correct misconceptions kindly. Keep answers focused on C# and programming study.",
          },
          ...messages,
        ],
      }),
    });
    if (!upstream.ok) {
      const details = await upstream.text();
      console.error(`LLM request failed (${upstream.status}): ${details.slice(0, 500)}`);
      const errorMessages = {
        401: "Google AI Studio rejected the API key. Check LLM_API_KEY in .env.",
        403: "Google AI Studio denied this request. Check that the key has Gemini API access and available quota.",
        404: "Google AI Studio could not find this Gemini model. Check LLM_MODEL in .env.",
        429: "Google AI Studio rate limit or quota reached. Wait a little, then try again or check your quota.",
        503: "Google AI Studio is temporarily busy. Your request could not be served right now; wait a minute and try again.",
      };
      return response.status(502).json({
        error: errorMessages[upstream.status] ||
          "Google AI Studio could not answer right now. Please try again shortly.",
      });
    }
    const result = await upstream.json();
    const reply = result.choices?.[0]?.message?.content;
    if (typeof reply !== "string" || !reply.trim()) {
      return response.status(502).json({ error: "The AI tutor returned an empty answer. Please try again." });
    }
    response.json({ reply });
  } catch (error) {
    console.error("LLM request failed:", error.message);
    response.status(502).json({ error: "Could not reach the AI tutor. Check your connection and try again." });
  }
});

app.get("/auth/google", (request, response) => {
  if (!googleConfigured()) {
    return response.redirect("/?gmail=setup");
  }
  for (const [pendingState, expiresAt] of oauthStates) {
    if (expiresAt <= Date.now()) oauthStates.delete(pendingState);
  }
  const state = crypto.randomBytes(32).toString("hex");
  oauthStates.set(state, Date.now() + 5 * 60_000);
  const authorizationUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authorizationUrl.search = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: process.env.GOOGLE_REDIRECT_URI || `http://localhost:${port}/auth/google/callback`,
    response_type: "code",
    state,
    scope: `openid email ${gmailScope}`,
    access_type: "offline",
    prompt: "consent",
  });
  response.redirect(authorizationUrl);
});

app.get("/auth/google/callback", async (request, response) => {
  const state = request.query.state;
  const expiresAt = typeof state === "string" ? oauthStates.get(state) : undefined;
  if (!expiresAt || expiresAt < Date.now()) {
    if (typeof state === "string") oauthStates.delete(state);
    return response.status(400).send("Gmail authorization expired or was invalid. Please try connecting again.");
  }
  oauthStates.delete(state);
  if (request.query.error) return response.redirect("/?gmail=denied");
  if (typeof request.query.code !== "string") return response.status(400).send("Google did not return an authorization code.");
  try {
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: request.query.code,
        client_id: process.env.GOOGLE_CLIENT_ID || "",
        client_secret: process.env.GOOGLE_CLIENT_SECRET || "",
        redirect_uri: process.env.GOOGLE_REDIRECT_URI || `http://localhost:${port}/auth/google/callback`,
        grant_type: "authorization_code",
      }),
    });
    const token = await tokenResponse.json();
    if (!tokenResponse.ok) {
      console.error("Google token exchange failed:", token.error_description || token.error);
      return response.status(502).send("Could not connect Gmail. Check your Google OAuth settings and try again.");
    }
    await writeJson(tokenFile, token);
    response.redirect("/?gmail=connected");
  } catch (error) {
    console.error("Google OAuth failed:", error.message);
    response.status(502).send("Could not connect Gmail.");
  }
});

app.post("/api/gmail/disconnect", async (_request, response, next) => {
  try {
    const token = await readJson(tokenFile, null);
    if (token?.refresh_token) {
      const revokeResponse = await fetch("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: token.refresh_token }),
      });
      if (!revokeResponse.ok) {
        return response.status(502).json({ error: "Google could not revoke access. Try again." });
      }
    }
    await fs.rm(tokenFile, { force: true });
    response.json({ connected: false });
  } catch (error) {
    next(error);
  }
});

function offlineTutorReply(question) {
  const text = question.toLowerCase();
  if (text.includes("async") || text.includes("await")) {
    return "In C#, `async` and `await` make asynchronous work easier to read. An async method commonly returns `Task` or `Task<T>`:\n\n```csharp\npublic async Task<string> LoadAsync()\n{\n    string text = await File.ReadAllTextAsync(\"notes.txt\");\n    return text;\n}\n```\n\n`await` yields control while the task completes instead of blocking the current thread. Quick check: why should you avoid `.Result` in UI code?";
  }
  if (text.includes("class") || text.includes("object")) {
    return "A **class** is a blueprint; an **object** is an instance created from it. For example:\n\n```csharp\nclass Student\n{\n    public string Name { get; set; } = \"\";\n}\n\nvar student = new Student { Name = \"Mina\" };\n```\n\n`Student` is the class and `student` is an object. Quick check: what does `new` do here?";
  }
  if (text.includes("interface")) {
    return "An **interface** defines a contract that a type agrees to implement:\n\n```csharp\ninterface IPrintable\n{\n    void Print();\n}\n\nclass Report : IPrintable\n{\n    public void Print() => Console.WriteLine(\"Report\");\n}\n```\n\nUse interfaces to describe capabilities and make implementations easier to swap or test. Quick check: which member must `Report` implement?";
  }
  return "I'm your C# study tutor. I can help with types, classes, interfaces, LINQ, collections, exceptions, async/await, and exam-style questions. Add an `LLM_API_KEY` to `.env` for full AI-powered answers. What C# topic should we tackle?";
}

async function getGoogleAccessToken(refreshToken) {
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const token = await tokenResponse.json();
  if (!tokenResponse.ok || !token.access_token) {
    throw new Error(token.error_description || "Could not refresh Google access token.");
  }
  return token.access_token;
}

async function sendGmailMessage(recipient, subject, body, refreshToken) {
  const accessToken = await getGoogleAccessToken(refreshToken);
  const rawMessage = [
    `To: ${recipient}`,
    `Subject: ${subject.replace(/[\r\n]/g, " ")}`,
    "Content-Type: text/plain; charset=UTF-8",
    "MIME-Version: 1.0",
    "",
    body,
  ].join("\r\n");
  const encodedMessage = Buffer.from(rawMessage)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const sendResponse = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw: encodedMessage }),
  });
  if (!sendResponse.ok) {
    const details = await sendResponse.text();
    throw new Error(`Gmail send failed (${sendResponse.status}): ${details.slice(0, 300)}`);
  }
}

async function sendGmailReminder(reminder, refreshToken) {
  const body = `This is your C# study reminder:\n\n${reminder.title}\n\nOpen SharpStudy to mark it complete.`;
  await sendGmailMessage(reminder.email, `SharpStudy reminder: ${reminder.title}`, body, refreshToken);
}

function localDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function sendDailyPlanEmail(reminders, settings, refreshToken, today) {
  const todaysReminders = reminders
    .filter((reminder) => localDateKey(new Date(reminder.dueAt)) === today)
    .sort((left, right) => new Date(left.dueAt) - new Date(right.dueAt));
  const lines = todaysReminders.length
    ? todaysReminders.map((reminder) => {
      const time = new Date(reminder.dueAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      return `${reminder.done ? "[Done]" : "[To do]"} ${time} - ${reminder.title}`;
    })
    : ["No study tasks are planned for today yet."];
  const pendingCount = todaysReminders.filter((reminder) => !reminder.done).length;
  const body = [
    `Here is your C# study plan for ${today}.`,
    "",
    ...lines,
    "",
    `${pendingCount} task${pendingCount === 1 ? "" : "s"} still to do.`,
    "",
    "You’ve got this!",
  ].join("\n");
  await sendGmailMessage(
    settings.digestEmail,
    `Your SharpStudy plan for ${today}`,
    body,
    refreshToken
  );
}

async function checkDueReminders() {
  try {
    const reminders = await readJson(remindersFile, []);
    const token = await readJson(tokenFile, null);
    const now = Date.now();
    const settings = await getSettings();
    let updated = false;
    for (const reminder of reminders) {
      if (!reminder.done && reminder.email && !reminder.emailSent &&
          !sentReminderIds.has(reminder.id) && new Date(reminder.dueAt).getTime() <= now) {
        if (!googleConfigured() || !token?.refresh_token) continue;
        sentReminderIds.add(reminder.id);
        try {
          await sendGmailReminder(reminder, token.refresh_token);
          reminder.emailSent = true;
          updated = true;
        } catch (error) {
          sentReminderIds.delete(reminder.id);
          console.error(`Could not email reminder "${reminder.title}":`, error.message);
        }
      }
    }
    if (updated) await writeJson(remindersFile, reminders);

    if (!digestSending && settings.digestEmail && googleConfigured() && token?.refresh_token) {
      const currentDate = new Date();
      const today = localDateKey(currentDate);
      const currentTime = `${String(currentDate.getHours()).padStart(2, "0")}:${String(currentDate.getMinutes()).padStart(2, "0")}`;
      if (currentTime >= settings.digestTime && settings.lastDigestDate !== today) {
        digestSending = true;
        try {
          await sendDailyPlanEmail(reminders, settings, token.refresh_token, today);
          settings.lastDigestDate = today;
          await writeJson(settingsFile, settings);
          console.log(`Sent daily study plan for ${today}.`);
        } finally {
          digestSending = false;
        }
      }
    }
  } catch (error) {
    console.error("Reminder check failed:", error.message);
  }
}

setInterval(checkDueReminders, 60_000).unref();
checkDueReminders();
app.listen(port, "127.0.0.1", () => console.log(`SharpStudy is running at http://localhost:${port}`));
