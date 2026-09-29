"""CRC64NVME matches the example AWS publishes for the algorithm."""

from pathlib import Path

from data_hub_watcher.util import file_digests


def test_crc64nvme_matches_the_aws_example(tmp_path: Path) -> None:
    path = tmp_path / "hello.txt"
    path.write_bytes(b"Hello World!")
    _sha, crc = file_digests(path)
    assert crc == "AuUcyF784aU="
