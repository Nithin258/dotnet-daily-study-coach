const chatForm = document.querySelector("#chat-form");
const chatInput = document.querySelector("#chat-input");
const chatMessages = document.querySelector("#chat-messages");
const suggestions = document.querySelector("#suggestions");
const sendButton = document.querySelector("#send-button");
const taskDialog = document.querySelector("#task-dialog");
const gmailSetupDialog = document.querySelector("#gmail-setup-dialog");
const aiSetupDialog = document.querySelector("#ai-setup-dialog");
const taskForm = document.querySelector("#task-form");
const taskList = document.querySelector("#task-list");
const taskEmpty = document.querySelector("#task-empty");
const toast = document.querySelector("#toast");
let messages = [];
let reminders = [];
let toastTimer;
let digestEmail = "";
let digestTime = "08:00";
let gmailConnected = false;
let gmailConfigured = false;
const notifiedReminders = new Set();

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error || `Request failed (${response.status}).`);
  }
  return response.status === 204 ? null : response.json();
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 3200);
}

function appendMessage(role, content) {
  const element = document.createElement("div");
  element.className = `message ${role}`;
  element.textContent = content;
  chatMessages.append(element);
  element.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function sendMessage(text) {
  const content = text.trim();
  if (!content || sendButton.disabled) return;
  suggestions.hidden = true;
  appendMessage("user", content);
  messages.push({ role: "user", content });
  chatInput.value = "";
  chatInput.style.height = "auto";
  sendButton.disabled = true;
  const typing = document.createElement("div");
  typing.className = "message assistant";
  typing.textContent = "Thinking through it…";
  chatMessages.append(typing);
  try {
    const result = await api("/api/chat", {
      method: "POST",
      body: JSON.stringify({ messages }),
    });
    typing.remove();
    messages.push({ role: "assistant", content: result.reply });
    appendMessage("assistant", result.reply);
  } catch (error) {
    typing.remove();
    messages.pop();
    appendMessage("assistant", error.message);
    showToast(error.message);
  } finally {
    sendButton.disabled = false;
    chatInput.focus();
  }
}

function formatDue(dateString) {
  const date = new Date(dateString);
  const today = new Date();
  const isToday = date.toDateString() === today.toDateString();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const isTomorrow = date.toDateString() === tomorrow.toDateString();
  const day = isToday ? "Today" : isTomorrow ? "Tomorrow" : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${day} · ${date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

function renderReminders() {
  taskList.replaceChildren();
  const pending = reminders.filter((item) => !item.done);
  const done = reminders.filter((item) => item.done);
  const sorted = [...pending, ...done].sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));
  for (const reminder of sorted) {
    const item = document.createElement("div");
    item.className = `task-item${reminder.done ? " completed" : ""}`;
    const check = document.createElement("button");
    check.className = `task-check${reminder.done ? " checked" : ""}`;
    check.type = "button";
    check.textContent = reminder.done ? "✓" : "";
    check.setAttribute("aria-label", reminder.done ? "Mark task incomplete" : "Mark task complete");
    check.addEventListener("click", () => updateReminder(reminder.id, !reminder.done));

    const content = document.createElement("div");
    content.className = "task-content";
    const title = document.createElement("p");
    title.className = "task-title";
    title.textContent = reminder.title;
    const time = document.createElement("div");
    time.className = "task-time";
    time.textContent = formatDue(reminder.dueAt);
    if (reminder.email) {
      const email = document.createElement("span");
      email.className = "task-email";
      email.textContent = " · email";
      time.append(email);
    }
    content.append(title, time);

    const remove = document.createElement("button");
    remove.className = "delete-task";
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Delete ${reminder.title}`);
    remove.addEventListener("click", () => deleteReminder(reminder.id));
    item.append(check, content, remove);
    taskList.append(item);
  }
  taskEmpty.hidden = reminders.length > 0;
  document.querySelector("#task-count").textContent = String(pending.length);
  document.querySelector("#progress-text").textContent = `${done.length} / ${reminders.length} done`;
  document.querySelector("#progress-bar").style.width = reminders.length ? `${done.length / reminders.length * 100}%` : "0";
}

async function loadReminders() {
  reminders = await api("/api/reminders");
  renderReminders();
}

function updateDigestStatus() {
  const status = document.querySelector("#digest-status");
  if (!digestEmail) {
    status.textContent = "Add an email address to enable your daily plan.";
  } else if (!gmailConnected) {
    status.textContent = "Saved. Connect Gmail above to start daily plan emails.";
  } else {
    const time = new Date(`2000-01-01T${digestTime}`).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
    status.textContent = `Your daily plan will be emailed at ${time} local time.`;
  }
}

async function loadDigestSettings() {
  const settings = await api("/api/settings");
  digestEmail = settings.digestEmail;
  digestTime = settings.digestTime;
  document.querySelector("#digest-email").value = digestEmail;
  document.querySelector("#digest-time").value = digestTime;
  updateDigestStatus();
}

async function updateReminder(id, done) {
  try {
    await api(`/api/reminders/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ done }),
    });
    await loadReminders();
    showToast(done ? "Nice work — task completed!" : "Task moved back to your list.");
  } catch (error) {
    showToast(error.message);
  }
}

async function deleteReminder(id) {
  try {
    await api(`/api/reminders/${encodeURIComponent(id)}`, { method: "DELETE" });
    reminders = reminders.filter((item) => item.id !== id);
    renderReminders();
    showToast("Study task removed.");
  } catch (error) {
    showToast(error.message);
  }
}

function checkBrowserReminders() {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const now = Date.now();
  for (const reminder of reminders) {
    if (!reminder.done && !notifiedReminders.has(reminder.id) && new Date(reminder.dueAt).getTime() <= now) {
      notifiedReminders.add(reminder.id);
      new Notification("Time for a little C# study", { body: reminder.title });
    }
  }
}

async function loadStatus() {
  try {
    const status = await api("/api/status");
    document.querySelector("#connection-dot").classList.toggle("online", status.llmConfigured);
    const connectionLabel = document.querySelector("#connection-label");
    const aiSetupButton = document.querySelector("#ai-setup-button");
    connectionLabel.textContent = status.llmConfigured ? "AI tutor ready" : "Tutor demo mode";
    connectionLabel.title = status.llmConfigured ? "" : "Click to connect Google AI Studio";
    connectionLabel.classList.toggle("setup-prompt", !status.llmConfigured);
    aiSetupButton.hidden = status.llmConfigured;
    const gmailButton = document.querySelector("#gmail-button");
    gmailConnected = status.gmailConnected;
    gmailConfigured = status.gmailConfigured;
    gmailButton.textContent = status.gmailConnected
      ? "Gmail connected"
      : gmailConfigured ? "Connect Gmail" : "Set up Gmail";
    gmailButton.classList.toggle("connected", status.gmailConnected);
    gmailButton.dataset.connected = String(status.gmailConnected);
    updateDigestStatus();
  } catch (error) {
    showToast(error.message);
  }
}

chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  sendMessage(chatInput.value);
});
chatInput.addEventListener("input", () => {
  chatInput.style.height = "auto";
  chatInput.style.height = `${Math.min(chatInput.scrollHeight, 130)}px`;
});
chatInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    chatForm.requestSubmit();
  }
});
suggestions.addEventListener("click", (event) => {
  const button = event.target.closest("[data-prompt]");
  if (button) sendMessage(button.dataset.prompt);
});
document.querySelector("#add-task-button").addEventListener("click", () => taskDialog.showModal());
document.querySelector("#empty-add-button").addEventListener("click", () => taskDialog.showModal());
document.querySelector("#cancel-task").addEventListener("click", () => taskDialog.close());
taskForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const localDate = new Date(document.querySelector("#task-due").value);
  try {
    const reminder = await api("/api/reminders", {
      method: "POST",
      body: JSON.stringify({
        title: document.querySelector("#task-title").value,
        dueAt: localDate.toISOString(),
        email: document.querySelector("#task-email").value,
      }),
    });
    reminders.push(reminder);
    renderReminders();
    taskForm.reset();
    taskDialog.close();
    showToast("Reminder saved. You’ve got this!");
  } catch (error) {
    showToast(error.message);
  }
});
document.querySelector("#digest-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const saveButton = event.currentTarget.querySelector(".digest-save");
  saveButton.disabled = true;
  try {
    const settings = await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify({
        digestEmail: document.querySelector("#digest-email").value,
        digestTime: document.querySelector("#digest-time").value,
      }),
    });
    digestEmail = settings.digestEmail;
    digestTime = settings.digestTime;
    updateDigestStatus();
    showToast(digestEmail ? "Daily plan email saved." : "Daily plan email turned off.");
  } catch (error) {
    showToast(error.message);
  } finally {
    saveButton.disabled = false;
  }
});
document.querySelector("#notification-button").addEventListener("click", async () => {
  if (!("Notification" in window)) return showToast("This browser does not support desktop notifications.");
  const permission = await Notification.requestPermission();
  showToast(permission === "granted" ? "Browser reminders are enabled." : "Notification permission was not granted.");
});
function openGmailSetup() {
  const callbackUrl = `${window.location.origin}/auth/google/callback`;
  document.querySelector("#gmail-callback-url").textContent = callbackUrl;
  document.querySelector("#gmail-env-callback").textContent = callbackUrl;
  gmailSetupDialog.showModal();
}

function openAiSetup() {
  aiSetupDialog.showModal();
}

document.querySelector("#connection-label").addEventListener("click", () => {
  if (!document.querySelector("#ai-setup-button").hidden) openAiSetup();
});
document.querySelector("#ai-setup-button").addEventListener("click", openAiSetup);
document.querySelector("#close-ai-setup").addEventListener("click", () => aiSetupDialog.close());
document.querySelector("#copy-callback").addEventListener("click", async () => {
  const callbackUrl = document.querySelector("#gmail-callback-url").textContent;
  try {
    await navigator.clipboard.writeText(callbackUrl);
    showToast("Redirect URL copied.");
  } catch {
    showToast("Copy this redirect URL from the setup window.");
  }
});
document.querySelector("#close-gmail-setup").addEventListener("click", () => gmailSetupDialog.close());
document.querySelector("#gmail-button").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  if (button.dataset.connected === "true") {
    try {
      await api("/api/gmail/disconnect", { method: "POST", body: "{}" });
      await loadStatus();
      showToast("Gmail disconnected and access revoked.");
    } catch (error) {
      showToast(error.message);
    }
    return;
  }
  if (!gmailConfigured) {
    openGmailSetup();
    return;
  }
  window.location.href = "/auth/google";
});

const query = new URLSearchParams(window.location.search);
if (query.has("gmail")) {
  const result = query.get("gmail");
  if (result === "setup") {
    openGmailSetup();
  } else {
    showToast(result === "connected" ? "Gmail connected. Email reminders are ready." : "Gmail connection was not completed.");
  }
  window.history.replaceState({}, "", "/");
}

Promise.all([loadReminders(), loadStatus(), loadDigestSettings()])
  .then(() => {
    checkBrowserReminders();
    setInterval(() => loadReminders().then(checkBrowserReminders).catch((error) => showToast(error.message)), 30_000);
  })
  .catch((error) => showToast(error.message));
