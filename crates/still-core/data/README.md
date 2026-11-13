# Word list for passphrases

`eff_large_wordlist.txt` is the Electronic Frontier Foundation's long word list for passphrases, exactly as published at <https://www.eff.org/files/2016/07/18/eff_large_wordlist.txt> (downloaded 2026-11-12; described at <https://www.eff.org/dice>). It holds 7,776 short, distinct English words, one per line after its five-dice number.

- SHA-256: `addd35536511597a02fa0a9ff1e5284677b8883b83e986e43f15a3db996b903e`, checked by a test in `src/generate.rs`.
- Licence: [Creative Commons Attribution 3.0 United States](https://creativecommons.org/licenses/by/3.0/us/), © the Electronic Frontier Foundation. Still uses it unchanged, and leaves out its four hyphenated words (`drop-down`, `felt-tip`, `t-shirt`, `yo-yo`) in code, so a phrase joined with hyphens splits back into its words.

It's compiled into the app; nothing is downloaded at runtime. **Never edit this file.** To change the list, replace it whole from its source and update the pinned hash.
