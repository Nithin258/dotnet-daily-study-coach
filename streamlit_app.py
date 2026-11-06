from __future__ import annotations

import json
import os
from datetime import date, datetime, time
from pathlib import Path
from typing import Any

import streamlit as st
import streamlit.components.v1 as components
from dotenv import load_dotenv

from study_plan import (
    DATABASE_PATH,
    EmailDeliveryError,
    PlanGenerationError,
    daily_email_body,
    finish_daily_email,
    generate_ai_tasks,
    generate_template_tasks,
    get_email_settings,
    get_tasks,
    reserve_daily_email,
    save_email_settings,
    save_tasks,
    send_gmail_email,
    set_task_completed,
    TutorResponseError,
    generate_tutor_reply,
    transcribe_tutor_audio,
)


load_dotenv(Path(__file__).resolve().parent / ".env")


def render_speech_button(text: str) -> None:
    safe_text = json.dumps(text, ensure_ascii=True).replace("<", "\\u003c")
    components.html(
        f"""
        <div class="speech-ctrl-wrap">
          <button id="speak-answer" type="button" aria-label="Read answer aloud">
            <span class="speak-icon">🔊</span> <span id="speak-label">Listen to answer</span>
          </button>
          <div class="sound-wave" id="sound-wave">
            <span></span><span></span><span></span><span></span>
          </div>
          <span id="speak-status" role="status"></span>
        </div>
        <style>
          body {{ margin: 0; font-family: "DM Sans", system-ui, sans-serif; }}
          .speech-ctrl-wrap {{ display: flex; align-items: center; gap: 8px; }}
          #speak-answer {{
            border: 0; border-radius: 999px; padding: 7px 15px;
            color: white; font-weight: 650; font-size: 13px; cursor: pointer;
            background: linear-gradient(110deg, #6366f1, #8b5cf6, #06b6d4);
            box-shadow: 0 4px 14px rgba(99, 102, 241, 0.3);
            display: inline-flex; align-items: center; gap: 6px;
            transition: all 0.2s ease;
          }}
          #speak-answer:hover {{ filter: brightness(1.1); transform: translateY(-1px); }}
          #speak-answer.playing {{ background: linear-gradient(110deg, #f43f5e, #e11d48); }}
          #speak-status {{ color: #64748b; font-size: 12px; font-weight: 500; }}
          .sound-wave {{ display: none; align-items: center; gap: 3px; height: 16px; }}
          .sound-wave.active {{ display: flex; }}
          .sound-wave span {{
            width: 3px; height: 6px; border-radius: 99px; background: #8b5cf6;
            animation: bounce 0.6s infinite alternate ease-in-out;
          }}
          .sound-wave span:nth-child(2) {{ animation-delay: 0.15s; }}
          .sound-wave span:nth-child(3) {{ animation-delay: 0.3s; }}
          .sound-wave span:nth-child(4) {{ animation-delay: 0.45s; }}
          @keyframes bounce {{ from {{ height: 5px; }} to {{ height: 18px; }} }}
        </style>
        <script>
          const answerText = {safe_text};
          const speakButton = document.getElementById("speak-answer");
          const speakLabel = document.getElementById("speak-label");
          const speakStatus = document.getElementById("speak-status");
          const soundWave = document.getElementById("sound-wave");
          let isSpeaking = false;

          speakButton.addEventListener("click", () => {{
            if (!("speechSynthesis" in window)) {{
              speakStatus.textContent = "Speech is not supported by this browser.";
              return;
            }}
            if (isSpeaking) {{
              window.speechSynthesis.cancel();
              isSpeaking = false;
              speakButton.classList.remove("playing");
              soundWave.classList.remove("active");
              speakLabel.textContent = "Listen to answer";
              speakStatus.textContent = "";
              return;
            }}
            window.speechSynthesis.cancel();
            const cleanText = answerText
              .replace(/```[\s\S]*?```/g, "Code example provided.")
              .replace(/[#*_~`>]/g, "")
              .trim();
            const answer = new SpeechSynthesisUtterance(cleanText);
            answer.rate = 1.0;
            answer.onstart = () => {{
              isSpeaking = true;
              speakButton.classList.add("playing");
              soundWave.classList.add("active");
              speakLabel.textContent = "Stop voice";
              speakStatus.textContent = "Speaking…";
            }};
            answer.onend = () => {{
              isSpeaking = false;
              speakButton.classList.remove("playing");
              soundWave.classList.remove("active");
              speakLabel.textContent = "Listen again";
              speakStatus.textContent = "";
            }};
            answer.onerror = () => {{
              isSpeaking = false;
              speakButton.classList.remove("playing");
              soundWave.classList.remove("active");
              speakLabel.textContent = "Listen to answer";
              speakStatus.textContent = "Could not play speech.";
            }};
            window.speechSynthesis.speak(answer);
          }});
        </script>
        """,
        height=54,
        scrolling=False,
    )


st.set_page_config(page_title=".NET Daily Coach", page_icon="🟣", layout="wide")
st.markdown(
    """
    <style>
      .stApp { background: linear-gradient(140deg, #f7f5ff 0%, #ffffff 48%, #effaff 100%); }
      .block-container { max-width: 1120px; padding-top: 2rem; padding-bottom: 5rem; }
      [data-testid="stSidebar"] { background: linear-gradient(180deg, #f1edff 0%, #eef8ff 100%); }
      [data-testid="stMetric"] { background: linear-gradient(135deg, #ffffff, #f3f5ff); border: 1px solid #e4e6f5; padding: 14px; border-radius: 16px; box-shadow: 0 7px 22px #4044770b; }
      .plan-card { padding: 14px 16px; border: 1px solid #e8ebf2; border-radius: 12px; margin: 8px 0; background: white; }
      .small-note { color: #777; font-size: .88rem; }
      .assistant-hero { padding: 24px 26px; border-radius: 22px; color: #fff; background: linear-gradient(115deg, #5b42d8 0%, #7956ea 45%, #138dcc 100%); box-shadow: 0 14px 34px #5940c52c; margin: 4px 0 18px; }
      .assistant-hero h2 { color: #fff; margin: 0 0 5px; font-size: 1.65rem; }
      .assistant-hero p { color: #f0edff; margin: 0; }
      .chat-welcome { padding: 18px 20px; border-radius: 16px; background: linear-gradient(120deg, #f0edff, #eaf8ff); border: 1px solid #e2defe; margin-bottom: 14px; }
      .chat-welcome h3 { margin: 0 0 6px; color: #26244a; }
      .chat-welcome p { margin: 0; color: #62617a; }
      [data-testid="stChatMessage"] { border: 1px solid #e4e5f2; border-radius: 16px; padding: 12px 16px; background: #ffffffd9; box-shadow: 0 6px 20px #3939670b; }
      [data-testid="stChatInput"] { border-radius: 16px; }
      div.stButton > button { border-radius: 12px; border-color: #dedcf3; }
      div.stButton > button[kind="primary"] { background: linear-gradient(110deg, #6649dc, #178dcc); border: 0; }
      @media (max-width: 700px) { .assistant-hero { padding: 19px; } .assistant-hero h2 { font-size: 1.35rem; } }
    </style>
    """,
    unsafe_allow_html=True,
)

st.title(".NET Daily Coach")
st.caption("Build your C# skills with a small, practical study plan every day.")

llm_key = os.getenv("LLM_API_KEY", "").strip()
llm_base_url = os.getenv(
    "LLM_BASE_URL",
    "https://generativelanguage.googleapis.com/v1beta/openai",
).strip()
llm_model = os.getenv("LLM_MODEL", "gemini-3.8-flash").strip()
gmail_sender = os.getenv("GMAIL_ADDRESS", "").strip()
gmail_app_password = os.getenv("GMAIL_APP_PASSWORD", "").strip()

if "tutor_messages" not in st.session_state:
    st.session_state.tutor_messages = []

if "pending_tutor_prompt" not in st.session_state:
    st.session_state.pending_tutor_prompt = None

st.markdown(
    """
    <div class="assistant-hero">
      <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 16px;">
        <div>
          <h2>✨ Beautiful AI Voice Assistant & Coach</h2>
          <p>Ask anything about C# & .NET. Type or record a question, then listen to the answer.</p>
        </div>
        <div style="display: flex; align-items: center; gap: 12px;">
          <div style="width: 52px; height: 52px; border-radius: 50%; background: radial-gradient(circle at 35% 35%, #fff 0%, #a855f7 45%, #06b6d4 100%); box-shadow: 0 0 25px rgba(255,255,255,0.7); animation: orb-pulse 3s infinite ease-in-out;"></div>
        </div>
      </div>
    </div>
    """,
    unsafe_allow_html=True,
)
chat_title, chat_actions = st.columns([5, 1])
with chat_title:
    st.subheader("Chat with your assistant")
    st.caption("Helpful answers for coding, learning, writing, ideas, and everyday questions.")
with chat_actions:
    if st.button(
        "New chat",
        key="clear_tutor_chat",
        use_container_width=True,
        disabled=not st.session_state.tutor_messages,
    ):
        st.session_state.tutor_messages = []
        st.rerun()

with st.expander("🎙️ Record a voice question", expanded=False):
    st.caption(
        "Your recording is sent to Google AI Studio for transcription. "
        "Answers can be read aloud using your browser's speech voice."
    )
    voice_recording = st.audio_input(
        "Record your question",
        disabled=not llm_key,
        key="tutor_voice_recording",
    )
    if st.button(
        "Transcribe and ask",
        key="transcribe_tutor_audio",
        disabled=not llm_key or voice_recording is None,
        type="primary",
    ):
        try:
            transcript = transcribe_tutor_audio(
                llm_key,
                llm_model,
                voice_recording.getvalue(),
            )
        except (TutorResponseError, ValueError) as error:
            st.error(str(error))
        else:
            st.session_state.pending_tutor_prompt = transcript
            st.rerun()

if st.session_state.tutor_messages:
    with st.container(border=True):
        for chat_message in st.session_state.tutor_messages:
            avatar = "✨" if chat_message["role"] == "assistant" else "🙂"
            with st.chat_message(chat_message["role"], avatar=avatar):
                st.markdown(chat_message["content"])
                if chat_message["role"] == "assistant":
                    render_speech_button(chat_message["content"])
else:
    with st.container(border=True):
        st.markdown(
            """
            <div class="chat-welcome">
              <h3>What would you like help with?</h3>
              <p>Ask a question, explore an idea, or get a clear step-by-step explanation.</p>
            </div>
            """,
            unsafe_allow_html=True,
        )
        prompt_columns = st.columns(3)
        starter_prompts = [
            ("Explain a topic", "Explain recursion using a simple everyday example."),
            ("Help me write", "Help me write a clear, friendly email to reschedule a meeting."),
            ("Brainstorm ideas", "Give me five practical ideas for learning something new this week."),
        ]
        for column, (label, starter_prompt) in zip(prompt_columns, starter_prompts):
            with column:
                if st.button(
                    label,
                    key=f"tutor-starter-{label}",
                    use_container_width=True,
                    disabled=not llm_key,
                ):
                    st.session_state.pending_tutor_prompt = starter_prompt
                    st.rerun()

if not llm_key:
    st.info("Add LLM_API_KEY to your local .env file to use the AI assistant.")

pending_prompt = st.session_state.pop("pending_tutor_prompt", None)
prompt = st.chat_input("Ask anything...", disabled=not llm_key) or pending_prompt
if prompt:
    st.session_state.tutor_messages.append({"role": "user", "content": prompt})
    with st.chat_message("user", avatar="🙂"):
        st.markdown(prompt)
    conversation = st.session_state.tutor_messages[-20:]
    with st.chat_message("assistant", avatar="✨"):
        with st.spinner("Thinking..."):
            try:
                reply = generate_tutor_reply(
                    llm_key,
                    llm_base_url,
                    llm_model,
                    conversation,
                )
            except (TutorResponseError, ValueError) as error:
                st.error(str(error))
            else:
                st.markdown(reply)
                st.session_state.tutor_messages.append(
                    {"role": "assistant", "content": reply}
                )
                render_speech_button(reply)

settings = get_email_settings()

with st.sidebar:
    st.header("Your training")
    level = st.selectbox("Experience level", ["Beginner", "Intermediate", "Advanced"])
    task_count = st.slider("Tasks in today's plan", min_value=3, max_value=5, value=3)
    plan_day = st.date_input("Plan date", value=date.today())

    st.divider()
    st.subheader("Daily Gmail reminder")
    with st.form("email_settings_form"):
        recipient = st.text_input(
            "Send the plan to",
            value=settings["recipient"],
            placeholder="you@example.com",
        )
        send_time = st.time_input("Send time (local)", value=settings["send_time"])
        email_enabled = st.toggle(
            "Email me automatically each day",
            value=settings["enabled"],
        )
        save_email = st.form_submit_button("Save email schedule", use_container_width=True)
    if save_email:
        try:
            save_email_settings(recipient, send_time, email_enabled)
            st.success("Daily email settings saved.")
            st.rerun()
        except ValueError as error:
            st.error(str(error))

    gmail_configured = bool(gmail_sender and gmail_app_password)
    if gmail_configured:
        st.success("Gmail SMTP is configured.")
    else:
        st.warning("Add GMAIL_ADDRESS and GMAIL_APP_PASSWORD to .env to send Gmail.")
    st.caption("Use a Google App Password, not your normal Gmail password.")

    if st.button("Send a test email", disabled=not gmail_configured or not recipient.strip()):
        try:
            send_gmail_email(
                recipient.strip(),
                ".NET Daily Coach test email",
                "Your Gmail reminder setup is working.",
                gmail_sender,
                gmail_app_password,
            )
            st.success("Test email sent. Check your inbox and spam folder.")
        except EmailDeliveryError as error:
            st.error(str(error))

st.subheader(f"Study plan · {plan_day.strftime('%A, %B %d')}")
tasks: list[dict[str, Any]] = get_tasks(plan_day, DATABASE_PATH)

if not tasks:
    st.write("No plan yet. Generate a short plan and start practicing.")
    ai_column, template_column = st.columns(2)
    with ai_column:
        if st.button(
            "Generate today's plan with Gemini",
            type="primary",
            use_container_width=True,
            disabled=not llm_key,
        ):
            try:
                generated = generate_ai_tasks(
                    llm_key,
                    llm_base_url,
                    llm_model,
                    plan_day,
                    level,
                    task_count,
                )
                save_tasks(plan_day, level, generated, "Gemini")
                st.rerun()
            except (PlanGenerationError, ValueError) as error:
                st.error(str(error))
    with template_column:
        if st.button("Use built-in .NET practice plan", use_container_width=True):
            try:
                generated = generate_template_tasks(level, task_count)
                save_tasks(plan_day, level, generated, "Built-in")
                st.rerun()
            except ValueError as error:
                st.error(str(error))
    if not llm_key:
        st.info("Gemini is not configured. You can still use the built-in daily plans.")
else:
    completed_count = sum(bool(task["completed"]) for task in tasks)
    total_minutes = sum(int(task["minutes"]) for task in tasks)
    metrics = st.columns(3)
    metrics[0].metric("Progress", f"{completed_count}/{len(tasks)} tasks")
    metrics[1].metric("Study time", f"{total_minutes} min")
    metrics[2].metric("Plan source", tasks[0]["source"])

    st.progress(completed_count / len(tasks))
    for task in tasks:
        with st.container(border=True):
            checkbox_column, details_column = st.columns([0.07, 0.93])
            with checkbox_column:
                completed = st.checkbox(
                    "Complete",
                    value=bool(task["completed"]),
                    key=f"done-{task['id']}",
                    label_visibility="collapsed",
                )
            if completed != bool(task["completed"]):
                set_task_completed(task["id"], completed)
                st.rerun()
            with details_column:
                st.markdown(f"**{task['title']}** · {task['minutes']} min")
                st.write(task["goal"])
                with st.expander("Open the practice task"):
                    st.write(task["exercise"])

    if st.button("Refresh this plan", help="Refreshes the page; completed tasks are kept."):
        st.rerun()

st.divider()
with st.expander("Set up Gmail reminders"):
    st.markdown(
        """
        1. In your Google Account, turn on **2-Step Verification**.
        2. Create an **App Password** for this local app in Google Account security settings.
        3. Add these values to the local, gitignored `.env` file:
        """
    )
    st.code(
        "GMAIL_ADDRESS=your-gmail-address@gmail.com\n"
        "GMAIL_APP_PASSWORD=your-16-character-app-password",
        language="dotenv",
    )
    st.markdown(
        "Save `.env`, restart Streamlit, enter the destination address and local send time, "
        "then enable the daily email. The app must remain open and running at that time."
    )
    st.markdown(
        "The separate Gemini API key only creates study plans; it does not grant Gmail access."
    )


@st.fragment(run_every="60s")
def scheduled_email_check() -> None:
    current_settings = get_email_settings()
    if not current_settings["enabled"] or not current_settings["recipient"]:
        return
    if not gmail_sender or not gmail_app_password:
        st.caption("Daily Gmail is enabled but waiting for Gmail SMTP credentials in `.env`.")
        return

    current_time = datetime.now().astimezone()
    if current_time.date() != date.today() or current_time.time().replace(tzinfo=None) < current_settings["send_time"]:
        return
    todays_tasks = get_tasks(date.today(), DATABASE_PATH)
    if not todays_tasks:
        return
    if not reserve_daily_email(date.today(), current_settings["recipient"]):
        return

    try:
        send_gmail_email(
            current_settings["recipient"],
            f"Your .NET study plan for {date.today().strftime('%A, %B %d')}",
            daily_email_body(date.today(), todays_tasks),
            gmail_sender,
            gmail_app_password,
        )
    except EmailDeliveryError as error:
        finish_daily_email(date.today(), sent=False, error=str(error))
        st.error(f"Daily Gmail reminder failed: {error}")
    else:
        finish_daily_email(date.today(), sent=True)
        st.toast("Today's study plan was sent to your email.", icon="✉️")


scheduled_email_check()
