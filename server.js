require("dotenv").config();

const express = require("express");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const nodemailer = require("nodemailer");

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

app.use(express.json({ limit: "15mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use(express.static(__dirname, {
  dotfiles: "ignore",
  index: "index.html",
}));

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

function isGmailConfigured() {
  return Boolean(
    (process.env.GMAIL_ADDRESS && process.env.GMAIL_APP_PASSWORD) ||
    (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)
  );
}

function googleConfigured() {
  return isGmailConfigured();
}

async function getSettings() {
  const saved = await readJson(settingsFile, {});
  return {
    digestEmail: typeof saved.digestEmail === "string" ? saved.digestEmail : (process.env.GMAIL_ADDRESS || ""),
    digestTime: typeof saved.digestTime === "string" && /^\d{2}:\d{2}$/.test(saved.digestTime)
      ? saved.digestTime
      : "08:00",
    lastDigestDate: typeof saved.lastDigestDate === "string" ? saved.lastDigestDate : "",
  };
}

app.get("/api/status", async (_request, response, next) => {
  try {
    const token = await readJson(tokenFile, null);
    const hasSmtp = Boolean(process.env.GMAIL_ADDRESS && process.env.GMAIL_APP_PASSWORD);
    const hasOAuth = Boolean(token && token.refresh_token);
    const gmailConnected = hasSmtp || hasOAuth;
    response.json({
      llmConfigured: Boolean(process.env.LLM_API_KEY),
      model: process.env.LLM_MODEL || "gemini-3.8-flash",
      gmailConfigured: isGmailConfigured(),
      gmailConnected,
      gmailAddress: process.env.GMAIL_ADDRESS || "",
      method: hasSmtp ? "SMTP (App Password)" : hasOAuth ? "OAuth" : "None",
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
    const { title, dueAt, email, notifyImmediately } = request.body || {};
    if (typeof title !== "string" || !title.trim() || title.length > 120) {
      return response.status(400).json({ error: "Enter a task title up to 120 characters." });
    }
    const dueDate = new Date(dueAt);
    if (!dueAt || Number.isNaN(dueDate.getTime())) {
      return response.status(400).json({ error: "Choose a valid reminder date and time." });
    }
    const targetEmail = (email || process.env.GMAIL_ADDRESS || "").trim();
    if (targetEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(targetEmail)) {
      return response.status(400).json({ error: "Enter a valid email address." });
    }

    const reminders = await readJson(remindersFile, []);
    const reminder = {
      id: crypto.randomUUID(),
      title: title.trim(),
      dueAt: dueDate.toISOString(),
      email: targetEmail,
      done: false,
      emailSent: false,
      createdAt: new Date().toISOString(),
    };

    if (notifyImmediately && targetEmail && isGmailConfigured()) {
      try {
        await sendGmailReminder(reminder, "scheduled");
        reminder.emailSent = true;
      } catch (err) {
        console.error("Instant notification error:", err.message);
      }
    }

    reminders.push(reminder);
    await writeJson(remindersFile, reminders);
    response.status(201).json(reminder);
  } catch (error) {
    next(error);
  }
});

app.post("/api/reminders/:id/notify", async (request, response, next) => {
  try {
    const reminders = await readJson(remindersFile, []);
    const reminder = reminders.find((item) => item.id === request.params.id);
    if (!reminder) return response.status(404).json({ error: "Study task not found." });
    const targetEmail = (request.body?.email || reminder.email || process.env.GMAIL_ADDRESS || "").trim();
    if (!targetEmail) {
      return response.status(400).json({ error: "Enter a valid email address to receive notification." });
    }
    reminder.email = targetEmail;
    await sendGmailReminder(reminder, "manual");
    reminder.emailSent = true;
    await writeJson(remindersFile, reminders);
    response.json({ success: true, message: `Notification email sent to ${targetEmail}!` });
  } catch (error) {
    console.error("Task notification failed:", error.message);
    response.status(500).json({ error: `Could not send email: ${error.message}` });
  }
});

app.post("/api/gmail/test", async (request, response) => {
  const targetEmail = (request.body?.recipient || process.env.GMAIL_ADDRESS || "").trim();
  if (!targetEmail) {
    return response.status(400).json({ error: "Provide a recipient email address." });
  }
  try {
    await sendEmailMessage({
      to: targetEmail,
      subject: "⚡ SharpStudy Gmail Automation Test",
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 580px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 16px; background: #ffffff;">
          <div style="background: linear-gradient(135deg, #6366f1, #8b5cf6); padding: 18px 22px; border-radius: 12px; color: #fff; margin-bottom: 20px;">
            <h1 style="margin: 0; font-size: 20px;">✨ SharpStudy Gmail Automation</h1>
            <p style="margin: 4px 0 0; font-size: 13px; opacity: 0.9;">C# & .NET Study Coach Notification System</p>
          </div>
          <h2 style="color: #0f172a; font-size: 17px; margin: 0 0 10px;">Test Notification Successful!</h2>
          <p style="color: #475569; font-size: 13px; line-height: 1.6;">
            Your Gmail automation is working. Study task reminders and daily learning plans will be sent directly to your inbox.
          </p>
          <div style="margin: 18px 0; padding: 14px; border-radius: 10px; background: #f8fafc; border: 1px solid #e2e8f0; font-size: 12px; color: #334155;">
            <p style="margin: 0;"><strong>Sender:</strong> ${process.env.GMAIL_ADDRESS}</p>
            <p style="margin: 5px 0 0;"><strong>Delivered to:</strong> ${targetEmail}</p>
            <p style="margin: 5px 0 0;"><strong>Timestamp:</strong> ${new Date().toLocaleString()}</p>
          </div>
          <p style="color: #64748b; font-size: 11px; margin: 0;">Happy coding! Small daily steps build great software.</p>
        </div>
      `,
      text: `SharpStudy Gmail Test\n\nGmail notification is active!\nSender: ${process.env.GMAIL_ADDRESS}\nRecipient: ${targetEmail}\nTime: ${new Date().toLocaleString()}`,
    });
    response.json({ success: true, message: `Test email successfully sent to ${targetEmail}!` });
  } catch (error) {
    console.error("Test email error:", error.message);
    response.status(500).json({ error: `Gmail delivery failed: ${error.message}` });
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

const PERSONA_PROMPTS = {
  tutor: "You are SharpStudy, an expert, inspiring, and patient C# & .NET tutor and daily coach. Explain concepts clearly with modern C# code snippets (C# 12/13), practical exam insights, and formatting in clean Markdown with code blocks.",
  architect: "You are SharpStudy Architect, a Principal .NET Solutions Architect. Give deep architectural insights into SOLID design principles, async/await patterns, memory performance (Span<T>, Memory<T>, pooling), clean architecture, and ASP.NET Core APIs. Include production-grade C# code examples.",
  quiz: "You are SharpStudy Quiz Master. Challenge the learner with an interactive, exam-style C# question or code puzzle with multiple choice options (A, B, C, D). When they reply with their answer, immediately evaluate it, explain why each option is correct or incorrect, and award encouragement.",
  debugger: "You are SharpStudy Code Doctor & Debugger. Analyze C# compiler errors, runtime exceptions, LINQ logic bugs, and async pitfalls. Provide the exact fix, explain what caused the issue, and demonstrate best-practice clean code.",
};

app.post("/api/chat", async (request, response) => {
  const { messages, persona = "tutor" } = request.body || {};
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

  const systemContent = PERSONA_PROMPTS[persona] || PERSONA_PROMPTS.tutor;

  if (!process.env.LLM_API_KEY) {
    const latestQuestion = [...messages].reverse().find((message) => message.role === "user")?.content || "";
    return response.json({ reply: offlineTutorReply(latestQuestion, persona) });
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
        model: process.env.LLM_MODEL || "gemini-3.8-flash",
        messages: [
          {
            role: "system",
            content: systemContent,
          },
          ...messages,
        ],
      }),
    });
    if (!upstream.ok) {
      const details = await upstream.text();
      console.error(`LLM request failed (${upstream.status}): ${details.slice(0, 500)}`);
      
      // If the API key is invalid/rejected by Google, gracefully fallback to the built-in C# tutor
      if (upstream.status === 400 || upstream.status === 401) {
        const latestQuestion = [...messages].reverse().find((m) => m.role === "user")?.content || "";
        const fallbackAnswer = offlineTutorReply(latestQuestion, persona);
        const replyWithNotice = `${fallbackAnswer}\n\n---\n> ⚠️ **Google AI Studio Key Notice**: Your \`LLM_API_KEY\` in \`.env\` was rejected by Google (*Invalid Auth Key*). The answer above was generated using the built-in C# tutor engine. Click **Set up AI** in the top bar to paste your active Gemini API key from [aistudio.google.com/apikey](https://aistudio.google.com/apikey).`;
        return response.json({ reply: replyWithNotice, keyInvalid: true });
      }

      const errorMessages = {
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

app.post("/api/transcribe", async (request, response) => {
  const { audioBase64, mimeType } = request.body || {};
  if (!audioBase64) {
    return response.status(400).json({ error: "Audio data is required." });
  }
  if (!process.env.LLM_API_KEY) {
    return response.status(400).json({ error: "LLM_API_KEY is not configured on the server." });
  }
  try {
    const model = process.env.LLM_MODEL || "gemini-3.8-flash";
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.LLM_API_KEY}`;
    const upstream = await fetch(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: "Transcribe the spoken audio into text accurately. Output only the transcribed text with no additional notes.",
              },
              {
                inlineData: {
                  mimeType: mimeType || "audio/webm",
                  data: audioBase64,
                },
              },
            ],
          },
        ],
      }),
    });
    if (!upstream.ok) {
      const err = await upstream.text();
      console.error("Transcribe failed:", err.slice(0, 300));
      return response.status(502).json({ error: "Audio transcription failed." });
    }
    const data = await upstream.json();
    const transcript = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
    response.json({ transcript });
  } catch (error) {
    console.error("Transcription error:", error);
    response.status(500).json({ error: "Could not transcribe audio." });
  }
});

app.put("/api/ai-key", async (request, response) => {
  const { apiKey } = request.body || {};
  const trimmed = typeof apiKey === "string" ? apiKey.trim() : "";
  if (!trimmed) {
    return response.status(400).json({ error: "Please provide a valid Google AI Studio key." });
  }

  try {
    const testRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${trimmed}`);
    if (!testRes.ok) {
      const errBody = await testRes.text();
      return response.status(400).json({
        error: `Google AI Studio rejected this key (${testRes.status}). Please check your key at https://aistudio.google.com/apikey.`
      });
    }

    const envPath = path.join(__dirname, ".env");
    let envContent = "";
    try {
      envContent = await fs.readFile(envPath, "utf8");
    } catch {
      envContent = "";
    }

    if (/^LLM_API_KEY=.*/m.test(envContent)) {
      envContent = envContent.replace(/^LLM_API_KEY=.*/m, `LLM_API_KEY="${trimmed}"`);
    } else {
      envContent += `\nLLM_API_KEY="${trimmed}"\n`;
    }
    await fs.writeFile(envPath, envContent, "utf8");
    process.env.LLM_API_KEY = trimmed;

    response.json({ success: true, message: "Gemini API key verified and connected successfully!" });
  } catch (err) {
    console.error("Failed to update AI key:", err.message);
    response.status(500).json({ error: `Could not verify key: ${err.message}` });
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

function offlineTutorReply(question, persona = "tutor") {
  const text = question.toLowerCase();
  if (persona === "quiz") {
    return "### 🎯 Quick C# Knowledge Check\n\n**Which statement correctly describes `ValueTask<T>` compared to `Task<T>` in modern .NET?**\n\n- **A)** `ValueTask<T>` is a reference type allocated on the managed heap.\n- **B)** `ValueTask<T>` is a struct that avoids heap allocation when the result is already available synchronously.\n- **C)** `ValueTask<T>` can be awaited multiple times concurrently.\n- **D)** `ValueTask<T>` is only available in .NET Framework 4.8.\n\n*Reply with your choice (A, B, C, or D) to check your answer!*";
  }
  if (persona === "architect") {
    return "### 🏛️ .NET Clean Architecture & Lifetimes\n\nWhen configuring dependency injection in ASP.NET Core, lifetime choice is critical:\n\n1. **Transient** (`AddTransient`): Lightweight, stateless services created on every request.\n2. **Scoped** (`AddScoped`): Created once per HTTP request (ideal for `DbContext`).\n3. **Singleton** (`AddSingleton`): Created once for the entire application lifetime.\n\n```csharp\nbuilder.Services.AddScoped<IOrderService, OrderService>();\nbuilder.Services.AddSingleton<ICacheProvider, MemoryCacheProvider>();\n```\n\n*Architect Tip: Avoid injecting Scoped services directly into Singletons to prevent captive dependencies!*";
  }
  if (persona === "debugger") {
    return "### 🔍 Debugging Tip: Handling `NullReferenceException`\n\nIn modern C#, enable Nullable Reference Types (`#nullable enable`) to catch null bugs at compile time:\n\n```csharp\n#nullable enable\nstring? maybeNull = GetUser();\n// Safe navigation + null-coalescing:\nstring name = maybeNull?.Trim() ?? \"Anonymous\";\n```\n\nPaste your error message or broken code and I will identify the root cause!";
  }
  if (text.includes("async") || text.includes("await")) {
    return "### ⚡ Understanding `async` and `await` in C#\n\nIn C#, `async` and `await` yield control back to the caller while I/O completes instead of blocking threads:\n\n```csharp\npublic async Task<string> LoadDataAsync()\n{\n    using var client = new HttpClient();\n    string text = await client.GetStringAsync(\"https://api.example.com\");\n    return text;\n}\n```\n\n**Best Practice:** Never use `.Result` or `.Wait()` because they can lead to thread pool starvation or deadlocks!";
  }
  if (text.includes("class") || text.includes("object")) {
    return "### 📦 Classes vs Objects in C#\n\nA **class** is a blueprint, while an **object** is the instance created in memory:\n\n```csharp\npublic class Student\n{\n    public required string Name { get; init; }\n}\n\nvar student = new Student { Name = \"Mina\" };\n```\n\n`Student` is the blueprint, and `student` is the live object stored on the managed heap.";
  }
  if (text.includes("interface")) {
    return "### 🔌 Interfaces in C#\n\nAn **interface** defines a contract that classes implement:\n\n```csharp\npublic interface IPrintable\n{\n    void Print();\n}\n\npublic class Report : IPrintable\n{\n    public void Print() => Console.WriteLine(\"Report rendered.\");\n}\n```\n\nInterfaces enable polymorphism and make unit testing with mocks effortless.";
  }
  return "👋 I'm **SharpStudy**, your C# & .NET study coach! I can help you with language syntax, LINQ queries, OOP principles, async/await, ASP.NET Core, and exam-style test questions.\n\nType a question or press the 🎙️ **Voice button** to ask with your voice!";
}

function getMailTransporter() {
  if (process.env.GMAIL_ADDRESS && process.env.GMAIL_APP_PASSWORD) {
    return nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.GMAIL_ADDRESS.trim(),
        pass: process.env.GMAIL_APP_PASSWORD.replace(/\s+/g, "").trim(),
      },
    });
  }
  return null;
}

async function sendEmailMessage({ to, subject, html, text }) {
  const transporter = getMailTransporter();
  if (transporter) {
    const info = await transporter.sendMail({
      from: `"SharpStudy Coach" <${process.env.GMAIL_ADDRESS.trim()}>`,
      to,
      subject,
      text: text || "",
      html: html || text || "",
    });
    console.log(`[Gmail SMTP] Sent email to ${to} (MessageId: ${info.messageId})`);
    return info;
  }

  // Fallback to Google OAuth API if token file exists
  const token = await readJson(tokenFile, null);
  if (token?.refresh_token) {
    const accessToken = await getGoogleAccessToken(token.refresh_token);
    const rawMessage = [
      `To: ${to}`,
      `Subject: ${subject.replace(/[\r\n]/g, " ")}`,
      "Content-Type: text/html; charset=UTF-8",
      "MIME-Version: 1.0",
      "",
      html || text,
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
      throw new Error(`Gmail API error (${sendResponse.status}): ${details.slice(0, 300)}`);
    }
    console.log(`[Gmail OAuth API] Sent email to ${to}`);
    return;
  }

  throw new Error("No Gmail credentials available. Check GMAIL_ADDRESS and GMAIL_APP_PASSWORD in .env.");
}

async function sendGmailReminder(reminder, reason = "due") {
  const dueFormatted = new Date(reminder.dueAt).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const isScheduled = reason === "scheduled";
  const subject = isScheduled
    ? `📅 Task Scheduled: ${reminder.title}`
    : `🔔 Study Reminder: ${reminder.title}`;

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 580px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 16px; background: #ffffff;">
      <div style="background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%); padding: 18px 24px; border-radius: 12px; color: #ffffff; margin-bottom: 20px;">
        <h1 style="margin: 0; font-size: 20px; font-weight: 700;">SharpStudy .NET Coach</h1>
        <p style="margin: 4px 0 0; font-size: 13px; opacity: 0.9;">
          ${isScheduled ? "Your study task is scheduled!" : "It's time for your scheduled C# study session!"}
        </p>
      </div>

      <div style="padding: 16px 20px; border: 1px solid #e2e8f0; border-radius: 12px; background: #f8fafc; margin-bottom: 20px;">
        <span style="font-size: 11px; font-weight: 700; color: #6366f1; text-transform: uppercase; letter-spacing: 0.5px;">
          ${isScheduled ? "Upcoming Task" : "Action Item"}
        </span>
        <h2 style="margin: 6px 0 0; color: #0f172a; font-size: 18px;">${reminder.title}</h2>
        <p style="margin: 6px 0 0; color: #64748b; font-size: 12px;">
          📅 Due: <strong>${dueFormatted}</strong>
        </p>
      </div>

      <p style="color: #334155; font-size: 14px; line-height: 1.6;">
        Consistent daily practice is the secret to mastering .NET and C# architecture. Open your study space, use the AI Voice Assistant if you want a concept explained or need help debugging, and mark this task complete!
      </p>

      <div style="margin: 24px 0; text-align: center;">
        <a href="http://localhost:3000" style="display: inline-block; background: #6366f1; color: #ffffff; text-decoration: none; padding: 12px 28px; border-radius: 999px; font-weight: 700; font-size: 14px; box-shadow: 0 4px 14px rgba(99, 102, 241, 0.3);">
          Open SharpStudy Assistant &rarr;
        </a>
      </div>

      <hr style="border: 0; border-top: 1px solid #f1f5f9; margin: 24px 0 16px;">
      <p style="color: #94a3b8; font-size: 11px; text-align: center; margin: 0;">
        Automated via SharpStudy Gmail Service &bull; Sent from ${process.env.GMAIL_ADDRESS || "SharpStudy"}
      </p>
    </div>
  `;

  const text = `SharpStudy Reminder:\n\nTask: ${reminder.title}\nDue: ${dueFormatted}\n\nOpen http://localhost:3000 to practice and complete!`;
  await sendEmailMessage({ to: reminder.email, subject, html, text });
}

function localDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function sendDailyPlanEmail(reminders, settings, today) {
  const todaysReminders = reminders
    .filter((reminder) => localDateKey(new Date(reminder.dueAt)) === today)
    .sort((left, right) => new Date(left.dueAt) - new Date(right.dueAt));

  const itemsHtml = todaysReminders.length
    ? todaysReminders
        .map((r) => {
          const time = new Date(r.dueAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
          const badge = r.done
            ? '<span style="background:#ecfdf5;color:#059669;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:700;">DONE</span>'
            : '<span style="background:#fef2f2;color:#dc2626;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:700;">TODO</span>';
          return `
            <li style="margin: 8px 0; padding: 10px 14px; border: 1px solid #e2e8f0; border-radius: 8px; background: #fff; display: flex; align-items: center; justify-content: space-between;">
              <span style="font-size: 13px; color: #1e293b;">${badge} &nbsp; <strong>${r.title}</strong></span>
              <span style="font-size: 11px; color: #64748b;">${time}</span>
            </li>
          `;
        })
        .join("")
    : '<p style="color: #64748b; font-size: 13px;">No study tasks scheduled for today yet.</p>';

  const pendingCount = todaysReminders.filter((r) => !r.done).length;
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 580px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 16px; background: #ffffff;">
      <div style="background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%); padding: 18px 24px; border-radius: 12px; color: #ffffff; margin-bottom: 20px;">
        <h1 style="margin: 0; font-size: 20px;">Your Daily C# Study Plan</h1>
        <p style="margin: 4px 0 0; font-size: 12px; opacity: 0.9;">Plan for ${today}</p>
      </div>

      <h2 style="font-size: 16px; color: #0f172a; margin: 0 0 12px;">Today's Learning Tasks (${pendingCount} remaining):</h2>
      <ul style="list-style: none; padding: 0; margin: 0 0 20px;">
        ${itemsHtml}
      </ul>

      <div style="text-align: center; margin: 24px 0;">
        <a href="http://localhost:3000" style="display: inline-block; background: #6366f1; color: #ffffff; text-decoration: none; padding: 11px 26px; border-radius: 999px; font-weight: 700; font-size: 13px;">
          Open SharpStudy Assistant &rarr;
        </a>
      </div>

      <hr style="border: 0; border-top: 1px solid #f1f5f9; margin: 20px 0 12px;">
      <p style="color: #94a3b8; font-size: 11px; text-align: center; margin: 0;">Sent via SharpStudy Daily Digest Automation</p>
    </div>
  `;

  await sendEmailMessage({
    to: settings.digestEmail,
    subject: `📋 Your C# Study Plan for ${today}`,
    html,
    text: `Your C# Study Plan for ${today}:\n${todaysReminders.map((r) => `- [${r.done ? "DONE" : "TODO"}] ${r.title}`).join("\n")}`,
  });
}

async function checkDueReminders() {
  try {
    const reminders = await readJson(remindersFile, []);
    const now = Date.now();
    const settings = await getSettings();
    let updated = false;

    for (const reminder of reminders) {
      if (
        !reminder.done &&
        reminder.email &&
        !reminder.emailSent &&
        !sentReminderIds.has(reminder.id) &&
        new Date(reminder.dueAt).getTime() <= now
      ) {
        if (!isGmailConfigured()) continue;
        sentReminderIds.add(reminder.id);
        try {
          await sendGmailReminder(reminder, "due");
          reminder.emailSent = true;
          updated = true;
          console.log(`[Gmail] Sent due reminder for "${reminder.title}" to ${reminder.email}`);
        } catch (error) {
          sentReminderIds.delete(reminder.id);
          console.error(`[Gmail] Could not email reminder "${reminder.title}":`, error.message);
        }
      }
    }
    if (updated) await writeJson(remindersFile, reminders);

    if (!digestSending && settings.digestEmail && isGmailConfigured()) {
      const currentDate = new Date();
      const today = localDateKey(currentDate);
      const currentTime = `${String(currentDate.getHours()).padStart(2, "0")}:${String(currentDate.getMinutes()).padStart(2, "0")}`;
      if (currentTime >= settings.digestTime && settings.lastDigestDate !== today) {
        digestSending = true;
        try {
          await sendDailyPlanEmail(reminders, settings, today);
          settings.lastDigestDate = today;
          await writeJson(settingsFile, settings);
          console.log(`[Gmail] Sent daily study plan for ${today} to ${settings.digestEmail}`);
        } catch (err) {
          console.error("[Gmail] Daily plan email failed:", err.message);
        } finally {
          digestSending = false;
        }
      }
    }
  } catch (error) {
    console.error("Reminder check failed:", error.message);
  }
}

setInterval(checkDueReminders, 30_000).unref();
checkDueReminders();
app.listen(port, "127.0.0.1", () => console.log(`SharpStudy is running at http://localhost:${port}`));
