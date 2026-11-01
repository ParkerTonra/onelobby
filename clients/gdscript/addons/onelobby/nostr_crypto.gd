class_name OneLobbyNostrCrypto
extends RefCounted
## The symmetric half of Nostr signaling (spec/nostr-signaling.md s.2 and s.3): HKDF-SHA256 key/topic derivation and
## AES-256-GCM sealing of frames. Godot has no GCM mode, so GCM is built from AESContext ECB (CTR keystream and the
## hash subkey) plus GHASH with Shoup's 4-bit table (the mbedtls layout), on 64-bit halves with logical shifts.

const SALT := "onelobby-nostr-v1"
const IV_LEN := 12
const TAG_LEN := 16

const _LAST4 := [0x0000, 0x1c20, 0x3840, 0x2460, 0x7080, 0x6ca0, 0x48c0, 0x54e0, 0xe100, 0xfd20, 0xd940, 0xc560, 0x9180, 0x8da0, 0xa9c0, 0xb5e0]
const _MASK60 := 0x0FFFFFFFFFFFFFFF
const _MASK63 := 0x7FFFFFFFFFFFFFFF


static func hmac_sha256(key: PackedByteArray, msg: PackedByteArray) -> PackedByteArray:
	return Crypto.new().hmac_digest(HashingContext.HASH_SHA256, key, msg)


static func hkdf_sha256(ikm: PackedByteArray, salt: PackedByteArray, info: PackedByteArray, length: int) -> PackedByteArray:
	var prk := hmac_sha256(salt, ikm)
	var out := PackedByteArray()
	var t := PackedByteArray()
	var counter := 1
	while out.size() < length:
		var block := t + info
		block.append(counter)
		t = hmac_sha256(prk, block)
		out.append_array(t)
		counter += 1
	return out.slice(0, length)


## Key and topic for a normalised 11-character code: {key: PackedByteArray(32), topic: String(64 hex)}.
static func derive(normalized_code: String) -> Dictionary:
	var ikm := normalized_code.to_ascii_buffer()
	var salt := SALT.to_ascii_buffer()
	return {
		"key": hkdf_sha256(ikm, salt, "key".to_ascii_buffer(), 32),
		"topic": hkdf_sha256(ikm, salt, "topic".to_ascii_buffer(), 32).hex_encode(),
	}


# ---------------------------------------------------------------- AES-256-GCM

static func _load64(b: PackedByteArray, o: int) -> int:
	var v := 0
	for i in 8:
		v = (v << 8) | b[o + i]
	return v


static func _store64(out: PackedByteArray, o: int, v: int) -> void:
	for i in 8:
		out[o + 7 - i] = (v >> (8 * i)) & 0xFF


static func _table(h: PackedByteArray) -> PackedInt64Array:
	# [0..15] = HH, [16..31] = HL
	var t := PackedInt64Array()
	t.resize(32)
	var vh := _load64(h, 0)
	var vl := _load64(h, 8)
	t[8] = vh
	t[16 + 8] = vl
	var i := 4
	while i > 0:
		var carry := (vl & 1) * 0xe1000000
		vl = ((vh << 63)) | ((vl >> 1) & _MASK63)
		vh = ((vh >> 1) & _MASK63) ^ (carry << 32)
		t[i] = vh
		t[16 + i] = vl
		i >>= 1
	i = 2
	while i <= 8:
		vh = t[i]
		vl = t[16 + i]
		for j in range(1, i):
			t[i + j] = vh ^ t[j]
			t[16 + i + j] = vl ^ t[16 + j]
		i *= 2
	return t


## y = (y xor block) * H, with y as two halves in `st` ([zh, zl]).
static func _mult(t: PackedInt64Array, x: PackedByteArray) -> void:
	var lo: int = x[15] & 0xF
	var zh: int = t[lo]
	var zl: int = t[16 + lo]
	for i in range(15, -1, -1):
		lo = x[i] & 0xF
		var hi: int = (x[i] >> 4) & 0xF
		var rem: int
		if i != 15:
			rem = zl & 0xF
			zl = (zh << 60) | ((zl >> 4) & _MASK60)
			zh = (zh >> 4) & _MASK60
			zh ^= _LAST4[rem] << 48
			zh ^= t[lo]
			zl ^= t[16 + lo]
		rem = zl & 0xF
		zl = (zh << 60) | ((zl >> 4) & _MASK60)
		zh = (zh >> 4) & _MASK60
		zh ^= _LAST4[rem] << 48
		zh ^= t[hi]
		zl ^= t[16 + hi]
	_store64(x, 0, zh)
	_store64(x, 8, zl)


static func _ghash(t: PackedInt64Array, ct: PackedByteArray) -> PackedByteArray:
	var y := PackedByteArray()
	y.resize(16)
	var n := ct.size()
	var o := 0
	while o < n:
		var take: int = mini(16, n - o)
		for i in take:
			y[i] ^= ct[o + i]
		_mult(t, y)
		o += 16
	# length block: 0 bits of AAD, then the ciphertext length in bits
	var lenb := PackedByteArray()
	lenb.resize(16)
	_store64(lenb, 8, n * 8)
	for i in 16:
		y[i] ^= lenb[i]
	_mult(t, y)
	return y


static func _aes_ecb(key: PackedByteArray, data: PackedByteArray) -> PackedByteArray:
	var ctx := AESContext.new()
	ctx.start(AESContext.MODE_ECB_ENCRYPT, key)
	var out := ctx.update(data)
	ctx.finish()
	return out


## CTR keystream XOR for blocks starting at counter 2 (counter 1 is the tag mask).
static func _ctr(key: PackedByteArray, iv: PackedByteArray, data: PackedByteArray) -> PackedByteArray:
	var n := data.size()
	var blocks := (n + 15) / 16
	var ctrs := PackedByteArray()
	ctrs.resize(blocks * 16)
	for b in blocks:
		var o := b * 16
		for i in 12:
			ctrs[o + i] = iv[i]
		var c := b + 2
		ctrs[o + 12] = (c >> 24) & 0xFF
		ctrs[o + 13] = (c >> 16) & 0xFF
		ctrs[o + 14] = (c >> 8) & 0xFF
		ctrs[o + 15] = c & 0xFF
	var ks := _aes_ecb(key, ctrs)
	var out := PackedByteArray()
	out.resize(n)
	for i in n:
		out[i] = data[i] ^ ks[i]
	return out


static func _tag(key: PackedByteArray, iv: PackedByteArray, ct: PackedByteArray) -> PackedByteArray:
	var zero := PackedByteArray()
	zero.resize(16)
	var h := _aes_ecb(key, zero)
	var j0 := iv.duplicate()
	j0.append_array(PackedByteArray([0, 0, 0, 1]))
	var mask := _aes_ecb(key, j0)
	var g := _ghash(_table(h), ct)
	for i in 16:
		g[i] ^= mask[i]
	return g


## ciphertext || 16-byte tag (no associated data).
static func gcm_seal(key: PackedByteArray, iv: PackedByteArray, plaintext: PackedByteArray) -> PackedByteArray:
	var ct := _ctr(key, iv, plaintext)
	return ct + _tag(key, iv, ct)


## The plaintext, or an empty array with ok=false semantics via null on a bad tag or short input.
static func gcm_open(key: PackedByteArray, iv: PackedByteArray, sealed: PackedByteArray) -> Variant:
	if sealed.size() < TAG_LEN:
		return null
	var ct := sealed.slice(0, sealed.size() - TAG_LEN)
	var tag := sealed.slice(sealed.size() - TAG_LEN)
	var want := _tag(key, iv, ct)
	var diff := 0
	for i in TAG_LEN:
		diff |= want[i] ^ tag[i]
	if diff != 0:
		return null
	return _ctr(key, iv, ct)


## Event content: base64(iv || ciphertext || tag) with a fresh random iv.
static func seal_content(key: PackedByteArray, plaintext: String) -> String:
	var iv := Crypto.new().generate_random_bytes(IV_LEN)
	return Marshalls.raw_to_base64(iv + gcm_seal(key, iv, plaintext.to_utf8_buffer()))


## Plaintext of an event content string, or null when it does not decrypt.
static func open_content(key: PackedByteArray, content: String) -> Variant:
	var raw := Marshalls.base64_to_raw(content)
	if raw.size() < IV_LEN + TAG_LEN:
		return null
	var pt: Variant = gcm_open(key, raw.slice(0, IV_LEN), raw.slice(IV_LEN))
	if pt == null:
		return null
	return (pt as PackedByteArray).get_string_from_utf8()
