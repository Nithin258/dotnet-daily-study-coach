from __future__ import annotations

import base64
import json
import os
import re
import smtplib
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import date, datetime, time, timedelta
from email.message import EmailMessage
from pathlib import Path
from typing import Any, Iterator
from urllib.parse import quote

import requests


ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
DATABASE_PATH = DATA_DIR / "dotnet_training.sqlite3"

CURRICULUM: dict[str, list[dict[str, Any]]] = {
    "Beginner": [
        {
            "title": "C# types and variables",
            "goal": "Choose suitable built-in types and explain the difference between value and reference types.",
            "exercise": "Write a small program that stores a learner's name, study minutes, and average score, then prints them with string interpolation.",
        },
        {
            "title": "Conditions and pattern matching",
            "goal": "Use if/else, switch expressions, and relational patterns to make readable decisions.",
            "exercise": "Write a method that maps a score from 0 to 100 to a letter grade and handles out-of-range values.",
        },
        {
            "title": "Loops and collections",
            "goal": "Select between for, foreach, List<T>, and arrays for common data-processing tasks.",
            "exercise": "Create a list of five scores and calculate the count, total, and average using foreach.",
        },
        {
            "title": "Methods and parameters",
            "goal": "Create reusable methods with clear parameter and return types.",
            "exercise": "Write a method that accepts a list of integers and returns the largest value; decide how it should handle an empty list.",
        },
        {
            "title": "Classes, objects, and properties",
            "goal": "Model a simple domain object and distinguish a class from an instance.",
            "exercise": "Create a Book class with Title and Author properties, then instantiate two books and print their details.",
        },
        {
            "title": "Exceptions and input validation",
            "goal": "Validate input and use exceptions for exceptional failures rather than normal control flow.",
            "exercise": "Parse a score with int.TryParse, reject values outside 0-100, and explain when a try/catch is appropriate.",
        },
        {
            "title": "Interfaces and polymorphism",
            "goal": "Describe an interface as a contract and use it to swap implementations.",
            "exercise": "Define an INotifier interface and implement ConsoleNotifier; write a method that depends on INotifier.",
        },
    ],
    "Intermediate": [
        {
            "title": "LINQ filtering and projection",
            "goal": "Use Where, Select, OrderBy, and ToList to express collection transformations.",
            "exercise": "Given a list of students, select the names of students with a passing score, ordered by score descending.",
        },
        {
            "title": "Async and await",
            "goal": "Use Task and async/await without blocking on .Result or .Wait().",
            "exercise": "Write an async method that reads a text file with File.ReadAllTextAsync and explain how cancellation could be added.",
        },
        {
            "title": "Dependency injection",
            "goal": "Explain constructor injection and why code should depend on abstractions.",
            "exercise": "Refactor a report service to receive an IClock dependency through its constructor and describe how to test it.",
        },
        {
            "title": "Unit testing with xUnit",
            "goal": "Arrange, act, and assert on a small unit of behavior with meaningful test names.",
            "exercise": "Write tests for a grade calculator, including a boundary score and invalid input.",
        },
        {
            "title": "ASP.NET Core minimal APIs",
            "goal": "Build a small HTTP endpoint and return appropriate status codes.",
            "exercise": "Sketch GET and POST endpoints for a task resource and identify the response for a missing task.",
        },
        {
            "title": "Entity Framework Core basics",
            "goal": "Understand DbContext, entity configuration, and asynchronous database operations.",
            "exercise": "Model a StudyTask entity and write an async query for incomplete tasks due today.",
        },
        {
            "title": "Nullable reference types",
            "goal": "Use nullable annotations and guard clauses to make null handling explicit.",
            "exercise": "Review a method that accepts a possibly missing email and design its contract with string? and validation.",
        },
    ],
    "Advanced": [
        {
            "title": "Cancellation and structured concurrency",
            "goal": "Propagate CancellationToken through asynchronous application and data-access methods.",
            "exercise": "Design an ASP.NET endpoint and service method that pass a cancellation token to an async database query.",
        },
        {
            "title": "Concurrency and thread safety",
            "goal": "Identify shared mutable state and choose an appropriate synchronization or immutable design.",
            "exercise": "Analyze a shared in-memory counter used by concurrent requests and propose a safe implementation.",
        },
        {
            "title": "Performance profiling and allocation",
            "goal": "Use measurement before optimizing and recognize avoidable allocations in hot paths.",
            "exercise": "Compare repeated string concatenation with StringBuilder and outline a benchmark using BenchmarkDotNet.",
        },
        {
            "title": "Resilient HTTP clients",
            "goal": "Configure IHttpClientFactory, timeouts, cancellation, and safe retry boundaries.",
            "exercise": "Design a typed client for a flaky upstream service and explain which failures are safe to retry.",
        },
        {
            "title": "Clean architecture and boundaries",
            "goal": "Keep domain logic independent from framework and infrastructure details.",
            "exercise": "Sketch project boundaries for a study-plan service and show where interfaces and persistence adapters belong.",
        },
        {
            "title": "Security fundamentals for .NET APIs",
            "goal": "Apply least privilege, input validation, secret management, and authorization checks.",
            "exercise": "Review a task API endpoint and list the checks needed before one user can access another user's task.",
        },
        {
            "title": "Integration testing",
            "goal": "Test an ASP.NET API with a real test host and controlled external dependencies.",
            "exercise": "Outline a WebApplicationFactory test for creating a task and checking the persisted response.",
        },
    ],
}


class PlanGenerationError(RuntimeError):
    """Raised when the configured tutor cannot produce a usable study plan."""


class TutorResponseError(RuntimeError):
    """Raised when the configured tutor cannot answer a chat message."""


class EmailDeliveryError(RuntimeError):
    """Raised when Gmail cannot accept a study-plan email."""


@contextmanager
def connect_database(database_path: Path = DATABASE_PATH) -> Iterator[sqlite3.Connection]:
    database_path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(database_path, timeout=15)
    connection.row_factory = sqlite3.Row
    try:
        connection.execute("PRAGMA journal_mode=WAL")
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY,
                plan_date TEXT NOT NULL,
                level TEXT NOT NULL,
                title TEXT NOT NULL,
                goal TEXT NOT NULL,
                exercise TEXT NOT NULL,
                minutes INTEGER NOT NULL,
                completed INTEGER NOT NULL DEFAULT 0,
                source TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS tasks_by_date ON tasks(plan_date);
            CREATE TABLE IF NOT EXISTS email_settings (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                recipient TEXT NOT NULL DEFAULT '',
                send_time TEXT NOT NULL DEFAULT '08:00',
                enabled INTEGER NOT NULL DEFAULT 0
            );
            INSERT OR IGNORE INTO email_settings (id) VALUES (1);
            CREATE TABLE IF NOT EXISTS digest_delivery (
                plan_date TEXT PRIMARY KEY,
                recipient TEXT NOT NULL,
                status TEXT NOT NULL,
                last_attempt TEXT NOT NULL,
                error TEXT NOT NULL DEFAULT ''
            );
            """
        )
        with connection:
            yield connection
    finally:
        connection.close()


def get_tasks(plan_date: date, database_path: Path = DATABASE_PATH) -> list[dict[str, Any]]:
    with connect_database(database_path) as connection:
        rows = connection.execute(
            "SELECT * FROM tasks WHERE plan_date = ? ORDER BY rowid",
            (plan_date.isoformat(),),
        ).fetchall()
    return [dict(row) for row in rows]


def save_tasks(
    plan_date: date,
    level: str,
    tasks: list[dict[str, Any]],
    source: str,
    database_path: Path = DATABASE_PATH,
) -> None:
    if level not in CURRICULUM:
        raise ValueError("Choose Beginner, Intermediate, or Advanced.")
    if not tasks:
        raise ValueError("A daily study plan must contain at least one task.")
    with connect_database(database_path) as connection:
        existing = connection.execute(
            "SELECT 1 FROM tasks WHERE plan_date = ? LIMIT 1",
            (plan_date.isoformat(),),
        ).fetchone()
        if existing:
            raise ValueError("A plan already exists for this date.")
        connection.executemany(
            """
            INSERT INTO tasks
                (id, plan_date, level, title, goal, exercise, minutes, completed, source)
            VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
            """,
            [
                (
                    str(uuid.uuid4()),
                    plan_date.isoformat(),
                    level,
                    task["title"],
                    task["goal"],
                    task["exercise"],
                    task["minutes"],
                    source,
                )
                for task in tasks
            ],
        )


def set_task_completed(
    task_id: str,
    completed: bool,
    database_path: Path = DATABASE_PATH,
) -> None:
    with connect_database(database_path) as connection:
        result = connection.execute(
            "UPDATE tasks SET completed = ? WHERE id = ?",
            (int(completed), task_id),
        )
        if result.rowcount != 1:
            raise ValueError("Study task was not found.")


def get_email_settings(database_path: Path = DATABASE_PATH) -> dict[str, Any]:
    with connect_database(database_path) as connection:
        row = connection.execute(
            "SELECT recipient, send_time, enabled FROM email_settings WHERE id = 1"
        ).fetchone()
    return {
        "recipient": row["recipient"],
        "send_time": time.fromisoformat(row["send_time"]),
        "enabled": bool(row["enabled"]),
    }


def save_email_settings(
    recipient: str,
    send_time: time,
    enabled: bool,
    database_path: Path = DATABASE_PATH,
) -> None:
    normalized_recipient = recipient.strip()
    if normalized_recipient and not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", normalized_recipient):
        raise ValueError("Enter a valid email address.")
    with connect_database(database_path) as connection:
        connection.execute(
            """
            UPDATE email_settings
            SET recipient = ?, send_time = ?, enabled = ?
            WHERE id = 1
            """,
            (normalized_recipient, send_time.isoformat(timespec="minutes"), int(enabled)),
        )


def generate_template_tasks(level: str, count: int) -> list[dict[str, Any]]:
    if level not in CURRICULUM:
        raise ValueError("Choose Beginner, Intermediate, or Advanced.")
    if not 1 <= count <= 7:
        raise ValueError("Choose between 1 and 7 study tasks.")
    return [
        {
            **item,
            "minutes": 15 if index < 3 else 20,
        }
        for index, item in enumerate(CURRICULUM[level][:count])
    ]


def _parse_plan(content: str, count: int) -> list[dict[str, Any]]:
    cleaned = content.strip()
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", cleaned, flags=re.IGNORECASE)
    start = cleaned.find("[")
    end = cleaned.rfind("]")
    if start < 0 or end < start:
        raise PlanGenerationError("Gemini did not return a JSON task list. Try again or use the built-in plan.")
    try:
        parsed = json.loads(cleaned[start : end + 1])
    except json.JSONDecodeError as error:
        raise PlanGenerationError("Gemini returned an unreadable plan. Try again or use the built-in plan.") from error
    if not isinstance(parsed, list) or len(parsed) != count:
        raise PlanGenerationError(f"Gemini must return exactly {count} tasks. Try again or use the built-in plan.")

    validated: list[dict[str, Any]] = []
    for item in parsed:
        if not isinstance(item, dict):
            raise PlanGenerationError("Gemini returned an invalid task. Try again or use the built-in plan.")
        task: dict[str, Any] = {}
        for field in ("title", "goal", "exercise"):
            value = item.get(field)
            if not isinstance(value, str) or not value.strip() or len(value) > 1200:
                raise PlanGenerationError("Gemini returned a task with missing or invalid details.")
            task[field] = value.strip()
        try:
            minutes = int(item.get("minutes", 20))
        except (TypeError, ValueError) as error:
            raise PlanGenerationError("Gemini returned an invalid task duration.") from error
        if not 5 <= minutes <= 90:
            raise PlanGenerationError("Gemini returned a task duration outside 5-90 minutes.")
        task["minutes"] = minutes
        validated.append(task)
    return validated


def generate_ai_tasks(
    api_key: str,
    base_url: str,
    model: str,
    plan_date: date,
    level: str,
    count: int,
    timeout: int = 35,
) -> list[dict[str, Any]]:
    if not api_key.strip():
        raise PlanGenerationError("Add LLM_API_KEY to your local .env file to generate AI study plans.")
    if level not in CURRICULUM or not 1 <= count <= 7:
        raise ValueError("Choose a supported level and between 1 and 7 tasks.")

    endpoint = f"{base_url.rstrip('/')}/chat/completions"
    payload = {
        "model": model,
        "temperature": 0.6,
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are a practical .NET/C# instructor. Create distinct daily study tasks "
                    "appropriate to the learner's level. Each task must include title, goal, "
                    "exercise, and minutes (5-90). Return only a JSON array, with no markdown."
                ),
            },
            {
                "role": "user",
                "content": (
                    f"Create exactly {count} C#/.NET study tasks for {plan_date.isoformat()} "
                    f"at {level} level. Cover a useful progression of concepts. Include concrete "
                    "hands-on coding exercises, realistic time estimates, and no repeated topics. "
                    'JSON shape: [{"title":"...", "goal":"...", "exercise":"...", "minutes":20}]'
                ),
            },
        ],
    }
    try:
        response = requests.post(
            endpoint,
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json=payload,
            timeout=timeout,
        )
    except requests.RequestException as error:
        raise PlanGenerationError("Could not reach Google AI Studio. Check your connection and try again.") from error

    if not response.ok:
        messages = {
            401: "Google AI Studio rejected the API key. Check LLM_API_KEY in .env.",
            403: "Google AI Studio denied the request. Check API access and quota for this key.",
            404: "Google AI Studio could not find this model. Check LLM_MODEL in .env.",
            429: "Google AI Studio quota or rate limit reached. Wait, then try again.",
            503: "Google AI Studio is temporarily busy. Wait a minute and try again.",
        }
        raise PlanGenerationError(messages.get(response.status_code, f"Google AI Studio request failed (HTTP {response.status_code})."))
    try:
        response_data = response.json()
        content = response_data["choices"][0]["message"]["content"]
    except (ValueError, KeyError, IndexError, TypeError) as error:
        raise PlanGenerationError("Google AI Studio returned an unexpected response. Try again.") from error
    if not isinstance(content, str):
        raise PlanGenerationError("Google AI Studio returned an empty study plan. Try again.")
    return _parse_plan(content, count)


def generate_tutor_reply(
    api_key: str,
    base_url: str,
    model: str,
    messages: list[dict[str, str]],
    timeout: int = 35,
) -> str:
    if not api_key.strip():
        raise TutorResponseError("Add LLM_API_KEY to your local .env file to use the AI assistant.")
    if not messages or len(messages) > 20:
        raise ValueError("The tutor chat must contain between 1 and 20 messages.")
    for message in messages:
        if (
            message.get("role") not in {"user", "assistant"}
            or not isinstance(message.get("content"), str)
            or not message["content"].strip()
            or len(message["content"]) > 4000
        ):
            raise ValueError("The tutor chat contains an invalid message.")

    payload = {
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are a helpful, capable general-purpose AI assistant. Answer questions "
                    "across a wide range of topics, including programming, learning, writing, "
                    "creative work, and everyday questions. Be clear, accurate, and appropriately "
                    "detailed; adapt explanations to the user's needs and use examples when useful. "
                    "For C# and .NET questions, provide practical, correct explanations and code "
                    "examples. If you are unsure or a request needs current information you cannot "
                    "verify, say so plainly instead of inventing facts. Ask a brief follow-up "
                    "question when the request is ambiguous."
                ),
            },
            *messages,
        ],
    }
    try:
        response = requests.post(
            f"{base_url.rstrip('/')}/chat/completions",
            headers={"Authorization": f"******", "Content-Type": "application/json"},
            json=payload,
            timeout=timeout,
        )
    except requests.RequestException as error:
        raise TutorResponseError(
            "Could not reach the AI service. Check your connection and try again."
        ) from error

    if not response.ok:
        messages_by_status = {
            401: "The AI service rejected the API key. Check LLM_API_KEY in .env.",
            403: "The AI service denied the request. Check API access and quota for this key.",
            404: "The AI service could not find this model. Check LLM_MODEL in .env.",
            429: "The AI service quota or rate limit was reached. Wait, then try again.",
            503: "The AI service is temporarily busy. Wait a minute and try again.",
        }
        detail = _provider_error_detail(response, api_key)
        message = messages_by_status.get(
            response.status_code,
            f"The AI service rejected the request (HTTP {response.status_code}).",
        )
        raise TutorResponseError(
            f"{message} {detail}" if detail else message
        )
    try:
        response_data = response.json()
        content = response_data["choices"][0]["message"]["content"]
    except (ValueError, KeyError, IndexError, TypeError) as error:
        raise TutorResponseError(
            "The AI service returned an unexpected response. Please try again."
        ) from error
    if not isinstance(content, str) or not content.strip():
        raise TutorResponseError("The AI service returned an empty answer. Please try again.")
    return content.strip()


def _provider_error_detail(response: requests.Response, api_key: str) -> str:
    try:
        response_data = response.json()
    except (ValueError, TypeError):
        return ""
    if not isinstance(response_data, dict):
        return ""
    provider_error = response_data.get("error")
    if not isinstance(provider_error, dict):
        return ""
    detail = provider_error.get("message")
    if not isinstance(detail, str) or not detail.strip():
        return ""
    safe_detail = detail.strip().replace(api_key, "[redacted]")
    return f"Provider details: {safe_detail[:500]}"


def transcribe_tutor_audio(
    api_key: str,
    model: str,
    audio: bytes,
    timeout: int = 45,
) -> str:
    if not api_key.strip():
        raise TutorResponseError("Add LLM_API_KEY to your local .env file to use voice input.")
    if not audio or len(audio) > 15 * 1024 * 1024:
        raise ValueError("Record a non-empty voice question shorter than 15 MB.")
    if not model.strip():
        raise ValueError("Set LLM_MODEL in .env before using voice input.")

    endpoint = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        f"{quote(model.strip(), safe='')}:generateContent"
    )
    payload = {
        "contents": [
            {
                "parts": [
                    {
                        "inlineData": {
                            "mimeType": "audio/wav",
                            "data": base64.b64encode(audio).decode("ascii"),
                        }
                    },
                    {
                        "text": (
                            "Transcribe the spoken question exactly. Return only the "
                            "transcription, without commentary."
                        )
                    },
                ]
            }
        ]
    }
    try:
        response = requests.post(
            endpoint,
            params={"key": api_key},
            json=payload,
            timeout=timeout,
        )
    except requests.RequestException as error:
        raise TutorResponseError(
            "Could not reach Google AI Studio to transcribe the recording."
        ) from error

    if not response.ok:
        detail = _provider_error_detail(response, api_key)
        message = (
            "Google AI Studio could not transcribe the recording "
            f"(HTTP {response.status_code})."
        )
        raise TutorResponseError(f"{message} {detail}" if detail else message)
    try:
        response_data = response.json()
        parts = response_data["candidates"][0]["content"]["parts"]
        transcript = " ".join(
            part["text"].strip()
            for part in parts
            if isinstance(part, dict)
            and isinstance(part.get("text"), str)
            and part["text"].strip()
        )
    except (ValueError, KeyError, IndexError, TypeError) as error:
        raise TutorResponseError(
            "Google AI Studio returned an unreadable voice transcription."
        ) from error
    if not transcript:
        raise TutorResponseError("No speech was recognized. Try recording your question again.")
    return transcript


def send_gmail_email(
    recipient: str,
    subject: str,
    body: str,
    sender: str,
    app_password: str,
) -> None:
    if not sender.strip() or not app_password.strip():
        raise EmailDeliveryError("Set GMAIL_ADDRESS and GMAIL_APP_PASSWORD in .env first.")

    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = sender.strip()
    message["To"] = recipient.strip()
    message.set_content(body)

    try:
        with smtplib.SMTP("smtp.gmail.com", 587, timeout=25) as smtp:
            smtp.ehlo()
            smtp.starttls()
            smtp.ehlo()
            smtp.login(sender.strip(), app_password.replace(" ", ""))
            smtp.send_message(message)
    except smtplib.SMTPAuthenticationError as error:
        raise EmailDeliveryError(
            "Gmail authentication failed. Use the Gmail address and a Google App Password (not your account password)."
        ) from error
    except (smtplib.SMTPException, OSError) as error:
        raise EmailDeliveryError("Gmail could not send the message. Check the SMTP setup and try again.") from error


def reserve_daily_email(
    plan_date: date,
    recipient: str,
    now: datetime | None = None,
    database_path: Path = DATABASE_PATH,
) -> bool:
    current_time = now or datetime.now().astimezone()
    current_time = current_time.astimezone()
    cutoff = (current_time - timedelta(minutes=15)).isoformat()
    with connect_database(database_path) as connection:
        connection.execute("BEGIN IMMEDIATE")
        previous = connection.execute(
            "SELECT status, last_attempt FROM digest_delivery WHERE plan_date = ?",
            (plan_date.isoformat(),),
        ).fetchone()
        if previous and (
            previous["status"] == "sent" or previous["last_attempt"] > cutoff
        ):
            return False
        connection.execute(
            """
            INSERT INTO digest_delivery (plan_date, recipient, status, last_attempt, error)
            VALUES (?, ?, 'sending', ?, '')
            ON CONFLICT(plan_date) DO UPDATE SET
                recipient = excluded.recipient,
                status = 'sending',
                last_attempt = excluded.last_attempt,
                error = ''
            """,
            (plan_date.isoformat(), recipient, current_time.isoformat()),
        )
    return True


def finish_daily_email(
    plan_date: date,
    sent: bool,
    error: str = "",
    database_path: Path = DATABASE_PATH,
) -> None:
    with connect_database(database_path) as connection:
        connection.execute(
            """
            UPDATE digest_delivery
            SET status = ?, error = ?
            WHERE plan_date = ?
            """,
            ("sent" if sent else "error", error[:300], plan_date.isoformat()),
        )


def daily_email_body(plan_date: date, tasks: list[dict[str, Any]]) -> str:
    lines = [f"Your C#/.NET study plan for {plan_date.strftime('%A, %B %d, %Y')}", ""]
    if not tasks:
        lines.extend(["No study tasks have been added for today yet.", ""])
        return "\n".join(lines)
    for task in tasks:
        state = "DONE" if task["completed"] else "TODO"
        lines.extend(
            [
                f"[{state}] {task['title']} ({task['minutes']} minutes)",
                f"Goal: {task['goal']}",
                f"Practice: {task['exercise']}",
                "",
            ]
        )
    completed_count = sum(bool(task["completed"]) for task in tasks)
    lines.append(f"Progress: {completed_count} of {len(tasks)} tasks complete.")
    lines.append("Small steps every day build strong .NET skills. Keep going!")
    return "\n".join(lines)
