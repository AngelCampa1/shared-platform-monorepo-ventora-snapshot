from __future__ import annotations

import pytest

from ventora_storage.keys import MAX_FILENAME_LENGTH, build_tenant_key, sanitize_filename


class TestSanitizeFilename:
    def test_valid_chars_unchanged(self) -> None:
        assert sanitize_filename("hello-world.txt") == "hello-world.txt"

    def test_removes_special_chars(self) -> None:
        result = sanitize_filename("hello world!@#.txt")
        assert " " not in result
        assert "!" not in result
        assert "@" not in result
        assert "#" not in result

    def test_strips_unix_path_separator(self) -> None:
        assert sanitize_filename("some/path/file.txt") == "some_path_file.txt"

    def test_strips_windows_path_separator(self) -> None:
        assert sanitize_filename("some\\path\\file.txt") == "some_path_file.txt"

    def test_mixed_path_separators(self) -> None:
        assert sanitize_filename("C:\\Users\\some/path\\file.txt") == "C_Users_some_path_file.txt"

    def test_truncates_to_max_length(self) -> None:
        long_name = "a" * (MAX_FILENAME_LENGTH + 50)
        result = sanitize_filename(long_name)
        assert len(result) <= MAX_FILENAME_LENGTH

    def test_returns_file_for_empty_result(self) -> None:
        assert sanitize_filename("!!!") == "file"

    def test_returns_file_for_empty_string(self) -> None:
        assert sanitize_filename("") == "file"

    def test_preserves_leading_hyphen(self) -> None:
        assert sanitize_filename("-hello.txt") == "-hello.txt"

    def test_preserves_trailing_hyphen(self) -> None:
        assert sanitize_filename("hello.txt-") == "hello.txt-"

    def test_collapses_multiple_separators(self) -> None:
        result = sanitize_filename("hello...world")
        assert ".." not in result

    def test_alphanumeric_with_dots_and_dashes(self) -> None:
        assert sanitize_filename("my-file_v2.0.tar.gz") == "my-file_v2.0.tar.gz"

    def test_preserves_hyphens_after_trimming_dots_and_underscores(self) -> None:
        assert sanitize_filename("...---") == "---"


class TestBuildTenantKey:
    def test_basic_key_construction(self) -> None:
        key = build_tenant_key("tenant1", "uploads", "file.txt")
        assert key == "tenant1/uploads/file.txt"

    def test_single_segment(self) -> None:
        key = build_tenant_key("acme-corp", "document.pdf")
        assert key == "acme-corp/document.pdf"

    def test_raises_on_empty_tenant_id(self) -> None:
        with pytest.raises(ValueError, match="Invalid tenant_id"):
            build_tenant_key("", "file.txt")

    def test_raises_on_tenant_id_with_slash(self) -> None:
        with pytest.raises(ValueError, match="Invalid tenant_id"):
            build_tenant_key("tenant/evil", "file.txt")

    def test_raises_on_tenant_id_with_dot(self) -> None:
        with pytest.raises(ValueError, match="Invalid tenant_id"):
            build_tenant_key("tenant.evil", "file.txt")

    def test_raises_on_tenant_id_with_dotdot(self) -> None:
        with pytest.raises(ValueError, match="Invalid tenant_id"):
            build_tenant_key("../evil", "file.txt")

    def test_sanitizes_segment_with_no_alphanumeric_to_file(self) -> None:
        assert build_tenant_key("tenant1", "!!!") == "tenant1/file"

    def test_preserves_sanitized_hyphen_segment(self) -> None:
        assert build_tenant_key("tenant1", "._-") == "tenant1/-"

    def test_sanitizes_segment_filenames(self) -> None:
        key = build_tenant_key("tenant1", "path/to/file.txt")
        assert key == "tenant1/path_to_file.txt"

    def test_raises_when_no_segments_provided(self) -> None:
        with pytest.raises(ValueError, match="At least one path segment"):
            build_tenant_key("tenant1")

    def test_raises_on_segment_with_dotdot(self) -> None:
        with pytest.raises(ValueError, match="Path traversal"):
            build_tenant_key("tenant1", "uploads", "a..b", "file.txt")

    def test_valid_tenant_with_hyphens(self) -> None:
        key = build_tenant_key("my-tenant-123", "file.txt")
        assert key.startswith("my-tenant-123/")

    def test_multiple_segments(self) -> None:
        key = build_tenant_key("tenant1", "images", "avatar", "photo.jpg")
        assert key == "tenant1/images/avatar/photo.jpg"
