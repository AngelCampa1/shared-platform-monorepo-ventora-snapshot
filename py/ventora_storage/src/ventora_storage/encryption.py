from __future__ import annotations

import os


def encrypt_bytes(data: bytes, key: bytes) -> bytes:
    """AES-256-GCM encrypt. key must be 32 bytes. Returns nonce+tag+ciphertext."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    nonce = os.urandom(12)
    aesgcm = AESGCM(key)
    ciphertext = aesgcm.encrypt(nonce, data, None)
    return nonce + ciphertext  # ciphertext includes 16-byte GCM tag appended by cryptography


def decrypt_bytes(data: bytes, key: bytes) -> bytes:
    """AES-256-GCM decrypt. data must be nonce(12)+tag+ciphertext."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    nonce = data[:12]
    ciphertext = data[12:]
    aesgcm = AESGCM(key)
    return aesgcm.decrypt(nonce, ciphertext, None)


def generate_data_key() -> bytes:
    """Generate a random 32-byte AES-256 key."""
    return os.urandom(32)
