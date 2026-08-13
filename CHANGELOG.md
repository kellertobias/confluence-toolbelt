## <small>2.10.1 (2026-08-11)</small>

* fix(obsidian): render Confluence constructs and stop spurious merge conflicts ([d10ef07](https://github.com/kellertobias/confluence-toolbelt/commit/d10ef07))

## 2.10.0 (2026-07-02)

* feat(storage-dom): round-trip markdown footnotes ([9d9e55a](https://github.com/kellertobias/confluence-toolbelt/commit/9d9e55a))

## 2.9.0 (2026-07-02)

* feat(core): add mkdir/remove to the FileSystem port ([a217206](https://github.com/kellertobias/confluence-toolbelt/commit/a217206))
* feat(plugin): download attachments into an attachments/ subfolder ([014b314](https://github.com/kellertobias/confluence-toolbelt/commit/014b314))

## <small>2.8.2 (2026-07-01)</small>

* Merge branch 'main' of github-personal:kellertobias/confluence-toolbelt ([59096dc](https://github.com/kellertobias/confluence-toolbelt/commit/59096dc))
* fix: send a default User-Agent on Obsidian plugin requests ([48e802a](https://github.com/kellertobias/confluence-toolbelt/commit/48e802a))

## <small>2.8.1 (2026-07-01)</small>

* Merge branch 'main' of github-personal:kellertobias/confluence-toolbelt ([1bf24db](https://github.com/kellertobias/confluence-toolbelt/commit/1bf24db))
* fix: upload error ([cf77921](https://github.com/kellertobias/confluence-toolbelt/commit/cf77921))

## 2.8.0 (2026-07-01)

* fix: resolve obsidian/@codemirror peer conflict blocking release CI ([4cd0dbc](https://github.com/kellertobias/confluence-toolbelt/commit/4cd0dbc))
* fix: strip comment thread tags on upload to stop round-trip duplication ([e0b7ea1](https://github.com/kellertobias/confluence-toolbelt/commit/e0b7ea1))
* Merge branch 'main' of github-personal:kellertobias/confluence-toolbelt ([31568a9](https://github.com/kellertobias/confluence-toolbelt/commit/31568a9))
* feat: Obsidian Plugin ([976985c](https://github.com/kellertobias/confluence-toolbelt/commit/976985c))
* feat: Obsidian plugin — round-trip Confluence sync with change-bar gutter ([f2a494f](https://github.com/kellertobias/confluence-toolbelt/commit/f2a494f))

## <small>2.7.1 (2026-06-25)</small>

* fix: re-upload edited images referenced as #filename after a round-trip ([77e37af](https://github.com/kellertobias/confluence-toolbelt/commit/77e37af)), closes [#filename](https://github.com/kellertobias/confluence-toolbelt/issues/filename) [#filename](https://github.com/kellertobias/confluence-toolbelt/issues/filename)

## 2.7.0 (2026-06-24)

* feat: skip re-uploading unchanged images via content-hash cache ([597d0ca](https://github.com/kellertobias/confluence-toolbelt/commit/597d0ca))

## 2.6.0 (2026-06-24)

* chore: add .DS_Store to gitignore ([072c026](https://github.com/kellertobias/confluence-toolbelt/commit/072c026))
* feat: upload local images as page attachments ([ca9cf8d](https://github.com/kellertobias/confluence-toolbelt/commit/ca9cf8d)), closes [#filename](https://github.com/kellertobias/confluence-toolbelt/issues/filename)

## 2.5.0 (2026-04-29)

* feat: allow explicit closing tags for toc macros ([0f8f4f0](https://github.com/kellertobias/confluence-toolbelt/commit/0f8f4f0))

## <small>2.4.1 (2026-04-29)</small>

* fix: preserve blank lines as paragraph breaks in table cells ([6972cbe](https://github.com/kellertobias/confluence-toolbelt/commit/6972cbe))

## 2.4.0 (2026-04-28)

* feat: list to table feature ([469615a](https://github.com/kellertobias/confluence-toolbelt/commit/469615a))

## <small>2.3.1 (2026-04-23)</small>

* fix(links): use ri:content-entity for pageid:SPACE:ID links ([801598b](https://github.com/kellertobias/confluence-toolbelt/commit/801598b))

## 2.3.0 (2026-04-23)

* feat(download): improve inline comment handling ([1384095](https://github.com/kellertobias/confluence-toolbelt/commit/1384095))

## 2.2.0 (2026-04-23)

* feat(confluence-links): improve page link conversion with space keys ([959c47a](https://github.com/kellertobias/confluence-toolbelt/commit/959c47a))
* feat(jira): support round-trip of jira issue macro ([49ede32](https://github.com/kellertobias/confluence-toolbelt/commit/49ede32))

## <small>2.1.1 (2026-04-23)</small>

* fix: deflists ([164ff4f](https://github.com/kellertobias/confluence-toolbelt/commit/164ff4f))

## 2.1.0 (2026-04-23)

* feat: link shortening & search ([aed6afe](https://github.com/kellertobias/confluence-toolbelt/commit/aed6afe))

## 2.0.0 (2026-04-23)

* fix: improve visibility in cli ([6a2b4c9](https://github.com/kellertobias/confluence-toolbelt/commit/6a2b4c9))
* feat: add sync cli entrypoint ([883409c](https://github.com/kellertobias/confluence-toolbelt/commit/883409c))
* feat!: sync feature ([ab7d704](https://github.com/kellertobias/confluence-toolbelt/commit/ab7d704))


### BREAKING CHANGE

* This adds a new sidecar. Before you use sync, you must
download your files again

## 1.15.0 (2026-04-23)

* fix: infinite loop on misformed lists ([3ae942a](https://github.com/kellertobias/confluence-toolbelt/commit/3ae942a))
* feat: add debug feature ([d19c86c](https://github.com/kellertobias/confluence-toolbelt/commit/d19c86c))

## 1.14.0 (2026-04-22)

* feat: normalize unicode dashes to ascii hyphen on upload ([12131b5](https://github.com/kellertobias/confluence-toolbelt/commit/12131b5))
* fix: improve markdown escaping for dashes and em delimiters ([d23633b](https://github.com/kellertobias/confluence-toolbelt/commit/d23633b))

## 1.13.0 (2026-04-22)

* feat: enhance comment retrieval and threading ([b7a128d](https://github.com/kellertobias/confluence-toolbelt/commit/b7a128d))

## 1.12.0 (2026-04-21)

* feat: comment text download ([427c04d](https://github.com/kellertobias/confluence-toolbelt/commit/427c04d))

## 1.11.0 (2026-04-20)

* Merge branch 'main' of https://github.com/kellertobias/confluence-toolbelt ([2724c45](https://github.com/kellertobias/confluence-toolbelt/commit/2724c45))
* feat(markdown): add support for definition lists in markdown conversion ([23b4624](https://github.com/kellertobias/confluence-toolbelt/commit/23b4624))

## <small>1.10.2 (2026-04-20)</small>

* Merge branch 'main' of https://github.com/kellertobias/confluence-toolbelt ([dafc2d3](https://github.com/kellertobias/confluence-toolbelt/commit/dafc2d3))
* fix: italics text ([c05bf34](https://github.com/kellertobias/confluence-toolbelt/commit/c05bf34))

## <small>1.10.1 (2026-04-17)</small>

* fix(storage-dom): refactor storage-dom into modular structure ([6ad16ba](https://github.com/kellertobias/confluence-toolbelt/commit/6ad16ba))
* chore: improve code readability with minor formatting changes ([315ac36](https://github.com/kellertobias/confluence-toolbelt/commit/315ac36))

## 1.10.0 (2026-04-17)

* feat(confluence): add page creation commands for siblings and children ([bfea420](https://github.com/kellertobias/confluence-toolbelt/commit/bfea420))

## 1.9.0 (2026-04-17)

* feat(markdown): add requirement list support for upload and download ([cdf7c83](https://github.com/kellertobias/confluence-toolbelt/commit/cdf7c83))

## 1.8.0 (2026-04-16)

* fix: improve nested markdown list detection with blank lines ([4cbb40d](https://github.com/kellertobias/confluence-toolbelt/commit/4cbb40d))
* feat: handle nreq rejected requirement rows in storage ([899c0a6](https://github.com/kellertobias/confluence-toolbelt/commit/899c0a6))
* feat: improve markdown conversion accuracy in storage-dom tests ([576bc0d](https://github.com/kellertobias/confluence-toolbelt/commit/576bc0d))

## 1.7.0 (2026-04-16)

* feat(markdown-import): improve nested list handling for markdown ([5240fd8](https://github.com/kellertobias/confluence-toolbelt/commit/5240fd8))

## <small>1.6.1 (2026-04-15)</small>

* Merge branch 'main' of https://github.com/kellertobias/confluence-toolbelt ([64cc26b](https://github.com/kellertobias/confluence-toolbelt/commit/64cc26b))
* fix: mermaid download ([fec8ec6](https://github.com/kellertobias/confluence-toolbelt/commit/fec8ec6))

## 1.6.0 (2026-04-15)

* Merge branch 'main' of https://github.com/kellertobias/confluence-toolbelt ([7271bc1](https://github.com/kellertobias/confluence-toolbelt/commit/7271bc1))
* feat: enhance table width and column configuration support ([3bbbb22](https://github.com/kellertobias/confluence-toolbelt/commit/3bbbb22))

## 1.5.0 (2026-04-15)

* Merge branch 'main' of https://github.com/kellertobias/confluence-toolbelt ([c033745](https://github.com/kellertobias/confluence-toolbelt/commit/c033745))
* feat: enhance table handling in markdown ([a4c05cf](https://github.com/kellertobias/confluence-toolbelt/commit/a4c05cf))

## 1.4.0 (2026-04-15)

* Merge branch 'main' of https://github.com/kellertobias/confluence-toolbelt ([a231e97](https://github.com/kellertobias/confluence-toolbelt/commit/a231e97))
* feat: add support for Mermaid diagrams in markdown ([4af6e18](https://github.com/kellertobias/confluence-toolbelt/commit/4af6e18))

## 1.3.0 (2026-04-14)

* Merge branch 'main' of https://github.com/kellertobias/confluence-toolbelt ([f10b15d](https://github.com/kellertobias/confluence-toolbelt/commit/f10b15d))
* feat: implement local markdown link resolution to Confluence page IDs ([9667c60](https://github.com/kellertobias/confluence-toolbelt/commit/9667c60))

## <small>1.2.5 (2026-04-14)</small>

* fix: release ([83695d5](https://github.com/kellertobias/confluence-toolbelt/commit/83695d5))
* chore: refine semantic-release configuration and GitHub Actions ([0cb2dc5](https://github.com/kellertobias/confluence-toolbelt/commit/0cb2dc5))
* chore: update GitHub Actions workflow to include build step ([85bfe76](https://github.com/kellertobias/confluence-toolbelt/commit/85bfe76))
* Merge branch 'main' of https://github.com/kellertobias/confluence-toolbelt ([f21943c](https://github.com/kellertobias/confluence-toolbelt/commit/f21943c))

## <small>1.2.4 (2026-04-14)</small>

* chore: enhance semantic-release configuration ([6196134](https://github.com/kellertobias/confluence-toolbelt/commit/6196134))
* chore: update semantic-release configuration and GitHub Actions ([c9830ef](https://github.com/kellertobias/confluence-toolbelt/commit/c9830ef))
* fix: lint ([77ad07f](https://github.com/kellertobias/confluence-toolbelt/commit/77ad07f))
* fix: numbered lists ([e2cd2f3](https://github.com/kellertobias/confluence-toolbelt/commit/e2cd2f3))
* fix: semantic release direct npm push ([359824e](https://github.com/kellertobias/confluence-toolbelt/commit/359824e))
* Merge branch 'main' of https://github.com/kellertobias/confluence-toolbelt ([738ec12](https://github.com/kellertobias/confluence-toolbelt/commit/738ec12))

## <small>1.2.3 (2025-10-29)</small>

* fix: update readme for final release version ([4b18929](https://github.com/kellertobias/confluence-toolbelt/commit/4b18929))

## <small>1.2.2 (2025-10-29)</small>

* Merge branch 'main' of https://github.com/kellertobias/confluence-toolbelt ([e995b9d](https://github.com/kellertobias/confluence-toolbelt/commit/e995b9d))
* fix: enhance initialization process to commit .gitignore ([9c55c08](https://github.com/kellertobias/confluence-toolbelt/commit/9c55c08))

## <small>1.2.1 (2025-10-29)</small>

* Merge branch 'main' of https://github.com/kellertobias/confluence-toolbelt ([37acd7e](https://github.com/kellertobias/confluence-toolbelt/commit/37acd7e))
* fix: is now able to correctly parse smart links ([8f3bbb3](https://github.com/kellertobias/confluence-toolbelt/commit/8f3bbb3))

## 1.2.0 (2025-10-29)

* feat: add NO_AUTO_COMMIT option to disable automatic git commits ([489d8b6](https://github.com/kellertobias/confluence-toolbelt/commit/489d8b6))
* Merge branch 'main' of https://github.com/kellertobias/confluence-toolbelt ([386cb71](https://github.com/kellertobias/confluence-toolbelt/commit/386cb71))
* chore: swap npm and exec plugins in semantic release configuration ([3d531ed](https://github.com/kellertobias/confluence-toolbelt/commit/3d531ed))

## 1.1.0 (2025-10-29)

* feat: enhance download functionality and README updates ([6bbf24c](https://github.com/kellertobias/confluence-toolbelt/commit/6bbf24c))
* feat: enhance README and CLI with new download and upload features ([6072bac](https://github.com/kellertobias/confluence-toolbelt/commit/6072bac))
* chore: update semantic release configuration in .releaserc.json ([e9b6b12](https://github.com/kellertobias/confluence-toolbelt/commit/e9b6b12))

## 1.0.0 (2025-10-29)

* fix: don't do unnecessary escapes and newlines ([2d638c0](https://github.com/kellertobias/confluence-toolbelt/commit/2d638c0))
* fix: remove npm release for now and fix github release first ([95b7073](https://github.com/kellertobias/confluence-toolbelt/commit/95b7073))
* chore: add repository URL to .releaserc.json for better project visibility ([c4c5470](https://github.com/kellertobias/confluence-toolbelt/commit/c4c5470))
* chore: enhance package.json with additional metadata ([fd9b1fa](https://github.com/kellertobias/confluence-toolbelt/commit/fd9b1fa))
* chore: update package version and enhance documentation ([a005ef1](https://github.com/kellertobias/confluence-toolbelt/commit/a005ef1))
* feat: order files in upload selection to be newest first ([c1559dd](https://github.com/kellertobias/confluence-toolbelt/commit/c1559dd))
* feat: release (BREAKING) ([2dc872b](https://github.com/kellertobias/confluence-toolbelt/commit/2dc872b))
* feat: update cli ([62f1ddc](https://github.com/kellertobias/confluence-toolbelt/commit/62f1ddc))
* .. ([503ab04](https://github.com/kellertobias/confluence-toolbelt/commit/503ab04))
* ... ([5a82170](https://github.com/kellertobias/confluence-toolbelt/commit/5a82170))
* Add configuration files for semantic release and initialize environment setup ([e8af1c4](https://github.com/kellertobias/confluence-toolbelt/commit/e8af1c4))
* Add initial project structure with Confluence CLI tools and documentation ([cea33fe](https://github.com/kellertobias/confluence-toolbelt/commit/cea33fe))
* Add Jira task creation command and update README.md ([8c1d988](https://github.com/kellertobias/confluence-toolbelt/commit/8c1d988))
* Add new task script and enhance markdown processing ([2158da6](https://github.com/kellertobias/confluence-toolbelt/commit/2158da6))
* Add NPM token inspection step to GitHub Actions workflow ([954e2c5](https://github.com/kellertobias/confluence-toolbelt/commit/954e2c5))
* Enhance Confluence CLI and markdown processing ([e9e0e7d](https://github.com/kellertobias/confluence-toolbelt/commit/e9e0e7d))
* Enhance markdown conversion in storage DOM ([1bc350e](https://github.com/kellertobias/confluence-toolbelt/commit/1bc350e))
* Enhance markdown processing in storage DOM ([b9f223b](https://github.com/kellertobias/confluence-toolbelt/commit/b9f223b))
* Enhance README.md and Confluence tools with header extraction features ([31c27c4](https://github.com/kellertobias/confluence-toolbelt/commit/31c27c4))
* initial ([258666e](https://github.com/kellertobias/confluence-toolbelt/commit/258666e))
* Refactor markdown processing and update dependencies ([75f8531](https://github.com/kellertobias/confluence-toolbelt/commit/75f8531))
* Refactor semantic release configuration in .releaserc.json ([91a7859](https://github.com/kellertobias/confluence-toolbelt/commit/91a7859))
* Remove obsolete configuration and script files related to Confluence sync ([a6ff303](https://github.com/kellertobias/confluence-toolbelt/commit/a6ff303))
* Remove obsolete README.md file from documentation directory ([372ca93](https://github.com/kellertobias/confluence-toolbelt/commit/372ca93))
* Update GitHub Actions workflow for semantic release ([837f705](https://github.com/kellertobias/confluence-toolbelt/commit/837f705))
* Update GitHub Actions workflow for semantic release ([c4faf91](https://github.com/kellertobias/confluence-toolbelt/commit/c4faf91))
* Update package configuration and dependencies for @tobisk/confluence-tools ([8caecb3](https://github.com/kellertobias/confluence-toolbelt/commit/8caecb3))
* Update package version and add repository information ([28eda1b](https://github.com/kellertobias/confluence-toolbelt/commit/28eda1b))
* Update README.md to clarify markdown features and comment handling ([e929032](https://github.com/kellertobias/confluence-toolbelt/commit/e929032))
