# Embedded hybrid emblem

Runtime PNGs are byte-identical copies from [the production-v1 source pack](https://github.com/DanielssonThomas/Stellar/blob/develop/libs/stellar-emblem/production-v1/README.md); JSON and SVG copies match after LF normalization. Issue #176 supplied the hybrid raster artwork and SVG geometry. #204 added circle planes, #211 divided bodies into registered clips, and #221 corrected body registration. The six original generated cutouts remain unchanged.

Experiment #251 uses 81 planes. Built-in ImageGen supplied six flat body/hair/leaf segmentation maps, preserved with their prompts in the source library. Deterministic Canvas extraction assigns each original hair pixel to one of twelve curved groups per color. Each isolated rasterized source recomposes pixel-identically; settled assembly restores the exact original SVG/raster stack. Direct vector Canvas composition and rasterized arc composition can differ at antialiased stroke edges, as recorded in source validation. Complete registered assembly groups preload and restore their original body/hair/ornament and secondary-ring images after settlement. Jewelry uses twenty leaf regions and two gemstone settings; bodies use eleven wavy organic regions per color with scrambled poses. The main ring stays whole; the four secondary rings each use three coaxial arcs at varied explicit depths. Raster fragment depth and the overall stack extent are preserved. The complete main frame stays centered; outer fragments use progressively denser spacing and an elliptical inward taper of their measured visible centers. Gold body fragments stay at positive depths 530–830, while all violet character fragments stay at negative depth. All assembled transforms remain zero.

The experimental runtime payload is 6,492,456 bytes across the manifest and 91 unique image files, within an 8 MiB budget. Text newline conventions can change this count slightly. References, source maps, registration, generation prompts and review captures remain in the source library. Native appearance/performance remains separate verification; this pack is an experimental candidate.

Copy integrity was checked against source files on this checkout. SHA-256 hashes normalize JSON/SVG text to LF and preserve exact PNG bytes.

| Runtime file                    | SHA-256                                                          |
| ------------------------------- | ---------------------------------------------------------------- |
| manifest.json                   | 1a04a717d15761e76fc8dd6391bd14496d12c3d66b464a21b9604a81dbbeb044 |
| layers/violet-body-1.png        | 704433353b3e00d6246fdeacbaabafb609ca8b6dd6cf211c6ff510dcab81cba0 |
| layers/violet-body.png          | 2d26d670fbaab0630cd7d243e55ba75de39b8662d34507fd3ceefef482868730 |
| layers/violet-body-2.png        | d705f4333a57d91a10b24ce0d7238bb6e8f5a8bc4c308d9656e7bcabf64557d5 |
| layers/violet-body-3.png        | 410b3e026c9377832736a7db1e2b7505dc486159182e372ea691956d237fd41b |
| layers/violet-body-4.png        | 724e5ddeb9632b98538cd00acb58f5f048a07e2fd649dc5df23cb1c6bc8269dc |
| layers/violet-body-5.png        | 9f9a6c5bc4d51fdb0f89781206260cae938eed9d01468758f6165c88f44b04c3 |
| layers/violet-body-6.png        | dbf0fe61a3f6238ae86ccad5b0c67062a96a471f70fa11f4c0c8de66a95e05ee |
| layers/violet-body-7.png        | ea2a2f6b02fb6b9b42b234283081114b4556a7b375d9b978204fe7bbc1e23ce9 |
| layers/violet-body-8.png        | 75781faf4c0ad78f2b6c0656e8376df18d9806d279bb520338110a221768a9b6 |
| layers/violet-body-9.png        | d4de91e962bf399c64619037c42e78bbb8538c52f80b0239314ccaf7e0120506 |
| layers/violet-body-10.png       | e84c729e6ae86301f7506ce4fff2be2c6d9f906cdbd1799950178f49ea401147 |
| layers/violet-body-11.png       | 33dfd47aaf0bb15aa560521ee87793a52d493b324b48bb1ebe986c2969542316 |
| layers/violet-hair-1.png        | fdf79f113bbed0ff41582b59ec3d50bfe9243e06611641c199a367e99a6a03e4 |
| layers/violet-hair.png          | 5ca76606302c0758dd55b520c5ce0cd751bda9e9b8c827ff2e78920c19938da3 |
| layers/violet-hair-2.png        | 5f91bb8c41280ff33033c520935df93e432906db6dbd6ba05fe6e6592003a16f |
| layers/violet-hair-3.png        | 89e0d841a028d10a526abd3150b916229f7cf673512a880ce7be6f3ad86d4407 |
| layers/violet-hair-4.png        | 68481cd7e9a239f6aa64771687b822705ad9b6c3799aa998c678529c96155e67 |
| layers/violet-hair-5.png        | 00ca641ed1da203779516fded42087685178a0c39fade60acc68ca04efd9933a |
| layers/violet-hair-6.png        | 5f16c1b63a046975a8c4b839c7739f511c83a66df72351a755d3b890b417902f |
| layers/violet-hair-7.png        | 7064dc89bb9b649bd62e661d7c8c5ed1d1eb17760c70992393f8c67a9f59637d |
| layers/violet-hair-8.png        | dc31815d8dd9ecfe350df7988b4715c2f92a15c08ac8ce9f7ab68c05574aaf01 |
| layers/violet-hair-9.png        | 58a70515c2235a99a7251ac8594fdb2f8bb064506b5fb6278c6a680f4cb6a7b1 |
| layers/violet-hair-10.png       | 7efd0c63a6fa8ce7be17dd38874ed5d2f0f0ee733c9a8be5dfe817a00ede3280 |
| layers/violet-hair-11.png       | f6206dd6211c3df58b10df7127c9b0a2d4fcc18e44719e37bbaa8023e4e14e84 |
| layers/violet-hair-12.png       | 42347ecb8944f07ddf4ee964120458420f7ce19c3c336959b1e531039953b53c |
| layers/violet-ornament-1.png    | d7bafce1997ec9d7d5eb305d6f8202d30668dac1f32b131208e4d16bbb61af32 |
| layers/violet-ornament.png      | 693fdcba33e399e0585d05c27ca3fac38b93bd66d4d61c0cd08ecdd0647d09ef |
| layers/violet-ornament-2.png    | 03c6bdd16da506e9ae3200e0d42a2212527c9dfe41c1805eba95469261369adc |
| layers/violet-ornament-3.png    | 141216657279d6482851bc38a0901b62dd72ae77a561bd34f6b19f78502f64ae |
| layers/violet-ornament-4.png    | 3276d1c97eaf8957606d46f645608c6c393321cf53d37c0faa2d99bcf4614a01 |
| layers/violet-ornament-5.png    | 05ad78a5c165161b43f194d54a07cb003523d50f034f5885594d9dcb58e9fc30 |
| layers/violet-ornament-6.png    | 4573dba9224fdb9de5e84b4610e84da5b9b87c69bc1ddee5cbc81814c2ce2919 |
| layers/violet-ornament-7.png    | 847defca73720e423773ddfd063bbcf1995741318be20f945f584e99208baaa2 |
| layers/gold-body-1.png          | 54db2e1ca032fd886db6398624ec2a85232b1774b1f4c451545138e3318ae9f9 |
| layers/gold-body.png            | e4f0044e8b4a320b312c0071596cf0d91912136915cb322fec9dd96446aa3e9c |
| layers/gold-body-2.png          | ec9af2b31f2577e9b025624ad886a502d020055ecb2db7abc2061d5d1831af21 |
| layers/gold-body-3.png          | 7c0915f51def66c832a465576e730b76ca6ff7dc969cda638b7071f26c010aac |
| layers/gold-body-4.png          | 87e3897cc21940d2b6dff20249e2aa4f569172cf84444d8417d751df03577485 |
| layers/gold-body-5.png          | 444dfcae06e7c50097e22c7e4ca1483f24d13df27f63359a139ab68a070c070e |
| layers/gold-body-6.png          | 0b5e14c9d499e6feafc39e28d2f3fc4cf8e1d1cc403b6facfb47a43116c100e4 |
| layers/gold-body-7.png          | 9a84836d13e987b9d075f1ff679e44b8622df4cfbbee4418862685b50b9afac7 |
| layers/gold-body-8.png          | a684e783e85f04bb78c152b3bc35cfb26bd17d3425c6186856fa10b4488b9fa3 |
| layers/gold-body-9.png          | 572cf2678c942529c753ca1e02c2a1d2597f667b3ea04145d80a07c29e437e71 |
| layers/gold-body-10.png         | bf2a448697d20aa3cc7ee5b685e0da7d659e581d1163959c28088774cb0e7ec8 |
| layers/gold-body-11.png         | 91a45423165daca4de2ece2f975aab3e215f94a0dc68c7c0e00cb7e711ce435f |
| layers/gold-hair-1.png          | 1a629d511ee8abb025a6fb6b5bda50331f18e739c56c750834404326502b3b0e |
| layers/gold-hair.png            | 43b1bf105096cd2ac20f60050c8adb8e05d99dabeb65c2bb886330b661da3448 |
| layers/gold-hair-2.png          | e987386617fa0a3831ed54f65fb83b4ed5e28191ed844e1fd3b6264c28f8ce09 |
| layers/gold-hair-3.png          | 0b20c2aea6d3e1839edc79578dd459784e25eb7dacb5dc415e0b161f4ee742af |
| layers/gold-hair-4.png          | 0e6ea32e088f5b2b9f8bf8f6ae224c413b65f81f71718a6f3320c1038360bd8c |
| layers/gold-hair-5.png          | a5757e7bb091e33532e1bd38f8d5d964dfbbe9d639822fd855271717d1108cec |
| layers/gold-hair-6.png          | 83508a9ac0c356f76f10048c795035958975ef56bc7b6d9080bab957024adeae |
| layers/gold-hair-7.png          | be70037039fd985ca5d73b6c5c79607c8834ced7d68537288522089e8a7a494a |
| layers/gold-hair-8.png          | 63323ab29eed191ceb7c75b64e9cb8374d6d63ed29ba56713da05353dc4495f5 |
| layers/gold-hair-9.png          | 695ad0a5e5701699744bc31f66a6c975b09d36bbf031763624ab8d084b0a476d |
| layers/gold-hair-10.png         | ac0265c22cb3c6b8c997c733c1b32adcf2fcae4e25ffc2569b4a6fb4e3ddbbb2 |
| layers/gold-hair-11.png         | fbe5d83728ae09f7b1daf44bc936334068519a4e29e58acfc2a7475f7c967db7 |
| layers/gold-hair-12.png         | 799631bde8d1ef9f8d4c77c4c16cde3c62b0610a8bcb7fe82eb12af1bed2143e |
| layers/gold-ornament-1.png      | 41bbb72afb6791a622e907d6c0eaaf0f1cc755ecf08f455f898d1488797cccb3 |
| layers/gold-ornament.png        | f9c182b24634b242e03b4515b61ea68c8ffe325bd16f12f9c4c3130a634b8350 |
| layers/gold-ornament-2.png      | 6886b2e1af46e22527390b6d82f5dd936e80eeb75aafd7338488933bbc447299 |
| layers/gold-ornament-3.png      | addc6c51f67241a21885dd1e484dd516bbe224cb4af618ea58b9e1b6f05c566d |
| layers/gold-ornament-4.png      | f53670a2fcdc8ff49e04a7369c9aa39c80064675dc27c8242d2049cb8211e96c |
| layers/gold-ornament-5.png      | 0b9d15d304f0b38410ea2a55b73d36490a4cdbdd6b20100dd7f6ff898c8b5355 |
| layers/gold-ornament-6.png      | dcc7d1aa21a09499dfcfc593d1ea5c17486c91b63ba6750784688f8d5181de7d |
| layers/gold-ornament-7.png      | e70bb24a82c11948ac0a6739f79aed721f6e3b5ab25462d6796e5e7acfe1d807 |
| layers/gold-ornament-8.png      | 107c5d573e730c0f58af544c712273bd3f7a6eaefacc34d899cf1252105f7e5c |
| layers/gold-ornament-9.png      | 327b8771e025931046d5b77e8bfaf6d76a0162c1308b20729f8148a43f681292 |
| layers/gold-ornament-10.png     | a2646d4376de74ee2331613f83141367a828a6083d50bfc6c6b8999f42b2e98b |
| layers/gold-ornament-11.png     | 8990178f98a8575419f363c4a6ceab5ca8d9bfdf5626ed7b63a2b943a4cb37b9 |
| layers/gold-ornament-12.png     | 6fde6ef076c0d2556c7b0410f5c33f932fe39ba70f73523bd494b6535a14bf78 |
| layers/gold-ornament-13.png     | e2e0495ef181aaf16cfbaf03f822cb1e4e376375f5b5c7dd77885ecda65158ee |
| layers/gold-ornament-14.png     | 099946e280472bdb087af791596d0bc113fe465dfb4ec877706d9728b6501fb2 |
| layers/gold-ornament-15.png     | 537ed625ffbe0b096c5aecd43eeeb03c45c34a21d1d7baa7f1c56521b5485a5e |
| layers/outer-frame.svg          | 513a4316be96fe9cd4081aa7d02429728d6d3c206e3e504e2808194a8b169f4c |
| layers/inner-circle-arc-1.png   | f7c520f0d17c96fe36f414c1b806414e82503439ba6acf1a0c01a12d535f47e9 |
| layers/inner-circle.svg         | b9a2ecdfc3ee139f6e0a183e1364397624c9246ca62a641098b1dc37416a4855 |
| layers/inner-circle-arc-2.png   | 74d9fd935327cb95398d3f140b174a26e3cc1e9f8b52727a33ff976aa2ac8e79 |
| layers/inner-circle-arc-3.png   | bfc1d0c8e1fd2144bcb9c8f9ca33dc85c3c05bbb4001dc9197bcd816004bbd4f |
| layers/inner-circle-2-arc-1.png | f7c520f0d17c96fe36f414c1b806414e82503439ba6acf1a0c01a12d535f47e9 |
| layers/inner-circle-2.svg       | cc745af8a7e0d15b60840136d9df336366c18f06693dbdb194386b66696d6162 |
| layers/inner-circle-2-arc-2.png | 74d9fd935327cb95398d3f140b174a26e3cc1e9f8b52727a33ff976aa2ac8e79 |
| layers/inner-circle-2-arc-3.png | bfc1d0c8e1fd2144bcb9c8f9ca33dc85c3c05bbb4001dc9197bcd816004bbd4f |
| layers/inner-circle-3-arc-1.png | f7c520f0d17c96fe36f414c1b806414e82503439ba6acf1a0c01a12d535f47e9 |
| layers/inner-circle-3.svg       | aedfc78658780e12e6a07e54af7a4fea2588ecc772cde0ce3e6c88be59ac756c |
| layers/inner-circle-3-arc-2.png | 74d9fd935327cb95398d3f140b174a26e3cc1e9f8b52727a33ff976aa2ac8e79 |
| layers/inner-circle-3-arc-3.png | bfc1d0c8e1fd2144bcb9c8f9ca33dc85c3c05bbb4001dc9197bcd816004bbd4f |
| layers/inner-circle-4-arc-1.png | f7c520f0d17c96fe36f414c1b806414e82503439ba6acf1a0c01a12d535f47e9 |
| layers/inner-circle-4.svg       | ac10367f20f03609f0c24fd17d72e9d1b6c0b1f8ead11dc7bdf9b48e953dd64e |
| layers/inner-circle-4-arc-2.png | 74d9fd935327cb95398d3f140b174a26e3cc1e9f8b52727a33ff976aa2ac8e79 |
| layers/inner-circle-4-arc-3.png | bfc1d0c8e1fd2144bcb9c8f9ca33dc85c3c05bbb4001dc9197bcd816004bbd4f |
