"""Run detail parsing matches the file objects GET /runs/:runId returns."""

from data_hub_lambda.models import RunDetailResponse


def test_run_detail_parses_the_api_file_shape() -> None:
    payload = {
        "id": "11111111-1111-4111-8111-111111111111",
        "instrument_id": "dishcam",
        "instrument_display_name": "DishCam",
        "run_id": "run-1",
        "source": "watcher",
        "watcher_id": None,
        "created_at": "2026-09-22T00:00:00.000Z",
        "acquired_at": None,
        "updated_at": "2026-09-22T00:00:00.000Z",
        "deleted_at": None,
        "deleted_by": None,
        "metadata": {},
        "attributions": [],
        "files": [
            {
                "id": 1,
                "filename": "run.json",
                "relative_path": "capture/run.json",
                "s3_key": "dishcam/run-1/run.json",
                "content_type": "application/json",
                "size_bytes": 10,
                "category": "raw",
                "status": "uploaded",
                "metadata": {},
                "error_message": None,
                "detected_at": None,
                "upload_requested_at": None,
                "uploaded_at": "2026-09-22T00:00:00.000Z",
                "processed_at": None,
                "processing_started_at": None,
                "download_url": None,
                "created_at": "2026-09-22T00:00:00.000Z",
                "file_created_at": None,
                "deleted_at": None,
            }
        ],
    }

    detail = RunDetailResponse.model_validate(payload)

    assert detail.files[0].relative_path == "capture/run.json"
    assert detail.files[0].s3_key == "dishcam/run-1/run.json"
    assert detail.files[0].deleted_at is None
