# Embedded hybrid emblem

Runtime files are byte-identical copies from [the production-v1 source pack](https://github.com/DanielssonThomas/Stellar/blob/develop/libs/stellar-emblem/production-v1/README.md). Issue #176 supplied the hybrid raster artwork and editable SVG geometry; #204 composes its four stars into the outer frame, adds three matching inner circles and assigns eleven uniformly spaced logical planes. The manifest retains production-candidate status. All files share a 1280 square origin and all assembled transforms remain zero. The six registered raster files are unchanged.

The runtime payload is 2,742,800 bytes for the manifest and eleven registered layers on this checkout. Text newline conventions can change that count on another platform. Original references, generated masters, registration, history and previews remain in the source library. Imagegen supplied the raster artwork; this does not attribute it to the earlier Hermes SVG study. Native performance and physical microphones require separate verification.

Copy integrity was checked byte-for-byte against source files on this checkout. SHA-256 hashes below normalize JSON/SVG text to LF and preserve exact PNG bytes.

| Runtime file               | SHA-256                                                          |
| -------------------------- | ---------------------------------------------------------------- |
| manifest.json              | f85da103438a03d85daafcf0055e52e08e112beb9ccd63d646b78c07c2177fd7 |
| layers/violet-body.png     | 0010606509668e59836ba19a07eb9cf8e99d46ae275fe2f2c2258e4f1f021127 |
| layers/violet-hair.png     | 5ca76606302c0758dd55b520c5ce0cd751bda9e9b8c827ff2e78920c19938da3 |
| layers/violet-ornament.png | 693fdcba33e399e0585d05c27ca3fac38b93bd66d4d61c0cd08ecdd0647d09ef |
| layers/gold-body.png       | c722b70f806345416863141be4cb9201d38a94b5578e049859a461a180ee6dd7 |
| layers/gold-hair.png       | 43b1bf105096cd2ac20f60050c8adb8e05d99dabeb65c2bb886330b661da3448 |
| layers/gold-ornament.png   | f9c182b24634b242e03b4515b61ea68c8ffe325bd16f12f9c4c3130a634b8350 |
| layers/outer-frame.svg     | 513a4316be96fe9cd4081aa7d02429728d6d3c206e3e504e2808194a8b169f4c |
| layers/inner-circle.svg    | b9a2ecdfc3ee139f6e0a183e1364397624c9246ca62a641098b1dc37416a4855 |
| layers/inner-circle-2.svg  | cc745af8a7e0d15b60840136d9df336366c18f06693dbdb194386b66696d6162 |
| layers/inner-circle-3.svg  | aedfc78658780e12e6a07e54af7a4fea2588ecc772cde0ce3e6c88be59ac756c |
| layers/inner-circle-4.svg  | ac10367f20f03609f0c24fd17d72e9d1b6c0b1f8ead11dc7bdf9b48e953dd64e |
