# webin-cli `-context` values: a complete, honest comparison

Static source analysis only — no network, no webin-cli runs, no credentials.

**Question I was given:** enumerate *all* webin-cli `-context` values; for each, tabulate the
FLATFILE reader format, whether the submitted source feature survives, the required/optional
manifest fields and accepted FILE types, the accession class returned, whether a CHROMOSOME_LIST
is accepted/required, and the checklist/template requirements. Then answer the decisive question:
is switching Pathoplexus/Loculus viral genome assemblies from `-context genome` + FLATFILE +
CHROMOSOME_LIST to `-context sequence` (to preserve the flatfile's own source feature) realistic,
or the wrong tool?

**Sources**

- webin-cli 9.0.3: `/workspaces/claude-devcontainer/scratch/webincli-src-2026-07-25`
  (`webin-cli/`, `webin-cli-validator/`, `readtools/`, `jars/`)
- sequencetools (git clone, HEAD d731cbc): `/workspaces/claude-devcontainer/scratch/sequencetools-src`
- ENA docs (local copy): `/workspaces/claude-devcontainer/scratch/ena-docs-reference` — exists,
  contains `read_docs/` (the readthedocs source) and a `webin-cli/` tree.

Paths below are relative to those two roots.

---

## 1. The complete context list

`webin-cli/src/main/java/uk/ac/ebi/ena/webin/cli/WebinCliContext.java:35-71` defines **six**
contexts. Every context is user-selectable: picocli renders the enum directly as the `-context`
completion candidates (`WebinCliCommand.java:36-41`, description at `:184`
`"Submission type: ${COMPLETION-CANDIDATES}"`), so `polysample` is not hidden.

| `-context` | Manifest class | Manifest reader | XML writer | Validator | Title prefix | ANALYSIS_TYPE element produced |
|---|---|---|---|---|---|---|
| `genome` | `GenomeManifest` | `GenomeManifestReader` | `GenomeXmlWriter` | `SubmissionValidator` (sequencetools) | "Genome assembly" | `<SEQUENCE_ASSEMBLY>` — `GenomeXmlWriter.java:31` |
| `transcriptome` | `TranscriptomeManifest` | `TranscriptomeManifestReader` | `TranscriptomeXmlWriter` | `SubmissionValidator` | "Transcriptome assembly" | `<TRANSCRIPTOME_ASSEMBLY>` — `TranscriptomeXmlWriter.java:31` |
| `sequence` | `SequenceManifest` | `SequenceManifestReader` | `SequenceXmlWriter` | `SubmissionValidator` | "Sequence assembly" | `<SEQUENCE_FLATFILE>` — `SequenceXmlWriter.java:31` |
| `polysample` | `PolySampleManifest` | `PolySampleManifestReader` | `PolySampleXmlWriter` | `SubmissionValidator` | "Polysample" | `<ENVIRONMENTAL_SEQUENCE_SET>` — `PolySampleXmlWriter.java:34` |
| `reads` | `ReadsManifest` | `ReadsManifestReader` | `ReadsXmlWriter` | `ReadsValidator` (readtools) | "Raw reads" | *none* — emits `EXPERIMENT` + `RUN` XML instead (`ReadsXmlWriter.java:43-51`) |
| `taxrefset` | `TaxRefSetManifest` | `TaxRefSetManifestReader` | `TaxRefSetXmlWriter` | `TxmbValidator` | "Taxonomy reference set" | `<TAXONOMIC_REFERENCE_SET>` — `TaxRefSetXmlWriter.java:30` |

Note the title prefix for `sequence` is literally `"Sequence assembly"`
(`WebinCliContext.java:53`) — a misleading label; the ENA docs call this route "targeted
sequences" and explicitly say it is *not* for assemblies.

All non-reads contexts share `SequenceToolsXmlWriter.createXml`
(`webin-cli/.../context/SequenceToolsXmlWriter.java:41-102`), which always emits a single
`<ANALYSIS>` with `STUDY_REF`, an optional `SAMPLE_REF` (only when
`manifest.getSample() != null && getBioSampleId() != null`, lines 68-74), `RUN_REF`/`ANALYSIS_REF`,
one `ANALYSIS_TYPE` child and a `FILES` block. The submission bundle's XML file types are
`SUBMISSION, ANALYSIS, RUN, EXPERIMENT` (`submit/SubmissionBundle.java:36-41`).

### sequencetools has its *own*, different `Context` enum

`src/main/java/uk/ac/ebi/embl/api/validation/submission/Context.java:17-30`:

```java
sequence(FileType.FLATFILE, FileType.TSV),
polysample_fasta_sample(FileType.FASTA, FileType.SAMPLE_TSV),
polysample_full(FileType.FASTA, FileType.SAMPLE_TSV, FileType.TAX_TSV),
polysample_tax(FileType.TAX_TSV),
transcriptome(FileType.FASTA, FileType.FLATFILE, FileType.MASTER),
genome(FileType.FASTA, FileType.FLATFILE, FileType.AGP, FileType.CHROMOSOME_LIST,
       FileType.UNLOCALISED_LIST, FileType.MASTER, FileType.ANNOTATION_ONLY_FLATFILE);
```

Six values, but they do **not** map 1:1 onto webin-cli's six: sequencetools knows nothing about
`reads` or `taxrefset` (different validators entirely), and it splits `polysample` into three
sub-contexts chosen at runtime from which files are present
(`SubmissionValidator.java:244-278`, `getPolySampleContext`).

The webin-cli → sequencetools mapping is `SubmissionValidator.mapManifestToSubmissionOptions`
(`SubmissionValidator.java:112-242`): `GenomeManifest → Context.genome` (`:211`),
`TranscriptomeManifest → Context.transcriptome` (`:215`), `PolySampleManifest → polysample_*`
(`:221`), and an unconditional `else → Context.sequence` (`:224`). That `else` is a fall-through,
not a type test — so any future manifest type that isn't genome/transcriptome/polysample silently
becomes `sequence`.

**This `getFileTypes()` list is the master switch for the whole validation plan.**
`SubmissionValidationPlan.execute()` (`submission/SubmissionValidationPlan.java:51-138`) gates every
stage on `options.context.get().getFileTypes().contains(...)`:

- `:60` `contains(MASTER)` → `createMaster()`
- `:61-62` `contains(CHROMOSOME_LIST)` → `validateChromosomeList()`
- `:63-64` `contains(UNLOCALISED_LIST)` → `validateUnlocalisedList()`
- `:65-75` `contains(AGP)` → AGP contig DB
- `:76-81` `contains(ANNOTATION_ONLY_FLATFILE)` → annotation-only path
- `:82-88` `contains(FASTA)` → `validateFasta()` (polysample excluded)
- `:90-93` `contains(FLATFILE)` → `validateFlatfile()`
- `:99-111` `contains(TSV|SAMPLE_TSV|TAX_TSV)` → `validateTsvfile()`
- `:115-135` `Context.genome` only → `registerSequences()`, COVID-19 genome-size check,
  sequenceless-chromosome check, unlocalised object names, assembly sequence-count check

Because `Context.sequence` lists only `FLATFILE, TSV`, **`sequence` never creates a master entry,
never reads a chromosome list, never reads an AGP file, and never runs any of the assembly-level
checks.** That single fact drives most of what follows.

---

## 2. Per-context tabulation

### 2a. FLATFILE reader format

`check/file/FlatfileFileValidationCheck.java:55-58`:

```java
Format format = options.context.get() == Context.genome
    ? Format.ASSEMBLY_FILE_FORMAT
    : Format.EMBL_FORMAT;
```

(A GenBank file — first line starts with `LOCUS`, `FileValidationCheck.java:672-677` `isGenbank` —
bypasses this entirely and uses `GenbankEntryReader`, `FlatfileFileValidationCheck.java:59-62`.)

| context | reaches `FlatfileFileValidationCheck`? | Format branch |
|---|---|---|
| `genome` | yes (`Context.genome` lists FLATFILE) | `ASSEMBLY_FILE_FORMAT` |
| `transcriptome` | **yes** (`Context.transcriptome` lists FLATFILE) | **`EMBL_FORMAT`** — the `else` branch |
| `sequence` | yes | `EMBL_FORMAT` |
| `polysample_*` | no — no FLATFILE in their file-type lists | n/a |
| `reads`, `taxrefset` | no — different validators | n/a |

So the answer to "does transcriptome also go through this and which branch": yes, and it lands on
`EMBL_FORMAT`, the same branch as `sequence`. But — see 2b — that does **not** mean the
transcriptome source feature survives.

What `ASSEMBLY_FILE_FORMAT` does differently is in
`flatfile/reader/embl/EmblEntryReader.java:223-252`: it installs `IDReader(lineReader, true)`
("Allow submitter accession to be provided on the ID line", `:224-225`), and then registers
`AC`, `PR`, `DE`, `KW`, `DT`, `ST*`, `CC`, `DR`, `OS`, `OC`, `OG` and every `R*` reference line as
**skip-tag counters** rather than block readers (`:226-250`) — i.e. those lines are parsed and
discarded. Finally `:251` sets `skipSourceFeature = true`.

### 2b. Does the submitted source feature survive?

Three mechanisms, in order.

**(i) Parse-time drop (genome only).** `skipSourceFeature` is passed into the feature reader at
`EmblEntryReader.java:268`:
`append((new FeatureReader(lineReader, skipSourceFeature, isReducedFlatfile)).read(entry));`

In `flatfile/reader/FeatureReader.java:69-81`, when the feature name is `source` and `skipSource`
is set, the reader spins forward consuming lines until the next feature line, discarding the
source feature's qualifier lines. The bare `Feature` object built from the FT line (name +
location) is still added to the entry unconditionally at `FeatureReader.java:148`
(`entry.addFeature(feature);`), and the "source must have /mol_type" error FT.9 is suppressed
(`:145`, `&& !skipSource`). Net for `-context genome`: the entry ends up with a **source feature
carrying zero qualifiers** — no `/organism`, `/isolate`, `/country`, `/collection_date`, `/host`,
nothing. The reader also never calls `sourceFeature.setScientificName()` / `setTaxId()`
(`FeatureReader.java:93-110`) because it never sees the `/organism` or `/db_xref` qualifiers.

**(ii) `appendHeader` — the per-context rebuild.** `check/file/FileValidationCheck.java:335-400`.
Call sites: `FlatfileFileValidationCheck.java:119`, `TSVFileValidationCheck.java:94`,
`FastaFileValidationCheck.java:102` and `:117`, `AnnotationOnlyFlatfileValidationCheck.java:81`,
`AGPFileValidationCheck.java:129`.

Exactly what it does, per context:

- **`sequence`** — `:337-344`:
  ```java
  if (Context.sequence == getOptions().context.get()) {
    try { addTemplateHeader(entry); return; } catch (Exception e) { ... }
  }
  ```
  Early return. **`addSourceQualifiers` is never called, so the submitted source feature and all
  its qualifiers survive intact.** `addTemplateHeader` (`:611-670`) only touches the header:
  clears references (`:613`), clears and re-adds the project accession from
  `options.getProjectId()` (`:614-615`), forces `sequence.setVersion(1)` (`:616`), clears secondary
  accessions (`:617-618`), and installs a submitter reference — from the manifest
  AUTHORS+ADDRESS if both present (`:620-631`) else, under webin-cli, a hardcoded stub reference
  with author "CLELAND" and the EMBL-EBI address (`:654-668`). (The non-webin-cli branch at
  `:634-653` goes to the ERAPRO DAO; not reachable from webin-cli since
  `SubmissionValidator.java:155` sets `options.isWebinCLI = true`.)

- **`genome` and `transcriptome`** — `:345-399`. First `:345-347` hard-fails if there is no master
  entry ("Master entry must to validate sequences"). Then it **replaces the header wholesale from
  the master**: `removeReferences()`, `removeProjectAccessions()` (`:349-350`), then adds the
  master's references, project accessions, XRefs (which include the `BioSample` XRef), comment and
  division (`:351-355`). Sets the data class from `getDataclass()` (`:362`). Calls
  **`addSourceQualifiers(entry)`** (`:364`). Then forces `mol_type` from the master (`:365`) and
  topology from the master if unset (`:366-368`).
  - genome extra: `:369-384` `Utils.setAssemblyLevelDescription(...)` overwrites the DE line with
    an assembly-level-derived description (contig=0 / scaffold=1 / chromosome=2).
  - transcriptome extra: `:385-399` forces `sequence.setVersion(1)`, **resets the source feature's
    location to the full 1..length span**, and overwrites the description to
    `"TSA: <scientific name> <submitter accession>"`.
  - Note `:358-363` contains a dead `if (Context.sequence == ...)` branch — unreachable, because
    `sequence` already returned at `:340`.

- **`polysample_*`** — never reaches `appendHeader` on any path I could find: their file-type lists
  contain no FLATFILE, their FASTA is explicitly skipped in the plan
  (`SubmissionValidationPlan.java:82-85`), and the TSV path routes to
  `validatePolySampleTSV` / `validateSequenceTaxTSV`, not `validateTemplateSubmission`
  (`TSVFileValidationCheck.java:43-52`), neither of which calls `appendHeader`.

- **`reads`, `taxrefset`** — not sequencetools; no flat files, no source features.

**(iii) `addSourceQualifiers` — the wipe.** `FileValidationCheck.java:538-609`. The load-bearing
line is **`:565`**:

```java
entry.getPrimarySourceFeature().removeAllQualifiers();
```

Before that, `:552-557` stashes only one qualifier — `submitter_seqid` — and `:606-608` restores
it afterwards. Everything else the submitter wrote is gone. Then:

- `:566-599`, genome only: looks up the entry's submitter accession in
  `sharedInfo.chromosomeNameQualifiers` (populated from the CHROMOSOME_LIST) and adds the
  chromosome-derived qualifiers; and for WGS-dataclass entries adds
  `/note="contig: <submitter accession>"`.
- `:601-605`: copies **every qualifier from the master entry's source feature** onto the entry.

So for **transcriptome** the source feature *is* parsed from the flatfile (EMBL_FORMAT, no
`skipSource`) — but `:565` then wipes its qualifiers and `:601-605` replaces them with the
master's. The end state is the same as genome: sample-derived source. The only difference is
that for transcriptome the parse-time `/organism`, `/mol_type` and `/db_xref` *were* seen by the
reader (and would raise FT.9 if `/mol_type` were missing), whereas for genome they were not.

**Where the master's source feature comes from.** `SubmissionValidator.java:143-154`:

```java
if (manifest.getSample() != null) {
  assemblyInfo.setBiosampleId(manifest.getSample().getBioSampleId());
  assemblyInfo.setOrganism(manifest.getSample().getOrganism());
  SourceFeature sourceFeature = new SourceFeatureUtils()
      .constructSourceFeature(manifest.getSample(), new TaxonomyClient());
  sourceFeature.addQualifier(Qualifier.DB_XREF_QUALIFIER_NAME,
      String.valueOf(manifest.getSample().getTaxId()));
  options.source = Optional.of(sourceFeature);
}
```

`api/service/MasterEntryService.java:122-184` (`getMasterEntryFromWebinCli`) then hard-requires
both `assemblyInfoEntry` and `source` (`:124-132`, throwing otherwise) and hangs that source
feature on the master (`:164`). `getAnalysisType` (`:186-195`) returns `SEQUENCE_ASSEMBLY` for
genome, `TRANSCRIPTOME_ASSEMBLY` for transcriptome, and **`null` for everything else** — so even
if a master were somehow requested for `sequence`, `:136-138` would return an empty entry.

**The clean summary:** the reason `-context sequence` preserves the submitted source feature is
*not* a deliberate "trust the flatfile" policy — it is that `sequence` has **no SAMPLE field at
all**, so there is no sample-derived source feature to overwrite it with. See 2c.

One more source-related difference: `addSubmitterSeqIdQual`
(`FileValidationCheck.java:868-887`) adds `/submitter_seqid=<object name>` only when the scope is
`ASSEMBLY_CONTIG`, `ASSEMBLY_SCAFFOLD` or `ASSEMBLY_CHROMOSOME` — i.e. genome only. Scope is set
by `getValidationScope` (`:135-165`): genome → `ASSEMBLY_CONTIG|SCAFFOLD|CHROMOSOME` depending on
the chromosome/unlocalised lists; transcriptome → `ASSEMBLY_TRANSCRIPTOME` (`:158-159`);
**sequence → `ValidationScope.EMBL_TEMPLATE`** (`:160-161`), commented in
`ValidationScope.java:20-21` as "Pipeline (Webin-CLI sequence scope)".

### 2c. Manifest fields, mandatory vs optional, and accepted FILE types

Shared across all readers: `Fields.NAME` and the optional `INFO`, `SUBMISSION_TOOL`,
`SUBMISSION_TOOL_VERSION` (`manifest/ManifestReader.java:46-65`).

**`genome`** — `context/genome/GenomeManifestReader.java:107-249`

- Required: `NAME` (synonym `ASSEMBLYNAME`, `:113-117`), `STUDY` (`:119-123`), `SAMPLE`
  (`:125-129`), `ASSEMBLY_TYPE` (`:131-135`, CV at `:90-98`: "clone or isolate", "primary
  metagenome", "binned metagenome", "Metagenome-Assembled Genome (MAG)", "Environmental
  Single-Cell Amplified Genome (SAG)", "COVID-19 outbreak", "clinical isolate assembly"),
  `COVERAGE` (`:141-145`), `PROGRAM` (`:146-150`), `PLATFORM` (`:151-155`).
- Optional: `DESCRIPTION`, `MINGAPLENGTH`, `MOLECULETYPE` (CV: genomic DNA / genomic RNA / viral
  cRNA, `:87-88`; defaults to "genomic DNA" at `:338-341`), `RUN_REF`, `ANALYSIS_REF`, `TPA`,
  `AUTHORS`, `ADDRESS`, `SUBMISSION_TOOL(_VERSION)`.
- File fields, all individually optional: `FASTA`, `FLATFILE`, `CHROMOSOME_LIST`,
  `UNLOCALISED_LIST` (`:179-202`). Note **no `AGP` field is declared in the reader** even though
  `GenomeManifest.FileType` has `AGP` — AGP reaches sequencetools via
  `SubmissionValidator.java:326-336`, so it is presumably injected elsewhere; I could not find a
  manifest field that populates `GenomeManifest.FileType.AGP` in 9.0.3. **Flagging this as
  unverified** — either AGP is supported through a path I did not find, or it is currently dead in
  this version. The public docs do list `AGP` as a manifest field
  (`ena-docs-reference/read_docs/submit/assembly/genome.rst`, manifest file-name list).
- Four valid file groups (`:231-249`): FASTA alone; FASTA + CHROMOSOME_LIST (+ optional
  UNLOCALISED_LIST); FLATFILE alone; **FLATFILE + CHROMOSOME_LIST (+ optional UNLOCALISED_LIST)**
  — the last is what Pathoplexus uses.
- Extra constraint (`:387-407`): for `primary metagenome`, `binned metagenome` and
  `clinical isolate assembly`, only FASTA is permitted.

**`transcriptome`** — `context/transcriptome/TranscriptomeManifestReader.java:71-174`

- Required: `NAME` (synonym `ASSEMBLYNAME`), `STUDY`, `SAMPLE`, `PROGRAM`, `PLATFORM`,
  `ASSEMBLY_TYPE` (`:151-155`, CV = "isolate" | "metatranscriptome", `:68-69`).
- Optional: `RUN_REF`, `ANALYSIS_REF`, `DESCRIPTION`, `TPA`, `AUTHORS`, `ADDRESS`,
  `SUBMISSION_TOOL(_VERSION)`.
- Files: `FASTA`, `FLATFILE`. Groups (`:168-174`): FASTA alone, or FLATFILE alone. **No
  CHROMOSOME_LIST, no AGP.**

**`sequence`** — `context/sequence/SequenceManifestReader.java:50-123`

- Required: `NAME` (`:55-58`), `STUDY` (`:60-64`). **That is the entire mandatory set.**
- Optional: `RUN_REF`, `ANALYSIS_REF`, `DESCRIPTION`, `AUTHORS`, `ADDRESS`,
  `SUBMISSION_TOOL(_VERSION)`.
- **There is no `SAMPLE` field** — the `Field` interface at `:27-36` lists only
  `STUDY, RUN_REF, ANALYSIS_REF, DESCRIPTION, TAB, FLATFILE, AUTHORS, ADDRESS`. No `ASSEMBLY_TYPE`,
  no `COVERAGE`, no `PROGRAM`, no `PLATFORM`, no `MOLECULETYPE`, no `MINGAPLENGTH`, no `TPA`.
- Files: `TAB` and `FLATFILE`, groups at `:117-123` — "Annotated sequences in a comma separated
  file." (TAB) **or** "Annotated sequences in a flat file." (FLATFILE). Mutually exclusive, one
  required.
- Suffix processors: FLATFILE must be gzip/bzip2 (`:148-153`), TAB must match `TAB_FILE_SUFFIX`
  (`:142-146`). There is a `getFastaProcessors()` at `:155-159` that is **never referenced** —
  dead code; FASTA is not accepted in this context.

**`polysample`** — `context/polysample/PolySampleManifestReader.java:78-215`

- Required: `NAME` (`:82-86`), `STUDY` (`:87-91`).
- Optional metadata: `RUN_REF`, `ANALYSIS_REF`, `DESCRIPTION`, `ANALYSIS_TYPE`,
  `ANALYSIS PROTOCOL`, `ANALYSIS DATE`, `TARGET LOCUS`, `ANALYSIS CODE`, `ANALYSIS VERSION`,
  `ORGANELLE`, `FORWARD/REVERSE PRIMER NAME`, `FORWARD/REVERSE PRIMER SEQUENCE`,
  `ANALYSIS CENTER`, `AUTHORS`, `ADDRESS`, `SUBMISSION_TOOL(_VERSION)`. These become
  `ANALYSIS_ATTRIBUTE` tag/value pairs (`PolySampleXmlWriter.java:88-119`).
- Files: `FASTA`, `SAMPLE_TSV`, `TAX_TSV`. No SAMPLE field. No CHROMOSOME_LIST.

**`reads`** — `context/reads/ReadsManifestReader.java`

- Required: `NAME`, `STUDY`, `SAMPLE`, `LIBRARY_SOURCE`, `LIBRARY_SELECTION`, `LIBRARY_STRATEGY`
  (all CV-processed).
- Optional: `DESCRIPTION`, `INSTRUMENT`, `PLATFORM`, `LIBRARY_CONSTRUCTION_PROTOCOL`,
  `LIBRARY_NAME`, `INSERT_SIZE`, `QUALITY_SCORE`, `READ_TYPE`, hidden `__HORIZON`,
  `SUBMISSION_TOOL(_VERSION)`.
- File groups (`:236-245`): up to **10** `FASTQ` files; **or** one `CRAM`; **or** one `BAM`.
- Emits `EXPERIMENT` + `RUN` XML, not `ANALYSIS` (`ReadsXmlWriter.java:43-51`).

**`taxrefset`** — `context/taxrefset/TaxRefSetManifestReader.java:56-110`

- Required: `NAME`, `STUDY`, `DESCRIPTION` (required here, unlike everywhere else, `:72-76`),
  `TAXONOMY_SYSTEM` (`:77-81`), **and both files** `FASTA` (`:87-92`) and `TAB` (`:93-98`).
- Optional: `TAXONOMY_SYSTEM_VERSION`, up to 100 `CUSTOM_FIELD` entries (`:99-103`).
- Single file group: FASTA + TAB, both mandatory (`:106-110`). No SAMPLE. No CHROMOSOME_LIST.

**GFF3 is declared but not wired.** `GFF3` appears in `GenomeManifest.FileType:22`,
`TranscriptomeManifest.FileType:19` and `SequenceManifest.FileType:19`, but a repo-wide grep over
`webin-cli/src/main/java` and `webin-cli-validator/src/main/java` finds **no manifest field, no
processor and no XML writer branch** for it. In 9.0.3 GFF3 is a placeholder.

### 2d. CHROMOSOME_LIST — accepted? required?

| context | accepted | required | code |
|---|---|---|---|
| `genome` | **yes** | only within the chromosome-level file groups | `GenomeManifestReader.java:191-196` (field, `.optional()`), `:235-248` (groups) |
| `transcriptome` | no | — | not in `TranscriptomeManifestReader` fields (`:33-48`); not in `Context.transcriptome` (`Context.java:22`) |
| `sequence` | **no** | — | not in `SequenceManifestReader.Field` (`:27-36`); `Context.sequence` is `FLATFILE, TSV` only (`Context.java:18`), so `SubmissionValidationPlan.java:61-62` never fires |
| `polysample` | no | — | `Context.polysample_*` (`Context.java:19-21`) |
| `reads` / `taxrefset` | no | — | different validators |

What the chromosome list actually buys you, and why it matters for the decisive question:
`ChromosomeListFileValidationCheck` populates `sharedInfo.chromosomeNameQualifiers`, and
`entry/genomeassembly/ChromosomeEntry.setAndGetQualifiers(boolean virus)`
(`ChromosomeEntry.java:94-134`) turns each row into source qualifiers:

- `:102-113` — non-virus, non-phage with a `chromosomeLocation` → `/organelle=<mapped value>`
- `:114-118` — `chromosomeType == "plasmid"` → `/plasmid=<chromosome name>`
- `:119-122` — `chromosomeType == "chromosome"` → `/chromosome=<chromosome name>`
- `:123-127` — `chromosomeType == "segmented"` or `"multipartite"` → **`/segment=<chromosome name>`**
- `:129-132` — `chromosomeType == "monopartite"` → `/note=monopartite`

These are injected in `addSourceQualifiers` (`FileValidationCheck.java:566-592`), and the `virus`
flag is computed live from the taxonomy client against the **master entry's** organism
(`:579-584`, `taxonomyClient.isChildOf(<master /organism>, "Viruses")`). This is the mechanism
that produces `/segment` on viral segment records, and it exists **only** in the genome context
and **only** via the chromosome list.

### 2e. Checklist / template requirements

The template machinery lives in `sequencetools/src/main/java/uk/ac/ebi/embl/template/`
(`TemplateProcessor`, `TemplateLoader`, `TemplateEntryProcessor`, `TemplateIDs`, …) with **29
bundled templates** in `src/main/resources/templates/ERT0000NN.xml`
(ERT000002, 003, 006, 009, 020, 024, 028, 029, 030, 031, 032, 034, 035, 036, 037, 038, 039, 042,
047, 050, 051, 052, 053, 054, 055, 056, 057, 058, 060).

**Crucially, the template path is bound to TAB input, not to the `sequence` context.**
`check/file/TSVFileValidationCheck.java:43-52` dispatches: polysample TSV → `validatePolySampleTSV`,
sequence-tax TSV → `validateSequenceTaxTSV`, otherwise → `validateTemplateSubmission`.
In `validateTemplateSubmission` (`:54-132`):

- `:60-64` the template id is read **from the submitted TSV itself** via
  `getTemplateIdFromTsvFile` (`:160-185`), which gunzips the file, scans the first 10 lines and
  calls `CSVReader.getChecklistIdFromIdLine(line)`. A blank id is a hard
  `"Missing template id"` validation error.
- `:68` the matching `ERT…` XML is pulled from the bundled resources and written to the process dir
  (`getTemplateFromResourceAndWriteToProcessDir`, `:139-158`); an unknown id fails there.
- `:74-91` the template is loaded and `TemplateProcessor.process(...)` **constructs** each `Entry`
  from the spreadsheet row — including its source feature.
- `:94` then calls `appendHeader(entry)`, which for `sequence` is the early-return template-header
  path.

`TemplateEntryProcessor` runs under `ValidationScope.EMBL_TEMPLATE`
(`template/TemplateEntryProcessor.java:57`), the same scope `getValidationScope` assigns to the
`sequence` context — hence the name. `TemplateEntryProcessor.java:557-559` resolves an optional
sample id through `SequenceToolsServices.sampleRetrievalService()`, which
`SubmissionValidator.java:53-61` initialises **only for `Context.sequence`** — that is the
"you may optionally link a sample in an annotation checklist" feature, and it is per-row inside
the spreadsheet, not a manifest field.

**So: does `-context sequence` accept a raw FLATFILE at all, or only TAB/template?**
**It accepts a raw FLATFILE, with no checklist and no template id whatsoever.**

- `SequenceManifestReader.java:121-122` declares a valid file group "Annotated sequences in a flat
  file." requiring only `FLATFILE`.
- `SubmissionValidator.setSequenceOptions` (`:373-398`) maps `SequenceManifest.FileType.FLATFILE` →
  `SubmissionFile.FileType.FLATFILE` and `TAB` → `TSV`.
- `Context.sequence` lists `FLATFILE`, so `SubmissionValidationPlan.java:90-93` runs
  `validateFlatfile()` → `FlatfileFileValidationCheck`, which reads it as plain `EMBL_FORMAT` and
  never touches `TemplateProcessor`.

The one thing the flatfile path shares with the template path is the **30,000-sequence cap**:
`FileValidationCheck.java:68` `MAX_SEQUENCE_COUNT_FOR_TEMPLATE = 30000`, enforced for
`Context.sequence` in both `FlatfileFileValidationCheck.java:74-77` and
`TSVFileValidationCheck.java:96-99` (bypassable with `ignoreErrors`,
`FileValidationCheck.java:742-747`).

Two other sequence-specific flatfile behaviours: the data class defaults to `STD` if absent
(`FlatfileFileValidationCheck.java:108-114`) rather than being derived from assembly level; and
the "entry name required" hard error is **genome-only** (`:93-97`), so sequence-context entries
need no submitter object name.

The public docs agree: `read_docs/submit/sequence.rst:72-82` describes flat file and checklist
spreadsheet as **two alternatives**, and `read_docs/submit/sequence/webin-cli-flatfile.rst` is a
whole page on submitting raw flat files with `-context sequence`.

### 2f. Accession class returned

What webin-cli itself reports is thin. `service/SubmitService.java:186-204` parses the receipt,
and for each non-`SUBMISSION` XML file type reads `rootNode.getChild(<TYPE>).getAttributeValue("accession")`
and logs `WebinCliMessage.SUBMIT_SERVICE_SUCCESS` ("The following {0} accession was assigned to the
submission: {1}", `WebinCliMessage.java:59-60`). So statically, all webin-cli knows is:

- `genome`, `transcriptome`, `sequence`, `polysample`, `taxrefset` → one **ANALYSIS** accession
  (ERZ), because those writers emit only an `ANALYSIS_SET`.
- `reads` → an **EXPERIMENT** accession (ERX) **and** a **RUN** accession (ERR)
  (`ReadsXmlWriter.java:43-51`).

**Everything downstream of that is server-side and is not in this source tree.** There is no code
here that mints GCA accessions, sequence accessions (OZ/OA/CA…), or ERS/ERA. I can only cite the
docs, which I'll mark as doc-sourced, not code-verified:

- `read_docs/submit/general-guide/accessions.rst:34` analyses = `(E|D|S)RZ[0-9]{6,}`;
  `:36` assemblies = `GCA_[0-9]{9}\.[0-9]+`; `:38-42` assembled/annotated sequences = the
  `[A-Z]{1}[0-9]{5}`, `[A-Z]{2}[0-9]{6}`, `[A-Z]{2}[0-9]{8}`, `[A-Z]{4}[0-9]{2}S?[0-9]{6,8}`,
  `[A-Z]{6}[0-9]{2}S?[0-9]{7,9}` families.
- genome: `read_docs/submit/assembly.rst:105-108` — ERZ immediately, "for most assemblies…
  additional post-processing accession numbers starting with GCA_".
  `read_docs/submit/assembly/genome.rst` ("Assigned Accession Numbers") lists the citable set as
  study PRJEB, sample SAMEA, **GCA_**, and per-sequence accessions; and states ERZ "should not be
  used to reference the assembly in publications".
- **SARS-CoV-2 exception:** `read_docs/submit/assembly.rst:121-124` — "In alignment with INSDC
  partners, SARS-CoV-2 assemblies will not be assigned a GCA_ accession. For these assemblies,
  sequence accessions will continue to be assigned and the ERZ records will also be available in
  the browser". Directly relevant to Pathoplexus.
- sequence: `read_docs/submit/sequence.rst:26-28` — "All submissions of this type are submitted as
  'analysis' objects with accessions resembling ERZxxxxxx. However, analysis accessions of this
  type are **not exposed**. Instead, specific sequence accessions are assigned later". `:52-58`
  repeats that the ERZ is internal-only and not unique per sequence, and that per-sequence
  accessions arrive by email. **No GCA is mentioned anywhere for the sequence context**, which is
  consistent with the code: no assembly object is constructed, no assembly name, no assembly type,
  no sample.
- transcriptome / taxrefset / polysample: I did not verify the downstream accession classes.
  Transcriptome entries get `TSA` data class (`FileValidationCheck.java:296-297`), which in INSDC
  terms means a TSA-prefixed sequence set, but I have **not** confirmed that statically beyond the
  data class constant.

**Stated gap:** nothing in either source tree lets me confirm *statically* which post-processing
accessions ENA actually mints for any context. All the ERZ→GCA / ERZ→sequence-accession behaviour
is server-side.

---

## 3. The decisive question: would `-context sequence` work for Pathoplexus viral genome assemblies?

**No. It is the wrong tool, and it would not just change cosmetics — it would change what kind of
INSDC record is created.** The one thing it does buy (an unmangled source feature) is real, but
everything else about it is a downgrade for an assembly submission. Eight independent reasons, in
rough order of how fatal they are:

**1. Assemblies are explicitly out of scope for this route, and ENA says so twice.**
`read_docs/submit/sequence.rst:40-43`:

> "This submission route is for sets of stand-alone targeted assembled and annotated sequences
> only. If you intend to submit an annotated **assembly** such as a genome, please follow the
> assembly submission guidelines and submit your assembly in EMBL flat file format."

and `read_docs/submit/sequence/annotation-checklists.rst:9-11`: "none of the information here is
relevant to submission of annotated genome assemblies." Also `:16-19` of `sequence.rst`:
"Submissions of this type very rarely exceed a few hundred individual sequences… Please do not use
the information given here to submit thousands of sequences without prior approval as there may be
a more appropriate route." A high-volume pathogen brokering pipeline is precisely the case that
sentence is aimed at.

**2. No SAMPLE, therefore no BioSample linkage on the record.** `SequenceManifestReader.Field`
(`:27-36`) has no SAMPLE. `SequenceToolsXmlWriter.java:68-74` only emits a `SAMPLE_REF` when the
manifest has a sample, so the ANALYSIS XML would carry a `STUDY_REF` and nothing else. And
`appendHeader`'s master-entry branch — the one that adds `entry.addXRefs(masterEntry.getXRefs())`
(`FileValidationCheck.java:353`), which is where the `BioSample` DR line comes from
(`MasterEntryService.java:160`, `masterEntry.addXRef(new XRef("BioSample", ...))`) — is skipped
entirely. Pathoplexus registers a sample per sequence and relies on that linkage; `-context
sequence` structurally cannot express it at the manifest level. (A sample *can* be referenced
per-row inside a checklist spreadsheet — `TemplateEntryProcessor.java:557-559` — but that is the
TAB path, not the flatfile path, and it requires a checklist that fits your data. See point 5.)

**3. Different accession class, and no GCA.** Per §2f: the genome context yields ERZ → GCA +
per-sequence accessions; the sequence context yields an ERZ that ENA states is *not exposed*, plus
per-sequence accessions only. There is no assembly object to accession, because there is no
assembly name (`sequence` has no `ASSEMBLYNAME`), no assembly type, no coverage/program/platform,
and no `AssemblyInfoNameCheck` (that check is genome-only,
`SubmissionValidator.java:163-172`). If GCA accessions matter to Pathoplexus, this switch removes
them. *Nuance worth weighing honestly:* for SARS-CoV-2 specifically, ENA already withholds GCA
(`assembly.rst:121-124`), so for that one organism the "lose the GCA" objection is weaker — but it
still applies to every other Pathoplexus organism, and the ERZ visibility story is the opposite in
the two contexts (visible for SARS-CoV-2 genome submissions, explicitly *not* exposed for sequence
submissions).

**4. Loss of the chromosome list → loss of `/segment` and segment naming.** This is the one that
should be decisive on its own for segmented viruses. `-context sequence` cannot take a
CHROMOSOME_LIST (§2d), so `sharedInfo.chromosomeNameQualifiers` is never populated and
`ChromosomeEntry.setAndGetQualifiers` (`ChromosomeEntry.java:94-134`) never runs. That means no
`/segment`, no `/plasmid`, no `/chromosome`, no `/organelle`, no `/note=monopartite`. You would
have to write `/segment` by hand into each flatfile's source feature — which *would* now survive,
so it is technically recoverable — but you would also lose everything the chromosome list drives
on the ENA side: assembly level (`getValidationScope`, `FileValidationCheck.java:135-165`, returns
`EMBL_TEMPLATE` for sequence, never `ASSEMBLY_CHROMOSOME`), the STD-vs-WGS data class decision
(`getDataclass`, `:253-303`, returns `null` for sequence), the sequenceless-chromosome check and
the unlocalised-object-name check (`SubmissionValidationPlan.java:115-119`, genome-only), and the
topology-from-chromosome-list logic (`getTopology`, `FileValidationCheck.java:402-410`, which is
gated on `ASSEMBLY_CHROMOSOME`). A multi-segment influenza or hantavirus submission would stop
being "one chromosome-level assembly with N replicons" and become "N unrelated targeted
sequences".

**5. Checklists do not cover whole viral genomes.** If you went the TAB/template route instead of
flatfile, you would need an `ERT…` id in the spreadsheet
(`TSVFileValidationCheck.java:60-64`, `:160-185`). The bundled set has 29 templates, and the
virus-specific ones (`read_docs/submit/sequence/annotation-checklists.rst`, "Virus-Specific
Checklists") are ERT000028 single viral CDS, ERT000051 viral polyprotein, ERT000052 ssRNA(-) viral
cRNA, ERT000060 viral UTR/NTR, ERT000057/ERT000047 alpha/betasatellite, ERT000031 plant viroid.
**None is for a complete viral genome**, and ERT000060's definition says outright "Please do not
use this checklist for submitting virus genomes or viral coding genes." So the TAB route is out
and only the flatfile route is even available — which is fine mechanically (§2e) but removes the
"checklists give structured metadata" argument entirely.

**6. Loss of assembly_gap generation.** The implicit-gap machinery
(`SequenceToGapFeatureBasesFix` / `SequenceToGapFeatureBasesCheck`) is driven by
`options.minGapLength`, which is set only from `GenomeManifest.getMinGapLength()`
(`SubmissionValidator.java:311`). `sequence` has no MINGAPLENGTH field, so `minGapLength` stays at
its default `0` (`SubmissionOptions.java:63`) and the runs-of-Ns → `assembly_gap` conversion never
fires (`SequenceToGapFeatureBasesFix.java:55-57`). *Honest caveat:* this matters less for
Pathoplexus than the other points, since viral consensus genomes with internal N runs would
normally be N-masked rather than gapped, and `SequenceToGapFeatureBasesCheck` is listed for
`EMBL_TEMPLATE` scope too (`:33`) — so some gap checking still applies, just not the
minGapLength-driven scaffold synthesis.

**7. The submission would be silently mis-typed in the archive.** The ANALYSIS_TYPE element goes
from `<SEQUENCE_ASSEMBLY>` with NAME/TYPE/COVERAGE/PROGRAM/PLATFORM/MOL_TYPE
(`GenomeXmlWriter.java:29-56`) to a bare `<SEQUENCE_FLATFILE>` carrying nothing but optional
AUTHORS/ADDRESS (`SequenceXmlWriter.java:29-40`). Every piece of assembly provenance —
which assembler, which platform, what coverage, what assembly type — has nowhere to go. That is
metadata Pathoplexus currently supplies and ENA currently indexes.

**8. The 30,000-sequence cap.** `FileValidationCheck.java:68` + `:742-747`, enforced for
`Context.sequence` on the flatfile path at `FlatfileFileValidationCheck.java:74-77`. Genome
submissions are capped differently and per assembly level (docs:
`read_docs/submit/assembly/genome.rst`, "Sequence Count Validation" — contig-level 2 to 1,000,000).
Per-submission batching would need rethinking.

**What is actually true about the upside.** The premise is correct and I verified it: with
`-context sequence` the flatfile's own source feature survives completely intact, because
`appendHeader` returns at `FileValidationCheck.java:337-344` before reaching
`addSourceQualifiers`, and there is no sample-derived master source feature to overwrite it with
(`MasterEntryService.getAnalysisType` returns `null` for anything but genome/transcriptome,
`:186-195`). All of `/isolate`, `/country`, `/collection_date`, `/host`, `/strain`, `/note` etc.
would land verbatim. That is a genuine capability the genome context does not have.

**The narrower framing that is worth taking to ENA.** The real problem is not "which context" but
`FileValidationCheck.java:565` — one unconditional `removeAllQualifiers()` that throws away
submitter source qualifiers the genome context has no other way to accept. The surrounding code
already knows how to preserve a single qualifier across the wipe (`/submitter_seqid`, `:552-557`
and `:606-608`), so the shape of a fix — merge master-derived qualifiers over submitter-supplied
ones instead of replacing them, or whitelist additional submitter qualifiers — is small and local.
A brokering-specific ask along those lines, or a request that ENA populate the sample-derived
source feature from the richer attributes Pathoplexus already registers on the BioSample, is a far
more plausible route than moving an assembly submission into a targeted-sequence context.

---

## 4. Where the public ENA docs contradict or under-describe the code

Comparing `ena-docs-reference/read_docs/` against the two source trees:

1. **The source-feature rewrite is completely undocumented.** A grep for "source feature" across
   `read_docs/submit/` hits only `fileprep/sequence-flatfile.rst:49`, `:756-758`,
   `fileprep/flatfile_user_manual.txt:159-165` and `sequence/webin-cli-flatfile.rst:49` — all in
   the *targeted sequence* pages. **Nothing under `submit/assembly/` or
   `submit/fileprep/assembly.rst` mentions that a genome flatfile's source feature is discarded at
   parse time and rebuilt from the SAMPLE.** For anyone preparing an annotated genome flat file
   this is the single most surprising behaviour in the pipeline, and it is invisible in the docs.
   The nearest thing is `sequence/webin-cli-flatfile.rst:34-39`, which warns that `XXX` header
   sections and `R*` reference lines are overwritten — but that page is about the *sequence*
   context, where the source feature is in fact the one thing that is preserved. The docs warn you
   about the wrong context.

2. **`-context polysample` is entirely absent from the docs.** A case-insensitive grep for
   "polysample" across the whole local docs copy returns **zero hits**, yet it is a first-class
   selectable context (`WebinCliContext.java:54-59`) with its own manifest reader, three
   sequencetools sub-contexts and an `ENVIRONMENTAL_SEQUENCE_SET` analysis type. Either it is
   newer than this docs snapshot or it is deliberately undocumented; I cannot tell which.

3. **The genome manifest field list in the docs is incomplete.**
   `read_docs/submit/assembly/genome.rst` ("Manifest Files") lists STUDY, SAMPLE, ASSEMBLYNAME,
   ASSEMBLY_TYPE, COVERAGE, PROGRAM, PLATFORM, MINGAPLENGTH, MOLECULETYPE, DESCRIPTION, RUN_REF,
   and the file fields FASTA/FLATFILE/AGP/CHROMOSOME_LIST/UNLOCALISED_LIST. The code additionally
   accepts `ANALYSIS_REF`, `TPA`, `AUTHORS`, `ADDRESS`, `SUBMISSION_TOOL`,
   `SUBMISSION_TOOL_VERSION` and `INFO` (`GenomeManifestReader.java:167-228`,
   `ManifestReader.java:46-65`). `SUBMISSION_TOOL`/`SUBMISSION_TOOL_VERSION` matter for brokers
   like Pathoplexus and are undocumented on that page.

4. **Conversely, the docs list an `AGP` manifest field the reader does not declare.**
   `GenomeManifestReader` has no `AGP` field (`:37-57`, `:179-202`, `:362-385`) although
   `GenomeManifest.FileType.AGP` exists and `SubmissionValidator.java:326-336` consumes it.
   **Unverified** — I could not find the code path that populates it in 9.0.3, and I am not
   claiming AGP is broken, only that I could not trace it.

5. **The ASSEMBLY_TYPE controlled vocabulary is wider in code than in the docs.** Code
   (`GenomeManifestReader.java:90-98`) accepts seven values including "COVID-19 outbreak" and
   "clinical isolate assembly"; `genome.rst` documents only `'clone or isolate'` on the
   individuals/isolates page (the metagenome and SAG values live on separate pages; "COVID-19
   outbreak" I did not find documented in the local copy at all).

6. **"Sequence assembly" as the `sequence` context's title prefix** (`WebinCliContext.java:53`)
   contradicts the docs' own framing of that route as "targeted sequences" and "unrelated to the
   submission of genome assemblies" (`sequence.rst:12-15`). Anyone reading webin-cli's own output
   could reasonably conclude the opposite of what ENA intends.

7. **The 30,000-sequence limit for the sequence context is not in the docs.**
   `FileValidationCheck.java:68`. The docs say only "very rarely exceed a few hundred" and "do not
   submit thousands without prior approval" (`sequence.rst:16-19`) — a soft social limit, where the
   code has a hard numeric one.

8. **GFF3 appears in the code's file-type enums but nowhere in the docs, and nowhere else in the
   code either** — consistent, but worth noting so nobody mistakes the enum constant for support.

---

## 5. Explicitly unverified

- Downstream accession minting (ERZ → GCA, ERZ → OZ/OA/CA per-sequence accessions, TSA prefixes).
  Not in either source tree; all statements above are doc-sourced and labelled as such.
- How the ENA browser *presents* sequence-context vs genome-context records. Not determinable
  statically; the only code-side signal is that the sequence context produces no assembly object,
  and the only doc-side signal is `sequence.rst:26-28` ("analysis accessions of this type are not
  exposed").
- The AGP manifest field path for `-context genome` in 9.0.3 (see §4 item 4).
- Whether `polysample` is released or internal.
- Transcriptome's final INSDC record class beyond the `TSA` data class constant
  (`FileValidationCheck.java:296-297`).
- I did not open `readtools/` or the shipped jars in
  `/home/vscode/.claude/jobs/96bed7ed/tmp/enaval/fat/BOOT-INF/lib/`; everything above comes from
  the two Java source trees and the local docs copy. The `reads` context findings are therefore
  from webin-cli's side of the interface only (`ReadsManifestReader`, `ReadsXmlWriter`), not from
  `ReadsValidator`'s internals.
