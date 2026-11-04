from datetime import date, datetime, time, timezone
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from study_plan import (
    PlanGenerationError,
    TutorResponseError,
    _parse_plan,
    daily_email_body,
    finish_daily_email,
    generate_template_tasks,
    get_email_settings,
    get_tasks,
    generate_tutor_reply,
    transcribe_tutor_audio,
    reserve_daily_email,
    save_email_settings,
    save_tasks,
    set_task_completed,
)


class StudyPlanTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.database_path = Path(self.temporary_directory.name) / "study.sqlite3"
        self.today = date(2026, 11, 3)

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def test_template_tasks_match_requested_count(self) -> None:
        tasks = generate_template_tasks("Beginner", 3)
        self.assertEqual(len(tasks), 3)
        self.assertTrue(all(task["minutes"] >= 5 for task in tasks))

    def test_ai_plan_json_is_validated(self) -> None:
        content = '[{"title":"LINQ","goal":"Filter values","exercise":"Use Where","minutes":20}]'
        self.assertEqual(_parse_plan(content, 1)[0]["title"], "LINQ")
        with self.assertRaises(PlanGenerationError):
            _parse_plan("not json", 1)

    def test_tasks_persist_and_completion_is_saved(self) -> None:
        tasks = generate_template_tasks("Beginner", 3)
        save_tasks(self.today, "Beginner", tasks, "Built-in", self.database_path)
        saved = get_tasks(self.today, self.database_path)
        self.assertEqual(len(saved), 3)
        set_task_completed(saved[0]["id"], True, self.database_path)
        self.assertEqual(get_tasks(self.today, self.database_path)[0]["completed"], 1)

    def test_email_settings_round_trip(self) -> None:
        save_email_settings("learner@example.com", time(9, 15), True, self.database_path)
        settings = get_email_settings(self.database_path)
        self.assertEqual(settings["recipient"], "learner@example.com")
        self.assertEqual(settings["send_time"], time(9, 15))
        self.assertTrue(settings["enabled"])

    def test_daily_email_claim_is_sent_once(self) -> None:
        now = datetime(2026, 11, 3, 10, 0, tzinfo=timezone.utc)
        self.assertTrue(reserve_daily_email(self.today, "learner@example.com", now, self.database_path))
        self.assertFalse(reserve_daily_email(self.today, "learner@example.com", now, self.database_path))
        finish_daily_email(self.today, True, database_path=self.database_path)
        self.assertFalse(
            reserve_daily_email(
                self.today,
                "learner@example.com",
                datetime(2026, 11, 4, 10, 0, tzinfo=timezone.utc),
                self.database_path,
            )
        )

    def test_daily_email_includes_status_and_exercise(self) -> None:
        tasks = [
            {
                "title": "C# types",
                "goal": "Understand variables.",
                "exercise": "Write a small program.",
                "minutes": 15,
                "completed": 1,
            }
        ]
        body = daily_email_body(self.today, tasks)
        self.assertIn("[DONE] C# types", body)
        self.assertIn("Write a small program.", body)

    @patch("study_plan.requests.post")
    def test_tutor_returns_gemini_answer(self, post: Mock) -> None:
        response = Mock()
        response.ok = True
        response.json.return_value = {
            "choices": [{"message": {"content": "A class is a blueprint."}}]
        }
        post.return_value = response
        reply = generate_tutor_reply(
            "test-key",
            "https://example.test/v1",
            "test-model",
            [{"role": "user", "content": "What is a class?"}],
        )
        self.assertEqual(reply, "A class is a blueprint.")
        self.assertEqual(
            post.call_args.kwargs["json"]["messages"][-1],
            {"role": "user", "content": "What is a class?"},
        )
        system_prompt = post.call_args.kwargs["json"]["messages"][0]["content"]
        self.assertIn("general-purpose AI assistant", system_prompt)
        self.assertIn("wide range of topics", system_prompt)
        self.assertIn("C# and .NET", system_prompt)

    @patch("study_plan.requests.post")
    def test_tutor_reports_unavailable_model(self, post: Mock) -> None:
        response = Mock()
        response.ok = False
        response.status_code = 404
        post.return_value = response
        with self.assertRaisesRegex(TutorResponseError, "could not find this model"):
            generate_tutor_reply(
                "test-key",
                "https://example.test/v1",
                "missing-model",
                [{"role": "user", "content": "Explain LINQ."}],
            )

    @patch("study_plan.requests.post")
    def test_tutor_includes_provider_detail_for_bad_request_without_leaking_key(
        self, post: Mock
    ) -> None:
        response = Mock()
        response.ok = False
        response.status_code = 400
        response.json.return_value = {
            "error": {"message": "Invalid model for key secret-test-key"}
        }
        post.return_value = response
        with self.assertRaises(TutorResponseError) as error:
            generate_tutor_reply(
                "secret-test-key",
                "https://example.test/v1",
                "invalid-model",
                [{"role": "user", "content": "Hello"}],
            )
        self.assertIn("Invalid model for key [redacted]", str(error.exception))
        self.assertNotIn("secret-test-key", str(error.exception))

    @patch("study_plan.requests.post")
    def test_voice_input_transcribes_google_audio_response(self, post: Mock) -> None:
        response = Mock()
        response.ok = True
        response.json.return_value = {
            "candidates": [
                {"content": {"parts": [{"text": "Explain C# classes."}]}}
            ]
        }
        post.return_value = response
        transcript = transcribe_tutor_audio("test-key", "test-model", b"wav-audio")
        self.assertEqual(transcript, "Explain C# classes.")
        self.assertIn("test-model:generateContent", post.call_args.args[0])
        self.assertEqual(post.call_args.kwargs["params"], {"key": "test-key"})
        self.assertEqual(
            post.call_args.kwargs["json"]["contents"][0]["parts"][0]["inlineData"][
                "mimeType"
            ],
            "audio/wav",
        )

    def test_voice_input_rejects_empty_or_oversized_recordings(self) -> None:
        with self.assertRaises(ValueError):
            transcribe_tutor_audio("test-key", "model", b"")
        with self.assertRaises(ValueError):
            transcribe_tutor_audio("test-key", "model", b"x" * (15 * 1024 * 1024 + 1))

    def test_tutor_rejects_empty_or_oversized_conversations(self) -> None:
        with self.assertRaises(ValueError):
            generate_tutor_reply("test-key", "https://example.test/v1", "model", [])
        with self.assertRaises(ValueError):
            generate_tutor_reply(
                "test-key",
                "https://example.test/v1",
                "model",
                [{"role": "user", "content": "x" * 4001}],
            )


if __name__ == "__main__":
    unittest.main()
