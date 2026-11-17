import json

from evaluation.metadata import training_metadata


def test_methodology_uses_pinned_configuration_and_real_draft_counts(tmp_path):
    (tmp_path / "ml").mkdir()
    config = {
        "base_model": "unit/base",
        "revision": "b" * 40,
        "output_dir": "ml/runs/test",
        "lora_r": 32,
        "seed": 42,
    }
    (tmp_path / "ml/config.json").write_text(json.dumps(config))
    result = training_metadata(tmp_path)
    assert result["base_revision"] == "b" * 40
    assert result["draft_examples"] == 0
    assert result["adapter_available"] is False
    assert result["configuration"]["lora_r"] == 32
    assert (
        result["configuration"]["implementation_settings"]["assistant_only_loss"]
        is True
    )
    assert result["model_card"]["base_model"] == "unit/base"


def test_methodology_does_not_claim_missing_adapter_is_available(tmp_path):
    (tmp_path / "ml").mkdir()
    config = {
        "base_model": "unit/base",
        "revision": "b" * 40,
        "output_dir": "ml/runs/test",
    }
    (tmp_path / "ml/config.json").write_text(json.dumps(config))
    run = tmp_path / config["output_dir"]
    run.mkdir(parents=True)
    manifest = {
        "status": "training_completed",
        "base_model": "unit/base",
        "base_revision": "b" * 40,
        "training_config": config,
        "dataset": {"review_validation": {"reviewed": 1500}},
        "best_validation_loss": 1.2,
    }
    (run / "model_manifest.json").write_text(json.dumps(manifest))
    result = training_metadata(tmp_path)
    assert result["status"] == "training_completed"
    assert result["reviewed_examples"] == 1500
    assert result["adapter_available"] is False


def test_missing_incomplete_or_invalid_manifest_stays_not_trained(tmp_path):
    (tmp_path / "ml").mkdir()
    config = {
        "base_model": "unit/base",
        "revision": "b" * 40,
        "output_dir": "ml/runs/test",
    }
    (tmp_path / "ml/config.json").write_text(json.dumps(config))
    run = tmp_path / config["output_dir"]
    run.mkdir(parents=True)
    path = run / "model_manifest.json"
    assert training_metadata(tmp_path)["status"] == "not_trained"
    for text in ('{"status": "training_completed"}', "{broken", "null"):
        path.write_text(text)
        result = training_metadata(tmp_path)
        assert result["status"] == "not_trained"
        assert result["adapter_available"] is False
        assert "manifest_error" in result


def test_refresh_preserves_evaluations_and_prefers_runtime_data(tmp_path):
    from evaluation.metadata import refresh_latest
    from ml.dataset import generate_drafts, write_jsonl

    (tmp_path / "ml").mkdir()
    config = {
        "base_model": "unit/base",
        "revision": "b" * 40,
        "output_dir": "ml/runs/test",
        "expected_examples": 480,
    }
    (tmp_path / "ml/config.json").write_text(json.dumps(config))
    rows = generate_drafts()[:2]
    write_jsonl(tmp_path / "ml/data/runtime_drafts.jsonl", rows)
    result_path = tmp_path / "evaluation/results/latest.json"
    result_path.parent.mkdir(parents=True)
    evaluations = [{"name": "diagnostic", "sample_size": 7}]
    result_path.write_text(
        json.dumps(
            {"evaluations": evaluations, "limitations": ["Human assessment pending"]}
        )
    )
    result = refresh_latest(tmp_path)
    assert result["evaluations"] == evaluations
    assert result["limitations"] == ["Human assessment pending"]
    assert (
        result["training"]["dataset_provenance"]["path"]
        == "ml/data/runtime_drafts.jsonl"
    )
    assert result["training"]["draft_examples"] == 2
    assert result["training"]["expected_examples"] == 480
    assert result["training"]["status"] == "not_trained"
    write_jsonl(tmp_path / "ml/data/reviewed_examples.jsonl", rows[:1])
    assert training_metadata(tmp_path)["draft_examples"] == 1


def test_committed_evidence_manifest_replaces_a_missing_run_directory(tmp_path):
    """The run directory is gitignored, so the committed manifest must still report training."""
    (tmp_path / "ml").mkdir()
    config = {"base_model": "unit/base", "revision": "b" * 40, "output_dir": "ml/runs/test"}
    (tmp_path / "ml/config.json").write_text(json.dumps(config))
    evidence = tmp_path / "ml/training_evidence/voxprep-qlora-v5"
    evidence.mkdir(parents=True)
    manifest = {
        "status": "training_completed",
        "base_model": "unit/base",
        "base_revision": "b" * 40,
        "training_config": config,
        "dataset": {"review_validation": {"reviewed": 971}},
        "best_validation_loss": 0.0561,
    }
    (evidence / "model_manifest.json").write_text(json.dumps(manifest))
    result = training_metadata(tmp_path)
    assert result["status"] == "training_completed"
    assert result["manifest_source"] == "committed_evidence"
    assert result["reviewed_examples"] == 971
    assert result["best_validation_loss"] == 0.0561


def test_adapter_availability_follows_lora_path(tmp_path):
    (tmp_path / "ml").mkdir()
    config = {"base_model": "unit/base", "revision": "b" * 40, "output_dir": "ml/runs/test"}
    (tmp_path / "ml/config.json").write_text(json.dumps(config))
    evidence = tmp_path / "ml/training_evidence/voxprep-qlora-v5"
    evidence.mkdir(parents=True)
    (evidence / "model_manifest.json").write_text(
        json.dumps(
            {
                "status": "training_completed",
                "base_model": "unit/base",
                "base_revision": "b" * 40,
                "training_config": config,
                "dataset": {"review_validation": {"reviewed": 971}},
                "best_validation_loss": 0.0561,
            }
        )
    )
    # LORA_PATH points at a file that is not there yet: no adapter claim.
    (tmp_path / ".env").write_text("LORA_PATH=models/missing-lora.gguf\n")
    assert training_metadata(tmp_path)["adapter_available"] is False

    (tmp_path / "models").mkdir()
    (tmp_path / "models/missing-lora.gguf").write_bytes(b"stub")
    result = training_metadata(tmp_path)
    assert result["adapter_available"] is True
    assert result["adapter_path"].endswith("models/missing-lora.gguf")


def test_model_evaluation_reports_the_paired_comparison(tmp_path):
    from evaluation.metadata import model_evaluation_metadata

    results = tmp_path / "evaluation/results"
    results.mkdir(parents=True)
    records = []
    for prompt, base_pass, lora_pass in (("p1", False, True), ("p2", True, True), ("p3", True, True)):
        records.append({"id": prompt, "variant": "base_rag", "language_proxy_pass": base_pass})
        records.append({"id": prompt, "variant": "lora_rag", "language_proxy_pass": lora_pass})
    (results / "model.json").write_text(
        json.dumps(
            {
                "status": "measured_pending_human_review",
                "recorded_at": "2026-11-16T00:00:00+00:00",
                "sample_size": 3,
                "summary": {
                    "base_rag": {"schema_validity": 1.0, "language_script_proxy": 0.66, "first_token_p95_seconds": 1.8},
                    "lora_rag": {"schema_validity": 1.0, "language_script_proxy": 1.0, "first_token_p95_seconds": 2.0},
                },
                "records": records,
            }
        )
    )
    result = model_evaluation_metadata(tmp_path)
    assert result["sample_size"] == 3
    assert result["paired_base_vs_adapter"] == {"improved": 1, "regressed": 0, "unchanged": 2}
    assert result["variants"]["lora_rag"]["language_script_proxy"] == 1.0
