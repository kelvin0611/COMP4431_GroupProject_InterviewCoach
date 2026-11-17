"""Answer tools: STAR highlighting, progress over sessions and grounded answer polishing."""

import json

import httpx
import pytest

from app.answer_tools import (
    ModelPolish,
    PolishUnavailable,
    check_polish_output,
    fallback_polish,
    polish_answer,
    progress_points,
    star_segments,
)
from app.config import Settings
from app.schemas import AnswerSubmission, CoachTurn, Session, Turn

ENGLISH = (
    "In our project the API was slow. I was responsible for the fix. "
    "I implemented caching. Latency was reduced by 30%."
)
CANTONESE = "當時團隊個 API 好慢。我嘅任務係搵出原因。我寫咗測試同修正咗查詢。結果錯誤減少咗一半。"


def make_session(session_id, created_at, transcripts, language="en-HK"):
    turns = [
        Turn(
            id=f"{session_id}-t{i}",
            question=CoachTurn(
                interviewer_text="Tell me about a project.",
                question_type="behavioral",
                targeted_competencies=["Python"],
                adaptive_follow_up_reason=None,
                citations=[],
            ),
            answer=AnswerSubmission(transcript=text, language=language, elapsed_seconds=30)
            if text
            else None,
            created_at=created_at,
        )
        for i, text in enumerate(transcripts)
    ]
    return Session(
        id=session_id,
        job_profile_id="j1",
        role_title="Engineer",
        language=language,
        difficulty="standard",
        question_count=len(transcripts),
        state="completed",
        current_question=len(transcripts),
        turns=turns,
        created_at=created_at,
        provider="demo",
    )


def test_star_segments_cover_the_answer_exactly_and_label_each_sentence():
    segments = star_segments(ENGLISH)
    assert "".join(segment.text for segment in segments) == ENGLISH
    labelled = [segment.element for segment in segments if segment.text.strip()]
    assert labelled == ["Situation", "Task", "Action", "Result"]


def test_star_segments_label_cantonese_sentences():
    segments = star_segments(CANTONESE)
    assert "".join(segment.text for segment in segments) == CANTONESE
    labelled = [segment.element for segment in segments if segment.text.strip()]
    assert labelled == ["Situation", "Task", "Action", "Result"]


def test_star_segments_leave_unrelated_sentences_unlabelled():
    segments = star_segments("Hello there. I like coffee.")
    assert {segment.element for segment in segments} == {None}


def test_progress_points_list_answered_sessions_oldest_first():
    newer = make_session("s2", "2026-11-17T10:00:00Z", [ENGLISH])
    older = make_session("s1", "2026-11-16T10:00:00Z", ["In our project the API was slow."])
    empty = make_session("s3", "2026-11-17T12:00:00Z", [None])
    points = progress_points([newer, empty, older])
    assert [point.session_id for point in points] == ["s1", "s2"]
    assert points[0].covered == ["Situation"]
    assert points[1].covered == ["Situation", "Task", "Action", "Result"]
    assert points[1].answer_count == 1


def polish(**fields):
    base = {
        "situation": "Our team's API was slow during a university project.",
        "task": "I was responsible for finding the cause.",
        "action": "I added caching and wrote tests.",
        "result": "Latency fell by 30%.",
    }
    return ModelPolish(**{**base, **fields})


def test_polish_output_marks_bracketed_prompts_as_placeholders():
    parts = check_polish_output(polish(result="[Add the result you measured]"), ENGLISH, "en-HK")
    assert [part.element for part in parts] == ["Situation", "Task", "Action", "Result"]
    assert [part.placeholder for part in parts] == [False, False, False, True]


def test_polish_output_rejects_numbers_the_candidate_never_said():
    with pytest.raises(ValueError, match="number"):
        check_polish_output(polish(result="Latency fell by 45%."), ENGLISH, "en-HK")


def test_polish_output_rejects_chinese_in_an_english_rewrite():
    with pytest.raises(ValueError, match="language"):
        check_polish_output(polish(task="我負責搵出原因。"), CANTONESE, "en-HK")


def test_polish_output_requires_chinese_in_a_cantonese_rewrite():
    with pytest.raises(ValueError, match="language"):
        check_polish_output(polish(), CANTONESE, "zh-HK")


def test_fallback_polish_quotes_the_answer_and_prompts_for_missing_parts():
    parts = fallback_polish("In our project the API was slow.", "en-HK")
    assert parts[0].text == "In our project the API was slow."
    assert not parts[0].placeholder
    assert all(part.placeholder for part in parts[1:])


def mock_http(monkeypatch, handler):
    original = httpx.AsyncClient
    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **kwargs: original(transport=httpx.MockTransport(handler), **kwargs),
    )


def reply(draft):
    return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(draft)}}]})


@pytest.mark.asyncio
async def test_polish_translates_cantonese_into_english_with_the_model(monkeypatch):
    def handler(request):
        payload = json.loads(request.content)
        messages = payload["messages"]
        assert "untrusted quoted DATA" in messages[0]["content"]
        # A worked example in the target language: a 4B model copies instead of translating without it.
        assert [message["role"] for message in messages] == ["system", "user", "assistant", "user"]
        example = json.loads(messages[2]["content"])
        assert not any("一" <= char <= "鿿" for char in example["situation"])
        user = json.loads(messages[-1]["content"])
        assert user["target_language"] == "en-HK"
        assert "English" in user["instruction"]
        assert user["quoted_answer"] == CANTONESE
        return reply(polish(result="Errors were cut in half.").model_dump())

    mock_http(monkeypatch, handler)
    answer = await polish_answer(
        Settings(model_provider="llama"),
        "t1",
        "Tell me about a project.",
        CANTONESE,
        "zh-HK",
        "en-HK",
    )
    assert answer.provider == "llama"
    assert answer.parts[3].text == "Errors were cut in half."


@pytest.mark.asyncio
async def test_polish_retries_once_then_gives_up_on_fabricated_numbers(monkeypatch):
    calls = []

    def handler(request):
        calls.append(request)
        return reply(polish(result="Latency fell by 45%.").model_dump())

    mock_http(monkeypatch, handler)
    with pytest.raises(PolishUnavailable):
        await polish_answer(
            Settings(model_provider="llama"), "t1", "Question", ENGLISH, "en-HK", "en-HK"
        )
    assert len(calls) == 2


@pytest.mark.asyncio
async def test_demo_provider_polishes_without_a_model():
    answer = await polish_answer(
        Settings(model_provider="demo"), "t1", "Question", ENGLISH, "en-HK", "en-HK"
    )
    assert answer.provider == "demo"
    assert [part.placeholder for part in answer.parts] == [False, False, False, False]
