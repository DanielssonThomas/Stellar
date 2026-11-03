# Embedded hybrid emblem

Runtime PNGs are byte-identical copies from [the production-v1 source pack](https://github.com/DanielssonThomas/Stellar/blob/develop/libs/stellar-emblem/production-v1/README.md); JSON and SVG copies match after LF normalization. Issue #176 supplied the hybrid raster artwork and SVG geometry. #204 added circle planes, #211 divided bodies into registered clips, and #221 corrected body registration. The six original generated cutouts remain unchanged.

Experiment #251 uses 47 planes. Built-in ImageGen supplied two flat strand-segmentation maps, preserved with their prompts in the source library. Deterministic Canvas extraction assigns each original hair pixel to one of twelve curved groups per color. Full-resolution recomposition is pixel-identical. Complete registered assembly groups preload and restore their original hair image after settlement. Jewelry retains six clips per color. Two secondary rings scatter laterally while all five retain their previous depth intervals of 240 source units. The complete main frame stays centered; only outer fragments use progressively denser spacing. All assembled transforms remain zero.

The experimental runtime payload is 5,919,167 bytes across the manifest and 35 unique image files, within a 6 MiB budget. Text newline conventions can change this count slightly. References, source maps, registration, generation prompts and review captures remain in the source library. Native appearance/performance remains separate verification; this pack is an experimental candidate.

Copy integrity was checked against source files on this checkout. SHA-256 hashes normalize JSON/SVG text to LF and preserve exact PNG bytes.

| Runtime file               | SHA-256                                                          |
| -------------------------- | ---------------------------------------------------------------- |
| manifest.json              | fcabbe8caf659567df02be752e4ce56e97f1193372170db738d602f360505576 |
| layers/violet-body.png     | 2d26d670fbaab0630cd7d243e55ba75de39b8662d34507fd3ceefef482868730 |
| layers/violet-hair-1.png   | 42d846e30c9020b61d8c1cc1d620ee0cacdc0059c4a5fb6940894ddd16b64257 |
| layers/violet-hair.png     | 5ca76606302c0758dd55b520c5ce0cd751bda9e9b8c827ff2e78920c19938da3 |
| layers/violet-hair-2.png   | ed7f1467d13b4045183719f74922a76119215399dc1178507660860ea69a7c35 |
| layers/violet-hair-3.png   | 87a12954cff14d8f047769144c36e7b1749a30e7db05533922c710c13cfd3dee |
| layers/violet-hair-4.png   | 5a495abdfe309156df15a5501218823f949665ad302957988fbabf276e33300d |
| layers/violet-hair-5.png   | 6222e30e6da4832a3382a471c90c79e07ef2718c869fe199f54c32fce72aee2c |
| layers/violet-hair-6.png   | 260d1e0f24c4f92da420e94efefeb2951844c19f5e189c159a7aa0b1f0c21e84 |
| layers/violet-hair-7.png   | 2d23ded3b66b1c509fb5fed4de427015c0e04d84308ef9b18f328f2e5fc2257a |
| layers/violet-hair-8.png   | 8a83d1c5e7ccf63101cf1c8ba7c9baf6dfb8a4f0e90bd36d9d01ef195ff90221 |
| layers/violet-hair-9.png   | fb0810b98e24dfbb423f2f32458edfcddeff07d8bea16a45ab9a3d2b0a4a7820 |
| layers/violet-hair-10.png  | 9787a437a9d97b52173d7fc6020992dc11c4591490b4edf3f1c7b09f0476bae8 |
| layers/violet-hair-11.png  | 66ef3195f17db60abcd3f2b6db49b5a78175a570fe4a4c703bb386e0d72847c5 |
| layers/violet-hair-12.png  | 6d33bc45f333a2feff5882421536fee417748c82f3106a219270a670e16b8021 |
| layers/violet-ornament.png | 693fdcba33e399e0585d05c27ca3fac38b93bd66d4d61c0cd08ecdd0647d09ef |
| layers/gold-body.png       | e4f0044e8b4a320b312c0071596cf0d91912136915cb322fec9dd96446aa3e9c |
| layers/gold-hair-1.png     | ba01b20891fe5eeefc95bf86d83731f8a34622d4246df18a6a2d19b00d28707c |
| layers/gold-hair.png       | 43b1bf105096cd2ac20f60050c8adb8e05d99dabeb65c2bb886330b661da3448 |
| layers/gold-hair-2.png     | 5a905df47a3850aed19be8a36bd721cc5aa863f5ed724b2889947a7757af499d |
| layers/gold-hair-3.png     | 66ff278a42e11c699cb2506c0a6e9f1db89811febe0cb1044eab4ca80efb0f83 |
| layers/gold-hair-4.png     | 64537368a60433d614d17bc12a0f69e257989bcfff924cdee53f6e90ac979a5f |
| layers/gold-hair-5.png     | 7ab2799601b4455c1c2b649c01d96644570c6b88678a395751af071d33c1010b |
| layers/gold-hair-6.png     | 052c02a2c1c19dabee38022787406852facf43816c1991aede91701c479e4c26 |
| layers/gold-hair-7.png     | 5d628855cc48b78ec9b3bdf280d20b47e3914bfebd14534aa0f2a5e8e533031f |
| layers/gold-hair-8.png     | 2c49735baee50ad799fe0e838a37b695e50fb739874bb6e62f3564d23fa8587c |
| layers/gold-hair-9.png     | 9697cfb8968899fc6bb12abb21f47d33a89f6626dc151060735ff75e57e40d4e |
| layers/gold-hair-10.png    | e3ccf7615e237a494ffb72c6ac4b981cd736dc42c9bf5667d14f86935e626f97 |
| layers/gold-hair-11.png    | e16f48624723089375cc371913c9c091e4aebf6465367fc17f95893637f58d01 |
| layers/gold-hair-12.png    | 5e6a6be537068abba084a3e1e9309ba281b52530e37da736ffc5ab88113ac04c |
| layers/gold-ornament.png   | f9c182b24634b242e03b4515b61ea68c8ffe325bd16f12f9c4c3130a634b8350 |
| layers/outer-frame.svg     | 513a4316be96fe9cd4081aa7d02429728d6d3c206e3e504e2808194a8b169f4c |
| layers/inner-circle.svg    | b9a2ecdfc3ee139f6e0a183e1364397624c9246ca62a641098b1dc37416a4855 |
| layers/inner-circle-2.svg  | cc745af8a7e0d15b60840136d9df336366c18f06693dbdb194386b66696d6162 |
| layers/inner-circle-3.svg  | aedfc78658780e12e6a07e54af7a4fea2588ecc772cde0ce3e6c88be59ac756c |
| layers/inner-circle-4.svg  | ac10367f20f03609f0c24fd17d72e9d1b6c0b1f8ead11dc7bdf9b48e953dd64e |
