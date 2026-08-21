"""
verzegeld.py — een GitHub-secret versleutelen, zonder extra pakketten.

GitHub wil een secret aangeleverd als "sealed box" van libsodium. De gebruikelijke
weg daarheen is PyNaCl, maar dat vraagt om een compiler of een wiel, en op een
Mac met een uv-omgeving zonder pip strandt dat. Daarom staat het hier uitgeschreven
met alleen wat in Python zelf zit.

Wat een sealed box is, in vier stappen:

    1. maak een wegwerp-sleutelpaar (X25519)
    2. nonce = BLAKE2b(wegwerp-publieke sleutel || ontvangers publieke sleutel), 24 bytes
    3. gedeeld geheim = X25519(wegwerp-geheim, ontvangers publiek), daarna door
       HSalsa20 met een nul-nonce -- dat is wat crypto_box intern doet
    4. versleutel met XSalsa20-Poly1305 en plak de wegwerp-publieke sleutel ervoor

De uitkomst is byte-voor-byte gelijk aan die van PyNaCl; dat is getest.

Dit bestand doet geen sleutelbeheer en bewaart niets. Het versleutelt een
tekst voor een publieke sleutel, meer niet.
"""

from __future__ import annotations

import hashlib
import os
import struct

# ==========================================================================
# X25519
# ==========================================================================

_P = 2 ** 255 - 19
_A24 = 121665


def _klem(rauw: bytes) -> int:
    b = bytearray(rauw)
    b[0] &= 248
    b[31] &= 127
    b[31] |= 64
    return int.from_bytes(b, "little")


def x25519(geheim: bytes, punt: bytes) -> bytes:
    """De Montgomery-ladder uit RFC 7748, sectie 5."""
    k = _klem(geheim)
    u = int.from_bytes(punt, "little") % (2 ** 255)

    x1, x2, z2, x3, z3, gewisseld = u, 1, 0, u, 1, 0
    for t in range(254, -1, -1):
        bit = (k >> t) & 1
        if gewisseld ^ bit:
            x2, x3 = x3, x2
            z2, z3 = z3, z2
        gewisseld = bit
        a = (x2 + z2) % _P
        aa = a * a % _P
        b = (x2 - z2) % _P
        bb = b * b % _P
        e = (aa - bb) % _P
        c = (x3 + z3) % _P
        d = (x3 - z3) % _P
        da = d * a % _P
        cb = c * b % _P
        x3 = pow(da + cb, 2, _P)
        z3 = x1 * pow(da - cb, 2, _P) % _P
        x2 = aa * bb % _P
        z2 = e * (aa + _A24 * e) % _P
    if gewisseld:
        x2, x3 = x3, x2
        z2, z3 = z3, z2
    return (x2 * pow(z2, _P - 2, _P) % _P).to_bytes(32, "little")


_NEGEN = (9).to_bytes(32, "little")


# ==========================================================================
# Salsa20 en HSalsa20
# ==========================================================================

_SIGMA = b"expand 32-byte k"


def _draai(x: int, n: int) -> int:
    x &= 0xFFFFFFFF
    return ((x << n) | (x >> (32 - n))) & 0xFFFFFFFF


def _rondes(s: list[int]) -> list[int]:
    x = list(s)
    for _ in range(10):
        for a, b, c, d in ((0, 4, 8, 12), (5, 9, 13, 1), (10, 14, 2, 6), (15, 3, 7, 11)):
            x[b] ^= _draai(x[a] + x[d], 7)
            x[c] ^= _draai(x[b] + x[a], 9)
            x[d] ^= _draai(x[c] + x[b], 13)
            x[a] ^= _draai(x[d] + x[c], 18)
        for a, b, c, d in ((0, 1, 2, 3), (5, 6, 7, 4), (10, 11, 8, 9), (15, 12, 13, 14)):
            x[b] ^= _draai(x[a] + x[d], 7)
            x[c] ^= _draai(x[b] + x[a], 9)
            x[d] ^= _draai(x[c] + x[b], 13)
            x[a] ^= _draai(x[d] + x[c], 18)
    return x


def _opzet(sleutel: bytes, invoer: bytes) -> list[int]:
    k = struct.unpack("<8I", sleutel)
    n = struct.unpack("<4I", invoer)
    c = struct.unpack("<4I", _SIGMA)
    return [c[0], k[0], k[1], k[2], k[3], c[1], n[0], n[1],
            n[2], n[3], c[2], k[4], k[5], k[6], k[7], c[3]]


def hsalsa20(sleutel: bytes, invoer: bytes) -> bytes:
    """De sleutelafleiding die XSalsa20 van Salsa20 maakt.

    Anders dan bij Salsa20 wordt de begintoestand er NIET bij opgeteld; er
    worden acht woorden uit de toestand na de rondes genomen. Precies dat
    verschil maakt het een veilige sleutelafleiding.
    """
    x = _rondes(_opzet(sleutel, invoer))
    return struct.pack("<8I", x[0], x[5], x[10], x[15], x[6], x[7], x[8], x[9])


def _salsa20_blok(sleutel: bytes, nonce8: bytes, teller: int) -> bytes:
    invoer = nonce8 + struct.pack("<Q", teller)
    s = _opzet(sleutel, invoer)
    x = _rondes(s)
    return struct.pack("<16I", *[(x[i] + s[i]) & 0xFFFFFFFF for i in range(16)])


def _salsa20_stroom(sleutel: bytes, nonce8: bytes, lengte: int, teller: int = 0) -> bytes:
    uit = bytearray()
    while len(uit) < lengte:
        uit += _salsa20_blok(sleutel, nonce8, teller)
        teller += 1
    return bytes(uit[:lengte])


# ==========================================================================
# Poly1305
# ==========================================================================

def poly1305(bericht: bytes, sleutel: bytes) -> bytes:
    r = int.from_bytes(sleutel[:16], "little") & 0x0FFFFFFC0FFFFFFC0FFFFFFC0FFFFFFF
    s = int.from_bytes(sleutel[16:32], "little")
    p = (1 << 130) - 5
    h = 0
    for i in range(0, len(bericht), 16):
        blok = bericht[i:i + 16]
        n = int.from_bytes(blok + b"\x01", "little") if len(blok) < 16 \
            else int.from_bytes(blok, "little") + (1 << 128)
        h = (h + n) * r % p
    return ((h + s) & ((1 << 128) - 1)).to_bytes(16, "little")


# ==========================================================================
# De sealed box zelf
# ==========================================================================

def _secretbox(bericht: bytes, nonce24: bytes, sleutel: bytes) -> bytes:
    subsleutel = hsalsa20(sleutel, nonce24[:16])
    stroom = _salsa20_stroom(subsleutel, nonce24[16:], 32 + len(bericht))
    ct = bytes(a ^ b for a, b in zip(bericht, stroom[32:]))
    return poly1305(ct, stroom[:32]) + ct


def verzegel(bericht: bytes, publieke_sleutel: bytes) -> bytes:
    """crypto_box_seal: geeft wegwerp-publieke-sleutel || versleutelde tekst."""
    if len(publieke_sleutel) != 32:
        raise ValueError("Een publieke sleutel is 32 bytes.")
    esk = os.urandom(32)
    epk = x25519(esk, _NEGEN)
    nonce = hashlib.blake2b(epk + publieke_sleutel, digest_size=24).digest()
    gedeeld = x25519(esk, publieke_sleutel)
    sleutel = hsalsa20(gedeeld, b"\x00" * 16)
    return epk + _secretbox(bericht, nonce, sleutel)
