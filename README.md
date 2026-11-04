# dotnet-daily-study-coach

An automated C#/.NET study coach built with Streamlit and Gemini API. It generates tailored daily learning roadmaps, features interactive coding prep, and sends scheduled plan summaries using Gmail SMTP integration. The project also includes a lightweight Express-based C# exam-prep tutor.

## Requirements

- Node.js 18 or newer
- A Google AI Studio API key (optional; the app has a built-in tutor fallback)
- Google OAuth credentials (optional; only needed to send Gmail reminders)

## Run locally

### Streamlit .NET training app

The Streamlit version includes a general-purpose AI chat assistant, voice-question transcription, browser read-aloud controls for assistant replies, daily C#/.NET learning tasks with completion tracking, and optional daily-plan email through Gmail SMTP.

1. Install Python 3.10 or newer.
2. Install Python dependencies with `python -m pip install -r requirements.txt`.
3. Keep your Google AI Studio key in the ignored `.env` file. The Gemini model and endpoint are read from `LLM_MODEL` and `LLM_BASE_URL`.
4. For Gmail notifications, enable 2-Step Verification on your Google account and create a Google App Password. Add `GMAIL_ADDRESS` and `GMAIL_APP_PASSWORD` to `.env`; do not use your regular Gmail password.
5. Start the dashboard with `python -m streamlit run streamlit_app.py`.
6. Open [http://localhost:8501](http://localhost:8501), choose your level, generate a plan, set your email and local send time, and enable the daily email.

The scheduler checks once a minute while the Streamlit app is open and running. It sends at most one plan email per date, and retries a failed send after 15 minutes. Use **Send a test email** to verify Gmail before enabling the daily schedule. Plans and notification settings are stored in `data/dotnet_training.sqlite3`.

Run the focused Python tests with `python -m unittest discover -s tests`.

The voice recorder uses Google AI Studio to transcribe recorded questions. The **Listen to answer** button uses the browser's built-in speech voice. If the AI provider rejects a chat request, the app displays the provider's error details (with the API key redacted); check the named model in `LLM_MODEL` if the provider reports a model or request-parameter problem.

### Existing web tutor

1. Copy `.env.example` to `.env`.
2. Add a **new, private** Google AI Studio API key as `LLM_API_KEY`. The Gemini OpenAI-compatible endpoint and `gemini-3.8-flash` model are preconfigured in `.env.example`. Keep `.env` private.
3. Install dependencies with `npm install`.
4. Run `npm run check` to check the JavaScript syntax.
5. Start the app with `npm start`.
6. Open [http://localhost:3000](http://localhost:3000).

Study tasks are stored in `data/reminders.json` on this machine. Do not expose this personal, single-user app directly to the public internet.

## Gmail setup (optional)

For the Streamlit training app, use a Google App Password as described above. For the existing web tutor, Gmail uses the separate OAuth flow below.

1. In Google Cloud Console, create or select a project and enable the Gmail API.
2. Configure the OAuth consent screen. If the app is in testing mode, add your Google account as a test user.
3. Create an OAuth client ID of type **Web application**. Add the exact redirect URI shown by the app's **Set up Gmail** dialog as an authorized redirect URI (for the default port, this is `http://localhost:3000/auth/google/callback`).
4. Put the client ID, secret, and matching redirect URI in `.env`. Never paste credentials into chat or commit `.env`.
5. Restart the server, click **Connect Gmail**, and grant the requested `gmail.send` permission.
6. Add an email address to a study task to receive a reminder when it is due.
7. In **Daily plan email** in the reminders panel, enter the destination address and choose a daily send time. SharpStudy emails a summary of that day's study tasks, including completed tasks, using the server computer's local time zone.

The OAuth refresh token is saved locally in `data/google-token.json`; do not share or commit that file. Disconnect Gmail in the app to revoke the saved token.

## Privacy and behavior

- LLM requests are sent by the server, using the configured endpoint, model, and API key. Do not enter sensitive personal information into chat.
- If an API key was pasted into chat or otherwise shared, revoke it and create a replacement before configuring `.env`.
- Without an LLM key, the app provides a small offline C# tutor response instead.
- Browser notifications require permission and work only while the app is open in a supported browser.
- Gmail reminders and daily plan emails are checked by the server about once a minute while it is running. The app must remain running at the scheduled time for email delivery. Daily email settings are stored in `data/settings.json`.
- This is a local, single-user starter app. It has no user accounts or multi-user access controls.
