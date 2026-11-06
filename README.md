# dotnet-daily-study-coach

An automated C#/.NET study coach and interactive tutor featuring a **Holographic 3D AI Voice Assistant**, multimodal speech recognition, customized daily learning roadmaps, and automated Gmail notifications for study tasks and summaries.

---

## ✨ Features

- **🎙️ Holographic AI Voice Assistant (Live Voice Mode)**:
  - 3D animated celestial orb with breathing, listening, thinking, and speaking states.
  - Interactive 7-bar audio waveform visualizer.
  - Bidirectional voice conversation (speech-to-text with Web Speech API and text-to-speech with natural voices).
  - Hands-free continuous voice loop mode.
- **💬 Beautiful AI Chatbot & 4 Personas**:
  - 🎓 **C# Exam Prep**: Plain-English concept breakdowns and check-for-understanding quizzes.
  - 🏛️ **.NET Architect**: SOLID design principles, async/await memory optimization, and ASP.NET Core Web APIs.
  - 🎯 **Quiz Master**: Interactive multiple-choice exam challenges with instant feedback.
  - 🔍 **Code Doctor**: Instant compiler diagnostics, exception debugging, and LINQ fixes.
  - Dark-mode syntax-highlighted code blocks with 1-click **Copy Code** buttons.
  - Audio narration for every assistant response (`🔊 Listen`).
- **✉️ Automated Gmail Notifications**:
  - Real-time email reminders when study tasks are due.
  - Instant task confirmation emails.
  - Automated morning study plan summaries.
  - 1-click "Notify Now" and "Send Test Email" controls.
- **📊 Streamlit Training Dashboard**:
  - Daily C#/.NET study task generation with Gemini API or built-in curriculum.
  - Progress tracking stored locally in SQLite (`data/dotnet_training.sqlite3`).

---

## 🚀 Getting Started

### 1. Requirements
- **Node.js 18+**
- **Python 3.10+**
- A free Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey) (optional; built-in AI tutor fallback is included).
- Google App Password for Gmail notifications (optional).

### 2. Run the Web Tutor & AI Voice Assistant (Recommended)
```bash
# Install dependencies
npm install

# Start the web server
npm start
```
Open **[http://localhost:3000](http://localhost:3000)** in Chrome or Edge.

### 3. Run the Streamlit Dashboard
```bash
# Install Python dependencies
python -m pip install -r requirements.txt

# Start the dashboard
python -m streamlit run streamlit_app.py
```
Open **[http://localhost:8501](http://localhost:8501)**.

---

## ⚙️ Environment Configuration

Copy `.env.example` to `.env`:
```dotenv
# Gemini API Key from Google AI Studio
LLM_API_KEY=your-api-key
LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
LLM_MODEL=gemini-3.8-flash

# Gmail Automation (Google App Password)
GMAIL_ADDRESS=your-email@gmail.com
GMAIL_APP_PASSWORD=your-16-char-app-password
```
*(You can also connect your Gemini API key directly from the browser UI by clicking **Set up AI** in the top bar).*
