# Embedded hybrid emblem

Runtime files are byte-identical copies from [the reviewed production-v1 source pack](../../../../libs/stellar-emblem/production-v1/README.md), merged in develop at 7943827073b15084bf4f457d4dcead8a61ef07fd for issue #176. The manifest retains its production-candidate status. Twelve meaningful raster/SVG layers share a 1280 square origin; all assembled transforms are zero. The motion component selects the exploded idle pose and assembled activity pose.

The runtime payload is 2,742,704 bytes. Original reference, generated masters, registration, history and previews remain in the source library and are not copied into the application. Imagegen supplied the raster artwork; this copy does not attribute it to the earlier Hermes SVG study. Independent source/visual acceptance does not qualify physical microphones or native performance.

Copy integrity was checked byte-for-byte against source files on this checkout. The payload count describes that checkout; text newline conventions can change the count on another platform. SHA-256 hashes below normalize JSON/SVG text to LF and preserve exact PNG bytes.

| Runtime file               | SHA-256                                                          |
| -------------------------- | ---------------------------------------------------------------- |
| manifest.json              | fab14554ddcc01b5d2dbe36d9b313d3ccc03d6686e4eeb284521ec37509d6bc5 |
| layers/violet-body.png     | 0010606509668e59836ba19a07eb9cf8e99d46ae275fe2f2c2258e4f1f021127 |
| layers/violet-hair.png     | 5ca76606302c0758dd55b520c5ce0cd751bda9e9b8c827ff2e78920c19938da3 |
| layers/violet-ornament.png | 693fdcba33e399e0585d05c27ca3fac38b93bd66d4d61c0cd08ecdd0647d09ef |
| layers/gold-body.png       | c722b70f806345416863141be4cb9201d38a94b5578e049859a461a180ee6dd7 |
| layers/gold-hair.png       | 43b1bf105096cd2ac20f60050c8adb8e05d99dabeb65c2bb886330b661da3448 |
| layers/gold-ornament.png   | f9c182b24634b242e03b4515b61ea68c8ffe325bd16f12f9c4c3130a634b8350 |
| layers/outer-frame.svg     | 8055f680da24c538e8afa6b4c0efe38240482ab0d53977741578d5310e3f54f2 |
| layers/inner-circle.svg    | b9a2ecdfc3ee139f6e0a183e1364397624c9246ca62a641098b1dc37416a4855 |
| layers/cardinal-north.svg  | 88666fcbcfedb08790a3f009470a4ea7e76f8a2e304bc05110396b4b9bf3cd56 |
| layers/cardinal-east.svg   | 2bacd9d38875ea72bb21a0e5d0ea9b25a165fb819aa372f5143a6ad57ad8927e |
| layers/cardinal-south.svg  | 6d23fd94eab237582081d0e722a7d6ae789a5b43610415300f42110b9d8d0e2a |
| layers/cardinal-west.svg   | f469572a6ec58097db2213e02f6d4dd3e72dc61f8e3cb327a5e5aac64d786db3 |
