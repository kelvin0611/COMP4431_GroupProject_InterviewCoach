"""HTTP contract for answer highlighting, progress and polishing (demo provider)."""

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app

ANSWER = (
    "In our project the API was slow. I was responsible for the fix. "
    "I implemented caching. Latency was reduced by 30%."
)


@pytest.fixture
def client(tmp_path):
    settings = Settings(
        database_url=f"sqlite:///{tmp_path}/test.db",
        model_provider="demo",
        whisper_base_url="http://127.0.0.1:9",
    )
    with TestClient(create_app(settings)) as client:
        yield client


def start_session(client):
    profile = client.post(
        "/api/job-profiles",
        json={
            "text": "Graduate Software Engineer. Build Python APIs, test software and use SQL databases.",
            "title": "Graduate Engineer",
        },
    )
    assert profile.status_code == 201, profile.text
    session = client.post(
        "/api/sessions",
        json={
            "job_profile_id": profile.json()["id"],
            "language": "en-HK",
            "question_count": 3,
            "difficulty": "standard",
            "store_transcript": True,
        },
    )
    assert session.status_code == 201, session.text
    return session.json()


def answer_once(client, session):
    result = client.post(
        f"/api/sessions/{session['id']}/answer",
        json={"transcript": ANSWER, "language": "en-HK", "elapsed_seconds": 40},
    )
    assert result.status_code == 200, result.text
    return result.json()


def test_answers_endpoint_returns_star_segments_for_each_answer(client):
    session = answer_once(client, start_session(client))
    answers = client.get(f"/api/sessions/{session['id']}/answers")
    assert answers.status_code == 200, answers.text
    [first] = answers.json()
    assert first["transcript"] == ANSWER
    assert "".join(segment["text"] for segment in first["segments"]) == ANSWER
    assert {segment["element"] for segment in first["segments"]} >= {"Situation", "Result"}


def test_polish_endpoint_rewrites_an_answered_turn(client):
    session = answer_once(client, start_session(client))
    turn_id = session["turns"][0]["id"]
    result = client.post(
        f"/api/sessions/{session['id']}/turns/{turn_id}/polish", json={"target_language": "en-HK"}
    )
    assert result.status_code == 200, result.text
    body = result.json()
    assert body["provider"] == "demo"
    assert [part["element"] for part in body["parts"]] == ["Situation", "Task", "Action", "Result"]


def test_polish_endpoint_rejects_unknown_and_unanswered_turns(client):
    session = answer_once(client, start_session(client))
    unknown = client.post(f"/api/sessions/{session['id']}/turns/nope/polish", json={})
    assert unknown.status_code == 404
    pending_turn = session["turns"][-1]["id"]
    unanswered = client.post(f"/api/sessions/{session['id']}/turns/{pending_turn}/polish", json={})
    assert unanswered.status_code == 409


def test_progress_endpoint_reports_star_coverage_per_session(client):
    answer_once(client, start_session(client))
    start_session(client)
    progress = client.get("/api/progress")
    assert progress.status_code == 200, progress.text
    [point] = progress.json()
    assert point["answer_count"] == 1
    assert point["covered"] == ["Situation", "Task", "Action", "Result"]
