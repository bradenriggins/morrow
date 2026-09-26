"""Failure cases for the browser-owned Moodle course read."""

import unittest

from moodle import browser_read


class MoodleBrowserReadTest(unittest.TestCase):
    def test_rejects_unsafe_site_addresses(self):
        for base in (
            "http://school.example/moodle",
            "https://user:password@school.example/moodle",
            "https://school.example.evil.test/moodle",
            "https://school.example/moodle?token=secret",
            "https://school.example/moodle#secret",
        ):
            with self.subTest(base=base):
                with self.assertRaises(ValueError):
                    browser_read.normalize_site_base(
                        base, expected_host="school.example")

    def test_moodle_state_is_separate_from_canvas_state(self):
        config = browser_read.BrowserConfig.for_tree(
            "/tmp/example-morrow-tree", "https://school.example/moodle",
            state_root="/tmp/example-morrow-state")
        self.assertIn("/moodle/", config.profile_dir)
        self.assertNotIn("/helper/profile", config.profile_dir)
        self.assertNotEqual(config.port, 8901)
        self.assertNotEqual(config.port, 8902)

    def test_course_result_removes_extra_provider_fields(self):
        result = browser_read.validate_course_result({
            "ok": True,
            "principal_id": 3,
            "courses": [{"id": 2, "name": "My first course",
                         "student_name": "Do not send", "enrolled": 14}],
            "sesskey": "Do not send",
            "raw": "Do not send",
        })
        self.assertEqual(result, {
            "principal_id": 3,
            "courses": [{"id": 2, "name": "My first course"}],
        })

    def test_unknown_or_failed_result_never_becomes_a_course_list(self):
        bad = (
            {"ok": False, "code": "login_required"},
            {"ok": True, "principal_id": 0, "courses": []},
            {"ok": True, "principal_id": 3, "courses": "not a list"},
            {"ok": True, "principal_id": 3,
             "courses": [{"id": "2", "name": "ok"}]},
            {"ok": True, "principal_id": 3,
             "courses": [{"id": 2, "name": ""}]},
        )
        for result in bad:
            with self.subTest(result=result):
                with self.assertRaises(browser_read.CourseReadError):
                    browser_read.validate_course_result(result)

    def test_script_is_read_only_and_contains_no_secret_value(self):
        expression = browser_read.course_list_expression(
            "https://school.example/moodle")
        self.assertIn("core_course_get_enrolled_courses_by_timeline_classification",
                      expression)
        self.assertIn("method: 'POST'", expression)
        self.assertIn("credentials: 'same-origin'", expression)
        self.assertNotIn("Do not send", expression)
        self.assertNotIn("MoodleSession.write", expression)


if __name__ == "__main__":
    unittest.main()
