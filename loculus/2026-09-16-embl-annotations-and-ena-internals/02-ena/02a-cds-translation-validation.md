# Does ENA validate submitted CDS `/translation` values in `-context genome` (FLATFILE)?

Static source analysis only. No network, no webin-cli runs, no credentials.

**Question as given:** find the CDS translation check class(es) and their message keys/severities;
trace whether the check actually runs in the `-context genome` flatfile path; determine the FIX
behaviour and the decisive question — *is a WRONG `/translation` rejected, silently corrected, or
passed through?*; also cover the no-`/translation` case and the other CDS-level checks;
`ProteinIdRemovalFix`; and version skew vs the shipped jar.

**Sources**
- sequencetools clone, HEAD `d731cbc100683b17ecc4864724e92afa236b56d0` (2026-07-08) —
  `/workspaces/claude-devcontainer/scratch/sequencetools-src`. Note: the clone has **no git tags**,
  so HEAD cannot be mapped to a released version number from the repo itself.
- webin-cli 9.0.3 sources (`webin-cli/build.gradle:11` → `version = '9.0.3'`), HEAD
  `5f42e6fe841b147b0f36ed84e647131c2f89ef6a` —
  `/workspaces/claude-devcontainer/scratch/webincli-src-2026-07-25/webin-cli`
- shipped jars — `/home/vscode/.claude/jobs/96bed7ed/tmp/enaval/fat/BOOT-INF/lib/`
  (`sequencetools-2.33.2.jar`, `webin-cli-validator-2.0.7.jar`)
- `javap` was available at `/usr/lib/jvm/java-21-openjdk-arm64/bin/javap`, so §6 is verified, not guessed.

---

## Short answer

**Yes, ENA validates the submitted `/translation`, and the outcome is split three ways:**

| submitted `/translation` | outcome | key | severity |
|---|---|---|---|
| identical to conceptual | pass, no message | — | — |
| differs **only** at positions where the *submitted* residue is `X` (incl. trailing `X` runs) | **silently corrected** to the conceptual translation | `CDSTranslator-2` | **WARNING** |
| differs in any other way (wrong residue, shorter, longer with non-`X` tail) | **rejected** | `CDSTranslator-16` | **ERROR** |
| absent / empty | **generated** from the sequence, no message at all | — | — |
| CDS has `/pseudo`, `/pseudogene` or `/exception` | comparison **skipped entirely**, value passed through unchanged | — | — |

So the answer to the decisive question is **(a) rejected with an ERROR** for a genuinely wrong
translation, but **(b) silently corrected** for the `X`-only case — and "silently" is literal in
webin-cli: see §3.4.

---

## 1. The check class, message keys, texts and severities

### 1.1 Classes

- `uk/ac/ebi/embl/api/validation/check/feature/CdsFeatureTranslationCheck.java:31` — the registered
  check. It is a `FeatureValidationCheck`; `check(Feature)` at :41 instantiates a `CdsTranslator`
  (:42) and calls `translator.translate(cdsFeature, entry)` (:54-55). It does no comparison itself —
  it only relays messages (:68-71) and attaches a `TranslationReportInfo` when there is at least one
  ERROR or WARNING (:74-76).
- `uk/ac/ebi/embl/api/translation/CdsTranslator.java:45` — where the actual comparison and the
  in-place mutation of the feature happen.
- `uk/ac/ebi/embl/api/translation/Translator.java` — produces the conceptual translation and raises
  the `Translator-*` codon/partiality errors.

### 1.2 Message texts (bundle)

All texts live in
`src/main/resources/uk/ac/ebi/embl/api/validation/ValidationMessages.properties`:

```
:84  CDSTranslator-2=Expected and conceptual translations are different. Accepting the conceptual translation.
:98  CDSTranslator-16=Expected and conceptual translations are different.
:83  CDSTranslator-1=Missing exceptional translation.
:85  CDSTranslator-3=Not an exceptional translation. Consider removing exception qualifier.
:86  CDSTranslator-4=CDS locations are not within the sequence length.
:87  CDSTranslator-5=Missing sequence.
:88  CDSTranslator-6="transl_except" has a start location "{0}" outside the CDS range.
:89  CDSTranslator-7="transl_except" has an end location "{0}" outside the CDS range.
:92  CDSTranslator-10=organism classified. Submitted /transl_table "{0}" conflicts with translation table "{1}" recruited from taxonomy. ...
:99  CDSTranslator-17=Qualifier "translation_table" with value "{0}" added to the CDS feature.
:62-81 Translator-1 .. Translator-20
:104 CdsFeatureAminoAcidCheck=Invalid amino acid "{0}" in translation.
```

Fixer texts are in `.../FixerMessages.properties` (`:112-118` for the translator auto-fixes,
`:105` for `ProteinIdRemovalFix_1`).

### 1.3 Where severity is declared — **not** in a properties file

There is **no** severity table. `ValidationMessageManager`
(`src/main/java/uk/ac/ebi/embl/api/validation/ValidationMessageManager.java:22-46, 55-70`) only
resolves the *text* of a key from `ResourceBundle`s. Severity is a constructor argument at each call
site:

- `CdsTranslator.java:167` → `Severity.WARNING, "CDSTranslator-2"`
- `CdsTranslator.java:172` → `Severity.ERROR, "CDSTranslator-16"`
- `CdsTranslator.java:159` → `Severity.WARNING, "CDSTranslator-3"`
- `CdsTranslator.java:97`  → `Severity.ERROR, "CDSTranslator-1"`
- `CdsTranslator.java:106` → `Severity.ERROR, "CDSTranslator-4"`
- `CdsTranslator.java:86`  → `Severity.ERROR, "CDSTranslator-5"`
- `CdsTranslator.java:373` → `Severity.ERROR, "CDSTranslator-10"`
- `CdsTranslator.java:414` → `Severity.FIX, "CDSTranslator-17"`
- `CdsTranslator.java:181` → `Severity.FIX` for every entry in `translator.getFixes()`

For `*Check` classes the helpers do it: `check/entry/EntryValidationCheck.java:36-38`
(`reportError` → `Severity.ERROR`) and `:47-49` (`reportWarning` → `Severity.WARNING`);
`ValidationException.error()` → `ValidationMessage.error()` → `Severity.ERROR`
(`ValidationException.java:44-46`, `ValidationMessage.java:232-233`), which is what every
`ValidationException.throwError("Translator-NN")` produces.

**One severity-rewriting mechanism exists and is inert here.** `ValidationPlan.execute`
(`plan/ValidationPlan.java:136-141`) calls `demoteSeverity(validationResult, annotation.maxSeverity())`
after any annotated check. `@ExcludeScope.maxSeverity()` defaults to `Severity.ERROR`
(`annotation/ExcludeScope.java:32`) and `demoteSeverity` returns immediately for `ERROR`
(`ValidationPlan.java:155-157`). `CdsFeatureTranslationCheck` does not override `maxSeverity`, so
nothing is demoted. (Aside: `demoteSeverity` walks the *whole accumulated* `validationResult`, not
just the current check's messages — latent bug, but unreachable while `maxSeverity` stays `ERROR`.)

---

## 2. Does the check run in `-context genome` FLATFILE? — Yes

### 2.1 The path

1. `WebinCliContext.java:36-41` (webin-cli 9.0.3) maps `genome` → `SubmissionValidator.class`.
2. `submission/SubmissionValidator.java:93-99` → `mapManifestToSubmissionOptions(manifest)` then
   `validate()`; `:155` sets `options.isWebinCLI = true`; `:211` sets
   `options.context = Optional.of(Context.genome)`.
3. `SubmissionValidator.java:63` → `new SubmissionValidationPlan(options).execute()`.
4. `submission/SubmissionValidationPlan.java:90-93` → `validateFlatfile()` because
   `Context.genome` includes `FileType.FLATFILE` (`submission/Context.java:23-30`).
5. `SubmissionValidationPlan.java:246-256` → `new FlatfileFileValidationCheck(options, sharedInfo)`
   and `check.check(flatfile)`.
6. `check/file/FlatfileFileValidationCheck.java:99-121`:
   - `:99-102` sets `validationScope` to `getValidationScope(entry.getSubmitterAccession())`
   - `:103-106` sets `fileType = FileType.EMBL`
   - `:118` `validationPlan = new EmblEntryValidationPlan(getOptions().getEntryValidationPlanProperty())`
   - `:121` `ValidationResult planResult = validationPlan.execute(entry)`

### 2.2 Which `ValidationScope` genome/flatfile gets

`check/file/FileValidationCheck.java:135-165`, `case genome:`

- name in the chromosome list → `ValidationScope.ASSEMBLY_CHROMOSOME` (:146)
- name referenced by an AGP → `ValidationScope.ASSEMBLY_SCAFFOLD` (:154)
- otherwise → `ValidationScope.ASSEMBLY_CONTIG` (:156)

All three are `Group.ASSEMBLY` (`ValidationScope.java:33-39`). `ASSEMBLY_MASTER` (:33) is used only
for the master record, not for flatfile entries — `FlatfileFileValidationCheck` never returns it.

### 2.3 How checks are selected per scope — hardcoded list + runtime annotation filter

There is **no** per-scope registry file. I looked for one: `CheckFileManager`
(`check/CheckFileManager.java:13-24`) is only a resolver for the `/uk/ac/ebi/embl/api/validation/data/`
TSV path, not a check registry; `find src/main/resources -name '*check*'` returns nothing. Selection
is two-stage:

**Stage 1 — a hardcoded enum.** `plan/ValidationUnit.java`:
- `SEQUENCE_ENTRY_CHECKS(...)` at `:75-164` — contains `CdsFeatureTranslationCheck.class` at **:147**
  (and `CdsFeatureAminoAcidCheck.class` :117, `TranslExceptQualifierCheck.class` :116,
  `AntiCodonTranslationCheck.class` :142, `PeptideFeatureCheck.class` :146,
  `ProteinIdExistsCheck.class` :101, `PseudogeneValueCheck.class` :106).
- `SEQUENCE_ENTRY_FIXES(...)` at `:165-220` — contains `ProteinIdRemovalFix.class` at **:204**.

`plan/EmblEntryValidationPlan.java:37-61` loads `SEQUENCE_ENTRY_CHECKS` unconditionally (:47) and
`SEQUENCE_ENTRY_FIXES` only `if (planProperty.getOptions().isFixMode)` (:48-50), then runs
**fixes first, checks second** (:54-55). `executeChecksandFixes` (:79-108) reflectively instantiates
each class and, for a `FeatureValidationCheck`, loops over `entry.getFeatures()` (:93-105), calling
`((CdsFeatureTranslationCheck) check).setEntry(entry)` (:95-97) before `execute(check, feature)`.

**Stage 2 — runtime annotation filter.** `plan/ValidationPlan.execute(ValidationCheck, Object)`
(`:81-146`):
- `:112-113` reads `@ExcludeScope` / `@RemoteExclude`, `:114` `@GroupIncludeScope`
- `:116-118` skip if `@RemoteExclude` and `remote` (and `remote == isWebinCLI`, see
  `SubmissionOptions.java:157` `property.isRemote.set(isWebinCLI)`)
- `:119-122` skip if the current scope is listed in `@ExcludeScope.validationScope()`
- `:124-127` skip if `@GroupIncludeScope` is present and the current scope's group is not listed
- `:134` otherwise run it

**Verdict.** `CdsFeatureTranslationCheck` is annotated
`@ExcludeScope(validationScope = {ASSEMBLY_MASTER, NCBI, NCBI_MASTER})`
(`check/feature/CdsFeatureTranslationCheck.java:25-30`). `ASSEMBLY_CONTIG` /
`ASSEMBLY_SCAFFOLD` / `ASSEMBLY_CHROMOSOME` are **not** in that list, it carries no `@RemoteExclude`
and no `@GroupIncludeScope` → **the CDS translation check runs for every genome flatfile entry.**

One early-exit to note: `CdsFeatureTranslationCheck.java:49-51` requires a non-null sequence of
non-zero length, and `FlatfileFileValidationCheck.java:83-85` already `continue`s past sequenceless
genome entries.

---

## 3. FIX behaviour, and the decisive question

### 3.1 `isFixMode` / `isFixCds`

`submission/SubmissionOptions.java:56-57`:
```java
public boolean isFixMode = true;
public boolean isFixCds = true;
```

- `isFixMode` has three consumers: `plan/EmblEntryValidationPlan.java:48`,
  `plan/GenomeAssemblyValidationPlan.java:34,41,46`, `translation/CdsTranslator.java:201`.
- **`isFixCds` has NO consumers at all.** `rg -n 'isFixCds'` across the whole sequencetools tree
  returns exactly one hit — its own declaration at `SubmissionOptions.java:57`. It is dead
  configuration in HEAD, and also in the shipped jar (§6). It gates nothing.
- webin-cli 9.0.3 never touches either flag: `rg -n 'isFixCds|isFixMode|SubmissionOptions'` over
  `webin-cli/src/main/java` returns nothing but `WebinCliContext.java`'s import of
  `SubmissionValidator`. `SubmissionValidator.mapManifestToSubmissionOptions` sets `isWebinCLI = true`
  (`:155`) and never touches `isFixMode`/`isFixCds`. **Defaults hold: fix mode is ON.**

### 3.2 There is no CDS translation *fixer* class

I looked for one (`fixer/feature/`, `fixer/entry/`): there is no `CdsFeatureTranslationFix`,
no `TranslationFix`. `rg -ln 'TRANSLATION_QUALIFIER_NAME|setTranslation' src/main/java/.../fixer/`
returns nothing. **The "fix" is performed inside the CHECK**, by `CdsTranslator` mutating the
`CdsFeature` in place. This matters: the translation-acceptance branch is *not* gated by
`isFixMode` — only the Translator's partiality/pseudo auto-fixes are (`CdsTranslator.java:200-212`).

### 3.3 The decisive code

`translation/CdsTranslator.java:129-175`:

```java
129   TranslationResult translationResult = extendedTranslatorResult.getExtension();
130   String expectedTranslation = cds.getTranslation();          // the SUBMITTED /translation
131   String conceptualTranslation = translationResult.getConceptualTranslation();
133   if (extendedTranslatorResult.count(Severity.ERROR) > 0) return extendedTranslatorResult;
137-143  // apply 5'/3' partiality fixes to cds.getLocations()
145   if (translationResult.isFixedPseudo()) {
146       cds.addQualifier(... PSEUDO_QUALIFIER_NAME);
147       cds.setTranslation(null);
148   }
149   if (expectedTranslation == null || expectedTranslation.length() == 0) {
150       if (!(cds instanceof PeptideFeature))
151           cds.setTranslation(conceptualTranslation);           // GENERATE, silently
152   } else {
153       ImmutablePair<Boolean, Integer> comparisonRes =
154           translator.equalsTranslation(expectedTranslation, conceptualTranslation);
155       if (comparisonRes.left) {                                 // exact match
156           if (cds.isException())
159               ... Severity.WARNING, "CDSTranslator-3"
161       } else if (!cds.isException() && !cds.isPseudo()) {
162           if (acceptTranslation || comparisonRes.right > 0) {   // X-only mismatch
163               cds.setTranslation(conceptualTranslation);        // OVERWRITE submitter's value
167               ... Severity.WARNING, "CDSTranslator-2"
168           } else {
172               ... Severity.ERROR, "CDSTranslator-16"            // REJECT
173           }
174       }
175   }
```

`translator.equalsTranslation` (`translation/Translator.java:627-652`) returns
`ImmutablePair<Boolean equal, Integer xMismatchCount>`:

- `:629-631` submitted **shorter** than conceptual → `(false, 0)` → **ERROR**
- `:632-640` per-position: a mismatch where the *submitted* residue is `X` increments `xMismatch`;
  any other mismatch → immediate `(false, 0)` → **ERROR**
- `:642-650` trailing residues in the submitted string beyond the conceptual length: `X` counts as a
  mismatch, anything else → `(false, 0)` → **ERROR**
- `:651` returns `(xMismatch == 0, xMismatch)`

So `comparisonRes.right > 0` ⟺ *every* difference was a submitted `X`. `acceptTranslation` is a
field (`CdsTranslator.java:48`) with a public setter (`:264-266`) that **nothing in main ever
calls** — verified in both HEAD and the shipped jar (§6), so it is permanently `false`.

The upstream tests confirm the intent exactly
(`src/test/java/uk/ac/ebi/embl/api/translation/CdsTranslatorTest.java`):
- `:242-258` `testTranslationCorrection` — submitted `...AXR...` vs conceptual `...AAR...` →
  asserts `CDSTranslator-2`
- `:260-276` `testTranslationCorrectionTrailingX` — trailing `XXXXX` → asserts `CDSTranslator-2`
- `:278-294` `testTranslationCorrectionInvalid` — submitted `...ARR...` vs conceptual `...AAR...` →
  asserts `CDSTranslator-16`
- `:296-306` `testTranslationCorrectionTrailingAminoAcids` — conceptual + `GIGG` → asserts `CDSTranslator-16`

### 3.4 Why "silently" is literal in webin-cli

`CDSTranslator-2` is a WARNING, and `ValidationResult.isValid()` returns `false` only for `ERROR`
(`ValidationResult.java:190-197`). `FlatfileFileValidationCheck.java:133-138`:

```java
133   if (!planResult.isValid()) {
134       getReporter().writeToFile(getReportFile(submissionFile), planResult);
135       addMessageStats(planResult.getMessages(Severity.ERROR));
136   } else {
137       assignProteinAccessionAndWriteToFile(entry, fixedFileWriter, submissionFile, false);
138   }
```

An entry whose only messages are WARNING/FIX takes the `else` branch, so **the report file is never
written and the submitter never sees `CDSTranslator-2`**. (Same gating for parse warnings at
`:67-70`.) `SubmissionValidator.validate(Manifest)` only returns a status
(`SubmissionValidator.java:93-110`), so nothing else surfaces it.

### 3.5 …and why the in-memory correction does not reach the uploaded bytes (webin-cli side)

`FileValidationCheck.writeEntryToFile` (`:755-771`) begins:

```java
756   if (!getOptions().forceReducedFlatfileCreation
757       && (getOptions().isWebinCLI || EntryUtils.excludeDistribution(sharedInfo.assemblyType))) {
758     return;
759   }
```

Under webin-cli, `isWebinCLI == true`, so for `Context.genome` the reduced/chromosome flat file is
**not** written (the `Context.sequence` branch in `assignProteinAccessionAndWriteToFile`
(`:773-785`, `:778-780`) is the only one that writes to `fixedFileWriter`). Meanwhile
`getFixedFileWriter` (`:412-420`) still *creates* an empty `<file>.fixed`, because the fixed-file
path is always supplied — `SubmissionValidator.java:337-346` builds the FLATFILE `SubmissionFile`
with `new File(file.getFile() + SequenceEntryUtils.FIXED_FILE_SUFFIX)`.

And webin-cli uploads the **original** manifest files, not `.fixed`:
`WebinCliExecutor.java:262-271` builds `uploadFileList` from `file.getFile()`.

**Consequence:** in the CLI, the translation correction, the added `/pseudo`, the added `<`/`>`
partiality and the `/protein_id` removal are all *validation-only* mutations of the in-memory
`Entry`. The submitter's original flatfile is what is uploaded. ENA's server-side pipeline runs the
same sequencetools code with `isWebinCLI == false`, where `writeEntryToFile` proceeds and
`EmblReducedFlatFileWriter` (`flatfile/writer/embl/EmblReducedFlatFileWriter.java:41-75`, "Always
write sequence features" at :74-75) materialises the corrected feature table into the archived
record. **I could verify only the shared code path; I did not verify ENA's server-side invocation
itself — that part is inference from `isWebinCLI == false`, not observation.**

---

## 4. No `/translation` supplied, and the other CDS-level checks

### 4.1 Missing `/translation` → generated, no message

`CdsTranslator.java:149-151`. Unconditional (not gated by `isFixMode`), suppressed only for
`PeptideFeature`. No validation message of any severity is emitted for this. `CdsFeature.setTranslation`
(`entry/feature/CdsFeature.java:88-94`) writes the `/translation` qualifier; note the reader/writer
strip newlines and spaces from the value on both get and set (`:96-112`).

### 4.2 Codon-level checks — all inside `Translator`, surfaced through `CdsFeatureTranslationCheck`

Every one of these is `ValidationException.throwError(...)` → **ERROR**, unless the corresponding
fix flag is on, in which case the condition is auto-repaired and a **FIX** message is emitted
instead (`CdsTranslator.java:176-182`). Fix flags are set from `isFixMode` at
`CdsTranslator.java:200-212` — default **on**.

| condition | ERROR key | code | fix flag (fix-mode ON) | FIX message key |
|---|---|---|---|---|
| `codon_start` not in 1..3 | `Translator-2` | `Translator.java:346` | — (always ERROR) | — |
| `codon_start` != 1 and not 5' partial | `Translator-3` | `:355` | `fixCodonStartNotOneMake5Partial` (:350-353) | `fixCodonStartNotOneMake5Partial` |
| <3 bases with `codon_start` != 1 | `Translator-4` | `:365` | — | — |
| <3 bases and not partial | `Translator-10` | `:441` | — | — |
| length not a multiple of 3 | `Translator-11` | `:467` | `fixNonMultipleOfThreeMake3And5Partial` (:458-463) | same |
| single stop codon not 3 bases + 5' partial | `Translator-12` | `:520` | — | — |
| >1 trailing stop codon | `Translator-13` | `:532` | — | — |
| stop codon at a 3'-partial end | `Translator-14` | `:547` | `fixValidStopCodonRemove3Partial` (:539-542) | same |
| no stop codon, not 3' partial | `Translator-15` | `:561` | `fixNoStopCodonMake3Partial` (:556-559) | same |
| partial codon after the stop codon | `Translator-16` | `:577` | `fixDeleteTrailingBasesAfterStopCodon` — **declared but the fix body is commented out** (:569-574) | — |
| internal stop codon(s) | `Translator-17` | `:598` | `fixInternalStopCodonMakePseudo` (:591-595) → adds `/pseudo`, drops `/translation` (`CdsTranslator.java:145-148`) | same |
| translation does not start with `M` | `Translator-18` | `:619` | `fixNoStartCodonMake5Partial` (:613-616) | same |
| no sequence | `Translator-19` | `:306` | — | — |
| >50% `X` in the translation | `Translator-20` | `:219` | — | — |
| no translation possible | `Translator-1` | `:333` | — | — |

FIX texts: `FixerMessages.properties:112-118`.

### 4.3 Partial markers `<` / `>`

Not a check of their own at CDS level — they are *consumed* (`CdsTranslator.java:426-427`,
`translator.setFivePrimePartial/ setThreePrimePartial` from `CompoundLocation`) and *written back*
by the fixes above (`CdsTranslator.java:137-143`). Location sanity is checked elsewhere:
`check/feature/FeatureLocationCheck.java:30-33,55,67,73,80` (all `reportError` → ERROR;
`FeatureLocationCheck-1/-2/-3/-5`), `check/entry/EntryFeatureLocationCheck.java:29,58-59` (ERROR,
`@ExcludeScope{ASSEMBLY_MASTER, NCBI_MASTER}` at :26, so it runs for contigs/scaffolds/chromosomes),
plus the range check `CDSTranslator-4` (ERROR, `CdsTranslator.java:104-107`, via `checkLocations`
:231-244). Fixer: `fixer/feature/FeatureLocationFix.java:26-27,74-81` (FIX and ERROR).

### 4.4 `/transl_table`

`CdsTranslator.configureFromFeature` (`:271-474`):
- `:369-377` submitted `/transl_table` conflicts with the table recruited from taxonomy →
  **`CDSTranslator-10`, Severity.ERROR** (and then the *submitted* table is used anyway, :377)
- `:378-380` otherwise an INFO message `CDSTranslator-11/-12/-13/-14/-15` describing the recruitment
- `:381-395` no table at all → INFO `CDSTranslator-8`, default table
- `:406-416` if the effective table != 1 and the feature lacks `/transl_table`, one is **added** and
  **`CDSTranslator-17`, Severity.FIX** is emitted
- Taxonomy lookup is via `TaxonomyClient` (`CdsTranslator.java:281-287`) — a REST client, so this
  branch is network-dependent at runtime; I could not exercise it statically.

### 4.5 `/pseudo`, `/pseudogene`

`CdsFeature.isPseudo()` is true for either qualifier (`entry/feature/CdsFeature.java:114-117`).
`CdsTranslator.java:430` `translator.setNonTranslating(feature.isPseudo())` — a pseudo CDS produces
no conceptual translation, and `CdsTranslator.java:161` (`!cds.isPseudo()`) means **a pseudo CDS's
submitted `/translation` is never compared and never corrected — it passes through unchanged.**
Note the ordering subtlety: if fix mode just *added* `/pseudo` at :146, `cds.isPseudo()` is already
true at :161, so no `CDSTranslator-16` is raised for that entry; its `/translation` was dropped at
:147. Separate check: `check/feature/PseudogeneValueCheck.java:25,51` (ERROR;
`@ExcludeScope{NCBI, NCBI_MASTER}` → runs for genome). I found **no** exclusivity rule barring
`/translation` alongside `/pseudo` in `data/exclusive-qualifiers*.tsv`.

### 4.6 `/exception`

- `CdsTranslator.java:92-98` — `/exception` present but no `/translation` → **`CDSTranslator-1`, ERROR**
- `CdsTranslator.java:155-160` — translations match *and* `/exception` present →
  **`CDSTranslator-3`, WARNING** ("Consider removing exception qualifier")
- `CdsTranslator.java:161` — `/exception` present and translations differ → comparison skipped,
  submitted value kept
- `CdsTranslator.java:432` `translator.setException(feature.isException())` — suppresses most
  codon-level errors inside `Translator` (`:512-513`, `:526`, `:588`)

### 4.7 `/transl_except`

`check/feature/TranslExceptQualifierCheck.java:28-35` message IDs
`TranslExceptQualifierCheck_1.._6`; `:70,82,86,90,95` `reportError` (ERROR) and `:74-76`
`reportWarning` (WARNING, amino acid does not match). Registered at `ValidationUnit.java:116`.
Fixer `Transl_exceptLocationFix` at `ValidationUnit.java:203`. Range mapping errors
`CDSTranslator-6` / `CDSTranslator-7` (ERROR) at `CdsTranslator.java:452-459`. In-frame/span errors
`Translator-6..-9` at `Translator.java:388-415`.

### 4.8 Amino acid alphabet

`check/feature/CdsFeatureAminoAcidCheck.java:19-44` — **ERROR** (`reportError` :38) for any residue
the `AminoAcidFactory` does not know, or for a literal `*`. It has **no** `@ExcludeScope`, so it runs
in every scope, and it is *also* invoked directly from inside the translator whenever a
`/translation` is present (`CdsTranslator.java:78-82`), before anything else. Registered
independently at `ValidationUnit.java:117`. The `/translation` qualifier itself has **no** regex
constraint: `data/feature-qualifier-values.tsv:101` has `REGEX = (null)`.

### 4.9 `/protein_id`

`check/entry/ProteinIdExistsCheck.java` (ERROR, `ProteinIdExistsCheck_1`, `:60`) is effectively
**dead in webin-cli**: `:49-51` returns early when
`getEmblEntryValidationPlanProperty().analysis_id.get() == null`, and `analysis_id` is only set from
`options.analysisId` (`SubmissionOptions.java:152`), which `SubmissionValidator`'s manifest mapping
never populates (`SubmissionOptions.java:117-118` in fact *requires* `analysisId` only when
`!isWebinCLI`). Also, fixes run before checks, so `ProteinIdRemovalFix` has already stripped the
qualifier by then (§5).

---

## 5. `ProteinIdRemovalFix`

**Location:** `src/main/java/uk/ac/ebi/embl/api/validation/fixer/entry/ProteinIdRemovalFix.java`
(note: `fixer/**entry**/`, not `fixer/feature/`).

- **Registered** at `plan/ValidationUnit.java:204`, in `SEQUENCE_ENTRY_FIXES`.
- **When it fires:** whenever `isFixMode` is true (`EmblEntryValidationPlan.java:48-50` — default
  true, and webin-cli never overrides it) and the scope is not one of
  `{ASSEMBLY_MASTER, NCBI, NCBI_MASTER}` (`ProteinIdRemovalFix.java:26-31`). For `-context genome`
  flatfile the scope is `ASSEMBLY_CONTIG`/`_SCAFFOLD`/`_CHROMOSOME`, so **it always fires**, and it
  fires in the *fix* pass, i.e. **before** any check runs (`EmblEntryValidationPlan.java:54-55`).
- **What it removes:** every `/protein_id` qualifier on **every feature** of the entry — it is an
  `EntryValidationCheck` looping `entry.getFeatures()` (`:45-54`), not CDS-specific.
- **Severity / message:** `Severity.FIX`, key `ProteinIdRemovalFix_1` (`:50-51`, constant at `:34`).
  Text at `FixerMessages.properties:105`:
  `protein_id "{0}" has been deleted for feature "{1}", as protein_ids can only be assigned by EMBL.`
- **Visibility:** as in §3.4, a FIX-only entry keeps `planResult.isValid() == true`, so the message
  is not written to the report file in webin-cli.
- Accession assignment is the counterpart and is also a no-op in the CLI:
  `FileValidationCheck.assignProteinAccession` (`:985-991`) returns immediately when
  `isRemote` (== `isWebinCLI`).

---

## 6. Version skew: HEAD clone vs shipped `sequencetools-2.33.2.jar`

`javap` (JDK 21, `/usr/lib/jvm/java-21-openjdk-arm64/bin/javap`) was available; everything below is
verified against the jar, not assumed. **For every class cited in this report the shipped 2.33.2 has
the same shape and the same semantics.**

- **`ValidationMessages.properties` — byte-identical** to HEAD after stripping CR
  (`diff` clean). `CDSTranslator-2` at line 84, `CDSTranslator-16` at line 98 in both.
- **`FixerMessages.properties` — 2 keys newer in HEAD** (`SerotypeQualifierDeleted`,
  `MacronuclearQualifierFix_1`) plus a trailing-newline difference. None of the keys this report
  cites differ.
- **`CdsTranslator`** — `javap -c` confirms the exact decision structure:
  `isException` → `ifne`; `isPseudo` → `ifne`; `getfield acceptTranslation` → `ifne`;
  `ImmutablePair.right → Integer.intValue → ifle`; then
  `setTranslation` + `getstatic Severity.WARNING` + `ldc "CDSTranslator-2"`, else
  `getstatic Severity.ERROR` + `ldc "CDSTranslator-16"` (bytecode offsets 536-623). Also
  `getfield SubmissionOptions.isFixMode` at offset 18 of `createTranslator`.
- **`Translator`** — all eight fix flags present (`fixDegenerateStartCodon`,
  `fixNoStartCodonMake5Partial`, `fixCodonStartNotOneMake5Partial`, `fixNoStopCodonMake3Partial`,
  `fixValidStopCodonRemove3Partial`, `fixNonMultipleOfThreeMake3And5Partial`,
  `fixInternalStopCodonMakePseudo`, `fixDeleteTrailingBasesAfterStopCodon`) and
  `ImmutablePair<Boolean,Integer> equalsTranslation(String, String)`.
- **`CdsFeatureTranslationCheck`** — `javap -v` shows the identical annotation:
  `@Description("Runs the translator and returns results")` and
  `@ExcludeScope(validationScope=[ASSEMBLY_MASTER, NCBI, NCBI_MASTER])`.
- **`ProteinIdRemovalFix`** — `ldc "protein_id"`, `Feature.removeQualifier`,
  `getstatic Severity.FIX`, `ldc "ProteinIdRemovalFix_1"`, `reportMessage`. Identical.
- **`SubmissionOptions`** — `public boolean isFixMode; public boolean isFixCds;
  public boolean ignoreErrors; public boolean isWebinCLI;` all present.
- **`FileValidationCheck.writeEntryToFile`** — the `forceReducedFlatfileCreation` /
  `isWebinCLI` / `excludeDistribution` early return is present verbatim in 2.33.2 bytecode.
- **`ValidationUnit`** — I extracted every `class …` constant-pool reference from the jar's
  `<clinit>` and compared with HEAD's source: the **only** difference is `MacronuclearQualifierFix`
  (present twice in HEAD, absent from 2.33.2) — consistent with the new `MacronuclearQualifierFix_1`
  key in HEAD's `FixerMessages.properties`. `CdsFeatureTranslationCheck` and `ProteinIdRemovalFix`
  are both present in the jar's list.
- **`isFixCds` is dead in the shipped jar too.** A binary scan of the extracted 2.33.2 +
  webin-cli-validator-2.0.7 class files finds the string `isFixCds` in exactly one class file
  (`SubmissionOptions.class`, the declaration) and `setAcceptTranslation` in exactly one
  (`CdsTranslator.class`, its own declaration). No callers anywhere.

**Skew summary:** HEAD `d731cbc` is slightly *ahead* of the shipped 2.33.2 (one extra fixer,
`MacronuclearQualifierFix`, and two extra fixer message keys). Nothing cited here differs.
The clone carries no tags, so I cannot state the exact commit distance.

---

## 7. Things I could NOT verify statically, and loose ends

- **Server-side behaviour at ENA.** I verified only the code that webin-cli runs
  (`isWebinCLI == true`). The claim that the corrected feature table is what ends up in the archived
  record rests on the same classes running with `isWebinCLI == false` (`writeEntryToFile`
  proceeding into `EmblReducedFlatFileWriter`). That is inference from the code, **not** observation.
- **Taxonomy-dependent branches.** `CDSTranslator-10` (conflicting `/transl_table`) and the
  `CDSTranslator-11..-15` INFO recruitment messages depend on live `TaxonomyClient` REST lookups
  (`CdsTranslator.java:281-287`). Not exercised.
- **Whether webin-cli surfaces WARNING/FIX anywhere else.** I traced the report-file path
  (`FlatfileFileValidationCheck.java:133-138`) and `SubmissionValidator.validate(Manifest)`
  (`:93-110`) and found none. I did not exhaustively audit every webin-cli console-output path.
- **Apparent message-key bug (unverified as intentional).** `Translator.java:384-387` throws
  `"Translator-4"` for the case its own comment describes as "Translation exception outside frame on
  the 5' end". `Translator-5` ("Translation exception feature outside frame on the 5' end.",
  `ValidationMessages.properties:66`) is defined but **never emitted** — `rg` finds no
  `"Translator-5"` anywhere in `src/main`. So that case reports the text of `Translator-4`
  ("Protein coding feature with fewer than 3 bases must have start codon 1."), which is wrong.
- **`fixDeleteTrailingBasesAfterStopCodon` is a no-op.** The flag exists and `Translator.java:569`
  branches on it, but the body is commented out (`:570-574`), so setting it would silently swallow
  `Translator-16` rather than fix anything. It is not enabled by `isFixMode` anyway
  (`CdsTranslator.java:204` is itself commented out).
- **`demoteSeverity` scope bug** (`ValidationPlan.java:136-141` + `:154-168`) — operates on the
  whole accumulated result, not the current check's messages. Unreachable while every
  `maxSeverity()` stays at the `ERROR` default, but it would misfire if any check ever set a lower
  `maxSeverity`.
- **Empty `.fixed` file.** `getFixedFileWriter` (`FileValidationCheck.java:412-420`) creates
  `<flatfile>.fixed` for genome submissions and then nothing is ever written to it, because
  `writeEntryToFile` returns early. Cosmetic, but it is a real artefact left in the submitter's
  directory.
