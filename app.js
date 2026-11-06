// ── DOM Elements ──
const chatForm = document.querySelector("#chat-form");
const chatInput = document.querySelector("#chat-input");
const chatMessages = document.querySelector("#chat-messages");
const suggestions = document.querySelector("#suggestions");
const sendButton = document.querySelector("#send-button");
const micButton = document.querySelector("#mic-button");
const speechBanner = document.querySelector("#speech-banner");
const speechText = document.querySelector("#speech-text");
const speechCancel = document.querySelector("#speech-cancel");
const welcomeBanner = document.querySelector("#welcome-banner");
const chatHeaderActions = document.querySelector("#chat-header-actions");
const clearChatBtn = document.querySelector("#clear-chat-btn");
const chatPersonaIndicator = document.querySelector("#chat-persona-indicator");
const personaOptions = document.querySelector("#persona-options");

// Modals & Panels
const taskDialog = document.querySelector("#task-dialog");
const gmailSetupDialog = document.querySelector("#gmail-setup-dialog");
const aiSetupDialog = document.querySelector("#ai-setup-dialog");
const voiceSettingsDialog = document.querySelector("#voice-settings-dialog");
const voiceModal = document.querySelector("#voice-modal");
const voiceModalClose = document.querySelector("#voice-modal-close");
const voiceModalBackdrop = document.querySelector("#voice-modal-backdrop");
const voiceLaunchBtn = document.querySelector("#voice-launch-btn");
const voiceAssistantTrigger = document.querySelector("#voice-assistant-trigger");
const navVoice = document.querySelector("#nav-voice");
const navChat = document.querySelector("#nav-chat");
const voiceQuickCard = document.querySelector("#voice-quick-card");
const voiceSettingsBtn = document.querySelector("#voice-settings-btn");

// Voice Modal Controls
const aiOrb = document.querySelector("#ai-orb");
const aiWaveBars = document.querySelector("#ai-wave-bars");
const voiceStatusPill = document.querySelector("#voice-status-pill");
const voiceUserText = document.querySelector("#voice-user-text");
const voiceAiText = document.querySelector("#voice-ai-text");
const voiceOrbMicBtn = document.querySelector("#voice-orb-mic-btn");
const orbMicLabel = document.querySelector("#orb-mic-label");
const voiceAutoloopCheck = document.querySelector("#voice-autoloop-check");
const voiceStopSpeechBtn = document.querySelector("#voice-stop-speech-btn");
const voiceReplaySpeechBtn = document.querySelector("#voice-replay-speech-btn");
const voiceSettingsToggleBtn = document.querySelector("#voice-settings-toggle-btn");

// Task & Reminder Elements
const taskForm = document.querySelector("#task-form");
const taskList = document.querySelector("#task-list");
const taskEmpty = document.querySelector("#task-empty");
const toast = document.querySelector("#toast");

// ── Application State ──
let messages = [];
let reminders = [];
let toastTimer;
let digestEmail = "";
let digestTime = "08:00";
let gmailConnected = false;
let gmailConfigured = false;
let currentPersona = "tutor";
const notifiedReminders = new Set();

// Voice Settings State
let availableVoices = [];
let selectedVoiceURI = localStorage.getItem("sharpstudy_voice") || "";
let speechRate = parseFloat(localStorage.getItem("sharpstudy_rate") || "1.0");
let speechPitch = parseFloat(localStorage.getItem("sharpstudy_pitch") || "1.0");
let autoSpeakAnswers = localStorage.getItem("sharpstudy_autospeak") !== "false";
let soundEffectsEnabled = localStorage.getItem("sharpstudy_sfx") !== "false";
let lastAssistantSpeechText = "";

// Recognition State
let recognition = null;
let isRecognizingChat = false;
let isRecognizingVoiceModal = false;
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition || null;

// ── Audio Feedback (Web Audio API) ──
function playChime(type = "start") {
  if (!soundEffectsEnabled) return;
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    if (type === "start") {
      osc.frequency.setValueAtTime(440, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.15);
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);
      osc.start();
      osc.stop(ctx.currentTime + 0.2);
    } else if (type === "finish") {
      osc.frequency.setValueAtTime(659, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(523, ctx.currentTime + 0.2);
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
      osc.start();
      osc.stop(ctx.currentTime + 0.25);
    }
  } catch {
    // Ignore audio context autoplay restriction
  }
}

// ── API Helper ──
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
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 3200);
}

// ── Markdown Parser with Syntax Highlighting & Copy ──
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function renderMarkdown(rawText) {
  if (!rawText) return "";

  // 1. Extract and replace code blocks with tokens
  const codeBlocks = [];
  let processed = rawText.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (match, lang, code) => {
    const id = `__CODE_BLOCK_${codeBlocks.length}__`;
    codeBlocks.push({ lang: lang || "csharp", code });
    return id;
  });

  // 2. Escape HTML on text outside code blocks
  processed = escapeHtml(processed);

  // 3. Headers
  processed = processed.replace(/^### (.*$)/gim, "<h3>$1</h3>");
  processed = processed.replace(/^## (.*$)/gim, "<h2>$1</h2>");
  processed = processed.replace(/^# (.*$)/gim, "<h1>$1</h1>");

  // 4. Bold and italics
  processed = processed.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
  processed = processed.replace(/\*(.*?)\*/g, "<em>$1</em>");
  processed = processed.replace(/`([^`]+)`/g, "<code>$1</code>");

  // 5. Blockquotes
  processed = processed.replace(/^\> (.*$)/gim, "<blockquote>$1</blockquote>");

  // 6. Lists
  processed = processed.replace(/^\s*-\s+(.*$)/gim, "<li>$1</li>");
  processed = processed.replace(/(<li>.*<\/li>)/gms, "<ul>$1</ul>");

  // 7. Line breaks
  processed = processed.replace(/\n{2,}/g, "</p><p>");
  processed = processed.replace(/\n/g, "<br>");
  processed = `<p>${processed}</p>`;

  // 8. Reinsert code blocks
  codeBlocks.forEach((item, index) => {
    const token = `__CODE_BLOCK_${index}__`;
    const escapedCode = escapeHtml(item.code);
    const html = `
      <div class="code-block-container">
        <div class="code-block-header">
          <span>${item.lang}</span>
          <button type="button" class="copy-code-btn" data-code="${encodeURIComponent(item.code)}">
            📋 Copy
          </button>
        </div>
        <pre><code class="language-${item.lang}">${escapedCode}</code></pre>
      </div>
    `;
    processed = processed.replace(token, html);
  });

  return processed;
}

// ── Speech Synthesis (Voice Output) ──
function populateVoiceList() {
  if (!("speechSynthesis" in window)) return;
  availableVoices = window.speechSynthesis.getVoices();
  const select = document.querySelector("#voice-select");
  if (!select) return;

  select.innerHTML = "";
  const englishVoices = availableVoices.filter((v) => v.lang.startsWith("en"));
  const voiceList = englishVoices.length > 0 ? englishVoices : availableVoices;

  voiceList.forEach((voice) => {
    const option = document.createElement("option");
    option.value = voice.voiceURI;
    option.textContent = `${voice.name} (${voice.lang})${voice.default ? " [Default]" : ""}`;
    if (selectedVoiceURI && voice.voiceURI === selectedVoiceURI) {
      option.selected = true;
    }
    select.append(option);
  });

  if (!selectedVoiceURI && voiceList.length > 0) {
    const preferred = voiceList.find(
      (v) =>
        v.name.includes("Google") ||
        v.name.includes("Natural") ||
        v.name.includes("Samantha") ||
        v.name.includes("Jenny")
    ) || voiceList[0];
    selectedVoiceURI = preferred.voiceURI;
    select.value = selectedVoiceURI;
  }
}

if ("speechSynthesis" in window) {
  window.speechSynthesis.onvoiceschanged = populateVoiceList;
  populateVoiceList();
}

function cleanTextForSpeech(text) {
  return text
    .replace(/```[\s\S]*?```/g, "Code example provided below.")
    .replace(/`[^`]+`/g, (m) => m.replace(/`/g, ""))
    .replace(/[#*_~>]/g, "")
    .trim();
}

function stopAllSpeech() {
  if ("speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }
  document.querySelectorAll(".msg-btn.speaking").forEach((btn) => {
    btn.classList.remove("speaking");
    btn.textContent = "🔊 Listen";
  });
  setOrbState("idle");
  if (aiWaveBars) aiWaveBars.classList.remove("active");
}

function speakText(rawText, onStart = null, onEnd = null) {
  if (!("speechSynthesis" in window)) {
    showToast("Text-to-speech is not supported by your browser.");
    return;
  }
  stopAllSpeech();

  const textToSpeak = cleanTextForSpeech(rawText);
  if (!textToSpeak) return;

  const utterance = new SpeechSynthesisUtterance(textToSpeak);
  utterance.rate = speechRate;
  utterance.pitch = speechPitch;

  if (selectedVoiceURI) {
    const voice = availableVoices.find((v) => v.voiceURI === selectedVoiceURI);
    if (voice) utterance.voice = voice;
  }

  utterance.onstart = () => {
    if (onStart) onStart();
  };

  utterance.onend = () => {
    if (onEnd) onEnd();
  };

  utterance.onerror = () => {
    stopAllSpeech();
  };

  window.speechSynthesis.speak(utterance);
}

// ── Persona Display Details ──
const PERSONA_NAMES = {
  tutor: "🎓 C# Exam Prep Mode",
  architect: "🏛️ .NET Architect Mode",
  quiz: "🎯 Quiz Master Mode",
  debugger: "🔍 Code Doctor Mode",
};

function setPersona(persona) {
  currentPersona = persona;
  document.querySelectorAll(".persona-pill").forEach((pill) => {
    pill.classList.toggle("active", pill.dataset.persona === persona);
  });
  if (chatPersonaIndicator) {
    chatPersonaIndicator.textContent = PERSONA_NAMES[persona] || "🎓 C# Study Mode";
  }
}

// ── Append Message to Chat ──
function appendMessage(role, content) {
  const messageCard = document.createElement("div");
  messageCard.className = `message ${role}`;

  if (role === "assistant") {
    lastAssistantSpeechText = content;
    const meta = document.createElement("div");
    meta.className = "message-meta";
    meta.innerHTML = `
      <span class="message-avatar-badge">✨ SharpStudy AI</span>
      <span>·</span>
      <span>${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
    `;
    messageCard.append(meta);

    const contentDiv = document.createElement("div");
    contentDiv.className = "message-content";
    contentDiv.innerHTML = renderMarkdown(content);
    messageCard.append(contentDiv);

    // Actions: Read Aloud & Copy
    const actions = document.createElement("div");
    actions.className = "message-actions";

    const listenBtn = document.createElement("button");
    listenBtn.className = "msg-btn";
    listenBtn.type = "button";
    listenBtn.innerHTML = "🔊 Listen";
    listenBtn.addEventListener("click", () => {
      if (listenBtn.classList.contains("speaking")) {
        stopAllSpeech();
      } else {
        speakText(
          content,
          () => {
            listenBtn.classList.add("speaking");
            listenBtn.innerHTML = "⏹️ Stop";
          },
          () => {
            listenBtn.classList.remove("speaking");
            listenBtn.innerHTML = "🔊 Listen";
          }
        );
      }
    });

    const copyBtn = document.createElement("button");
    copyBtn.className = "msg-btn";
    copyBtn.type = "button";
    copyBtn.innerHTML = "📋 Copy";
    copyBtn.addEventListener("click", async () => {
      await navigator.clipboard.writeText(content).catch(() => {});
      copyBtn.textContent = "✓ Copied";
      setTimeout(() => (copyBtn.innerHTML = "📋 Copy"), 2000);
    });

    actions.append(listenBtn, copyBtn);
    messageCard.append(actions);
  } else {
    messageCard.textContent = content;
  }

  chatMessages.append(messageCard);
  messageCard.scrollIntoView({ behavior: "smooth", block: "nearest" });

  if (chatHeaderActions) chatHeaderActions.hidden = false;
  return messageCard;
}

// ── Send Message ──
async function sendMessage(text) {
  const content = text.trim();
  if (!content || sendButton.disabled) return;

  if (suggestions) suggestions.hidden = true;
  if (welcomeBanner) welcomeBanner.style.display = "none";

  appendMessage("user", content);
  messages.push({ role: "user", content });

  chatInput.value = "";
  chatInput.style.height = "auto";
  sendButton.disabled = true;

  const typing = document.createElement("div");
  typing.className = "message assistant typing";
  typing.innerHTML = `
    <div class="message-meta">
      <span class="message-avatar-badge">✨ Thinking…</span>
    </div>
    <div style="color: #64748b; font-size: 12px;">Crafting clear C# explanation…</div>
  `;
  chatMessages.append(typing);

  try {
    const result = await api("/api/chat", {
      method: "POST",
      body: JSON.stringify({
        messages,
        persona: currentPersona,
      }),
    });
    typing.remove();
    messages.push({ role: "assistant", content: result.reply });
    appendMessage("assistant", result.reply);

    if (result.keyInvalid) {
      const connLabel = document.querySelector("#connection-label");
      if (connLabel) {
        connLabel.textContent = "AI Key Invalid";
        connLabel.classList.add("setup-prompt");
      }
      const setupBtn = document.querySelector("#ai-setup-button");
      if (setupBtn) setupBtn.hidden = false;
    }

    // Auto speak if enabled
    if (autoSpeakAnswers) {
      speakText(result.reply);
    }
  } catch (error) {
    typing.remove();
    messages.pop();
    appendMessage("assistant", `⚠️ ${error.message}`);
    showToast(error.message);
  } finally {
    sendButton.disabled = false;
    chatInput.focus();
  }
}

// ── Copy Code Delegation ──
document.addEventListener("click", async (e) => {
  const copyBtn = e.target.closest(".copy-code-btn");
  if (!copyBtn) return;
  const code = decodeURIComponent(copyBtn.dataset.code || "");
  try {
    await navigator.clipboard.writeText(code);
    copyBtn.textContent = "✓ Copied!";
    setTimeout(() => (copyBtn.innerHTML = "📋 Copy"), 2000);
  } catch {
    showToast("Could not copy code to clipboard.");
  }
});

// ── Speech Recognition (Voice Input) ──
function initSpeechRecognition() {
  if (!SpeechRecognition) return null;
  const rec = new SpeechRecognition();
  rec.continuous = false;
  rec.interimResults = true;
  rec.lang = "en-US";

  rec.onstart = () => {
    playChime("start");
  };

  rec.onresult = (event) => {
    let interim = "";
    let final = "";
    for (let i = event.resultIndex; i < event.results.length; ++i) {
      if (event.results[i].isFinal) {
        final += event.results[i][0].transcript;
      } else {
        interim += event.results[i][0].transcript;
      }
    }

    const transcript = final || interim;
    if (isRecognizingChat) {
      chatInput.value = transcript;
      if (speechText) speechText.textContent = `Hearing: "${transcript}"`;
    } else if (isRecognizingVoiceModal) {
      if (voiceUserText) voiceUserText.textContent = transcript;
    }
  };

  rec.onerror = (event) => {
    console.warn("Speech error:", event.error);
    if (event.error !== "no-speech") {
      showToast(`Speech recognition notice: ${event.error}`);
    }
    stopRecognition();
  };

  rec.onend = () => {
    playChime("finish");
    const wasChat = isRecognizingChat;
    const wasModal = isRecognizingVoiceModal;
    stopRecognition();

    if (wasChat && chatInput.value.trim()) {
      sendMessage(chatInput.value);
    } else if (wasModal && voiceUserText.textContent.trim()) {
      handleVoiceModalSubmit(voiceUserText.textContent);
    }
  };

  return rec;
}

recognition = initSpeechRecognition();

function startChatVoiceInput() {
  if (!recognition) {
    showToast("Speech Recognition is not supported by your browser. Use Chrome, Edge, or Safari.");
    return;
  }
  stopAllSpeech();
  isRecognizingChat = true;
  isRecognizingVoiceModal = false;
  micButton.classList.add("listening");
  if (speechBanner) {
    speechBanner.hidden = false;
    speechText.textContent = "Listening to your voice…";
  }
  try {
    recognition.start();
  } catch {
    // Ignore already started error
  }
}

function stopRecognition() {
  isRecognizingChat = false;
  isRecognizingVoiceModal = false;
  if (micButton) micButton.classList.remove("listening");
  if (speechBanner) speechBanner.hidden = true;
  if (voiceOrbMicBtn) {
    voiceOrbMicBtn.classList.remove("active");
    orbMicLabel.textContent = "Tap to Speak";
  }
  if (recognition) {
    try {
      recognition.stop();
    } catch {
      // Ignore
    }
  }
}

// ── Voice Assistant Modal (Live Voice Experience) ──
function setOrbState(state) {
  if (!aiOrb) return;
  aiOrb.className = `ai-orb ${state}`;
  if (voiceStatusPill) {
    voiceStatusPill.className = `voice-status-pill ${state}`;
    voiceStatusPill.textContent = state.charAt(0).toUpperCase() + state.slice(1);
  }
  if (aiWaveBars) {
    aiWaveBars.classList.toggle("active", state === "speaking" || state === "listening");
  }
}

function openVoiceModal() {
  stopAllSpeech();
  voiceModal.hidden = false;
  setOrbState("idle");
  if (voiceOrbMicBtn) orbMicLabel.textContent = "Tap to Speak";
}

function closeVoiceModal() {
  stopAllSpeech();
  stopRecognition();
  voiceModal.hidden = true;
}

function startVoiceModalRecognition() {
  if (!recognition) {
    showToast("Speech Recognition is not available. Please use Google Chrome or Microsoft Edge.");
    return;
  }
  stopAllSpeech();
  isRecognizingVoiceModal = true;
  isRecognizingChat = false;
  voiceOrbMicBtn.classList.add("active");
  orbMicLabel.textContent = "Listening…";
  setOrbState("listening");
  voiceUserText.textContent = "Listening to your voice…";

  try {
    recognition.start();
  } catch {
    // Ignore
  }
}

async function handleVoiceModalSubmit(prompt) {
  if (!prompt || prompt.includes("Listening to your voice") || prompt.includes("Click the microphone")) return;

  setOrbState("thinking");
  orbMicLabel.textContent = "Thinking…";
  voiceAiText.textContent = "Analyzing question and preparing C# explanation…";

  try {
    const result = await api("/api/chat", {
      method: "POST",
      body: JSON.stringify({
        messages: [{ role: "user", content: prompt }],
        persona: currentPersona,
      }),
    });

    voiceAiText.textContent = result.reply;
    lastAssistantSpeechText = result.reply;

    // Speak response with animated waveform
    speakText(
      result.reply,
      () => {
        setOrbState("speaking");
        orbMicLabel.textContent = "Speaking…";
      },
      () => {
        setOrbState("idle");
        orbMicLabel.textContent = "Tap to Speak";

        // Hands-free conversation loop
        if (voiceAutoloopCheck.checked && !voiceModal.hidden) {
          setTimeout(() => {
            if (!voiceModal.hidden && !isRecognizingVoiceModal) {
              startVoiceModalRecognition();
            }
          }, 600);
        }
      }
    );
  } catch (err) {
    voiceAiText.textContent = `⚠️ Error: ${err.message}`;
    setOrbState("idle");
    orbMicLabel.textContent = "Tap to Speak";
  }
}

// ── Reminders & Tasks ──
function formatDue(dateString) {
  const date = new Date(dateString);
  const today = new Date();
  const isToday = date.toDateString() === today.toDateString();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const isTomorrow = date.toDateString() === tomorrow.toDateString();
  const day = isToday
    ? "Today"
    : isTomorrow
    ? "Tomorrow"
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${day} · ${date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

function renderReminders() {
  if (!taskList) return;
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

    const notifyBtn = document.createElement("button");
    notifyBtn.className = "notify-task-btn";
    notifyBtn.type = "button";
    notifyBtn.title = "Send Gmail notification for this task right now";
    notifyBtn.textContent = reminder.emailSent ? "✉️ Sent" : "✉️ Notify";
    notifyBtn.addEventListener("click", async () => {
      try {
        notifyBtn.disabled = true;
        notifyBtn.textContent = "Sending…";
        const res = await api(`/api/reminders/${encodeURIComponent(reminder.id)}/notify`, { method: "POST" });
        reminder.emailSent = true;
        notifyBtn.textContent = "✓ Sent";
        showToast(res.message || "Notification email sent!");
      } catch (err) {
        notifyBtn.textContent = "✉️ Notify";
        showToast(err.message);
      } finally {
        notifyBtn.disabled = false;
      }
    });

    const remove = document.createElement("button");
    remove.className = "delete-task";
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Delete ${reminder.title}`);
    remove.addEventListener("click", () => deleteReminder(reminder.id));

    item.append(check, content, notifyBtn, remove);
    taskList.append(item);
  }

  if (taskEmpty) taskEmpty.hidden = reminders.length > 0;
  const countEl = document.querySelector("#task-count");
  if (countEl) countEl.textContent = String(pending.length);
  const progText = document.querySelector("#progress-text");
  if (progText) progText.textContent = `${done.length} / ${reminders.length} done`;
  const progBar = document.querySelector("#progress-bar");
  if (progBar) progBar.style.width = reminders.length ? `${(done.length / reminders.length) * 100}%` : "0";
}

async function loadReminders() {
  reminders = await api("/api/reminders");
  renderReminders();
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

function updateDigestStatus() {
  const status = document.querySelector("#digest-status");
  if (!status) return;
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
  const emailInput = document.querySelector("#digest-email");
  const timeInput = document.querySelector("#digest-time");
  if (emailInput) emailInput.value = digestEmail;
  if (timeInput) timeInput.value = digestTime;
  updateDigestStatus();
}

async function loadStatus() {
  try {
    const status = await api("/api/status");
    const dot = document.querySelector("#connection-dot");
    if (dot) dot.classList.toggle("online", status.llmConfigured);

    const modelName = document.querySelector("#model-name");
    if (modelName && status.model) modelName.textContent = status.model;

    const connectionLabel = document.querySelector("#connection-label");
    const aiSetupButton = document.querySelector("#ai-setup-button");
    if (connectionLabel) {
      connectionLabel.textContent = status.llmConfigured ? "AI Coach Active" : "Tutor Offline Demo";
      connectionLabel.classList.toggle("setup-prompt", !status.llmConfigured);
    }
    if (aiSetupButton) aiSetupButton.hidden = status.llmConfigured;

    const gmailButton = document.querySelector("#gmail-button");
    if (gmailButton) {
      gmailConnected = status.gmailConnected;
      gmailConfigured = status.gmailConfigured;
      gmailButton.textContent = status.gmailConnected
        ? `✓ Gmail Active (${status.gmailAddress ? status.gmailAddress.split("@")[0] : "Connected"})`
        : gmailConfigured
        ? "Connect Gmail"
        : "Set up Gmail";
      gmailButton.classList.toggle("connected", status.gmailConnected);
      gmailButton.dataset.connected = String(status.gmailConnected);
      gmailButton.title = status.gmailAddress ? `Gmail automation sender: ${status.gmailAddress}` : "";
    }
    if (status.gmailAddress) {
      const taskEmail = document.querySelector("#task-email");
      if (taskEmail && !taskEmail.value) taskEmail.placeholder = status.gmailAddress;
      const digestEmailInput = document.querySelector("#digest-email");
      if (digestEmailInput && !digestEmailInput.value) digestEmailInput.value = status.gmailAddress;
    }
    updateDigestStatus();
  } catch (error) {
    showToast(error.message);
  }
}

// ── Event Listeners ──
chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  sendMessage(chatInput.value);
});

chatInput.addEventListener("input", () => {
  chatInput.style.height = "auto";
  chatInput.style.height = `${Math.min(chatInput.scrollHeight, 140)}px`;
});

chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    chatForm.requestSubmit();
  }
});

micButton.addEventListener("click", () => {
  if (isRecognizingChat) {
    stopRecognition();
  } else {
    startChatVoiceInput();
  }
});

if (speechCancel) {
  speechCancel.addEventListener("click", stopRecognition);
}

// Persona selection
if (personaOptions) {
  personaOptions.addEventListener("click", (e) => {
    const pill = e.target.closest(".persona-pill");
    if (!pill) return;
    setPersona(pill.dataset.persona);
    showToast(`Switched to ${PERSONA_NAMES[pill.dataset.persona]}`);
  });
}

// Clear chat
if (clearChatBtn) {
  clearChatBtn.addEventListener("click", () => {
    messages = [];
    chatMessages.innerHTML = "";
    if (chatHeaderActions) chatHeaderActions.hidden = true;
    if (welcomeBanner) welcomeBanner.style.display = "block";
    if (suggestions) suggestions.hidden = false;
    stopAllSpeech();
    showToast("Chat cleared. Ready for your next question!");
  });
}

// Suggestions
if (suggestions) {
  suggestions.addEventListener("click", (event) => {
    const button = event.target.closest("[data-prompt]");
    if (button) sendMessage(button.dataset.prompt);
  });
}

// Voice Assistant Triggers
[voiceLaunchBtn, voiceAssistantTrigger, navVoice, voiceQuickCard].forEach((trigger) => {
  if (trigger) trigger.addEventListener("click", openVoiceModal);
});

if (navChat) {
  navChat.addEventListener("click", () => {
    closeVoiceModal();
    chatInput.focus();
  });
}

if (voiceModalClose) voiceModalClose.addEventListener("click", closeVoiceModal);
if (voiceModalBackdrop) voiceModalBackdrop.addEventListener("click", closeVoiceModal);

if (voiceOrbMicBtn) {
  voiceOrbMicBtn.addEventListener("click", () => {
    if (isRecognizingVoiceModal) {
      stopRecognition();
    } else {
      startVoiceModalRecognition();
    }
  });
}

if (voiceStopSpeechBtn) {
  voiceStopSpeechBtn.addEventListener("click", stopAllSpeech);
}

if (voiceReplaySpeechBtn) {
  voiceReplaySpeechBtn.addEventListener("click", () => {
    if (lastAssistantSpeechText) {
      speakText(lastAssistantSpeechText, () => setOrbState("speaking"), () => setOrbState("idle"));
    } else {
      showToast("No answer to replay yet.");
    }
  });
}

// Voice quick prompts in modal
document.querySelectorAll(".vqp-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const prompt = btn.dataset.vprompt;
    if (voiceUserText) voiceUserText.textContent = prompt;
    handleVoiceModalSubmit(prompt);
  });
});

// Voice Settings Dialog
function openVoiceSettings() {
  const rateInput = document.querySelector("#voice-rate");
  const pitchInput = document.querySelector("#voice-pitch");
  const rateVal = document.querySelector("#rate-value");
  const pitchVal = document.querySelector("#pitch-value");
  const autoSpeakCheck = document.querySelector("#setting-auto-speak");
  const sfxCheck = document.querySelector("#setting-sound-effects");

  if (rateInput) rateInput.value = speechRate;
  if (pitchInput) pitchInput.value = speechPitch;
  if (rateVal) rateVal.textContent = `${speechRate}x`;
  if (pitchVal) pitchVal.textContent = `${speechPitch}`;
  if (autoSpeakCheck) autoSpeakCheck.checked = autoSpeakAnswers;
  if (sfxCheck) sfxCheck.checked = soundEffectsEnabled;

  populateVoiceList();
  voiceSettingsDialog.showModal();
}

if (voiceSettingsBtn) voiceSettingsBtn.addEventListener("click", openVoiceSettings);
if (voiceSettingsToggleBtn) voiceSettingsToggleBtn.addEventListener("click", openVoiceSettings);

document.querySelector("#voice-rate")?.addEventListener("input", (e) => {
  speechRate = parseFloat(e.target.value);
  document.querySelector("#rate-value").textContent = `${speechRate.toFixed(1)}x`;
});

document.querySelector("#voice-pitch")?.addEventListener("input", (e) => {
  speechPitch = parseFloat(e.target.value);
  document.querySelector("#pitch-value").textContent = `${speechPitch.toFixed(1)}`;
});

document.querySelector("#test-voice-btn")?.addEventListener("click", () => {
  const select = document.querySelector("#voice-select");
  if (select) selectedVoiceURI = select.value;
  speakText("Hello! This is how your C# AI study coach sounds.");
});

document.querySelector("#save-voice-settings")?.addEventListener("click", () => {
  const select = document.querySelector("#voice-select");
  if (select) selectedVoiceURI = select.value;
  autoSpeakAnswers = document.querySelector("#setting-auto-speak")?.checked ?? true;
  soundEffectsEnabled = document.querySelector("#setting-sound-effects")?.checked ?? true;

  localStorage.setItem("sharpstudy_voice", selectedVoiceURI);
  localStorage.setItem("sharpstudy_rate", String(speechRate));
  localStorage.setItem("sharpstudy_pitch", String(speechPitch));
  localStorage.setItem("sharpstudy_autospeak", String(autoSpeakAnswers));
  localStorage.setItem("sharpstudy_sfx", String(soundEffectsEnabled));

  voiceSettingsDialog.close();
  showToast("Voice preferences saved.");
});

// Task dialog events
document.querySelector("#add-task-button")?.addEventListener("click", () => taskDialog.showModal());
document.querySelector("#empty-add-button")?.addEventListener("click", () => taskDialog.showModal());
document.querySelector("#cancel-task")?.addEventListener("click", () => taskDialog.close());

taskForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const localDate = new Date(document.querySelector("#task-due").value);
  const notifyImmediately = document.querySelector("#task-notify-immediate")?.checked ?? false;
  try {
    const reminder = await api("/api/reminders", {
      method: "POST",
      body: JSON.stringify({
        title: document.querySelector("#task-title").value,
        dueAt: localDate.toISOString(),
        email: document.querySelector("#task-email").value,
        notifyImmediately,
      }),
    });
    reminders.push(reminder);
    renderReminders();
    taskForm.reset();
    taskDialog.close();
    showToast(
      notifyImmediately
        ? "Reminder saved & confirmation email sent to your Gmail!"
        : "Reminder saved. You'll receive a Gmail alert when it's due!"
    );
  } catch (error) {
    showToast(error.message);
  }
});

document.querySelector("#digest-test-btn")?.addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  const email = (document.querySelector("#digest-email").value || "").trim();
  btn.disabled = true;
  btn.textContent = "Sending…";
  try {
    const res = await api("/api/gmail/test", {
      method: "POST",
      body: JSON.stringify({ recipient: email }),
    });
    showToast(res.message || "Test email sent! Check your inbox.");
  } catch (err) {
    showToast(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Send Test Email ✉️";
  }
});

document.querySelector("#digest-form")?.addEventListener("submit", async (event) => {
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

// Gmail Setup & Notifications
function openGmailSetup() {
  const callbackUrl = `${window.location.origin}/auth/google/callback`;
  document.querySelector("#gmail-callback-url").textContent = callbackUrl;
  document.querySelector("#gmail-env-callback").textContent = callbackUrl;
  gmailSetupDialog.showModal();
}

function openAiSetup() {
  aiSetupDialog.showModal();
  document.querySelector("#ai-key-input")?.focus();
}

document.querySelector("#ai-key-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.querySelector("#ai-key-input");
  const saveBtn = document.querySelector("#save-ai-key-btn");
  const key = input.value.trim();
  if (!key) return;

  saveBtn.disabled = true;
  saveBtn.textContent = "Verifying with Google…";

  try {
    const res = await api("/api/ai-key", {
      method: "PUT",
      body: JSON.stringify({ apiKey: key }),
    });
    showToast(res.message || "Gemini connected successfully!");
    aiSetupDialog.close();
    input.value = "";
    await loadStatus();
  } catch (err) {
    showToast(err.message);
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = "Save & Connect Gemini";
  }
});

document.querySelector("#connection-label")?.addEventListener("click", () => {
  if (!document.querySelector("#ai-setup-button")?.hidden) openAiSetup();
});
document.querySelector("#ai-setup-button")?.addEventListener("click", openAiSetup);
document.querySelector("#close-ai-setup")?.addEventListener("click", () => aiSetupDialog.close());
document.querySelector("#copy-callback")?.addEventListener("click", async () => {
  const callbackUrl = document.querySelector("#gmail-callback-url").textContent;
  try {
    await navigator.clipboard.writeText(callbackUrl);
    showToast("Redirect URL copied.");
  } catch {
    showToast("Copy this redirect URL from the setup window.");
  }
});
document.querySelector("#close-gmail-setup")?.addEventListener("click", () => gmailSetupDialog.close());

document.querySelector("#gmail-button")?.addEventListener("click", async (event) => {
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

// Initialization
Promise.all([loadReminders(), loadStatus(), loadDigestSettings()])
  .then(() => {
    setInterval(() => loadReminders().catch((err) => showToast(err.message)), 30_000);
  })
  .catch((error) => showToast(error.message));