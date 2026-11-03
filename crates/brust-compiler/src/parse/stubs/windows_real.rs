//! Real definitions (not aborts) for symbols the Windows (MSVC) addon must provide and that the
//! Windows image keeps a caller of (ledger F484, plan amendment A2). Hand-written, unlike the
//! generated abort stubs in `windows.rs`. The logic is plain Rust so its tests run on every host;
//! only the exported symbols are gated to MSVC.

/// simdutf's `convert_valid_utf16le_to_utf8`: writes the UTF-8 form of `units` into `out` and
/// returns the byte count. simdutf trusts "valid" input; a lone surrogate becomes U+FFFD (3 bytes,
/// the width `simdutf__utf8_length_from_utf16le` in native.rs counts for it). `out` must hold the
/// result (`utf8_len(units)` bytes at least); a short `out` panics instead of overrunning.
pub(super) fn convert_valid_utf16le_to_utf8(units: &[u16], out: &mut [u8]) -> usize {
    let mut written = 0;
    for c in char::decode_utf16(units.iter().copied()) {
        let c = c.unwrap_or(char::REPLACEMENT_CHARACTER);
        written += c.encode_utf8(&mut out[written..]).len();
    }
    written
}

/// The byte count `convert_valid_utf16le_to_utf8` writes: the same count as native.rs's
/// `simdutf__utf8_length_from_utf16le` (a lone surrogate is 3 bytes).
pub(super) fn utf8_len(units: &[u16]) -> usize {
    char::decode_utf16(units.iter().copied())
        .map(|c| c.map_or(3, char::len_utf8))
        .sum()
}

/// `bun_core::strings::convert_utf16_to_utf8_in_buffer` (Windows wide paths) calls this.
#[cfg(all(windows, target_env = "msvc"))]
#[unsafe(no_mangle)]
unsafe extern "C" fn simdutf__convert_valid_utf16le_to_utf8(
    p: *const u16,
    len: usize,
    out: *mut u8,
) -> usize {
    if len == 0 {
        return 0;
    }
    // SAFETY: the caller passes `len` readable units.
    let units = unsafe { core::slice::from_raw_parts(p, len) };
    // The caller guarantees only that `out` holds the UTF-8 length of `units` (its assert is
    // `out.len() >= simdutf__utf8_length_from_utf16le`), not 3 bytes per unit: slice exactly that.
    let need = utf8_len(units);
    // SAFETY: `out` is valid for writes of at least `need` bytes (the caller's contract above).
    let out = unsafe { core::slice::from_raw_parts_mut(out, need) };
    convert_valid_utf16le_to_utf8(units, out)
}

/// A data symbol, so it cannot be an abort stub: `bun_core::output` reads `[AtomicI32; 3]` that
/// Bun's C startup sets when fd 0/1/2 is closed. Bun's C definition starts all-zero; nothing in
/// brust writes it.
#[cfg(all(windows, target_env = "msvc"))]
#[unsafe(no_mangle)]
static bun_is_stdio_null: [core::sync::atomic::AtomicI32; 3] =
    [const { core::sync::atomic::AtomicI32::new(0) }; 3];

#[cfg(test)]
mod tests {
    use super::convert_valid_utf16le_to_utf8 as convert;

    fn run(s: &[u16]) -> Vec<u8> {
        let mut out = vec![0u8; s.len() * 3];
        let n = convert(s, &mut out);
        out.truncate(n);
        out
    }

    #[test]
    fn ascii_thai_and_astral_match_std() {
        for s in [
            "",
            "C:\\app\\pages\\index.tsx",
            "C:\\ผู้ใช้\\แอป\\หน้า.tsx",
            "emoji 😀 / 𝄞",
        ] {
            let units: Vec<u16> = s.encode_utf16().collect();
            assert_eq!(run(&units), s.as_bytes(), "{s}");
        }
    }

    #[test]
    fn lone_surrogates_become_replacement_chars() {
        assert_eq!(run(&[0x61, 0xD800, 0x62]), "a\u{FFFD}b".as_bytes());
        assert_eq!(run(&[0xDC00]), "\u{FFFD}".as_bytes());
    }

    #[test]
    fn an_out_buffer_of_exactly_the_utf8_length_is_enough() {
        for s in ["C:\\app\\index.tsx", "ไทย😀x", "a"] {
            let mut units: Vec<u16> = s.encode_utf16().collect();
            units.push(0xD800); // lone surrogate: 3 bytes
            let mut out = vec![0u8; super::utf8_len(&units)];
            assert_eq!(convert(&units, &mut out), out.len(), "{s}");
        }
    }

    #[test]
    fn length_agrees_with_the_native_length_helper() {
        unsafe extern "C" {
            // native.rs defines it (no_mangle); declared here because that module keeps it private.
            fn simdutf__utf8_length_from_utf16le(p: *const u16, len: usize) -> usize;
        }
        let units: Vec<u16> = "ไทย😀x"
            .encode_utf16()
            .chain([0xD800, 0x41, 0xDC00])
            .collect();
        // SAFETY: a valid slice, as a pointer and a length.
        let want = unsafe { simdutf__utf8_length_from_utf16le(units.as_ptr(), units.len()) };
        assert_eq!(run(&units).len(), want);
    }
}
