# Spelling dictionaries

Hunspell dictionaries, read by `src/spellcheck.ts` through `hunspell-asm`
(Hunspell itself, compiled to WebAssembly). One `.aff` + `.dic` pair per
language, named by the code `LANG_MAP` in that file maps to.

Two constraints, both load-bearing:

- **UTF-8.** Hunspell reads the encoding from the `.aff`'s `SET` line, and a
  dictionary declaring anything else loses every accented word. Every pair here
  declares `SET UTF-8`.
- **The apostrophe.** Word tokens keep `'` and `’` inside them (`WORD_RE`), so a
  dictionary for a language that elides — French above all — needs an `ICONV`
  rule folding `’` to `'` before lookup, or half its vocabulary goes unfound in
  any manuscript typeset with curly apostrophes.

| Files | Language | Source | Licence |
|---|---|---|---|
| `fr_FR.*` | French | [Dictionnaires français][gram] 7.5 "classique" by Olivier R., via [`dictionary-fr`][npm-fr] 3.0.0 | MPL-2.0 |
| `en_US.*`, `en_GB.*` | English (US, UK) | Hunspell/SCOWL lineage, bundled since the first release | see the header of each `.aff` |
| `da_DK.*` | Danish | Stavekontrolden lineage, bundled since the first release | see the header of each `.aff` |
| `de_DE.*` | German | igerman98 lineage, bundled since the first release | see the header of each `.aff` |
| `es_ES.*` | Spanish | RLA/Hunspell lineage, bundled since the first release | see the header of each `.aff` |

The French pair is the one this table can speak for exactly, because it was
added with this file: `npm pack dictionary-fr`, then `index.aff` → `fr_FR.aff`
and `index.dic` → `fr_FR.dic`. The MPL requires the licence text to travel with
the files, which is what the comment block at the top of `fr_FR.aff` is — do not
strip it. The other four predate this note; their provenance is recorded only in
their own headers, which is where to look before shipping any claim about them.

Adding a language is these files plus one line in `LANG_MAP`. It is not,
however, the whole job: `mapLangToLanguageTool` (grammar), `STOPWORDS` in
`detectSettings.ts` (what language is this?), `LISTS` in `languageAnalysis.ts`
(the writing report) and `KNOWN_MANUSCRIPT_LANGS` in the interface each carry
their own list, and a language in one and not the others is a language that
half works. French is the worked example — `git log` for the commit that added
this file shows every place that had to change.

[gram]: https://grammalecte.net/
[npm-fr]: https://www.npmjs.com/package/dictionary-fr
