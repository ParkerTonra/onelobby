class_name OneLobbySecp256k1
extends RefCounted
## BIP340 Schnorr signing on secp256k1 in pure GDScript (Nostr event signatures).
##
## GDScript ints are 64-bit signed, so field elements are 10 little-endian limbs of 26 bits in a PackedInt64Array and
## the multiply/square are unrolled by tools/gen_secp256k1.py (between the GENERATED markers). Signing only ever needs
## k*G, so it uses a precomputed fixed-base comb (secp256k1_table.gd, 64 windows of 15 affine points): 64 mixed
## additions, no doublings. Verification is not implemented (relays verify; receivers authenticate by the GCM tag).
##
## Field values are "weakly reduced": limbs 0..8 below 2^26 + 2^16, limb 9 below 2^23. fe_strict() gives the canonical
## form. Scalars (mod n) are exact 26-bit limbs, always fully reduced.

const M := 0x3FFFFFF

# 2p in limbs (added before a subtraction so no limb goes negative)
const P2 := [0x7FFF85E, 0x7FFFF7E, 0x7FFFFFE, 0x7FFFFFE, 0x7FFFFFE, 0x7FFFFFE, 0x7FFFFFE, 0x7FFFFFE, 0x7FFFFFE, 0x7FFFFE]
# p in limbs
const PL := [0x3FFFC2F, 0x3FFFFBF, 0x3FFFFFF, 0x3FFFFFF, 0x3FFFFFF, 0x3FFFFFF, 0x3FFFFFF, 0x3FFFFFF, 0x3FFFFFF, 0x3FFFFF]
const N_HEX := "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141"

static var _n: PackedInt64Array
static var _win_cache: Array = []
static var _tag_cache: Dictionary = {}


## A signing key pair: secret key adjusted to an even-y public key (BIP340), plus its x-only public key.
class Keypair:
	var d: PackedInt64Array  # scalar limbs
	var px: PackedByteArray  # 32-byte x-only public key
	var d_bytes: PackedByteArray

	func pubkey_hex() -> String:
		return px.hex_encode()


# ---------------------------------------------------------------- field basics

static func fe_from_bytes(b: PackedByteArray) -> PackedInt64Array:
	var r := PackedInt64Array()
	r.resize(10)
	var acc := 0
	var bits := 0
	var li := 0
	for i in range(31, -1, -1):
		acc |= b[i] << bits
		bits += 8
		if bits >= 26 and li < 9:
			r[li] = acc & M
			acc >>= 26
			bits -= 26
			li += 1
	r[9] = acc
	return r


static func limbs_to_bytes(a: PackedInt64Array) -> PackedByteArray:
	var out := PackedByteArray()
	out.resize(32)
	var acc := 0
	var bits := 0
	var li := 0
	for i in range(31, -1, -1):
		while bits < 8 and li < 10:
			acc |= a[li] << bits
			bits += 26
			li += 1
		out[i] = acc & 0xFF
		acc >>= 8
		bits -= 8
	return out


## Carry, fold the bits above 256 back in and settle: restores the weak-reduction invariant.
static func fe_weak(a: PackedInt64Array) -> PackedInt64Array:
	var r := a.duplicate()
	var t := 0
	for i in 9:
		t = r[i] >> 26
		r[i] &= M
		r[i + 1] += t
	t = r[9] >> 22
	r[9] &= 0x3FFFFF
	r[0] += t * 977
	r[1] += t << 6
	t = r[0] >> 26
	r[0] &= M
	r[1] += t
	t = r[1] >> 26
	r[1] &= M
	r[2] += t
	return r


static func fe_add(a: PackedInt64Array, b: PackedInt64Array) -> PackedInt64Array:
	var r := PackedInt64Array()
	r.resize(10)
	for i in 10:
		r[i] = a[i] + b[i]
	return fe_weak(r)


static func fe_sub(a: PackedInt64Array, b: PackedInt64Array) -> PackedInt64Array:
	var r := PackedInt64Array()
	r.resize(10)
	for i in 10:
		r[i] = a[i] + P2[i] - b[i]
	return fe_weak(r)


static func fe_small(a: PackedInt64Array, k: int) -> PackedInt64Array:
	var r := PackedInt64Array()
	r.resize(10)
	for i in 10:
		r[i] = a[i] * k
	return fe_weak(r)


## Canonical form: fully reduced into [0, p).
static func fe_strict(a: PackedInt64Array) -> PackedInt64Array:
	var r := a.duplicate()
	var t := 0
	for _round in 3:
		for i in 9:
			t = r[i] >> 26
			r[i] &= M
			r[i + 1] += t
		t = r[9] >> 22
		r[9] &= 0x3FFFFF
		r[0] += t * 977
		r[1] += t << 6
	for i in 9:
		t = r[i] >> 26
		r[i] &= M
		r[i + 1] += t
	# value is now below 2^256 + tiny and canonical limbs; subtract p if value >= p (add 2^256 - p, look for carry out)
	var s := r.duplicate()
	s[0] += 977
	s[1] += 64
	for i in 9:
		t = s[i] >> 26
		s[i] &= M
		s[i + 1] += t
	if (s[9] >> 22) != 0:
		s[9] &= 0x3FFFFF
		return s
	return r


static func fe_to_bytes(a: PackedInt64Array) -> PackedByteArray:
	return limbs_to_bytes(fe_strict(a))


static func fe_is_zero(a: PackedInt64Array) -> bool:
	var s := fe_strict(a)
	for i in 10:
		if s[i] != 0:
			return false
	return true


static func fe_is_odd(a: PackedInt64Array) -> bool:
	return (fe_strict(a)[0] & 1) == 1


static func fe_one() -> PackedInt64Array:
	var r := PackedInt64Array()
	r.resize(10)
	r[0] = 1
	return r


static func fe_sqr_n(a: PackedInt64Array, n: int) -> PackedInt64Array:
	var r := a
	for _i in n:
		r = fe_sqr(r)
	return r


## a^(p-2) by the libsecp256k1 addition chain (255 squarings, 15 multiplications).
static func fe_inv(x: PackedInt64Array) -> PackedInt64Array:
	var x2 := fe_mul(fe_sqr(x), x)
	var x3 := fe_mul(fe_sqr(x2), x)
	var x6 := fe_mul(fe_sqr_n(x3, 3), x3)
	var x9 := fe_mul(fe_sqr_n(x6, 3), x3)
	var x11 := fe_mul(fe_sqr_n(x9, 2), x2)
	var x22 := fe_mul(fe_sqr_n(x11, 11), x11)
	var x44 := fe_mul(fe_sqr_n(x22, 22), x22)
	var x88 := fe_mul(fe_sqr_n(x44, 44), x44)
	var x176 := fe_mul(fe_sqr_n(x88, 88), x88)
	var x220 := fe_mul(fe_sqr_n(x176, 44), x44)
	var x223 := fe_mul(fe_sqr_n(x220, 3), x3)
	var t := fe_mul(fe_sqr_n(x223, 23), x22)
	t = fe_mul(fe_sqr_n(t, 5), x)
	t = fe_mul(fe_sqr_n(t, 3), x2)
	return fe_mul(fe_sqr_n(t, 2), x)


# BEGIN GENERATED (tools/gen_secp256k1.py)
static func fe_mul(a: PackedInt64Array, b: PackedInt64Array) -> PackedInt64Array:
	var a0: int = a[0]
	var a1: int = a[1]
	var a2: int = a[2]
	var a3: int = a[3]
	var a4: int = a[4]
	var a5: int = a[5]
	var a6: int = a[6]
	var a7: int = a[7]
	var a8: int = a[8]
	var a9: int = a[9]
	var b0: int = b[0]
	var b1: int = b[1]
	var b2: int = b[2]
	var b3: int = b[3]
	var b4: int = b[4]
	var b5: int = b[5]
	var b6: int = b[6]
	var b7: int = b[7]
	var b8: int = b[8]
	var b9: int = b[9]
	var c0: int = a0 * b0
	var c1: int = a0 * b1 + a1 * b0
	var c2: int = a0 * b2 + a1 * b1 + a2 * b0
	var c3: int = a0 * b3 + a1 * b2 + a2 * b1 + a3 * b0
	var c4: int = a0 * b4 + a1 * b3 + a2 * b2 + a3 * b1 + a4 * b0
	var c5: int = a0 * b5 + a1 * b4 + a2 * b3 + a3 * b2 + a4 * b1 + a5 * b0
	var c6: int = a0 * b6 + a1 * b5 + a2 * b4 + a3 * b3 + a4 * b2 + a5 * b1 + a6 * b0
	var c7: int = a0 * b7 + a1 * b6 + a2 * b5 + a3 * b4 + a4 * b3 + a5 * b2 + a6 * b1 + a7 * b0
	var c8: int = a0 * b8 + a1 * b7 + a2 * b6 + a3 * b5 + a4 * b4 + a5 * b3 + a6 * b2 + a7 * b1 + a8 * b0
	var c9: int = a0 * b9 + a1 * b8 + a2 * b7 + a3 * b6 + a4 * b5 + a5 * b4 + a6 * b3 + a7 * b2 + a8 * b1 + a9 * b0
	var c10: int = a1 * b9 + a2 * b8 + a3 * b7 + a4 * b6 + a5 * b5 + a6 * b4 + a7 * b3 + a8 * b2 + a9 * b1
	var c11: int = a2 * b9 + a3 * b8 + a4 * b7 + a5 * b6 + a6 * b5 + a7 * b4 + a8 * b3 + a9 * b2
	var c12: int = a3 * b9 + a4 * b8 + a5 * b7 + a6 * b6 + a7 * b5 + a8 * b4 + a9 * b3
	var c13: int = a4 * b9 + a5 * b8 + a6 * b7 + a7 * b6 + a8 * b5 + a9 * b4
	var c14: int = a5 * b9 + a6 * b8 + a7 * b7 + a8 * b6 + a9 * b5
	var c15: int = a6 * b9 + a7 * b8 + a8 * b7 + a9 * b6
	var c16: int = a7 * b9 + a8 * b8 + a9 * b7
	var c17: int = a8 * b9 + a9 * b8
	var c18: int = a9 * b9
	var t := 0
	t = c0 >> 26
	c0 &= M
	c1 += t
	t = c1 >> 26
	c1 &= M
	c2 += t
	t = c2 >> 26
	c2 &= M
	c3 += t
	t = c3 >> 26
	c3 &= M
	c4 += t
	t = c4 >> 26
	c4 &= M
	c5 += t
	t = c5 >> 26
	c5 &= M
	c6 += t
	t = c6 >> 26
	c6 &= M
	c7 += t
	t = c7 >> 26
	c7 &= M
	c8 += t
	t = c8 >> 26
	c8 &= M
	c9 += t
	t = c9 >> 26
	c9 &= M
	c10 += t
	t = c10 >> 26
	c10 &= M
	c11 += t
	t = c11 >> 26
	c11 &= M
	c12 += t
	t = c12 >> 26
	c12 &= M
	c13 += t
	t = c13 >> 26
	c13 &= M
	c14 += t
	t = c14 >> 26
	c14 &= M
	c15 += t
	t = c15 >> 26
	c15 &= M
	c16 += t
	t = c16 >> 26
	c16 &= M
	c17 += t
	t = c17 >> 26
	c17 &= M
	c18 += t
	var c19 := c18 >> 26
	c18 &= M
	c1 += c11 * 15632
	c2 += c11 << 10
	c2 += c12 * 15632
	c3 += c12 << 10
	c3 += c13 * 15632
	c4 += c13 << 10
	c4 += c14 * 15632
	c5 += c14 << 10
	c5 += c15 * 15632
	c6 += c15 << 10
	c6 += c16 * 15632
	c7 += c16 << 10
	c7 += c17 * 15632
	c8 += c17 << 10
	c8 += c18 * 15632
	c9 += c18 << 10
	c9 += c19 * 15632
	c10 += c19 << 10
	c0 += c10 * 15632
	c1 += c10 << 10
	t = c0 >> 26
	c0 &= M
	c1 += t
	t = c1 >> 26
	c1 &= M
	c2 += t
	t = c2 >> 26
	c2 &= M
	c3 += t
	t = c3 >> 26
	c3 &= M
	c4 += t
	t = c4 >> 26
	c4 &= M
	c5 += t
	t = c5 >> 26
	c5 &= M
	c6 += t
	t = c6 >> 26
	c6 &= M
	c7 += t
	t = c7 >> 26
	c7 &= M
	c8 += t
	t = c8 >> 26
	c8 &= M
	c9 += t
	t = c9 >> 22
	c9 &= 0x3FFFFF
	c0 += t * 977
	c1 += t << 6
	t = c0 >> 26
	c0 &= M
	c1 += t
	t = c1 >> 26
	c1 &= M
	c2 += t
	return PackedInt64Array([c0, c1, c2, c3, c4, c5, c6, c7, c8, c9])


static func fe_sqr(a: PackedInt64Array) -> PackedInt64Array:
	var a0: int = a[0]
	var a1: int = a[1]
	var a2: int = a[2]
	var a3: int = a[3]
	var a4: int = a[4]
	var a5: int = a[5]
	var a6: int = a[6]
	var a7: int = a[7]
	var a8: int = a[8]
	var a9: int = a[9]
	var d0: int = a0 * 2
	var d1: int = a1 * 2
	var d2: int = a2 * 2
	var d3: int = a3 * 2
	var d4: int = a4 * 2
	var d5: int = a5 * 2
	var d6: int = a6 * 2
	var d7: int = a7 * 2
	var d8: int = a8 * 2
	var c0: int = a0 * a0
	var c1: int = d0 * a1
	var c2: int = d0 * a2 + a1 * a1
	var c3: int = d0 * a3 + d1 * a2
	var c4: int = d0 * a4 + d1 * a3 + a2 * a2
	var c5: int = d0 * a5 + d1 * a4 + d2 * a3
	var c6: int = d0 * a6 + d1 * a5 + d2 * a4 + a3 * a3
	var c7: int = d0 * a7 + d1 * a6 + d2 * a5 + d3 * a4
	var c8: int = d0 * a8 + d1 * a7 + d2 * a6 + d3 * a5 + a4 * a4
	var c9: int = d0 * a9 + d1 * a8 + d2 * a7 + d3 * a6 + d4 * a5
	var c10: int = d1 * a9 + d2 * a8 + d3 * a7 + d4 * a6 + a5 * a5
	var c11: int = d2 * a9 + d3 * a8 + d4 * a7 + d5 * a6
	var c12: int = d3 * a9 + d4 * a8 + d5 * a7 + a6 * a6
	var c13: int = d4 * a9 + d5 * a8 + d6 * a7
	var c14: int = d5 * a9 + d6 * a8 + a7 * a7
	var c15: int = d6 * a9 + d7 * a8
	var c16: int = d7 * a9 + a8 * a8
	var c17: int = d8 * a9
	var c18: int = a9 * a9
	var t := 0
	t = c0 >> 26
	c0 &= M
	c1 += t
	t = c1 >> 26
	c1 &= M
	c2 += t
	t = c2 >> 26
	c2 &= M
	c3 += t
	t = c3 >> 26
	c3 &= M
	c4 += t
	t = c4 >> 26
	c4 &= M
	c5 += t
	t = c5 >> 26
	c5 &= M
	c6 += t
	t = c6 >> 26
	c6 &= M
	c7 += t
	t = c7 >> 26
	c7 &= M
	c8 += t
	t = c8 >> 26
	c8 &= M
	c9 += t
	t = c9 >> 26
	c9 &= M
	c10 += t
	t = c10 >> 26
	c10 &= M
	c11 += t
	t = c11 >> 26
	c11 &= M
	c12 += t
	t = c12 >> 26
	c12 &= M
	c13 += t
	t = c13 >> 26
	c13 &= M
	c14 += t
	t = c14 >> 26
	c14 &= M
	c15 += t
	t = c15 >> 26
	c15 &= M
	c16 += t
	t = c16 >> 26
	c16 &= M
	c17 += t
	t = c17 >> 26
	c17 &= M
	c18 += t
	var c19 := c18 >> 26
	c18 &= M
	c1 += c11 * 15632
	c2 += c11 << 10
	c2 += c12 * 15632
	c3 += c12 << 10
	c3 += c13 * 15632
	c4 += c13 << 10
	c4 += c14 * 15632
	c5 += c14 << 10
	c5 += c15 * 15632
	c6 += c15 << 10
	c6 += c16 * 15632
	c7 += c16 << 10
	c7 += c17 * 15632
	c8 += c17 << 10
	c8 += c18 * 15632
	c9 += c18 << 10
	c9 += c19 * 15632
	c10 += c19 << 10
	c0 += c10 * 15632
	c1 += c10 << 10
	t = c0 >> 26
	c0 &= M
	c1 += t
	t = c1 >> 26
	c1 &= M
	c2 += t
	t = c2 >> 26
	c2 &= M
	c3 += t
	t = c3 >> 26
	c3 &= M
	c4 += t
	t = c4 >> 26
	c4 &= M
	c5 += t
	t = c5 >> 26
	c5 &= M
	c6 += t
	t = c6 >> 26
	c6 &= M
	c7 += t
	t = c7 >> 26
	c7 &= M
	c8 += t
	t = c8 >> 26
	c8 &= M
	c9 += t
	t = c9 >> 22
	c9 &= 0x3FFFFF
	c0 += t * 977
	c1 += t << 6
	t = c0 >> 26
	c0 &= M
	c1 += t
	t = c1 >> 26
	c1 &= M
	c2 += t
	return PackedInt64Array([c0, c1, c2, c3, c4, c5, c6, c7, c8, c9])
# END GENERATED


# ---------------------------------------------------------------- scalars mod n

static func _n_limbs() -> PackedInt64Array:
	if _n.is_empty():
		_n = fe_from_bytes(N_HEX.hex_decode())
	return _n


static func _cmp(a: PackedInt64Array, b: PackedInt64Array) -> int:
	for i in range(9, -1, -1):
		if a[i] != b[i]:
			return 1 if a[i] > b[i] else -1
	return 0


static func _sub_raw(a: PackedInt64Array, b: PackedInt64Array) -> PackedInt64Array:
	var r := PackedInt64Array()
	r.resize(10)
	var borrow := 0
	for i in 10:
		var v := a[i] - b[i] - borrow
		if v < 0:
			v += 1 << 26
			borrow = 1
		else:
			borrow = 0
		r[i] = v
	return r


static func sc_is_zero(a: PackedInt64Array) -> bool:
	for i in 10:
		if a[i] != 0:
			return false
	return true


## Reduce a value below 2^256 (so below 2n) into [0, n).
static func sc_reduce(a: PackedInt64Array) -> PackedInt64Array:
	var n := _n_limbs()
	if _cmp(a, n) >= 0:
		return _sub_raw(a, n)
	return a


static func sc_add(a: PackedInt64Array, b: PackedInt64Array) -> PackedInt64Array:
	var r := PackedInt64Array()
	r.resize(10)
	var carry := 0
	for i in 10:
		var v := a[i] + b[i] + carry
		carry = v >> 26
		r[i] = v & M
	# limb 9 may now exceed 22 bits (value < 2n < 2^257): the carry out of limb 9 stays in the top limb
	r[9] += carry << 26
	var n := _n_limbs()
	if _cmp(r, n) >= 0:
		return _sub_raw(r, n)
	return r


static func sc_neg(a: PackedInt64Array) -> PackedInt64Array:
	if sc_is_zero(a):
		return a
	return _sub_raw(_n_limbs(), a)


static func sc_mul(a: PackedInt64Array, b: PackedInt64Array) -> PackedInt64Array:
	var r := PackedInt64Array()
	r.resize(10)
	for li in range(9, -1, -1):
		var w: int = b[li]
		var top := 25 if li < 9 else 21
		for bit in range(top, -1, -1):
			r = sc_add(r, r)
			if (w >> bit) & 1 == 1:
				r = sc_add(r, a)
	return r


# ---------------------------------------------------------------- fixed-base multiplication

static func _window(i: int) -> PackedInt64Array:
	if _win_cache.is_empty():
		_win_cache.resize(64)
	var w = _win_cache[i]
	if w == null:
		var raw := Marshalls.base64_to_raw(OneLobbySecp256k1Table.WINDOWS[i])
		var arr := PackedInt64Array()
		arr.resize(300)
		for j in 30:
			var fe := fe_from_bytes(raw.slice(j * 32, j * 32 + 32))
			for k in 10:
				arr[j * 10 + k] = fe[k]
		_win_cache[i] = arr
		w = arr
	return w


## k*G for a scalar 1 <= k < n (limbs). Returns [x, y] affine field elements.
static func mul_base(k: PackedInt64Array) -> Array:
	var kb := limbs_to_bytes(k)
	var inf := true
	var X := PackedInt64Array()
	var Y := PackedInt64Array()
	var Z := PackedInt64Array()
	for i in 64:
		# window i = 4 bits starting at bit 4*i (kb is big-endian)
		var byte: int = kb[31 - (i >> 1)]
		var nib: int = (byte >> 4) if (i & 1) == 1 else (byte & 15)
		if nib == 0:
			continue
		var tab := _window(i)
		var o := (nib - 1) * 20
		var x2 := tab.slice(o, o + 10)
		var y2 := tab.slice(o + 10, o + 20)
		if inf:
			X = x2
			Y = y2
			Z = fe_one()
			inf = false
			continue
		# madd-2007-bl
		var z1z1 := fe_sqr(Z)
		var u2 := fe_mul(x2, z1z1)
		var s2 := fe_mul(fe_mul(y2, Z), z1z1)
		var h := fe_sub(u2, X)
		var hh := fe_sqr(h)
		var ii := fe_small(hh, 4)
		var j := fe_mul(h, ii)
		var r := fe_small(fe_sub(s2, Y), 2)
		var v := fe_mul(X, ii)
		var x3 := fe_sub(fe_sub(fe_sqr(r), j), fe_small(v, 2))
		var y3 := fe_sub(fe_mul(r, fe_sub(v, x3)), fe_small(fe_mul(Y, j), 2))
		var z3 := fe_sub(fe_sub(fe_sqr(fe_add(Z, h)), z1z1), hh)
		X = x3
		Y = y3
		Z = z3
	var zi := fe_inv(Z)
	var zi2 := fe_sqr(zi)
	return [fe_mul(X, zi2), fe_mul(Y, fe_mul(zi2, zi))]


# ---------------------------------------------------------------- BIP340

static func sha256(b: PackedByteArray) -> PackedByteArray:
	var h := HashingContext.new()
	h.start(HashingContext.HASH_SHA256)
	h.update(b)
	return h.finish()


static func tagged_hash(tag: String, data: PackedByteArray) -> PackedByteArray:
	var th: PackedByteArray = _tag_cache.get(tag, PackedByteArray())
	if th.is_empty():
		th = sha256(tag.to_utf8_buffer())
		_tag_cache[tag] = th
	var buf := th + th
	buf.append_array(data)
	return sha256(buf)


## Builds a key pair from a 32-byte secret key; null when the key is 0 or >= n.
static func keypair(sk: PackedByteArray) -> Keypair:
	if sk.size() != 32:
		return null
	var d0 := fe_from_bytes(sk)
	if sc_is_zero(d0) or _cmp(d0, _n_limbs()) >= 0:
		return null
	var pt := mul_base(d0)
	var kp := Keypair.new()
	kp.d = sc_neg(d0) if fe_is_odd(pt[1]) else d0
	kp.d_bytes = limbs_to_bytes(kp.d)
	kp.px = fe_to_bytes(pt[0])
	return kp


static func random_keypair() -> Keypair:
	while true:
		var kp := keypair(Crypto.new().generate_random_bytes(32))
		if kp != null:
			return kp
	return null


## BIP340 signature (64 bytes) of a 32-byte message with 32 bytes of auxiliary randomness.
static func sign_msg(msg: PackedByteArray, kp: Keypair, aux: PackedByteArray) -> PackedByteArray:
	var ah := tagged_hash("BIP0340/aux", aux)
	var t := PackedByteArray()
	t.resize(32)
	for i in 32:
		t[i] = kp.d_bytes[i] ^ ah[i]
	var nonce_in := t + kp.px + msg
	var k0 := sc_reduce(fe_from_bytes(tagged_hash("BIP0340/nonce", nonce_in)))
	if sc_is_zero(k0):
		return PackedByteArray()
	var rp := mul_base(k0)
	var k := sc_neg(k0) if fe_is_odd(rp[1]) else k0
	var rx := fe_to_bytes(rp[0])
	var e := sc_reduce(fe_from_bytes(tagged_hash("BIP0340/challenge", rx + kp.px + msg)))
	var s := sc_add(k, sc_mul(e, kp.d))
	return rx + limbs_to_bytes(s)


static func sign_random(msg: PackedByteArray, kp: Keypair) -> PackedByteArray:
	return sign_msg(msg, kp, Crypto.new().generate_random_bytes(32))
