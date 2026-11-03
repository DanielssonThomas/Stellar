# Embedded hybrid emblem

Runtime PNGs are byte-identical copies from [the production-v1 source pack](https://github.com/DanielssonThomas/Stellar/blob/develop/libs/stellar-emblem/production-v1/README.md); JSON and SVG copies match after LF normalization. Issue #176 supplied the hybrid raster artwork and SVG geometry. #204 added circle planes, #211 divided bodies into registered clips, and #221 corrected body registration. The six original generated cutouts remain unchanged.

Experiment #251 uses 73 planes. Built-in ImageGen supplied four flat hair/leaf segmentation maps, preserved with their prompts in the source library. Deterministic Canvas extraction assigns each original hair pixel to one of twelve curved groups per color. Full-resolution recomposition is pixel-identical. Complete registered assembly groups preload and restore their original hair image after settlement. Jewelry uses twenty leaf regions and two gemstone settings; bodies use eleven small slices per color with scrambled poses. All five rings align on one straight axis and retain their previous depth intervals of 240 source units. The complete main frame stays centered; outer fragments use progressively denser spacing and an elliptical inward taper of their measured visible centers. All assembled transforms remain zero.

The experimental runtime payload is 6,914,513 bytes across the manifest and 57 unique image files, within a 8 MiB budget. Text newline conventions can change this count slightly. References, source maps, registration, generation prompts and review captures remain in the source library. Native appearance/performance remains separate verification; this pack is an experimental candidate.

Copy integrity was checked against source files on this checkout. SHA-256 hashes normalize JSON/SVG text to LF and preserve exact PNG bytes.

| Runtime file | SHA-256 |
| --- | --- |
| manifest.json | 3f653e64e79b0fa236ed19cfd0aece9ae59d38103d17cf53bb4b82cfda6a1e7e |
| layers/violet-body.png | 2d26d670fbaab0630cd7d243e55ba75de39b8662d34507fd3ceefef482868730 |
| layers/violet-hair-1.png | 42d846e30c9020b61d8c1cc1d620ee0cacdc0059c4a5fb6940894ddd16b64257 |
| layers/violet-hair.png | 5ca76606302c0758dd55b520c5ce0cd751bda9e9b8c827ff2e78920c19938da3 |
| layers/violet-hair-2.png | ed7f1467d13b4045183719f74922a76119215399dc1178507660860ea69a7c35 |
| layers/violet-hair-3.png | 87a12954cff14d8f047769144c36e7b1749a30e7db05533922c710c13cfd3dee |
| layers/violet-hair-4.png | 5a495abdfe309156df15a5501218823f949665ad302957988fbabf276e33300d |
| layers/violet-hair-5.png | 6222e30e6da4832a3382a471c90c79e07ef2718c869fe199f54c32fce72aee2c |
| layers/violet-hair-6.png | 260d1e0f24c4f92da420e94efefeb2951844c19f5e189c159a7aa0b1f0c21e84 |
| layers/violet-hair-7.png | 2d23ded3b66b1c509fb5fed4de427015c0e04d84308ef9b18f328f2e5fc2257a |
| layers/violet-hair-8.png | 8a83d1c5e7ccf63101cf1c8ba7c9baf6dfb8a4f0e90bd36d9d01ef195ff90221 |
| layers/violet-hair-9.png | fb0810b98e24dfbb423f2f32458edfcddeff07d8bea16a45ab9a3d2b0a4a7820 |
| layers/violet-hair-10.png | 9787a437a9d97b52173d7fc6020992dc11c4591490b4edf3f1c7b09f0476bae8 |
| layers/violet-hair-11.png | 66ef3195f17db60abcd3f2b6db49b5a78175a570fe4a4c703bb386e0d72847c5 |
| layers/violet-hair-12.png | 6d33bc45f333a2feff5882421536fee417748c82f3106a219270a670e16b8021 |
| layers/violet-ornament-1.png | 368f4ce3014a04aa3e43a20660166c1261c2a791c3581a650ce25e96b4dbe77c |
| layers/violet-ornament.png | 693fdcba33e399e0585d05c27ca3fac38b93bd66d4d61c0cd08ecdd0647d09ef |
| layers/violet-ornament-2.png | 4621b8c7d80783f895b714efb9d419f329e72d5dbd4fff4d0cc98c95557e2e8e |
| layers/violet-ornament-3.png | e677234c34fefdec96f9944140b7ed73f8abd4c0cddd311626c1055741c542a2 |
| layers/violet-ornament-4.png | d12b71f7b36fbb05983915dce3a6f4e8a62edef2b374862df594d7e45d0c050a |
| layers/violet-ornament-5.png | b1dde30b272152c1f6261065b25576c04a5faf71c6442e6e546bcab3160266c0 |
| layers/violet-ornament-6.png | 8a03b313474e8c7bb58e5e8a3747dc4b5bf57c6ca2f65a5faef6fa9a25d6a9b7 |
| layers/violet-ornament-7.png | d21e3370d7a2bcad6a1a4688908ed49a2bd4ffd4114b547abd321f376311bd13 |
| layers/gold-body.png | e4f0044e8b4a320b312c0071596cf0d91912136915cb322fec9dd96446aa3e9c |
| layers/gold-hair-1.png | ba01b20891fe5eeefc95bf86d83731f8a34622d4246df18a6a2d19b00d28707c |
| layers/gold-hair.png | 43b1bf105096cd2ac20f60050c8adb8e05d99dabeb65c2bb886330b661da3448 |
| layers/gold-hair-2.png | 5a905df47a3850aed19be8a36bd721cc5aa863f5ed724b2889947a7757af499d |
| layers/gold-hair-3.png | 66ff278a42e11c699cb2506c0a6e9f1db89811febe0cb1044eab4ca80efb0f83 |
| layers/gold-hair-4.png | 64537368a60433d614d17bc12a0f69e257989bcfff924cdee53f6e90ac979a5f |
| layers/gold-hair-5.png | 7ab2799601b4455c1c2b649c01d96644570c6b88678a395751af071d33c1010b |
| layers/gold-hair-6.png | 052c02a2c1c19dabee38022787406852facf43816c1991aede91701c479e4c26 |
| layers/gold-hair-7.png | 5d628855cc48b78ec9b3bdf280d20b47e3914bfebd14534aa0f2a5e8e533031f |
| layers/gold-hair-8.png | 2c49735baee50ad799fe0e838a37b695e50fb739874bb6e62f3564d23fa8587c |
| layers/gold-hair-9.png | 9697cfb8968899fc6bb12abb21f47d33a89f6626dc151060735ff75e57e40d4e |
| layers/gold-hair-10.png | e3ccf7615e237a494ffb72c6ac4b981cd736dc42c9bf5667d14f86935e626f97 |
| layers/gold-hair-11.png | e16f48624723089375cc371913c9c091e4aebf6465367fc17f95893637f58d01 |
| layers/gold-hair-12.png | 5e6a6be537068abba084a3e1e9309ba281b52530e37da736ffc5ab88113ac04c |
| layers/gold-ornament-1.png | 0693373419c00215d573ab72550cc7d8ecae91906be5b91163bd8b6f48877c82 |
| layers/gold-ornament.png | f9c182b24634b242e03b4515b61ea68c8ffe325bd16f12f9c4c3130a634b8350 |
| layers/gold-ornament-2.png | 0370b2023d0b74bc32ebd7526e219ffd20c6775c9928101a8d9af8bb1a5d64a1 |
| layers/gold-ornament-3.png | 104365c07f61b3f0586343f0294cfb9334616125836f68733c5c8f0c2a1f3290 |
| layers/gold-ornament-4.png | 530002d41524fcecc5520fdc7fc7cec314d01d7d0fe78c5a56ac8c4242fce403 |
| layers/gold-ornament-5.png | 0fd2464476cd9ebf52b62013a5606c6b7e5aee67e823eb44289a05fa500e1c26 |
| layers/gold-ornament-6.png | a3ab60306676d1e34c13a05daca5755307b1e8480546d3643ef6b47fb5e758b2 |
| layers/gold-ornament-7.png | a5b09fd779bad7e1fa9aac232056dcd68afd7bcfa4ff6743d8554f7525285bc9 |
| layers/gold-ornament-8.png | 05e664f3c0658e6bf726cdfda073b76689c223812654afa0e1d96b4ea0c2a470 |
| layers/gold-ornament-9.png | 77b3e5a2bba6be8dc1d1730e1b8994c047d1b76ddee64bdf0bdd000bc195af09 |
| layers/gold-ornament-10.png | e5a3bdb1775280a2e25d05fc57bc9bff0fa13c046896d33fe94c71c0cac85d64 |
| layers/gold-ornament-11.png | 3fc624d859daf7bff971fabcd06ff2247d04ad2f657e663276a6f9495b43a774 |
| layers/gold-ornament-12.png | 14da185081ea8bc9c82569183cc5fcfef732430df0c948c3da2f24c4e7692956 |
| layers/gold-ornament-13.png | c5edf393fd5384be5cf3b3d3d369ee9a3d130c418f621157e9991183bb965389 |
| layers/gold-ornament-14.png | 89352e1f1f994a701bc00394c128f122443df4898b7c2ab744af696e06fba966 |
| layers/gold-ornament-15.png | e15c1ceb9ea69ffd4f2cc593b1f852124c737fa3b7492fda96900454b164f2e3 |
| layers/outer-frame.svg | 513a4316be96fe9cd4081aa7d02429728d6d3c206e3e504e2808194a8b169f4c |
| layers/inner-circle.svg | b9a2ecdfc3ee139f6e0a183e1364397624c9246ca62a641098b1dc37416a4855 |
| layers/inner-circle-2.svg | cc745af8a7e0d15b60840136d9df336366c18f06693dbdb194386b66696d6162 |
| layers/inner-circle-3.svg | aedfc78658780e12e6a07e54af7a4fea2588ecc772cde0ce3e6c88be59ac756c |
| layers/inner-circle-4.svg | ac10367f20f03609f0c24fd17d72e9d1b6c0b1f8ead11dc7bdf9b48e953dd64e |
