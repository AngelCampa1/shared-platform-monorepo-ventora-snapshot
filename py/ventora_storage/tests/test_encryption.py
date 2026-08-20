from __future__ import annotations
import pytest
from ventora_storage.encryption import encrypt_bytes, decrypt_bytes, generate_data_key


class TestGenerateDataKey:
    def test_returns_32_bytes(self) -> None:
        key = generate_data_key()
        assert len(key) == 32

    def test_returns_bytes(self) -> None:
        key = generate_data_key()
        assert isinstance(key, bytes)

    def test_keys_are_unique(self) -> None:
        key1 = generate_data_key()
        key2 = generate_data_key()
        assert key1 != key2


class TestEncryptDecrypt:
    def test_round_trip(self) -> None:
        key = generate_data_key()
        plaintext = b"Hello, Ventora!"
        ciphertext = encrypt_bytes(plaintext, key)
        result = decrypt_bytes(ciphertext, key)
        assert result == plaintext

    def test_round_trip_empty_bytes(self) -> None:
        key = generate_data_key()
        plaintext = b""
        ciphertext = encrypt_bytes(plaintext, key)
        result = decrypt_bytes(ciphertext, key)
        assert result == plaintext

    def test_round_trip_large_data(self) -> None:
        key = generate_data_key()
        plaintext = b"x" * 1_000_000
        ciphertext = encrypt_bytes(plaintext, key)
        result = decrypt_bytes(ciphertext, key)
        assert result == plaintext

    def test_same_input_produces_different_output(self) -> None:
        key = generate_data_key()
        plaintext = b"Hello, Ventora!"
        ct1 = encrypt_bytes(plaintext, key)
        ct2 = encrypt_bytes(plaintext, key)
        # Different nonces should produce different ciphertext
        assert ct1 != ct2

    def test_encrypted_output_longer_than_plaintext(self) -> None:
        key = generate_data_key()
        plaintext = b"Hello!"
        ciphertext = encrypt_bytes(plaintext, key)
        # nonce(12) + GCM tag(16) + plaintext
        assert len(ciphertext) == 12 + 16 + len(plaintext)

    def test_decrypt_with_wrong_key_raises(self) -> None:
        key = generate_data_key()
        wrong_key = generate_data_key()
        plaintext = b"sensitive data"
        ciphertext = encrypt_bytes(plaintext, key)
        with pytest.raises(Exception):
            decrypt_bytes(ciphertext, wrong_key)

    def test_decrypt_with_tampered_data_raises(self) -> None:
        key = generate_data_key()
        plaintext = b"sensitive data"
        ciphertext = bytearray(encrypt_bytes(plaintext, key))
        # Flip a bit in the ciphertext body (after nonce)
        ciphertext[20] ^= 0xFF
        with pytest.raises(Exception):
            decrypt_bytes(bytes(ciphertext), key)
